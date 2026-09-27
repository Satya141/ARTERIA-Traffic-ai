import { CFG, PHASES } from '../core/config.js';
import { compare } from '../ai/metrics.js';

// ============================================================================
//  All DOM rendering. Kept away from the simulation entirely: the HUD reads
//  state, it never writes any.
//
//  Guiding rule for the wording: someone who has never heard of traffic
//  engineering should be able to read any panel and know what it means. No
//  jargon, no units that need explaining, one idea per panel.
// ============================================================================

const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

export const SIDE_LABEL = { N: 'NORTH', E: 'EAST', S: 'SOUTH', W: 'WEST' };
const SIDES = ['N', 'E', 'S', 'W'];

// which controller events Laya says out loud in the feed
// controller notes worth showing when Laya is not the one deciding
const NOTE_KINDS = new Set(['green', 'gapout', 'coord', 'preempt']);

const COMPARISON_ROWS = [
  { key: 'wait',   label: 'Time stuck at red lights', unit: 's',   get: m => m.avgWait },
  { key: 'travel', label: 'Time to cross the area',   unit: 's',   get: m => m.avgTravel },
  { key: 'queue',  label: 'Vehicles sitting still',   unit: '',    get: m => m.queue, d: 0 },
  { key: 'stops',  label: 'Stops per journey',        unit: '',    get: m => m.avgStops, d: 2 },
  { key: 'co2',    label: 'Exhaust emitted',          unit: ' kg', get: m => m.co2Kg }
];

export class Hud {
  constructor(app) {
    this.app = app;
    this.seenChat = 0;
    this.seenEvents = 0;
    this.seenAlerts = 0;
    this.seenRecs = 0;
    this.buildComparison();
    this.buildJunctions();
    this.buildRoads();
    this.bind();
  }

  bind() {
    const app = this.app;

    $('segProfile').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      [...e.currentTarget.children].forEach(c => c.classList.toggle('on', c === b));
      app.setProfile(b.dataset.p);
    });

    $('btnView').addEventListener('click', () => app.cycleView());
    $('btnCoord').addEventListener('click', e => {
      app.toggleCoordination();
      const on = app.ai.coordination;
      e.currentTarget.classList.toggle('on', on);
      e.currentTarget.textContent = `SIGNALS TALK TO EACH OTHER: ${on ? 'ON' : 'OFF'}`;
    });
    $('btnReel').addEventListener('click', e => {
      const b = e.currentTarget;
      if (app.reel.running) { app.reel.stop(); return; }
      b.classList.add('on');
      b.textContent = 'RECORDING — CLICK TO STOP';
      app.reel.run({ record: true });
    });

    $('chatToggle').addEventListener('click', e => {
      const box = $('chatbox');
      box.classList.toggle('min');
      e.currentTarget.textContent = box.classList.contains('min') ? '+' : '–';
    });
  }

  // ---- side-by-side rows ---------------------------------------------------
  buildComparison() {
    const host = $('cmpRows');
    host.innerHTML = '';
    this.cmpEls = {};
    for (const row of COMPARISON_ROWS) {
      const el = document.createElement('div');
      el.className = 'cmp';
      el.innerHTML = `
        <div class="cmp-top"><span class="cmp-k">${row.label}</span><span class="cmp-d flat">—</span></div>
        <div class="cmp-bars">
          <div class="cmp-bar ai"><i style="width:0%"></i><span>—</span></div>
          <div class="cmp-bar fx"><i style="width:0%"></i><span>—</span></div>
        </div>`;
      host.appendChild(el);
      this.cmpEls[row.key] = {
        delta: el.querySelector('.cmp-d'),
        aBar: el.querySelector('.cmp-bar.ai i'), aVal: el.querySelector('.cmp-bar.ai span'),
        fBar: el.querySelector('.cmp-bar.fx i'), fVal: el.querySelector('.cmp-bar.fx span')
      };
    }
  }

  // ---- junction list -------------------------------------------------------
  buildJunctions() {
    const host = $('junctions');
    host.innerHTML = '';
    this.jxEls = {};
    for (const node of this.app.ai.net.signals) {
      const el = document.createElement('div');
      el.className = 'jx';
      el.innerHTML = `
        <div class="jx-top">
          <span class="jx-id">${node.name}</span>
          <span class="jx-wait"><b>0</b> waiting</span>
        </div>
        <div class="jx-green">
          <span class="chip">—</span><span class="which">—</span><span class="secs">—</span>
        </div>
        <div class="jx-ring"><i></i></div>
        <div class="jx-tag"></div>`;
      el.addEventListener('click', () => this.app.selectJunction(node.id));
      host.appendChild(el);
      this.jxEls[node.id] = {
        root: el,
        wait: el.querySelector('.jx-wait b'),
        chip: el.querySelector('.chip'),
        which: el.querySelector('.which'),
        secs: el.querySelector('.secs'),
        ring: el.querySelector('.jx-ring i'),
        tag: el.querySelector('.jx-tag')
      };
    }
  }

  // ---- the four roads of the selected junction -----------------------------
  buildRoads() {
    const host = $('roads');
    host.innerHTML = '';
    this.roadEls = {};
    for (const h of SIDES) {
      const el = document.createElement('div');
      el.className = 'road';
      el.innerHTML = `
        <div class="road-h">
          <span class="road-name">${SIDE_LABEL[h]}</span>
          <span class="road-state red">RED</span>
          <span class="road-secs">—<small>s</small></span>
        </div>
        <div class="road-cam"><div class="road-slot" data-h="${h}"></div></div>
        <div class="road-f">
          <b class="cnt">0</b> waiting
          <span class="waited">longest wait <b class="lw">0</b>s</span>
        </div>`;
      host.appendChild(el);
      this.roadEls[h] = {
        root: el,
        state: el.querySelector('.road-state'),
        secs: el.querySelector('.road-secs'),
        slot: el.querySelector('.road-slot'),
        cnt: el.querySelector('.cnt'),
        lw: el.querySelector('.lw')
      };
    }
  }

  // ==========================================================================
  update(app) {
    const ai = app.ai, fx = app.baseline;
    const c = compare(ai.metrics, fx.metrics);

    // ---- headline ---------------------------------------------------------
    const pct = c.wait;
    $('heroPct').textContent = (pct >= 0 ? '' : '−') + Math.abs(pct).toFixed(0);
    $('heroAi').textContent = fmt(ai.metrics.avgWait, 0);
    $('heroFx').textContent = fmt(fx.metrics.avgWait, 0);

    // ---- wasted green -----------------------------------------------------
    const wa = wasteOf(ai), wf = wasteOf(fx);
    $('wasteAi').style.width = `${Math.min(100, wa * 200)}%`;
    $('wasteFx').style.width = `${Math.min(100, wf * 200)}%`;
    $('wasteAiTxt').textContent = `${(wa * 100).toFixed(0)}%`;
    $('wasteFxTxt').textContent = `${(wf * 100).toFixed(0)}%`;
    $('reclaimS').textContent = Math.round(ai.controllers.reduce((s, k) => s + k.greenSaved, 0));

    // ---- side by side -----------------------------------------------------
    for (const row of COMPARISON_ROWS) {
      const e = this.cmpEls[row.key];
      const av = row.get(ai.metrics), bv = row.get(fx.metrics);
      const d = bv ? ((bv - av) / bv) * 100 : 0;
      const dec = row.d !== undefined ? row.d : 1;
      const max = Math.max(av, bv, 0.0001);
      e.aBar.style.width = `${(av / max) * 100}%`;
      e.fBar.style.width = `${(bv / max) * 100}%`;
      e.aVal.textContent = `${fmt(av, dec)}${row.unit}`;
      e.fVal.textContent = `${fmt(bv, dec)}${row.unit}`;
      if (Math.abs(d) < 3) {
        e.delta.textContent = 'about the same';
        e.delta.className = 'cmp-d flat';
      } else {
        e.delta.textContent = d >= 0 ? `${d.toFixed(0)}% better` : `${Math.abs(d).toFixed(0)}% worse`;
        e.delta.className = 'cmp-d ' + (d > 0 ? 'up' : 'down');
      }
    }

    this.updateJunctions(app);
    this.updateDetail(app);
    this.drainEvents(app);
    this.updateChat(app);
    this.updateAgent(app);

    const secs = Math.floor(ai.t);
    $('clockTime').textContent =
      `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  }

  // ---- junction list -------------------------------------------------------
  updateJunctions(app) {
    for (const node of app.ai.net.signals) {
      const el = this.jxEls[node.id];
      const ctrl = node.ctrl;
      const ph = PHASES[ctrl.phase];

      let waiting = 0;
      for (const h of SIDES) if (node.cams[h]) waiting += node.cams[h].queue;
      el.wait.textContent = waiting;

      if (ctrl.stage === 'green') {
        el.chip.className = 'chip';
        el.chip.textContent = 'GREEN';
        el.which.textContent = `${SIDE_LABEL[ph.key].toLowerCase()} road`;
      } else if (ctrl.stage === 'yellow') {
        el.chip.className = 'chip amber';
        el.chip.textContent = 'AMBER';
        el.which.textContent = `${SIDE_LABEL[ph.key].toLowerCase()} road clearing`;
      } else {
        el.chip.className = 'chip red';
        el.chip.textContent = 'ALL RED';
        el.which.textContent = 'switching over';
      }
      el.secs.textContent = `${fmt(ctrl.countdown, 0)}s`;

      const span = ctrl.stage === 'green' ? ctrl.plannedGreen
        : ctrl.stage === 'yellow' ? CFG.signal.yellow : CFG.signal.allRed;
      el.ring.style.width = `${Math.max(0, Math.min(100, (ctrl.countdown / Math.max(span, 0.1)) * 100))}%`;
      el.ring.className = ctrl.stage === 'green' ? '' : ctrl.stage === 'yellow' ? 'amber' : 'red';

      let tag = '';
      if (ctrl.preempting) tag = 'Ambulance — clearing its path';
      else if (ctrl.holdingForPlatoon) tag = 'Waiting for vehicles from the next signal';
      else if (node.coordArmed && app.ai.coordination) tag = 'Coordinating with its neighbours';
      el.tag.textContent = tag;
      el.tag.className = 'jx-tag' + (ctrl.preempting ? ' alarm' : '');
      el.root.classList.toggle('alarm', ctrl.preempting);
      el.root.classList.toggle('sel', app.selected === node.id);
    }
  }

  // ---- the selected junction, four roads -----------------------------------
  updateDetail(app) {
    const node = app.ai.net.byId[app.selected];
    if (!node) return;
    const ctrl = node.ctrl;
    const ph = PHASES[ctrl.phase];

    $('dId').textContent = node.name;
    if (ctrl.stage === 'green') {
      $('dNow').innerHTML = `<b>${SIDE_LABEL[ph.key]} road is green</b> — ${fmt(ctrl.countdown, 0)}s left`;
    } else if (ctrl.stage === 'yellow') {
      $('dNow').innerHTML = `${SIDE_LABEL[ph.key]} road on amber — clearing the junction`;
    } else {
      $('dNow').innerHTML = 'All roads red — safely switching over';
    }
    $('dWhy').textContent = ctrl.reason;

    for (const h of SIDES) {
      const el = this.roadEls[h];
      const cam = node.cams[h];
      const serving = ph.heads.includes(h);
      const state = serving
        ? (ctrl.stage === 'green' ? 'green' : ctrl.stage === 'yellow' ? 'amber' : 'red')
        : 'red';

      el.state.className = `road-state ${state}`;
      el.state.textContent = state === 'green' ? 'GREEN' : state === 'amber' ? 'AMBER' : 'RED';
      el.root.classList.toggle('serving', state === 'green');

      if (state === 'green' || state === 'amber') {
        el.secs.innerHTML = `${fmt(ctrl.countdown, 0)}<small>s left</small>`;
      } else {
        el.secs.innerHTML = `${fmt(this.waitEstimate(node, h), 0)}<small>s to go</small>`;
      }
      el.cnt.textContent = cam ? cam.queue : 0;
      el.lw.textContent = cam ? Math.round(cam.maxWait) : 0;
    }
  }

  // Rough "your turn comes in about N seconds" for a road currently on red.
  waitEstimate(node, heading) {
    const ctrl = node.ctrl;
    const target = PHASES.findIndex(p => p.heads.includes(heading));
    if (target < 0) return 0;
    const clear = CFG.signal.yellow + CFG.signal.allRed;
    let t = ctrl.countdown + (ctrl.stage === 'green' ? clear : 0);
    let p = ctrl.phase, guard = 0;
    while (guard++ < 6) {
      p = (p + 1) % PHASES.length;
      if (p === target) break;
      const d = ctrl.phaseDemand ? ctrl.phaseDemand(p) : { queue: 4 };
      if (d.queue < 0.5 && ctrl.kind === 'adaptive') continue;      // this phase gets skipped
      t += Math.max(CFG.signal.minGreen, Math.min(CFG.signal.maxGreen,
        CFG.signal.startupLoss + (d.queue / CFG.lanesPerDir) * CFG.signal.satHeadway)) + clear;
    }
    return t;
  }

  // ---- control room feed ----------------------------------------------------
  //  Three sources, ordered by when they happened:
  //    - Laya's decision records: the typed question, its answer, its probability
  //    - the controller's own notes when it is running on the fallback heuristic
  //    - the advisories junctions send each other
  updateChat(app) {
    const chat = app.ai.coordinator.chat;
    const events = app.ai.events;
    const recs = app.laya ? app.laya.records : [];
    if (chat.length === this.seenChat &&
        events.length === this.seenEvents &&
        recs.length === this.seenRecs) return;

    const items = [];
    for (const m of chat.slice(Math.max(this.seenChat, chat.length - 8))) {
      items.push({ t: m.at || 0, kind: 'link', from: m.fromId, to: m.toId, text: m.text });
    }
    for (const r of recs.slice(Math.max(this.seenRecs, recs.length - 8))) {
      items.push({ t: r.t, kind: 'laya', rec: r });
    }
    for (const e of events.slice(Math.max(this.seenEvents, events.length - 8))) {
      if (!NOTE_KINDS.has(e.kind)) continue;
      const cut = e.text.indexOf(': ');
      items.push({
        t: e.simT || 0, kind: 'note', level: e.kind,
        where: cut > 0 ? e.text.slice(0, cut) : '',
        text: cut > 0 ? e.text.slice(cut + 2) : e.text
      });
    }
    this.seenChat = chat.length;
    this.seenEvents = events.length;
    this.seenRecs = recs.length;
    if (!items.length) return;
    items.sort((a, b) => a.t - b.t);

    const body = $('chatBody');
    for (const m of items) {
      const el = document.createElement('div');
      if (m.kind === 'laya') {
        const r = m.rec;
        const p = typeof r.prob === 'number' ? r.prob : null;
        el.className = 'msg laya';
        el.innerHTML = `
          <div class="msg-from">
            <span class="av">L</span><b>LAYA</b>
            <span class="at">${escapeHtml(r.junction)}</span>
            <span class="qtype">${escapeHtml(r.kind)}</span>
          </div>
          <div class="msg-b">
            <span class="q">${escapeHtml(r.question)}</span>
            <span class="arrow">&rarr;</span>
            <b class="a">${escapeHtml(String(r.answer))}</b>
            ${p !== null ? `<span class="p">p=${p.toFixed(2)}</span>` : ''}
            <div class="sub">${escapeHtml(r.extra || '')}</div>
          </div>`;
      } else if (m.kind === 'note') {
        el.className = `msg note ${m.level}`;
        el.innerHTML = `
          <div class="msg-from"><b>CONTROLLER</b>${m.where ? `<span class="at">${escapeHtml(m.where)}</span>` : ''}</div>
          <div class="msg-b">${escapeHtml(m.text)}</div>`;
      } else {
        el.className = 'msg link';
        el.innerHTML = `
          <div class="msg-from"><b>${escapeHtml(m.from)}</b><span class="arrow">&rarr;</span>${escapeHtml(m.to)}</div>
          <div class="msg-b">${escapeHtml(m.text)}</div>`;
      }
      body.insertBefore(el, body.firstChild);
    }
    while (body.children.length > 26) body.removeChild(body.lastChild);
  }

  // ---- the agent pill tells the truth about what is deciding ---------------
  updateAgent(app) {
    const pill = $('agentPill');
    const state = $('agentState');
    if (!pill || !state) return;
    const l = app.laya;
    if (l && l.available) {
      pill.className = 'agent live';
      state.textContent = `DECIDING · ${Math.round(l.lastLatency)}ms`;
    } else if (l && l.status === 'checking') {
      pill.className = 'agent offline';
      state.textContent = 'CHECKING';
    } else {
      pill.className = 'agent offline';
      state.textContent = 'OFFLINE · FALLBACK';
    }
  }

  pushAlert(e) {
    const stack = $('alertStack');
    const el = document.createElement('div');
    el.className = `alert ${e.kind === 'preempt' ? 'preempt' : e.kind === 'coord' ? 'coord' : 'good'}`;
    el.textContent = e.text;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 4200);
    setTimeout(() => el.remove(), 4700);
    while (stack.children.length > 3) stack.removeChild(stack.firstChild);
  }

  // Banner alerts for the two things worth interrupting someone for. The feed
  // itself is drained in updateChat, which owns the event cursor.
  drainEvents(app) {
    const events = app.ai.events;
    const fresh = events.slice(this.seenAlerts);
    this.seenAlerts = events.length;
    for (const e of fresh) {
      if (e.kind === 'preempt') this.pushAlert(e);
    }
  }
}

function wasteOf(sim) {
  let g = 0, w = 0;
  for (const c of sim.controllers) { g += c.greenTotal; w += c.greenWasted; }
  return g > 0 ? w / g : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
