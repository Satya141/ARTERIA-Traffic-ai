import { CFG } from '../core/config.js';
import { buildNetwork } from './network.js';
import {
  createVehicle, chooseMovement, preferredLaneIndex, idmAccel, desiredSpeed,
  laneFollowing, stopLineDecision, targetLaneHasRoom, enterJunction, junctionGap,
  exitJunction, updatePose, tryLaneChange
} from './vehicle.js';
import { AdaptiveController } from '../ai/controller.js';
import { FixedTimeController } from '../ai/fixedtime.js';
import { VisionSystem } from '../ai/vision.js';
import { Coordinator } from '../ai/coordinator.js';
import { Metrics } from '../ai/metrics.js';
import { LayaClient } from '../ai/laya.js';

// ============================================================================
//  Simulation world.  Two of these run at once: the AI-controlled one that is
//  rendered, and a headless fixed-time twin fed the identical demand schedule.
// ============================================================================

export class Simulation {
  constructor({ schedule, mode = 'adaptive', label = 'AI', coordination = true, laya = null }) {
    this.mode = mode;
    this.label = label;
    this.schedule = schedule;
    this.net = buildNetwork();
    this.vehicles = [];
    this.t = 0;
    this.cursor = 0;
    this.backlog = this.net.sources.map(() => []);
    this.lostDemand = 0;
    this.heldDemand = 0;

    this.vision = new VisionSystem(this.net);
    this.coordination = coordination;
    // The coordinator is ALWAYS built, even for the fixed-time twin and for
    // adaptive-without-V2I. In those worlds it only observes: it still tracks
    // platoons and scores whether they met a green, which is what makes the
    // coordination benefit measurable instead of assumed.
    this.coordinator = new Coordinator(this.net);
    this.metrics = new Metrics();
    this.events = [];

    for (const n of this.net.signals) {
      n.ctrl = mode === 'adaptive'
        ? new AdaptiveController(n, this.vision, this.coordinator, coordination)
        : new FixedTimeController(n, this.coordinator);
    }
    this.controllers = this.net.signals.map(n => n.ctrl);

    // The decision engine, when one is attached. Only the adaptive world uses
    // it; the fixed-time twin must stay a fixed-time twin.
    this.laya = mode === 'adaptive' ? laya : null;
    if (this.laya) for (const c of this.controllers) c.laya = this.laya;

    this.visionAccum = 0;
    this.visionPeriod = 1 / CFG.vision.hz;
  }

  // -------------------------------------------------------------------------
  step(dt) {
    this.t += dt;
    this.spawnFromSchedule();

    this.visionAccum += dt;
    if (this.visionAccum >= this.visionPeriod) {
      const vdt = this.visionAccum;
      this.visionAccum = 0;
      this.vision.scan(this.t, vdt);
      if (this.coordinator) this.coordinator.update(this.t, vdt);
      // Ask Laya first; the answer lands a round-trip later and is picked up at
      // a following decision point, so nothing here waits on the network.
      if (this.laya) this.laya.request(this.net.signals, this.coordinator, this.t);
      for (const c of this.controllers) c.decide(this.t, vdt);
      this.drainEvents();
    }
    for (const c of this.controllers) c.tick(dt, this.t);

    this.integrate(dt);
    this.metrics.sample(this, dt);
  }

  // -------------------------------------------------------------------------
  //  Demand injection.  Arrivals that cannot fit are held in a per-entry
  //  backlog rather than discarded, so a congested world is penalised by the
  //  queue it creates instead of quietly losing its traffic.
  // -------------------------------------------------------------------------
  spawnFromSchedule() {
    const items = this.schedule.items;
    while (this.cursor < items.length && items[this.cursor].t <= this.t) {
      this.backlog[items[this.cursor].src].push(items[this.cursor]);
      this.cursor++;
    }
    for (let si = 0; si < this.backlog.length; si++) {
      const q = this.backlog[si];
      while (q.length) {
        if (!this.trySpawn(this.net.sources[si], q[0])) break;
        q.shift();
      }
      if (q.length > 250) { this.lostDemand += q.length - 250; q.splice(0, q.length - 250); }
    }
    this.heldDemand = 0;
    for (const q of this.backlog) this.heldDemand += q.length;
  }

  trySpawn(link, item) {
    const probe = createVehicle(null, item.cls, link.lanes[0], item.rolls);
    const mv = chooseMovement(probe, link.to);
    const idx = mv ? preferredLaneIndex(mv.turn, link, probe) : 0;
    const lane = link.lanes[idx];
    const q = lane.vehicles;
    if (q.length) {
      const last = q[q.length - 1];
      if (last.s - last.len / 2 < probe.len + 6) return false;
    }
    probe.lane = lane;
    probe.plannedMovement = mv;
    // A vehicle that could not be admitted was queued back beyond the model
    // boundary. That delay is real, so it is carried in with the vehicle —
    // otherwise a world that gridlocks would look good by simply turning
    // traffic away at the edge.
    probe.spawnT = item.t;
    const held = this.t - item.t;
    if (held > 0.5) { probe.waitT = held; probe.stops = 1; }
    probe.v = Math.min(desiredSpeed(probe) * 0.72, 12);
    probe.s = 0;
    q.push(probe);
    this.vehicles.push(probe);
    updatePose(probe);
    return true;
  }

  // -------------------------------------------------------------------------
  integrate(dt) {
    const veh = this.vehicles;
    const done = [];

    for (let i = 0; i < veh.length; i++) {
      const v = veh[i];
      let a;

      if (v.state === 'link') {
        const v0 = desiredSpeed(v);
        const follow = laneFollowing(v);
        a = follow ? idmAccel(v, v0, follow.gap, follow.dv) : idmAccel(v, v0, Infinity, 0);

        // stop line constraint
        const link = v.lane.link;
        if (link.entersSignal) {
          if (!v.plannedMovement) v.plannedMovement = chooseMovement(v, link.to);
          const mv = v.plannedMovement;
          const sig = mv ? link.to.ctrl.stateFor(mv.hIn, mv.turn) : 'red';
          const decision = mv ? stopLineDecision(v, link.to, sig) : 'stop';
          v.signalAhead = sig;

          // sort into the correct turn pocket while there is still room to
          const dl = v.lane.length - v.s;
          if (mv && !v.latOffset && dl > CFG.laneChange.minDist && dl < CFG.laneChange.maxDist) {
            const want = preferredLaneIndex(mv.turn, link, v);
            if (want !== v.lane.index) {
              const step = want > v.lane.index ? 1 : -1;
              tryLaneChange(v, link.lanes[v.lane.index + step]);
            }
          }

          let mustStop = decision === 'stop';
          if (!mustStop && mv) {
            const tl = this.pickExitLane(v, mv);
            if (!targetLaneHasRoom(v, tl)) mustStop = true;      // spill-back guard
            else v.pendingExitLane = tl;
          }
          if (mustStop) {
            const gap = v.lane.length - (v.s + v.len / 2);
            a = Math.min(a, idmAccel(v, v0, gap, v.v));
          }
        }
      } else {
        const v0 = CFG.turnSpeed[v.movement.turn] * v.driver;
        const g = junctionGap(v);
        a = g ? idmAccel(v, v0, g.gap, g.dv) : idmAccel(v, v0, Infinity, 0);
      }

      v.a = a;
      const prevV = v.v;
      v.v = Math.max(0, v.v + a * dt);
      v.braking = a < -0.9 ? Math.min(1, -a / 3) : 0;
      const ds = Math.max(0, (prevV + v.v) * 0.5 * dt);
      v.dist += ds;

      if (v.v < 0.35) {
        v.waitT += dt;
        v.idleT += dt;
        if (!v.wasStopped) { v.stops++; v.wasStopped = true; }
      } else if (v.v > 1.6) {
        v.wasStopped = false;
      }

      if (v.state === 'link') {
        v.s += ds;
        const link = v.lane.link;
        if (v.s >= v.lane.length) {
          if (!link.entersSignal) { v.state = 'done'; done.push(v); continue; }
          const mv = v.plannedMovement;
          const tl = v.pendingExitLane || this.pickExitLane(v, mv);
          if (mv && targetLaneHasRoom(v, tl)) {
            enterJunction(v, mv, tl);
            link.to.ctrl.registerDischarge(mv, this.t);
          } else {
            v.s = v.lane.length;                   // hold at the line
            v.v = Math.min(v.v, 0.4);
          }
        }
      } else {
        v.junctionDist += ds;
        v.u = Math.min(1, v.junctionDist / v.path.length);
        if (v.u >= 1) {
          const lane = exitJunction(v);
          v.plannedMovement = lane.link.entersSignal ? chooseMovement(v, lane.link.to) : null;
          v.pendingExitLane = null;
        }
      }
      updatePose(v, dt);
    }

    if (done.length) {
      for (const v of done) {
        const li = v.lane.vehicles.indexOf(v);
        if (li >= 0) v.lane.vehicles.splice(li, 1);
        if (v.lane.exiting === v) v.lane.exiting = null;
        this.metrics.complete(v, this.t);
      }
      this.vehicles = this.vehicles.filter(v => v.state !== 'done');
    }
  }

  // Vehicles leave a junction in the lane the manoeuvre naturally feeds, then
  // sort themselves towards the pocket they need via lane changes on the link.
  pickExitLane(v, mv) {
    const out = mv.outLink;
    const last = out.lanes.length - 1;
    if (mv.turn === 'right') return out.lanes[last];
    if (mv.turn === 'left') return out.lanes[Math.min(1, last)];
    const same = Math.min(Math.max(v.lane.index, 1), last);
    return out.lanes[same];
  }

  // Controllers narrate their own reasoning; the UI reads this feed.
  drainEvents() {
    for (const c of this.controllers) {
      if (!c.events.length) continue;
      for (const e of c.events) { e.simT = this.t; this.events.push(e); }
      c.events.length = 0;
    }
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80);
  }

  // -------------------------------------------------------------------------
  totalQueue() {
    let q = 0;
    for (const v of this.vehicles) if (v.v < 0.6) q++;
    return q;
  }
}
