import { PHASES } from '../core/config.js';

// ============================================================================
//  Laya — the decision engine.
//
//  Laya answers typed questions (choice / score / yes-no) about a piece of text
//  in one non-autoregressive forward pass, with calibrated probabilities. Every
//  discrete decision this controller makes is exactly that shape, so instead of
//  scoring phases against hand-tuned weights, the junction state is written out
//  in plain language and Laya is asked:
//
//      which road gets the green next?   -> choice over the four approaches
//      should this green be extended?    -> yes/no with a probability
//      does an emergency need priority?  -> yes/no
//      how badly is traffic building?    -> score, light..heavy
//
//  Two things matter for the simulation to stay usable:
//
//  1. It is ASYNCHRONOUS. The sim runs at 30 Hz; a decision round-trip does not.
//     Requests go out at a junction's decision points, answers are applied when
//     they arrive, and the controller keeps running on its own timing meanwhile.
//
//  2. It is OPTIONAL. If the sidecar is not running, `available` stays false and
//     the controller uses its built-in heuristic. `npm run dev` alone still
//     gives you the whole simulation.
// ============================================================================

const SIDES = ['N', 'E', 'S', 'W'];
const SIDE_WORD = { N: 'north', E: 'east', S: 'south', W: 'west' };
const WORD_SIDE = { north: 'N', east: 'E', south: 'S', west: 'W' };

export class LayaClient {
  constructor(url = 'http://127.0.0.1:8077') {
    this.url = url;
    this.available = false;
    this.status = 'checking';      // checking | live | offline
    this.info = null;
    this.inFlight = false;
    this.lastLatency = 0;
    this.lastRoundAt = -Infinity;
    this.decisions = new Map();    // junction id -> { answers, at }
    this.records = [];             // decision records for the UI feed
    this.errors = 0;
    this.rounds = 0;
    this.minInterval = 1.2;        // seconds of sim time between rounds
    this.nextProbe = 0;            // wall-clock ms; keep looking while offline
  }

  // The sidecar can be started after the page is already open, so keep probing
  // for it rather than deciding once at boot that it will never arrive.
  maybeProbe() {
    if (this.available || this.inFlight) return;
    const now = performance.now();
    if (now < this.nextProbe) return;
    this.nextProbe = now + 8000;
    this.probe();
  }

  async probe() {
    try {
      const r = await fetch(`${this.url}/health`, { method: 'GET' });
      if (!r.ok) throw new Error(String(r.status));
      this.info = await r.json();
      this.available = true;
      this.status = 'live';
    } catch {
      this.available = false;
      this.status = 'offline';
    }
    return this.available;
  }

  // ---- the text Laya reads -------------------------------------------------
  //  Written the way a duty operator would describe the junction, because that
  //  is the kind of text the engine is trained to reason over.
  describe(node, coordinator, t) {
    const ctrl = node.ctrl;
    const ph = PHASES[ctrl.phase];
    const lines = [`Junction ${node.name}, HITEC City. One road at a time may have a green light.`];

    for (const h of SIDES) {
      const cam = node.cams[h];
      if (!cam) continue;
      const serving = ph.heads.includes(h);
      const bits = [`${SIDE_WORD[h]} road: ${cam.queue} vehicles waiting`];
      bits.push(`longest wait ${Math.round(cam.maxWait)} seconds`);
      bits.push(`${cam.arrivals} more approaching`);
      if (serving && ctrl.stage === 'green') {
        bits.push(`it has the green now and has had it for ${Math.round(ctrl.timer)} seconds`);
      } else if (serving) {
        bits.push('it is clearing');
      }
      lines.push(bits.join(', ') + '.');
      if (cam.hasEmergency) {
        lines.push(`An ambulance is waiting on the ${SIDE_WORD[h]} road.`);
      }
    }

    if (coordinator) {
      for (const m of coordinator.messages) {
        if (m.to !== node) continue;
        const eta = Math.round(m.t0 - t);
        if (eta < -2 || eta > 25) continue;
        lines.push(
          `${m.from.name} reports ${m.count} vehicles arriving on the ` +
          `${SIDE_WORD[m.heading]} road in about ${Math.max(0, eta)} seconds.`);
      }
    }
    return lines.join('\n');
  }

  // ---- one batched round for every junction --------------------------------
  request(signals, coordinator, t) {
    this.maybeProbe();
    if (!this.available || this.inFlight) return;
    if (t - this.lastRoundAt < this.minInterval) return;
    this.lastRoundAt = t;
    this.inFlight = true;

    const junctions = signals.map(n => ({ id: n.id, state: this.describe(n, coordinator, t) }));
    const started = performance.now();

    fetch(`${this.url}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ junctions })
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(data => {
        this.lastLatency = data.latency_ms ?? (performance.now() - started);
        this.rounds++;
        for (const n of signals) {
          const d = data.decisions?.[n.id];
          if (!d) continue;
          this.decisions.set(n.id, { d, at: t });
        }
        this.noteRecords(signals, data, t);
        this.status = 'live';
        this.errors = 0;                       // a good round clears the streak
      })
      .catch(() => {
        this.errors++;
        if (this.errors > 3) { this.available = false; this.status = 'offline'; }
      })
      .finally(() => { this.inFlight = false; });
  }

  // Keep a short log of what was actually decided, for the control-room feed.
  noteRecords(signals, data, t) {
    for (const n of signals) {
      const d = data.decisions?.[n.id];
      if (!d) continue;
      const prev = this._last || (this._last = new Map());
      const key = `${n.id}:${d.next_road?.choice}:${(d.extend?.yes ?? 0) > 0.5}`;
      if (prev.get(n.id) === key) continue;       // only log when it changes
      prev.set(n.id, key);

      const p = d.next_road?.probabilities?.[d.next_road?.choice];
      this.records.push({
        t,
        junction: n.name,
        question: 'next_road',
        kind: 'choice',
        answer: d.next_road?.choice,
        prob: typeof p === 'number' ? p : d.next_road?.confidence,
        extra: `extend ${fmtP(d.extend?.yes)} · pressure ${fmtScore(d.pressure)}`,
        model: d.model
      });
    }
    if (this.records.length > 60) this.records.splice(0, this.records.length - 60);
  }

  // ---- what the controller asks for ----------------------------------------
  //  Returns null when there is no fresh answer, and the controller then uses
  //  its own heuristic. `maxAge` keeps a stale decision from being applied to a
  //  junction whose queues have moved on.
  answerFor(node, t, maxAge = 4.0) {
    const entry = this.decisions.get(node.id);
    if (!entry || t - entry.at > maxAge) return null;
    return entry.d;
  }

  static phaseForRoad(word) {
    const h = WORD_SIDE[word];
    if (!h) return -1;
    return PHASES.findIndex(p => p.heads.includes(h));
  }
}

const fmtP = v => (typeof v === 'number' ? v.toFixed(2) : '—');
const fmtScore = p => {
  if (!p || typeof p.score !== 'number') return '—';
  const label = p.legend?.[String(Math.round(p.score))];
  return label ? `${label} (${p.score.toFixed(2)})` : p.score.toFixed(2);
};
