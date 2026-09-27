import { CFG } from '../core/config.js';
import { lanePoint, bezierAt, bezierTangent, buildTurnPath } from './network.js';

// ============================================================================
//  Microscopic vehicle model.
//  Longitudinal behaviour: Intelligent Driver Model (Treiber et al., 2000).
//  Lateral behaviour: lane is chosen once per link from the turn intent, so
//  vehicles sort themselves into the correct turn pocket like real drivers.
// ============================================================================

const { aMax, bComf, bMax, s0, T, delta } = CFG.idm;

let nextId = 1;

export function createVehicle(spec, cls, lane, seedFloats) {
  const c = CFG.classes[cls];
  return {
    id: nextId++,
    cls,
    len: c.l, wid: c.w, hgt: c.h,
    pce: c.pce, weight: c.weight,
    emergency: cls === 'ambulance',
    colorSeed: seedFloats[0],
    driver: 0.9 + seedFloats[1] * 0.24,          // aggressiveness multiplier
    rolls: seedFloats,                            // pre-drawn randomness (shared across twins)
    rollAt: 2,

    lane, s: 0, v: 0, a: 0,
    state: 'link',                                // link | junction | done
    path: null, u: 0, junctionDist: 0, junctionLeader: null,
    movement: null, targetLane: null,

    // world pose, written by the sim, read by the renderer
    x: 0, z: 0, heading: 0, braking: 0,
    latOffset: 0, yawBias: 0, indicator: 0,

    // statistics
    spawnT: 0, waitT: 0, stops: 0, dist: 0, wasStopped: false, junctions: 0,
    idleT: 0, node: null
  };
}

export function nextRoll(v) {
  const r = v.rolls[v.rollAt % v.rolls.length];
  v.rollAt++;
  // decorrelate repeated use of the same pre-drawn pool
  return (r * 9301.17 + v.rollAt * 0.618033) % 1;
}

export function desiredSpeed(v) {
  return CFG.speedLimit * CFG.classes[v.cls].vmax * v.driver;
}

// ---------------------------------------------------------------------------
//  IDM acceleration.  gap/dv are supplied by the caller so the same function
//  serves lane following, stop lines and junction conflicts alike.
// ---------------------------------------------------------------------------
export function idmAccel(v, v0, gap, dv) {
  const free = 1 - Math.pow(Math.min(v.v / v0, 2), delta);
  if (gap === Infinity) return aMax * v.driver * free;
  const g = Math.max(gap, 0.12);
  const sStar = s0 + Math.max(0, v.v * T + (v.v * dv) / (2 * Math.sqrt(aMax * bComf)));
  const interaction = Math.pow(sStar / g, 2);
  return Math.max(-bMax, aMax * v.driver * (free - interaction));
}

// ---------------------------------------------------------------------------
//  Turn + lane selection when a vehicle enters a new link.
// ---------------------------------------------------------------------------
export function chooseMovement(v, node) {
  if (!node || node.type !== 'signal') return null;
  const opts = node.movements[v.lane.link.heading];
  if (!opts) return null;
  const split = CFG.demand.turnSplit;
  const entries = [];
  for (const turn of ['through', 'right', 'left']) {
    if (!opts[turn]) continue;
    let w = split[turn];
    // buses and trucks prefer to stay on the arterial
    if (turn === 'through' && (v.cls === 'bus' || v.cls === 'truck')) w *= 1.8;
    entries.push([turn, w]);
  }
  if (!entries.length) return null;
  let total = 0;
  for (const e of entries) total += e[1];
  let r = nextRoll(v) * total;
  let pick = entries[entries.length - 1][0];
  for (const e of entries) { r -= e[1]; if (r <= 0) { pick = e[0]; break; } }
  return opts[pick];
}

export function preferredLaneIndex(turn, link, v) {
  const last = link.lanes.length - 1;
  if (turn === 'left') return 0;                       // dedicated turn pocket
  if (turn === 'right') return last;                   // kerbside lane
  // through traffic balances itself across the non-pocket lanes
  let best = 1, bestScore = Infinity;
  for (let k = 1; k <= last; k++) {
    const occ = link.lanes[k].vehicles.length + (k === last ? 0.8 : 0);
    if (occ < bestScore) { bestScore = occ; best = k; }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Discretionary lane change (MOBIL-style safety test).  A driver only moves
//  over if the gap ahead is comfortable AND the driver they cut in front of is
//  not forced to brake hard.
// ---------------------------------------------------------------------------
export function tryLaneChange(v, target) {
  if (!target || v.latOffset) return false;
  const q = target.vehicles;
  let i = 0;
  while (i < q.length && q[i].s > v.s) i++;       // lanes are sorted front-first
  const ahead = q[i - 1];
  const behind = q[i];

  const gapAhead = ahead ? (ahead.s - ahead.len / 2) - (v.s + v.len / 2) : Infinity;
  if (gapAhead < s0 + 0.75 * v.v) return false;
  const gapBehind = behind ? (v.s - v.len / 2) - (behind.s + behind.len / 2) : Infinity;
  if (gapBehind < s0 + 0.65 * (behind ? behind.v : 0)) return false;

  const from = v.lane;
  const k = from.vehicles.indexOf(v);
  if (k >= 0) from.vehicles.splice(k, 1);
  if (from.exiting === v) from.exiting = null;
  q.splice(i, 0, v);
  v.latOffset = from.offset - target.offset;
  v.lane = target;
  return true;
}

// ---------------------------------------------------------------------------
//  Gap helpers
// ---------------------------------------------------------------------------
function gapOnLane(v, leader) {
  return (leader.s - leader.len / 2) - (v.s + v.len / 2);
}

// Leader for the vehicle at the head of a lane: the car that has just pulled
// into the junction ahead of it still counts.
function headOfLaneLeader(v) {
  const ex = v.lane.exiting;
  if (!ex || ex.state === 'done' || ex === v) return null;
  let leadDist;
  if (ex.state === 'junction') leadDist = v.lane.length + ex.junctionDist;
  else if (ex.lane) leadDist = v.lane.length + (ex.path ? ex.path.length : 8) + ex.s;
  else return null;
  return { gap: leadDist - ex.len / 2 - (v.s + v.len / 2), dv: v.v - ex.v };
}

export function laneFollowing(v) {
  const idx = v.lane.vehicles.indexOf(v);
  if (idx > 0) {
    const leader = v.lane.vehicles[idx - 1];
    return { gap: gapOnLane(v, leader), dv: v.v - leader.v };
  }
  return headOfLaneLeader(v);
}

// ---------------------------------------------------------------------------
//  Can this vehicle cross the stop line right now?
// ---------------------------------------------------------------------------
export function stopLineDecision(v, node, signalState) {
  const distToLine = v.lane.length - (v.s + v.len / 2);

  if (signalState === 'green') return 'go';
  if (signalState === 'yellow') {
    // dilemma zone: if stopping would need harsher than comfortable braking,
    // the driver commits and clears the junction instead.
    const stopDist = (v.v * v.v) / (2 * CFG.yellowDecelThreshold);
    return stopDist > distToLine && v.v > 3 ? 'go' : 'stop';
  }
  return 'stop';
}

export function targetLaneHasRoom(v, targetLane) {
  const q = targetLane.vehicles;
  if (!q.length) return true;
  const last = q[q.length - 1];
  return last.s - last.len / 2 > v.len + s0 * 0.8;
}

// ---------------------------------------------------------------------------
//  Enter / leave the junction
// ---------------------------------------------------------------------------
export function enterJunction(v, movement, targetLane) {
  const lane = v.lane;
  const i = lane.vehicles.indexOf(v);
  if (i >= 0) lane.vehicles.splice(i, 1);

  v.junctionLeader = lane.exiting && lane.exiting.state !== 'done' ? lane.exiting : null;
  lane.exiting = v;
  v.fromLane = lane;
  v.movement = movement;
  v.targetLane = targetLane;
  // turning paths are geometry-only, so cache one per (entry lane, exit lane)
  const key = `${lane.index}-${targetLane.index}`;
  if (!movement.paths) movement.paths = new Map();
  if (!movement.paths.has(key)) movement.paths.set(key, buildTurnPath(movement, lane, targetLane));
  v.path = movement.paths.get(key);
  v.state = 'junction';
  v.u = 0;
  v.junctionDist = 0;
  v.lane = null;
}

export function junctionGap(v) {
  const jl = v.junctionLeader;
  const remaining = v.path.length - v.junctionDist;
  if (jl && jl.state === 'junction') {
    return { gap: (jl.junctionDist - jl.len / 2) - (v.junctionDist + v.len / 2), dv: v.v - jl.v };
  }
  if (jl && jl.state === 'link' && jl.lane === v.targetLane) {
    return { gap: remaining + (jl.s - jl.len / 2) - v.len / 2, dv: v.v - jl.v };
  }
  const q = v.targetLane.vehicles;
  if (q.length) {
    const last = q[q.length - 1];
    return { gap: remaining + (last.s - last.len / 2) - v.len / 2, dv: v.v - last.v };
  }
  return null;
}

export function exitJunction(v) {
  const lane = v.targetLane;
  if (v.fromLane && v.fromLane.exiting === v) v.fromLane.exiting = null;
  v.lane = lane;
  v.s = 0.1;
  v.state = 'link';
  v.path = null;
  v.junctionLeader = null;
  lane.vehicles.push(v);
  v.junctions++;
  v.node = lane.link.to;
  return lane;
}

// ---------------------------------------------------------------------------
//  Pose update for the renderer
// ---------------------------------------------------------------------------
const tmp = { x: 0, z: 0 };
export function updatePose(v, dt = 0) {
  if (v.state === 'link') {
    lanePoint(v.lane, v.s, tmp);
    const r = v.lane.link.r;
    if (v.latOffset) {
      const prev = v.latOffset;
      const ease = dt > 0 ? Math.min(1, dt / CFG.laneChange.easeTime) : 1;
      v.latOffset += (0 - v.latOffset) * ease;
      if (Math.abs(v.latOffset) < 0.02) v.latOffset = 0;
      // yaw into the manoeuvre so the slide reads as a real lane change
      v.yawBias = Math.atan2((prev - v.latOffset) / Math.max(dt, 0.001), Math.max(v.v, 4));
      v.indicator = prev > 0 ? 1 : -1;
      tmp.x += r.x * v.latOffset;
      tmp.z += r.z * v.latOffset;
    } else {
      v.yawBias *= 0.82;
      v.indicator = 0;
    }
    v.x = tmp.x; v.z = tmp.z;
    const f = v.lane.link.f;
    v.heading = Math.atan2(f.x, f.z) + v.yawBias;
  } else if (v.state === 'junction') {
    bezierAt(v.path, v.u, tmp);
    v.x = tmp.x; v.z = tmp.z;
    const t = bezierTangent(v.path, v.u);
    v.heading = Math.atan2(t.x, t.z);
  }
}

export { s0 as MIN_GAP };
