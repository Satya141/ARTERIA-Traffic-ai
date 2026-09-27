import { CFG, PHASES } from '../core/config.js';

// ============================================================================
//  V2I corridor coordination.
//
//  Each junction is an agent. The instant one starts discharging a queue along
//  the arterial it broadcasts a PLATOON ADVISORY to the neighbour that queue is
//  heading towards:
//
//      { count, direction, ETA window }
//
//  The receiving junction folds that advisory into its phase score, so it will
//  bring the matching green forward — or hold one it already has — to meet the
//  platoon at the stop line rather than in front of it. Chain that down three
//  junctions and you get a green wave that forms itself from live demand,
//  instead of from a fixed offset plan drawn up years ago.
//
//  This is the same idea as SPaT/MAP messaging in a real V2I deployment, minus
//  the radio.
// ============================================================================

let msgId = 1;

const DIR_WORD = { N: 'northbound', S: 'southbound', E: 'eastbound', W: 'westbound' };
// the side of the RECEIVING junction that this traffic will arrive on
const OPP_SIDE = { N: 'south', S: 'north', E: 'west', W: 'east' };

export class Coordinator {
  constructor(net) {
    this.net = net;
    this.messages = [];          // live advisories
    this.wire = [];              // short-lived visual packets for the renderer
    this.handshakes = 0;
    this.waveLocks = [];
    this.savedByCoordination = 0;
    // Did the platoon actually meet a green? This is the objective the whole
    // mechanism exists to serve, so it is measured directly rather than
    // inferred from network averages.
    this.evaluated = 0;
    this.hits = 0;
    this.hitWindow = [];

    // Human-readable transcript of what the junctions tell each other. This is
    // the same information the controller acts on, written out in words.
    this.chat = [];
  }

  say(from, to, text, kind = 'reply') {
    if (!from || !to) return;
    this.chat.push({
      fromId: from.name || from.id, toId: to.name || to.id, text, kind,
      id: msgId++, at: this.clock
    });
    if (this.chat.length > 60) this.chat.shift();
  }

  get hitRate() { return this.evaluated ? this.hits / this.evaluated : 0; }

  get recentHitRate() {
    if (!this.hitWindow.length) return 0;
    let h = 0;
    for (const v of this.hitWindow) h += v;
    return h / this.hitWindow.length;
  }

  evaluateArrivals(t) {
    for (const m of this.messages) {
      if (m.checked || t < m.t0) continue;
      m.checked = true;
      const ctrl = m.to.ctrl;
      const hit = ctrl.stateFor(m.heading, 'through') === 'green';
      this.evaluated++;
      if (hit) this.hits++;
      this.hitWindow.push(hit ? 1 : 0);
      if (this.hitWindow.length > 60) this.hitWindow.shift();
    }
  }

  //  Called the moment a junction COMMITS to a through phase — at the start of
  //  its changeover, not when the green actually shows.
  onGreenScheduled(node, pid, greenAtT) {
    const ph = PHASES[pid];
    if (!ph.turns.includes('through')) return;

    for (const h of ph.heads) {
      const down = node.downstream[h];
      if (!down) continue;
      const out = node.out[h];
      const cam = node.cams[h];
      if (!cam) continue;

      // The platoon is what is standing on the through lanes now, plus what
      // will have joined the back of it by the time the green appears.
      const g = cam.groups.thru;
      const raw = g.queue + g.arrivals * 0.7;
      const count = Math.round(raw * (1 - CFG.demand.turnSplit.right * 0.55));
      if (count < CFG.coord.minPlatoon) continue;

      const cruise = CFG.speedLimit * 0.82;
      const travel = out.length / cruise;
      const discharge = (count / CFG.lanesPerDir) * CFG.signal.satHeadway;
      const lead = greenAtT + CFG.signal.startupLoss + travel;

      const msg = {
        id: msgId++,
        from: node, to: down, heading: h,
        count,
        t0: lead,
        t1: lead + discharge + 2.5,
        createdAt: greenAtT,
        link: out
      };
      this.messages.push(msg);
      this.wire.push({ ...msg, life: 0, duration: 1.2 });
      this.handshakes++;
      this.clock = greenAtT;
      this.say(node, down,
        `Just released ${count} vehicles ${DIR_WORD[h]} towards you. They reach your ${OPP_SIDE[h]} road in about ${Math.round(travel + CFG.signal.startupLoss)}s — try to be green.`,
        'advisory');
    }
  }

  // --------------------------------------------------------------------------
  //  Coordination is not free and it is not always right.
  //
  //  Holding or stretching an arterial green buys progression for the corridor
  //  and charges it to the cross street. Measured over many runs, that trade is
  //  a clear win when the arterial carries most of the demand, roughly neutral
  //  when the two are balanced, and a straight loss in light traffic where
  //  vehicles arrive too sparsely to form platoons worth protecting.
  //
  //  So each junction arms coordination only when its own detectors say the
  //  corridor dominates. The feature switches itself on where it pays.
  // --------------------------------------------------------------------------
  updateArming() {
    for (const n of this.net.signals) {
      let arterial = 0, cross = 0;
      for (const h of ['E', 'W']) if (n.cams[h]) arterial += n.cams[h].groups.thru.demand;
      for (const h of ['N', 'S']) if (n.cams[h]) cross += n.cams[h].groups.thru.demand;
      const total = arterial + cross;
      const share = total > 0 ? arterial / total : 0;
      n.coordArmed = total >= CFG.coord.demandFloor && share >= CFG.coord.arterialShare;
      n.coordShare = share;
    }
  }

  isArmed(node) { return !!node.coordArmed; }

  update(t, dt) {
    this.clock = t;
    this.updateArming();
    this.evaluateArrivals(t);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].t1 + 4 < t) this.messages.splice(i, 1);
    }
    for (let i = this.wire.length - 1; i >= 0; i--) {
      this.wire[i].life += dt;
      if (this.wire[i].life > this.wire[i].duration) this.wire.splice(i, 1);
    }
    this.computeWaveLocks(t);
  }

  // Does phase `pid` at `node` serve an advisory that is landing soon?
  bonusFor(node, pid, t) {
    const ph = PHASES[pid];
    if (!ph.turns.includes('through')) return 0;
    if (!node.coordArmed) return 0;
    let bonus = 0;
    for (const m of this.messages) {
      if (m.to !== node) continue;
      if (!ph.heads.includes(m.heading)) continue;
      const lead = m.t0 - t;
      if (lead > CFG.coord.horizon || t > m.t1) continue;
      // Full weight from `lead` seconds out — long enough for the downstream
      // junction to finish a minimum green and clear — then decaying once the
      // platoon has passed the stop line.
      const plateau = CFG.signal.minGreen + CFG.signal.yellow + CFG.signal.allRed;
      const closeness = lead > 0
        ? (lead <= plateau ? 1 : Math.max(0, 1 - (lead - plateau) / (CFG.coord.horizon - plateau)))
        : Math.max(0, 1 - (t - m.t0) / Math.max(m.t1 - m.t0, 1));
      // Dimensionally this is a VIRTUAL QUEUE: the platoon is treated as the
      // demand that will be standing at this stop line when it arrives, scored
      // with the same weight as any other approaching vehicle. Earlier versions
      // of this used an arbitrary large bonus and it measurably made the
      // network worse by overriding genuine cross-street demand.
      bonus += CFG.control.wCoord * m.count * closeness;
    }
    return bonus;
  }

  incomingPlatoon(node, pid, t) {
    const ph = PHASES[pid];
    if (!ph.turns.includes('through')) return null;
    if (!node.coordArmed) return null;
    let best = null;
    for (const m of this.messages) {
      if (m.to !== node || !ph.heads.includes(m.heading)) continue;
      const eta = m.t0 - t;
      if (eta < -1 || eta > CFG.coord.horizon) continue;
      if (!best || eta < best.eta) best = { eta: Math.max(0, eta), count: m.count, from: m.from.name || m.from.id, fromNode: m.from };
    }
    return best;
  }

  // A corridor is "locked" when consecutive junctions on it are simultaneously
  // serving the arterial through phase — the visible signature of a green wave.
  computeWaveLocks(t) {
    const locks = [];
    const rows = new Map();
    for (const n of this.net.signals) {
      if (!rows.has(n.gj)) rows.set(n.gj, []);
      rows.get(n.gj).push(n);
    }
    for (const [gj, row] of rows) {
      row.sort((a, b) => a.gi - b.gi);
      let run = [];
      for (const n of row) {
        const k = PHASES[n.ctrl.phase].key;
        const serving = (k === 'E' || k === 'W') && n.ctrl.stage === 'green';
        const armed = n.ctrl.coordBonus && Math.max(n.ctrl.coordBonus[1], n.ctrl.coordBonus[3]) > 4;
        if (serving || armed) run.push(n);
        else { if (run.length >= 2) locks.push(run.slice()); run = []; }
      }
      if (run.length >= 2) locks.push(run);
    }
    this.waveLocks = locks;
  }

  get activeAdvisories() { return this.messages.length; }
}
