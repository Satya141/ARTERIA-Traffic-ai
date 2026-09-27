import { CFG, PHASES } from '../core/config.js';
import { LayaClient } from './laya.js';

// ============================================================================
//  Density-adaptive signal controller.
//
//  Per junction this runs three ideas that real adaptive systems (SCATS, SCOOT,
//  and the max-pressure literature) each contribute a piece of:
//
//   1. MAX-PRESSURE phase selection — serve the phase whose upstream demand
//      most exceeds the space available downstream, so we never flush cars
//      into a link that is already full.
//   2. ACTUATED green length — the green is SIZED from the measured queue
//      (startup loss + saturation headway per lane) and then terminated early
//      the moment the queue clears and no vehicle is within `gapOut` seconds.
//      That early termination is where the wasted green goes away.
//   3. FAIRNESS + PREEMPTION — a starvation cap stops a quiet approach being
//      ignored forever, and a detected emergency vehicle preempts everything.
//
//  V2I corridor coordination is layered on top via the Coordinator.
// ============================================================================

const GREEN = 'green', YELLOW = 'yellow', RED = 'red';

// Once the served queue has emptied there is nothing left to protect, so the
// changeover cost no longer applies and a small edge is enough to switch.
const gapOutCandidate = d => d.queue < 1 && d.nearest > CFG.signal.gapOut;

// plain-language names used in everything the controller says out loud
const SIDE = { N: 'north', E: 'east', S: 'south', W: 'west' };

export class AdaptiveController {
  constructor(node, vision, coordinator, useCoord = true) {
    this.node = node;
    this.vision = vision;
    this.coord = coordinator;
    this.useCoord = useCoord;
    this.kind = 'adaptive';

    this.phase = 0;
    this.stage = GREEN;
    this.timer = 0;
    this.plannedGreen = CFG.signal.minGreen;
    this.nextPhase = null;
    this.lastServed = PHASES.map(() => 0);
    this.pressures = PHASES.map(() => 0);
    this.coordBonus = PHASES.map(() => 0);

    this.cycleCount = 0;
    this.greenTotal = 0;
    this.greenWasted = 0;
    this.greenSaved = 0;
    this.greenRecent = PHASES.map(() => 0);
    this.queueRecent = PHASES.map(() => 0);
    this.dischargeCount = 0;
    this.lastDischargeT = -99;
    this.preempting = false;
    this.holdingForPlatoon = false;
    this.reason = 'starting up';
    this.events = [];
    this.decisionCount = 0;
    this.laya = null;            // set by the Simulation when a client exists
    this.decidedBy = 'heuristic';
  }

  // ---- signal face seen by a vehicle ---------------------------------------
  stateFor(heading, turn) {
    const ph = PHASES[this.phase];
    const serves = ph.heads.includes(heading) && ph.turns.includes(turn);
    if (!serves) return RED;
    if (this.stage === GREEN) return GREEN;
    if (this.stage === YELLOW) return YELLOW;
    return RED;
  }

  phaseServes(pid, heading, turn) {
    const ph = PHASES[pid];
    return ph.heads.includes(heading) && ph.turns.includes(turn);
  }

  registerDischarge(mv, t) {
    this.dischargeCount++;
    this.lastDischargeT = t;
  }

  emit(kind, text, level = 'info') {
    this.events.push({ kind, text, level, node: this.node.id, t: performance.now() });
    if (this.events.length > 24) this.events.shift();
  }

  // ---- demand aggregation ---------------------------------------------------
  //  A phase serves one whole approach, so its demand is everything the camera
  //  on that approach can see — both the turn pocket and the through lanes.
  phaseDemand(pid) {
    const ph = PHASES[pid];
    let demand = 0, queue = 0, arrivals = 0, maxWait = 0, emergency = false, nearest = 99;
    for (const h of ph.heads) {
      const cam = this.node.cams[h];
      if (!cam) continue;
      for (const g of [cam.groups.left, cam.groups.thru]) {
        demand += g.demand;
        queue += g.queue;
        arrivals += g.arrivals;
        if (g.maxWait > maxWait) maxWait = g.maxWait;
        if (g.nearest < nearest) nearest = g.nearest;
        if (g.emergency) emergency = true;
      }
    }
    return { demand, queue, arrivals, maxWait, emergency, nearest };
  }

  // Max-pressure term: how much room is left on the receiving links.
  downstreamPenalty(pid) {
    const ph = PHASES[pid];
    let pen = 0;
    for (const h of ph.heads) {
      for (const turn of ph.turns) {
        const mv = this.node.movements[h] && this.node.movements[h][turn];
        if (!mv) continue;
        const out = mv.outLink;
        let occ = 0;
        for (const lane of out.lanes) occ += lane.vehicles.length;
        pen += Math.max(0, occ / Math.max(out.capacity, 1) - 0.55);
      }
    }
    return pen * 10;
  }

  score(pid, t) {
    const d = this.phaseDemand(pid);
    const bonus = this.useCoord ? this.coord.bonusFor(this.node, pid, t) : 0;
    this.coordBonus[pid] = bonus;

    // Phase skipping: an approach with nobody on it never gets a green. This
    // alone removes most of the dead time a fixed plan burns on empty lefts.
    if (d.demand < CFG.control.skipThreshold && !d.emergency && bonus < 1) {
      this.pressures[pid] = -1;
      return { s: -1, d, skipped: true };
    }

    let s = d.demand * CFG.control.wQueue - this.downstreamPenalty(pid) * CFG.control.wDownstream;
    const starve = t - this.lastServed[pid];
    if (starve > CFG.signal.starvationLimit * 0.6) {
      s += (starve - CFG.signal.starvationLimit * 0.6) * 0.9;
    }
    s += bonus;
    if (d.emergency) s += CFG.control.emergencyWeight;
    this.pressures[pid] = s;
    return { s, d, skipped: false };
  }

  // ---- green length sizing --------------------------------------------------
  //  The local queue is only half the story. A camera sees 95 m up the
  //  approach; a platoon released by the upstream junction is still 230 m away
  //  and therefore invisible. Sizing the green on local detection alone ends it
  //  just before that platoon arrives — which is precisely why the first
  //  version of this coordinated worse than it did uncoordinated. The advisory
  //  is what lets the green be planned to last until the platoon has cleared.
  sizeGreen(pid, t) {
    const d = this.phaseDemand(pid);
    const lanes = CFG.lanesPerDir;
    let need = CFG.signal.startupLoss + (d.queue / lanes) * CFG.signal.satHeadway + d.arrivals * 0.45;

    if (this.useCoord) {
      const p = this.coord.incomingPlatoon(this.node, pid, t);
      if (p) {
        const cover = p.eta + CFG.signal.startupLoss + (p.count / lanes) * CFG.signal.satHeadway;
        let competing = 0;
        for (let i = 0; i < PHASES.length; i++) {
          if (i !== pid) competing += this.phaseDemand(i).queue;
        }
        // only stretch the green if the progression is worth what it costs
        const benefit = p.count * CFG.coord.stopPenalty;
        const cost = Math.max(0, cover - need) * competing;
        if (benefit > cost) {
          need = Math.max(need, cover);
          this.waveArmed = true;
        }
      } else this.waveArmed = false;
    }
    return Math.max(CFG.signal.minGreen, Math.min(CFG.signal.maxGreen, need));
  }

  // ---- 10 Hz decision step --------------------------------------------------
  decide(t, dt) {
    this.decisionCount++;
    const scores = PHASES.map((_, i) => this.score(i, t));

    if (this.stage !== GREEN) return;
    const elapsed = this.timer;
    const cur = this.phaseDemand(this.phase);

    // --- emergency preemption ------------------------------------------------
    let emergencyPhase = -1;
    for (let i = 0; i < PHASES.length; i++) if (scores[i].d.emergency) { emergencyPhase = i; break; }
    if (emergencyPhase >= 0 && emergencyPhase !== this.phase && elapsed >= 2.0) {
      this.preempting = true;
      this.reason = 'clearing the way for an ambulance';
      this.emit('preempt',
        `${this.node.name}: ambulance on the ${SIDE[PHASES[emergencyPhase].key]} road. I am switching it to green now`, 'alert');
      this.beginTransition(emergencyPhase, t);
      return;
    }
    if (emergencyPhase === this.phase) {
      this.preempting = true;
      this.reason = 'holding green for an ambulance';
      return;
    }
    this.preempting = false;

    if (elapsed < CFG.signal.minGreen) { this.reason = 'minimum green time'; return; }

    // ---- Laya, if a fresh answer is available -----------------------------
    //  Laya decides WHICH road and WHETHER to hold; the safety timing around it
    //  (minimum green, clearance, the starvation cap) stays in code, because a
    //  decision engine should not be able to skip an all-red.
    let la = this.laya && this.laya.available ? this.laya.answerFor(this.node, t) : null;

    // ---- supervisory check on the engine's answer -------------------------
    //  The model proposes, the detectors dispose. A zero-shot checkpoint that
    //  has never seen a traffic decision can return a confident answer that
    //  contradicts what the cameras plainly show - naming a road with nobody on
    //  it while another is backed up. Rather than trust it blindly, the choice
    //  is checked against the measured demand and rejected if it is indefensible.
    if (la) {
      const target = LayaClient.phaseForRoad(la.next_road?.choice);
      if (target < 0) {
        la = null;
      } else {
        let best = 0;
        for (let i = 0; i < PHASES.length; i++) best = Math.max(best, scores[i].d.demand);
        const picked = scores[target].d.demand;
        // accept anything within a reasonable share of the strongest claim
        if (best > 2 && picked < best * CFG.control.layaMinShare) {
          this.layaRejected = (this.layaRejected || 0) + 1;
          if (this.laya) this.laya.rejected = (this.laya.rejected || 0) + 1;
          la = null;
        } else if (this.laya) {
          this.laya.accepted = (this.laya.accepted || 0) + 1;
        }
      }
    }

    if (la) {
      this.decidedBy = 'laya';
      this.layaAnswer = la;

      if ((la.emergency?.yes ?? 0) > 0.6) {
        for (let i = 0; i < PHASES.length; i++) {
          if (scores[i].d.emergency && i !== this.phase) {
            this.reason = `Laya: emergency priority (p=${la.emergency.yes.toFixed(2)})`;
            this.emit('preempt',
              `${this.node.name}: Laya says an emergency needs priority (p=${la.emergency.yes.toFixed(2)}). Switching now.`, 'alert');
            this.beginTransition(i, t);
            return;
          }
        }
      }

      const wantExtend = (la.extend?.yes ?? 0) > 0.55;
      const target = LayaClient.phaseForRoad(la.next_road?.choice);
      const maxed = elapsed >= CFG.signal.maxGreen;

      if (!maxed && wantExtend && cur.queue > 0) {
        this.plannedGreen = Math.min(CFG.signal.maxGreen, elapsed + 3.5);
        this.reason = `Laya: hold this green (p=${la.extend.yes.toFixed(2)})`;
        return;
      }
      if (target >= 0 && target !== this.phase && elapsed >= this.plannedGreen - 0.5) {
        const p = la.next_road?.probabilities?.[la.next_road.choice];
        this.reason = `Laya: ${la.next_road.choice} road next` +
          (typeof p === 'number' ? ` (p=${p.toFixed(2)})` : '');
        this.emit('green',
          `${this.node.name}: Laya picks the ${la.next_road.choice} road next` +
          (typeof p === 'number' ? ` with probability ${p.toFixed(2)}` : '') + '.');
        this.beginTransition(target, t);
        return;
      }
      if (maxed && target >= 0 && target !== this.phase) {
        this.reason = 'maximum green reached';
        this.beginTransition(target, t);
        return;
      }
      // Laya answered but wants no change yet: fall through to the safety rules
      // below, which still enforce starvation and max green.
    } else {
      this.decidedBy = this.laya && this.laya.available ? 'heuristic (guard)' : 'heuristic';
      this.layaAnswer = null;
    }

    // --- gap-out: the whole point of the exercise ----------------------------
    const queueCleared = cur.queue < 1;
    const gapOut = queueCleared && cur.nearest > CFG.signal.gapOut;

    // --- V2I hold: a platoon from upstream is about to land ------------------
    //  Holding a green is not free. It buys `count` vehicles a clean run
    //  through (worth ~stopPenalty seconds each) and charges every vehicle
    //  waiting on the competing approaches for the extra seconds. Only hold
    //  when the trade is actually positive.
    let hold = false;
    this.holdTrade = null;
    if (this.useCoord && elapsed < CFG.signal.maxGreen - 2) {
      const p = this.coord.incomingPlatoon(this.node, this.phase, t);
      if (p && p.eta <= CFG.coord.holdMax && elapsed < this.plannedGreen + CFG.coord.holdMax) {
        let competing = 0;
        for (let i = 0; i < PHASES.length; i++) if (i !== this.phase) competing += scores[i].d.queue;
        const benefit = p.count * CFG.coord.stopPenalty;
        const cost = p.eta * competing;
        this.holdTrade = { benefit, cost, count: p.count, eta: p.eta, from: p.from };
        if (benefit > cost) {
          hold = true;
          if (!this.holdingForPlatoon) {
            this.emit('coord',
              `${this.node.name}: a group of ${p.count} vehicles from ${p.from} arrives in ${p.eta.toFixed(0)}s, so I am holding the green to let them through without stopping`, 'coord');
            this.coord.say(this.node, p.fromNode,
              `Holding my green ${p.eta.toFixed(0)}s longer so your ${p.count} vehicles get through without stopping.`);
          }
        }
      }
    }
    this.holdingForPlatoon = hold;

    // A challenger has to clear the incumbent by more than the lost time a
    // changeover costs. Without this the junction oscillates.
    const margin = CFG.control.switchMargin + cur.queue * 0.55;
    let best = this.phase, bestScore = scores[this.phase].s;
    for (let i = 0; i < PHASES.length; i++) {
      if (i === this.phase || scores[i].skipped) continue;
      if (scores[i].s > bestScore + (gapOutCandidate(cur) ? 0.5 : margin)) {
        bestScore = scores[i].s; best = i;
      }
    }

    const maxedOut = elapsed >= CFG.signal.maxGreen;
    const plannedOut = elapsed >= this.plannedGreen;

    if (!maxedOut && hold) { this.reason = 'waiting for a group of vehicles from the next signal'; return; }

    // nothing else is asking for service: rest in the current green rather than
    // paying 4.6 s of clearance to show a red to an empty road
    if (best === this.phase && !maxedOut) {
      const anyone = scores.some((sc, i) => i !== this.phase && !sc.skipped);
      if (!anyone) { this.reason = 'no one waiting elsewhere, so this road stays green'; return; }
    }

    if (gapOut && best !== this.phase) {
      const saved = Math.max(0, this.plannedGreen - elapsed);
      this.greenSaved += saved;
      this.reason = 'road cleared early, moving on';
      if (saved >= 1) {
        this.emit('gapout',
          `${this.node.name}: the ${SIDE[PHASES[this.phase].key]} road has emptied, so I am ending its green ${saved.toFixed(0)}s early and handing the time to a road that is still waiting`, 'good');
      }
      this.beginTransition(best, t);
      return;
    }

    if ((plannedOut || maxedOut) && best !== this.phase) {
      this.reason = maxedOut ? 'maximum green reached, others have waited long enough' : 'everyone counted here has been served';
      this.beginTransition(best, t);
      return;
    }

    if (plannedOut && best === this.phase && !maxedOut) {
      // still the strongest phase: extend, but only by what the queue justifies
      const extra = Math.min(4.5, CFG.signal.maxGreen - elapsed);
      if (extra > 0.5 && cur.queue > 0) {
        this.plannedGreen = Math.min(CFG.signal.maxGreen, elapsed + extra);
        this.reason = `${Math.round(cur.queue)} vehicles still waiting, extending`;
        this.emit('extend',
          `${this.node.name}: ${Math.round(cur.queue)} vehicles are still waiting on the ${SIDE[PHASES[this.phase].key]} road, so I am holding its green ${extra.toFixed(0)}s longer`);
      }
    }
  }

  beginTransition(nextPhase, t) {
    this.stage = YELLOW;
    this.timer = 0;
    this.nextPhase = nextPhase;
    // Broadcast the platoon advisory at the START of the changeover rather than
    // when the green actually appears. Those 4.6 s of yellow and all-red are
    // exactly the head start the downstream junction needs to finish its own
    // minimum green and be showing green when the platoon arrives.
    if (this.coord) this.coord.onGreenScheduled(this.node, nextPhase, t + CFG.signal.yellow + CFG.signal.allRed);
  }

  // ---- continuous timing ----------------------------------------------------
  tick(dt, t) {
    this.timer += dt;
    // Share of green per approach over roughly the last minute. Lifetime totals
    // would be dominated by the warm-up and would barely move when demand
    // changes, which is exactly the moment worth showing: this decays, so it
    // answers "what is this junction doing NOW".
    const decay = Math.exp(-dt / 45);
    for (let i = 0; i < this.greenRecent.length; i++) {
      this.greenRecent[i] *= decay;
      // ...against the demand that earned it, smoothed the same way, so the two
      // are directly comparable. This pair is the whole argument: green share
      // should track queue share, and on a fixed timer it cannot.
      this.queueRecent[i] = this.queueRecent[i] * decay + this.phaseDemand(i).queue * dt;
    }
    if (this.stage === GREEN) {
      this.greenTotal += dt;
      this.greenRecent[this.phase] += dt;
      const cur = this.phaseDemand(this.phase);
      const productive = cur.queue > 0 || (t - this.lastDischargeT) < 2.2;
      if (!productive) this.greenWasted += dt;
      this.lastServed[this.phase] = t;
    } else if (this.stage === YELLOW) {
      if (this.timer >= CFG.signal.yellow) { this.stage = 'allred'; this.timer = 0; }
    } else {
      if (this.timer >= CFG.signal.allRed) {
        this.phase = this.nextPhase != null ? this.nextPhase : (this.phase + 1) % PHASES.length;
        this.nextPhase = null;
        this.stage = GREEN;
        this.timer = 0;
        this.cycleCount++;
        this.plannedGreen = this.sizeGreen(this.phase, t);
        const d = this.phaseDemand(this.phase);
        this.emit('green',
          `${this.node.name}: I am giving the ${SIDE[PHASES[this.phase].key]} road ${this.plannedGreen.toFixed(0)}s of green. The cameras count ${Math.round(d.queue)} vehicles waiting`);
      }
    }
  }

  get countdown() {
    if (this.stage === GREEN) return Math.max(0, this.plannedGreen - this.timer);
    if (this.stage === YELLOW) return Math.max(0, CFG.signal.yellow - this.timer);
    return Math.max(0, CFG.signal.allRed - this.timer);
  }

  get utilisation() {
    return this.greenTotal > 0 ? 1 - this.greenWasted / this.greenTotal : 1;
  }
}
