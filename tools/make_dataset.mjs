// ============================================================================
//  Build a fine-tuning dataset for Laya from the traffic simulator.
//
//      node tools/make_dataset.mjs [rowsPerProfile] [out.jsonl]
//
//  Why this works at all: the simulator knows things the controller does not.
//  The controller only ever sees what the cameras report — a 95 m range, a
//  per-frame miss rate, positional jitter. The simulator knows every vehicle on
//  the approach, exactly how long each has been waiting, and what is still out
//  of shot.
//
//  So each training row pairs:
//      state  — the noisy camera description, byte-identical to what the live
//               client sends, because it is produced by the same code
//      gold   — the decision computed from GROUND TRUTH
//
//  The model is therefore learning to infer the true state of a junction from
//  an imperfect description of it, which is exactly the job.
//
//  Labels are soft probability distributions, which is the format Laya's
//  fine-tuning path expects, so a close call trains as a close call rather than
//  being flattened into a hard label.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { CFG, PHASES } from '../src/core/config.js';
import { buildNetwork } from '../src/sim/network.js';
import { Simulation } from '../src/sim/simulation.js';
import { DemandSchedule, PROFILES } from '../src/sim/demand.js';
import { LayaClient } from '../src/ai/laya.js';

const ROADS = ['north', 'east', 'south', 'west'];
const HEAD_OF = { north: 'N', east: 'E', south: 'S', west: 'W' };
const WORD_OF = { N: 'north', E: 'east', S: 'south', W: 'west' };

// The question set must match server/laya_service.py exactly.
const QUESTIONS = {
  next_road: {
    type: 'choice',
    instructions:
      'One road at a time may have a green light. Given how many vehicles are ' +
      'waiting on each road and how long they have been waiting, which road ' +
      'should be given the green light next?',
    criteria: {
      north: 'the north road should be released next',
      east: 'the east road should be released next',
      south: 'the south road should be released next',
      west: 'the west road should be released next'
    }
  },
  extend: {
    type: 'noul',
    instructions:
      'The road that currently has the green still has vehicles moving through. ' +
      'Should its green be held for a few more seconds rather than switching now?'
  },
  emergency: {
    type: 'noul',
    instructions:
      'Is there an emergency vehicle, such as an ambulance, that must be given ' +
      'a green light immediately ahead of normal traffic?'
  },
  pressure: {
    type: 'score',
    instructions: 'How badly is traffic building up at this junction overall?',
    criteria: ['light', 'building', 'heavy']
  }
};

// ---------------------------------------------------------------------------
//  Ground truth for one approach: every vehicle on it, exact waits, no misses.
// ---------------------------------------------------------------------------
const TRUE_RANGE = 170;           // the cameras see 95 m; the simulator sees more

function truth(node, h) {
  const link = node.in[h];
  const out = { demand: 0, queue: 0, arrivals: 0, maxWait: 0, emergency: false, nearest: 99 };
  if (!link) return out;
  for (const lane of link.lanes) {
    for (const v of lane.vehicles) {
      const dist = lane.length - v.s;
      if (dist > TRUE_RANGE) continue;
      const stopped = v.v < 0.55;
      const w = CFG.classes[v.cls].weight;
      out.demand += w * (1 + Math.min(v.waitT, 120) * 0.03) * (stopped ? 1 : 0.5);
      if (stopped) out.queue++;
      else {
        out.arrivals++;
        out.nearest = Math.min(out.nearest, dist / Math.max(v.v, 1.5));
      }
      out.maxWait = Math.max(out.maxWait, v.waitT);
      if (v.emergency) out.emergency = true;
    }
  }
  return out;
}

function softmax(vals, temp) {
  const m = Math.max(...vals);
  const e = vals.map(v => Math.exp((v - m) / temp));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map(v => v / s);
}

// ---------------------------------------------------------------------------
//  The oracle: what the junction should do, given everything.
// ---------------------------------------------------------------------------
function goldFor(node, t) {
  const ctrl = node.ctrl;
  const cur = PHASES[ctrl.phase];
  const tr = {};
  for (const r of ROADS) tr[r] = truth(node, HEAD_OF[r]);

  // --- next_road: pressure, with a fairness term so nobody is starved ------
  const scores = ROADS.map(r => {
    const g = tr[r];
    let s = g.demand;
    // a road that has been waiting a long time earns priority
    s += Math.max(0, g.maxWait - 45) * 0.28;
    // an ambulance settles it
    if (g.emergency) s += 60;
    // a road already green and still discharging is cheap to continue
    if (cur.heads.includes(HEAD_OF[r]) && ctrl.stage === 'green' && g.queue > 0) s *= 1.18;
    return s;
  });
  const probs = softmax(scores, Math.max(1.6, Math.max(...scores) * 0.16));
  const nextRoad = {};
  ROADS.forEach((r, i) => { nextRoad[r] = round4(probs[i]); });

  // --- extend: is the green still productive? ------------------------------
  const servedRoad = WORD_OF[cur.heads[0]];
  const g = tr[servedRoad] || { queue: 0, nearest: 99 };
  const stillWorking = ctrl.stage === 'green' &&
    (g.queue > 0 || g.nearest < CFG.signal.gapOut);
  const bestOther = Math.max(...ROADS.filter(r => r !== servedRoad).map(r => tr[r].demand));
  const own = tr[servedRoad] ? tr[servedRoad].demand : 0;
  let pExtend = stillWorking ? 0.5 + 0.45 * clamp01(own / Math.max(bestOther, 1) - 0.2) : 0.06;
  if (ctrl.stage === 'green' && ctrl.timer > CFG.signal.maxGreen * 0.85) pExtend *= 0.3;
  pExtend = clamp01(pExtend);

  // --- emergency -----------------------------------------------------------
  const anyEmergency = ROADS.some(r => tr[r].emergency);
  const servedEmergency = tr[servedRoad] && tr[servedRoad].emergency && ctrl.stage === 'green';
  const pEmerg = anyEmergency ? (servedEmergency ? 0.35 : 0.95) : 0.03;

  // --- pressure: light / building / heavy ----------------------------------
  const totalQueue = ROADS.reduce((a, r) => a + tr[r].queue, 0);
  const worstWait = Math.max(...ROADS.map(r => tr[r].maxWait));
  const level = clamp01(totalQueue / 34) * 0.6 + clamp01(worstWait / 110) * 0.4;
  const lv = softmax([1 - level, 1 - Math.abs(level - 0.5) * 2, level].map(v => v * 3), 1.0);

  return {
    gold: {
      next_road: { probabilities: nextRoad },
      extend: { probabilities: { true: round4(pExtend), false: round4(1 - pExtend) } },
      emergency: { probabilities: { true: round4(pEmerg), false: round4(1 - pEmerg) } },
      pressure: { probabilities: { 0: round4(lv[0]), 1: round4(lv[1]), 2: round4(lv[2]) } }
    },
    best: ROADS[argmax(probs)]
  };
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const round4 = v => Math.round(v * 10000) / 10000;
const argmax = a => a.indexOf(Math.max(...a));

// ---------------------------------------------------------------------------
async function main() {
  const perProfile = Number(process.argv[2] || 6000);
  const outPath = process.argv[3] || 'data/traffic_decisions.jsonl';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const describer = new LayaClient();      // used only for describe(); never connects
  const rows = [];
  const byRoad = { north: 0, east: 0, south: 0, west: 0 };   // overall, for reporting

  const profiles = Object.keys(PROFILES);
  let seed = 4242;

  for (const prof of profiles) {
    const schedule = new DemandSchedule(buildNetwork(), seed++);
    schedule.setProfile(prof);
    const sim = new Simulation({ schedule, mode: 'adaptive', label: 'gen' });

    const dt = 1 / 15;
    // Quotas are per profile. Held globally, the first profile fills them and
    // every later one contributes nothing.
    const quota = { north: 0, east: 0, south: 0, west: 0 };
    let collected = 0;
    let nextSample = 25;                   // let the network fill first

    while (collected < perProfile) {
      schedule.ensure(sim.t);
      sim.step(dt);
      if (sim.t < nextSample) continue;
      nextSample = sim.t + 1.1;

      for (const node of sim.net.signals) {
        const { gold, best } = goldFor(node, sim.t);

        // Keep the four answers balanced. Without this the model can score well
        // by always naming the busiest corridor, which is exactly the
        // degenerate behaviour the zero-shot checkpoint showed.
        const target = Math.ceil((perProfile / 4) * 1.15);
        if (quota[best] >= target) continue;
        quota[best]++;
        byRoad[best]++;

        rows.push({
          state: JSON.stringify(describer.describe(node, sim.coordinator, sim.t)),
          questions: JSON.stringify(QUESTIONS),
          gold: JSON.stringify(gold),
          meta: JSON.stringify({ profile: prof, junction: node.name, t: Math.round(sim.t) })
        });
        collected++;
      }
      if (sim.t > 3600) break;             // safety stop
    }
    console.log(`${prof.padEnd(8)} -> ${collected} rows (sim reached ${Math.round(sim.t)}s)`);
  }

  // shuffle deterministically, then split
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const cut = Math.floor(rows.length * 0.9);
  const train = rows.slice(0, cut);
  const test = rows.slice(cut);

  const write = (p, arr) =>
    fs.writeFileSync(p, arr.map(r => JSON.stringify(r)).join('\n') + '\n');
  write(outPath, train);
  const testPath = outPath.replace(/\.jsonl$/, '.test.jsonl');
  write(testPath, test);

  console.log(`\ntotal ${rows.length} rows  ->  ${train.length} train, ${test.length} test`);
  console.log('answer balance:', byRoad);
  console.log('train:', outPath);
  console.log('test :', testPath);
}

main();
