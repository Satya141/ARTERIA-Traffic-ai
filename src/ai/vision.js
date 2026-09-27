import { CFG } from '../core/config.js';

// ============================================================================
//  Perception layer.
//
//  One virtual camera per approach. In a deployed system this is a YOLO-class
//  detector running on an edge box at the mast arm; here the detections are
//  drawn from the simulated scene and then DEGRADED on purpose — a per-frame
//  miss rate, positional jitter and distance-dependent confidence — so the
//  controller downstream has to cope with imperfect input exactly as it would
//  on real hardware. The controller never reads the ground truth.
// ============================================================================

const CLASS_LABEL = {
  hatchback: 'car', sedan: 'car', suv: 'car',
  auto: 'auto-rickshaw', bike: 'motorcycle',
  bus: 'bus', truck: 'truck', ambulance: 'emergency'
};

function emptyGroup() {
  return { queue: 0, arrivals: 0, demand: 0, maxWait: 0, nearest: 99, count: 0, emergency: false };
}

function resetGroup(g) {
  g.queue = 0; g.arrivals = 0; g.demand = 0; g.maxWait = 0;
  g.nearest = 99; g.count = 0; g.emergency = false;
}

export class VisionSystem {
  constructor(net) {
    this.net = net;
    this.cams = [];
    this.byKey = new Map();
    this.frame = 0;
    this.seed = 991;

    for (const node of net.signals) {
      for (const h of ['N', 'S', 'E', 'W']) {
        const link = node.in[h];
        if (!link) continue;
        const cam = {
          id: `${node.id}-${h}`,
          node, heading: h, link,
          // camera sits on the mast arm looking back up the approach
          detections: [],
          count: 0, queue: 0, queueMeters: 0, pce: 0,
          weightedDemand: 0, maxWait: 0, arrivals: 0, approachTime: 99,
          density: 0, occupancy: 0, flow: 0, hasEmergency: false,
          servedCount: 0, lastServedT: -99, lastArrivalT: -99,
          // per-lane-group readings: the left-turn pocket is metered separately
          // from the through/right lanes, exactly as a real stop-bar detector
          // layout does, so each phase is scored on its own traffic.
          groups: {
            left: emptyGroup(),
            thru: emptyGroup()
          },
          history: new Float32Array(120), histIdx: 0
        };
        this.cams.push(cam);
        this.byKey.set(cam.id, cam);
        node.cams = node.cams || {};
        node.cams[h] = cam;
      }
    }
  }

  rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  get(node, heading) { return this.byKey.get(`${node.id}-${heading}`); }

  scan(t, dt) {
    this.frame++;
    const R = CFG.vision.range;
    for (const cam of this.cams) {
      const dets = cam.detections;
      dets.length = 0;
      let queue = 0, queueMeters = 0, pce = 0, maxWait = 0, arrivals = 0;
      let hasEmergency = false, nearestApproach = 99, count = 0, occLen = 0;
      resetGroup(cam.groups.left);
      resetGroup(cam.groups.thru);

      for (const lane of cam.link.lanes) {
        const grp = lane.index === 0 ? cam.groups.left : cam.groups.thru;
        const q = lane.vehicles;
        for (let i = 0; i < q.length; i++) {
          const v = q[i];
          const distToLine = lane.length - v.s;
          if (distToLine > R) continue;
          count++;
          occLen += v.len;

          // ---- detector imperfection -------------------------------------
          const missChance = CFG.vision.missRate * (1 + distToLine / R);
          if (this.rand() < missChance) continue;
          const conf = Math.max(
            CFG.vision.confidenceFloor,
            0.995 - (distToLine / R) * 0.34 - (v.cls === 'bike' ? 0.09 : 0)
          );
          const jitter = (this.rand() - 0.5) * CFG.vision.jitter;

          const stopped = v.v < 0.55;
          const eta = distToLine / Math.max(v.v, 1.5);
          grp.count++;
          if (stopped) { queue++; grp.queue++; queueMeters = Math.max(queueMeters, distToLine); }
          else {
            arrivals++; grp.arrivals++;
            if (eta < nearestApproach) nearestApproach = eta;
            if (eta < grp.nearest) grp.nearest = eta;
          }
          pce += v.pce;
          if (v.waitT > maxWait) maxWait = v.waitT;
          if (v.waitT > grp.maxWait) grp.maxWait = v.waitT;
          if (v.emergency) { hasEmergency = true; grp.emergency = true; }

          const cw = CFG.classes[v.cls].weight;
          grp.demand += cw * (1 + Math.min(v.waitT, 90) * CFG.control.wWait)
                          * (stopped ? 1 : CFG.control.wArrival) * conf;

          dets.push({
            id: v.id,
            label: CLASS_LABEL[v.cls] || v.cls,
            cls: v.cls,
            conf,
            dist: Math.max(0, distToLine + jitter),
            speed: v.v,
            stopped,
            lane: lane.index,
            w: v.wid, l: v.len, h: v.hgt,
            x: v.x, z: v.z, heading: v.heading,
            wait: v.waitT,
            emergency: v.emergency
          });
        }
      }

      cam.count = count;
      cam.queue = queue;
      cam.queueMeters = queueMeters;
      cam.pce = pce;
      cam.maxWait = maxWait;
      cam.arrivals = arrivals;
      cam.approachTime = nearestApproach;
      cam.hasEmergency = hasEmergency;
      cam.density = (pce / R) * 100;                        // PCE per 100 m
      cam.occupancy = Math.min(1, occLen / (R * CFG.lanesPerDir));

      // Demand score the controller actually optimises against: a queued bus
      // full of people outweighs a single motorbike, and waiting compounds.
      let wd = 0;
      for (const d of dets) {
        const w = CFG.classes[d.cls].weight;
        const waitBoost = 1 + Math.min(d.wait, 90) * CFG.control.wWait;
        wd += w * waitBoost * (d.stopped ? 1 : CFG.control.wArrival) * d.conf;
      }
      cam.weightedDemand = wd;

      cam.history[cam.histIdx % cam.history.length] = queue;
      cam.histIdx++;
    }
  }
}
