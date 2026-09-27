import { CFG, PHASES } from '../core/config.js';

// ============================================================================
//  Fixed-time baseline controller — the control strategy running at the vast
//  majority of signalised junctions today. Pre-set splits, no detection, no
//  awareness of its neighbours. This is the thing the AI is measured against,
//  and it is deliberately given a sensible, well-tuned plan rather than a
//  strawman: the splits below are proportional to the design flows.
// ============================================================================

export class FixedTimeController {
  constructor(node, coordinator = null) {
    this.node = node;
    this.coord = coordinator;
    this.kind = 'fixed';
    this.phase = 0;
    this.stage = 'green';
    this.timer = 0;
    this.splits = CFG.fixedTime.splits;
    this.plannedGreen = this.splits[0];
    this.greenTotal = 0;
    this.greenWasted = 0;
    this.greenSaved = 0;
    this.greenRecent = PHASES.map(() => 0);
    this.cycleCount = 0;
    this.dischargeCount = 0;
    this.lastDischargeT = -99;
    this.pressures = PHASES.map(() => 0);
    this.coordBonus = PHASES.map(() => 0);
    this.reason = 'fixed plan';
    this.events = [];
    // a small offset per junction so the corridor is not pathologically bad
    this.timer = (node.gi * 9 + node.gj * 5) % 20;
  }

  stateFor(heading, turn) {
    const ph = PHASES[this.phase];
    const serves = ph.heads.includes(heading) && ph.turns.includes(turn);
    if (!serves) return 'red';
    if (this.stage === 'green') return 'green';
    if (this.stage === 'yellow') return 'yellow';
    return 'red';
  }

  registerDischarge(mv, t) { this.dischargeCount++; this.lastDischargeT = t; }
  decide() { /* deliberately blind */ }

  tick(dt, t) {
    this.timer += dt;
    // Share of green per approach over roughly the last minute. Lifetime totals
    // would be dominated by the warm-up and would barely move when demand
    // changes, which is exactly the moment worth showing: this decays, so it
    // answers "what is this junction doing NOW".
    const decay = Math.exp(-dt / 45);
    for (let i = 0; i < this.greenRecent.length; i++) this.greenRecent[i] *= decay;
    if (this.stage === 'green') {
      this.greenTotal += dt;
      this.greenRecent[this.phase] += dt;
      let queue = 0;
      const ph = PHASES[this.phase];
      for (const h of ph.heads) {
        const link = this.node.in[h];
        if (!link) continue;
        for (const lane of link.lanes) {
          for (const v of lane.vehicles) if (v.v < 0.55 && lane.length - v.s < 95) queue++;
        }
      }
      const productive = queue > 0 || (t - this.lastDischargeT) < 2.2;
      if (!productive) this.greenWasted += dt;

      if (this.timer >= this.splits[this.phase]) {
        this.stage = 'yellow'; this.timer = 0;
        const next = (this.phase + 1) % PHASES.length;
        if (this.coord) this.coord.onGreenScheduled(this.node, next, t + CFG.signal.yellow + CFG.signal.allRed);
      }
    } else if (this.stage === 'yellow') {
      if (this.timer >= CFG.signal.yellow) { this.stage = 'allred'; this.timer = 0; }
    } else {
      if (this.timer >= CFG.signal.allRed) {
        this.phase = (this.phase + 1) % PHASES.length;
        this.stage = 'green';
        this.timer = 0;
        this.cycleCount++;
        this.plannedGreen = this.splits[this.phase];
      }
    }
  }

  get countdown() {
    if (this.stage === 'green') return Math.max(0, this.splits[this.phase] - this.timer);
    if (this.stage === 'yellow') return Math.max(0, CFG.signal.yellow - this.timer);
    return Math.max(0, CFG.signal.allRed - this.timer);
  }

  get utilisation() {
    return this.greenTotal > 0 ? 1 - this.greenWasted / this.greenTotal : 1;
  }
}
