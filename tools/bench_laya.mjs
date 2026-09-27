// ============================================================================
//  Does Laya actually control traffic better than the heuristic?
//
//      node tools/bench_laya.mjs [profile] [minutes]
//
//  Held-out decision accuracy says whether the model agrees with the oracle on
//  single decisions. It does not say whether a network run by those decisions
//  moves more traffic — errors can be harmless or they can compound. This runs
//  three worlds on one shared demand schedule and measures the thing that
//  matters:
//
//      fixed-time   the conventional plan
//      heuristic    the hand-tuned adaptive controller
//      Laya         the same controller, decisions taken by the model
//
//  The sidecar must be running. Decisions are awaited rather than fired and
//  forgotten, because a headless loop runs far faster than real time and would
//  otherwise always be applying stale answers.
// ============================================================================

import { CFG } from '../src/core/config.js';
import { buildNetwork } from '../src/sim/network.js';
import { Simulation } from '../src/sim/simulation.js';
import { DemandSchedule } from '../src/sim/demand.js';
import { LayaClient } from '../src/ai/laya.js';

const URL = process.env.ARTERIA_LAYA_URL || 'http://127.0.0.1:8077';
const profile = process.argv[2] || 'normal';
const minutes = Number(process.argv[3] || 8);
const DECIDE_EVERY = 1.2;        // sim seconds between decision rounds

async function health() {
  try {
    const r = await fetch(`${URL}/health`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function decideRound(client, sim) {
  const junctions = sim.net.signals.map(n => ({
    id: n.id, state: client.describe(n, sim.coordinator, sim.t)
  }));
  const r = await fetch(`${URL}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ junctions })
  });
  if (!r.ok) throw new Error(`sidecar ${r.status}`);
  const data = await r.json();
  for (const n of sim.net.signals) {
    const d = data.decisions?.[n.id];
    if (d) client.decisions.set(n.id, { d, at: sim.t });
  }
  return data.latency_ms;
}

async function main() {
  const info = await health();
  if (!info) {
    console.error(`No sidecar at ${URL}. Start it first:\n  python server/laya_service.py`);
    process.exit(1);
  }
  console.log(`sidecar: ${info.checkpoint || 'laya'}  device=${info.device || '?'}`);

  const schedule = new DemandSchedule(buildNetwork(), 777);
  schedule.setProfile(profile);

  const client = new LayaClient(URL);
  client.available = true;          // the benchmark drives it directly

  const fixed = new Simulation({ schedule, mode: 'fixed' });
  const heur = new Simulation({ schedule, mode: 'adaptive' });
  const laya = new Simulation({ schedule, mode: 'adaptive', laya: client });
  // the benchmark issues the rounds itself, so stop the sim firing its own
  laya.laya = null;
  for (const c of laya.controllers) c.laya = client;

  const dt = 1 / 15;
  const steps = Math.round((minutes * 60) / dt);
  let nextDecide = 0;
  let rounds = 0, latency = 0;
  const t0 = Date.now();

  for (let i = 0; i < steps; i++) {
    schedule.ensure(laya.t);
    if (laya.t >= nextDecide) {
      nextDecide = laya.t + DECIDE_EVERY;
      try {
        latency += await decideRound(client, laya);
        rounds++;
      } catch (e) {
        console.error('decision round failed:', e.message);
        break;
      }
    }
    fixed.step(dt);
    heur.step(dt);
    laya.step(dt);
    if (i % 1500 === 0) {
      process.stdout.write(`\r  ${Math.round(laya.t)}s / ${minutes * 60}s   ` +
        `${rounds} rounds   ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
    }
  }
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  const accepted = client.accepted || 0, rejected = client.rejected || 0;
  const pad = (s, n) => String(s).padStart(n);
  console.log(`\n${minutes} min / ${profile.toUpperCase()}   ` +
    `${rounds} decision rounds, ${(latency / Math.max(rounds, 1)).toFixed(0)} ms avg\n`);
  console.log('world'.padEnd(14) + pad('wait', 9) + pad('travel', 9) +
              pad('stops/J', 9) + pad('veh/h', 8) + pad('waste%', 9));
  console.log('-'.repeat(58));
  for (const [name, w] of [['fixed-time', fixed], ['heuristic', heur], ['Laya', laya]]) {
    const m = w.metrics;
    const g = w.controllers.reduce((s, c) => s + c.greenTotal, 0);
    const waste = w.controllers.reduce((s, c) => s + c.greenWasted, 0);
    console.log(name.padEnd(14) +
      pad(m.avgWait.toFixed(1), 9) + pad(m.avgTravel.toFixed(1), 9) +
      pad(m.stopsPerJunction.toFixed(3), 9) +
      pad(m.throughputPerHour.toFixed(0), 8) +
      pad(((waste / g) * 100).toFixed(1), 9));
  }

  const h = heur.metrics.avgWait, l = laya.metrics.avgWait, f = fixed.metrics.avgWait;
  console.log(`\n  Laya vs fixed-time : ${((f - l) / f * 100).toFixed(1)}% less waiting`);
  console.log(`  Laya vs heuristic  : ${((h - l) / h * 100).toFixed(1)}% ` +
              `${l <= h ? 'less' : 'MORE'} waiting`);
  console.log(`  supervisory guard  : ${accepted} accepted, ${rejected} rejected` +
              (accepted + rejected ? ` (${(rejected / (accepted + rejected) * 100).toFixed(0)}% rejected)` : ''));
}

main();
