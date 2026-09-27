// ============================================================================
//  ARTERIA — offline film renderer.
//
//  Produces a broadcast-clean 1920x1080 / 30 fps explainer of the project.
//
//  WHY NOT SCREEN RECORDING
//  A MediaRecorder on a display stream captures whatever frame rate the machine
//  managed at that moment: a GTAO pass plus four extra scene renders plus a
//  bloom chain does not hold 60 fps, so the result stutters exactly where the
//  interesting things happen. Here the clock is the frame counter, not the wall
//  clock. Every frame advances the simulation by precisely 1/30 s, is rendered
//  at full quality however long that takes, is JPEG-encoded, and is posted to a
//  small local sink that writes it to disk. ffmpeg then assembles an exact
//  30 fps sequence. Slow to produce, perfectly smooth to watch.
//
//  The overlay here is NOT the app's interface. The app's panels are sized for
//  a person sitting at a desk; on a phone in a LinkedIn feed they are unreadable.
//  This draws a second, larger set of the same live numbers straight into the
//  film frame: the A/B result, wasted green, the four approach cameras with
//  their signal timing, and the messages junctions send each other.
// ============================================================================

import * as THREE from 'three';
import { CFG, PHASES } from '../core/config.js';
import { compare } from '../ai/metrics.js';
import { updateCityLighting } from '../render/city.js';

const W = 1920, H = 1080, FPS = 30;
const SINK = 'http://127.0.0.1:7788';

// ---- palette (matches the app) ---------------------------------------------
const C = {
  ink: '#05080e', panel: 'rgba(9,14,23,0.86)', panel2: 'rgba(12,19,31,0.92)',
  line: 'rgba(38,55,79,0.9)', line2: 'rgba(28,41,60,0.75)',
  txt: '#e4edf7', txt2: '#9db1c7', txt3: '#66798f',
  cyan: '#35e6d0', blue: '#4aa8ff', amber: '#ffb020',
  red: '#ff4d5e', green: '#3ddc84', violet: '#a67bff'
};

const MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace';
const SANS = 'Inter, system-ui, "Segoe UI", sans-serif';

// ---- layout ----------------------------------------------------------------
const FEED = { w: 272, h: 153, gap: 12, x0: 52, y: 872 };
const CHAT = { x: 1332, y: 516, w: 536, h: 509 };
const HERO = { x: 52, y: 150, w: 396, h: 268 };
const WASTE = { x: 52, y: 434, w: 396, h: 176 };
const ENGINE = { x: 1332, y: 150, w: 536, h: 158 };
const SCORE = { x: 1332, y: 324, w: 536, h: 176 };
const CAP = { x: 52, y: 624, w: 1180 };

const SIDE_FULL = { N: 'NORTH ROAD', E: 'EAST ROAD', S: 'SOUTH ROAD', W: 'WEST ROAD' };

// Slow in, slow out. Linear camera moves read as machinery; this reads as a
// crane shot.
const smooth = t => t * t * t * (t * (t * 6 - 15) + 10);
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);

// ============================================================================
//  The script
// ============================================================================
function script(app) {
  const net = app.ai.net;
  const find = n => net.signals.find(s => s.name === n);
  const cyber = find('Cyber Towers') || net.signals[1];
  const shilpa = find('Shilpa Layout') || net.signals[4];
  const durgam = find('Durgam Cheruvu') || net.signals[5];
  const kotha = find('Kothaguda') || net.signals[0];
  const span = Math.max(net.extent.x, net.extent.z);

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // camera placed relative to a junction, looking at it
  const wide = (x, y, z) => ({ pos: V(x, y, z), tgt: V(0, 0, 0) });

  //  Place a camera ALONG a road, looking back at the junction.
  //
  //  The grid is 230 m square and every plot is built out to the street wall,
  //  so a camera offset by a large amount on both axes is not "a nice diagonal
  //  view of the junction" — it is inside a tower, filming a wall. Offsetting
  //  along a single axis keeps the camera over the carriageway, which is also
  //  the shot that actually shows something: a queue running away down the road.
  //    axis  'x' east-west, 'z' north-south
  //    dist  metres along that road, signed
  //    lat   small sideways nudge, kept under the kerb line
  const road = (n, axis, dist, height, lat = 12) => ({
    pos: axis === 'x' ? V(n.pos.x + dist, height, n.pos.z + lat)
                      : V(n.pos.x + lat, height, n.pos.z + dist),
    tgt: V(n.pos.x, 2.5, n.pos.z)
  });

  return [
    { // 1 — title
      dur: 5.5, card: 'title', hud: false, cut: true,
      title: 'ARTERIA',
      text: 'Traffic lights that decide their own timing.',
      from: wide(span * 0.50, span * 0.44, span * 0.74),
      to: wide(span * 0.42, span * 0.34, span * 0.60)
    },
    { // 2 — the problem, shown rather than asserted
      dur: 10, cut: true, panel: 'problem',
      kicker: 'THE PROBLEM',
      title: 'The light is green. The road is empty.',
      text: 'An ordinary traffic light runs on a timer. It cannot see the road, so it '
          + 'gives green time to roads with nobody on them, while the road beside it queues.',
      action: () => app.selectJunction(shilpa.id),
      from: road(shilpa, 'x', 96, 31, 15),
      to: road(shilpa, 'x', 60, 22, 11)
    },
    { // 3 — see
      dur: 9, cut: true,
      kicker: 'WHAT WE BUILT  ·  1',
      title: 'A camera on every road',
      text: 'All four roads into a junction get their own camera. Ten times a second it '
          + 'counts the vehicles waiting, and how long they have been there.',
      from: road(shilpa, 'z', 78, 23, -14),
      to: road(shilpa, 'z', 48, 16, -10)
    },
    { // 4 — decide
      dur: 9.5,
      kicker: 'WHAT WE BUILT  ·  2',
      title: 'Green lasts as long as the queue needs',
      text: 'One road is green at a time. Its length is worked out from the vehicles the '
          + 'camera counted, and it ends early the moment that road clears.',
      action: () => app.selectJunction(cyber.id),
      from: road(cyber, 'x', 118, 34, 14),
      to: road(cyber, 'x', 72, 24, 11)
    },
    { // 5 — talk
      dur: 9.5, cut: true,
      kicker: 'WHAT WE BUILT  ·  3',
      title: 'Junctions tell each other what is coming',
      text: 'Letting a queue go sends the next junction a message: how many vehicles, '
          + 'arriving in how many seconds. It turns green in time, so nobody stops twice. '
          + 'That is the control room, right.',
      from: road(cyber, 'x', 232, 62, 18),
      to: road(cyber, 'x', 132, 40, 14)
    },
    { // 6 — the model
      dur: 9, cut: true,
      kicker: 'THE BRAIN',
      title: 'Laya makes the call',
      text: 'An Indian open-source AI model. We fine-tuned it on this city’s traffic and '
          + 'it went from 25% correct to 73%. The safety timing stays in plain code, never '
          + 'in the model.',
      action: () => app.selectJunction(kotha.id),
      from: road(kotha, 'z', -168, 50, 16),
      to: road(kotha, 'z', -96, 32, 12)
    },
    { // 7 — the stack
      dur: 8.5, cut: true, panel: 'stack',
      kicker: 'BUILT WITH',
      title: '',
      text: '',
      from: wide(-span * 0.44, span * 0.30, span * 0.52),
      to: wide(-span * 0.34, span * 0.26, span * 0.43)
    },
    { // 8 — load
      dur: 8.5, cut: true,
      kicker: 'PUT UNDER LOAD',
      title: 'Rush hour',
      text: 'Traffic climbs. The AI network keeps clearing vehicles. The fixed-timer copy '
          + 'running beside it starts to jam.',
      action: () => { app.setProfile('peak'); app.selectJunction(durgam.id); },
      from: road(durgam, 'x', -268, 92, 22),
      to: road(durgam, 'x', -164, 62, 16)
    },
    { // 9 — worst case
      dur: 10,
      kicker: 'THE WORST CASE',
      title: 'A stadium empties',
      text: 'Almost everybody wants to go one way at once. A fixed timer was drawn up for '
          + 'an average day, so it keeps serving roads that have just gone empty.',
      action: () => app.setProfile('surge'),
      from: wide(span * 0.36, span * 0.26, -span * 0.48),
      to: wide(span * 0.22, span * 0.20, -span * 0.32)
    },
    { // 10 — and how it is cleared
      dur: 9.5, cut: true, panel: 'share',
      kicker: 'HOW IT CLEARS IT',
      title: 'Green time moves to where the queue is',
      text: 'The cameras see the surge within seconds. The loaded roads start taking '
          + 'longer, back-to-back greens; the rest get just enough that nobody is '
          + 'stranded. Watch the blue bars climb towards the amber ones.',
      action: () => app.selectJunction(shilpa.id),
      from: road(shilpa, 'x', 104, 33, 15),
      to: road(shilpa, 'x', 62, 22, 11)
    },
    { // 11 — result
      dur: 10, cut: true,
      kicker: 'THE RESULT',
      title: 'Drivers wait about half as long',
      text: 'A fixed-timer copy runs at the same moment on exactly the same vehicles, so the '
          + 'comparison is fair. Every number on screen is measured live, as you watch.',
      action: () => app.setProfile('normal'),
      from: wide(span * 0.44, span * 0.33, span * 0.62),
      to: wide(span * 0.34, span * 0.27, span * 0.48)
    },
    { // 11 — end card
      dur: 6, card: 'end', hud: false,
      title: 'ARTERIA',
      text: 'Three.js · fine-tuned Laya · max-pressure control with V2I coordination',
      from: wide(span * 0.34, span * 0.27, span * 0.48),
      to: wide(span * 0.30, span * 0.25, span * 0.43)
    }
  ];
}

// ============================================================================
//  2D drawing helpers
// ============================================================================
function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function panel(ctx, x, y, w, h, { fill = C.panel, stroke = C.line, r = 10 } = {}) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.stroke();
}

function cardHead(ctx, x, y, w, label, right) {
  ctx.font = `600 12px ${MONO}`;
  ctx.fillStyle = C.txt3;
  ctx.textAlign = 'left';
  ctx.letterSpacing = '1.6px';
  ctx.fillText(label, x, y);
  if (right) {
    ctx.textAlign = 'right';
    ctx.fillStyle = C.txt3;
    ctx.fillText(right, x + w, y);
  }
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  ctx.strokeStyle = C.line2;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 10.5);
  ctx.lineTo(x + w, y + 10.5);
  ctx.stroke();
}

// Greedy wrap. Returns the y the caller should continue from.
function wrap(ctx, text, x, y, maxW, lh, max = 99) {
  const words = String(text).split(/\s+/);
  let line = '', n = 0;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lh; n++;
      if (n >= max) return y;
      line = word;
    } else line = test;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}

function bar(ctx, x, y, w, h, frac, col, track = 'rgba(255,255,255,0.07)') {
  ctx.fillStyle = track;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  const fw = Math.max(0, Math.min(1, frac)) * w;
  if (fw > 0.5) {
    ctx.fillStyle = col;
    roundRect(ctx, x, y, Math.max(fw, h), h, h / 2);
    ctx.fill();
  }
}

// ============================================================================
export class Film {
  constructor(app) {
    this.app = app;
    this.shots = script(app);
    this.total = this.shots.reduce((s, b) => s + b.dur, 0);
    this.frames = Math.round(this.total * FPS);
    this.msgs = [];
    this.seen = { chat: 0, recs: 0 };
    this.simTime = 0;
  }

  // ---- setup ---------------------------------------------------------------
  prepare() {
    const app = this.app;
    app._filming = true;
    document.body.classList.add('film-mode');

    // Exact 1920x1080 drawing buffer: pixel ratio 1 so the scissor rectangles
    // used for the approach-camera insets are in the same coordinate space as
    // the 2D overlay drawn on top of them.
    app.world.renderer.setPixelRatio(1);
    app.world.resize(W, H);
    app.world.controls.enabled = false;
    app.reelActive = true;
    app.speed = 1;

    this.film = document.createElement('canvas');
    this.film.width = W;
    this.film.height = H;
    this.film.id = 'filmCanvas';
    document.body.appendChild(this.film);
    this.ctx = this.film.getContext('2d', { alpha: false });

    this.gl = document.getElementById('scene');
  }

  teardown() {
    document.body.classList.remove('film-mode');
    this.app._filming = false;
    this.app.reelActive = false;
    this.app.world.controls.enabled = true;
  }

  // ---- which shot is frame `i` in ------------------------------------------
  shotAt(i) {
    const t = i / FPS;
    let acc = 0;
    for (let s = 0; s < this.shots.length; s++) {
      const sh = this.shots[s];
      if (t < acc + sh.dur || s === this.shots.length - 1) {
        return { shot: sh, index: s, local: t - acc, k: clamp01((t - acc) / sh.dur) };
      }
      acc += sh.dur;
    }
  }

  // ---- one frame -----------------------------------------------------------
  async frame(i) {
    const app = this.app;
    const { shot, index, local, k } = this.shotAt(i);

    if (this.lastShot !== index) {
      this.lastShot = index;
      if (shot.action) { try { shot.action(); } catch (e) { console.warn(e); } }
    }

    // --- advance the world by exactly one frame ---
    const dt = 1 / FPS;
    app.schedule.ensure(app.ai.t);
    app.ai.step(dt);
    app.baseline.step(dt);
    this.simTime += dt;

    // --- camera ---
    const cam = app.world.camera;
    const e = smooth(k);
    cam.position.lerpVectors(shot.from.pos, shot.to.pos, e);
    app.world.controls.target.lerpVectors(shot.from.tgt, shot.to.tgt, e);
    cam.lookAt(app.world.controls.target);

    // --- scene ---
    app.vehicles.sync(app.ai.vehicles, app.world.nightFactor, this.simTime);
    app.crowd.update(dt, this.simTime);
    app.signals.update(app.ai, this.simTime, app.world.nightFactor, app.selected);
    updateCityLighting(app.city.group, app.world.nightFactor, this.simTime);
    app.updateLabels();
    // The junction name sprites scale with camera distance, which is right for
    // an orbit view and absurd close up: at 70 m the label spans a third of the
    // frame. Close shots already name the junction in the caption and above the
    // camera strip, so drop them.
    for (const l of app.labels) {
      const d = Math.hypot(cam.position.x - l.node.pos.x, cam.position.z - l.node.pos.z);
      if (d < 190) l.sprite.visible = false;
    }
    app.world.render();

    // --- approach-camera insets, straight into the same framebuffer ---
    const node = app.ai.net.byId[app.selected];
    const shown = [];
    app.feed.clearRects();
    if (node && shot.hud !== false) {
      let x = FEED.x0;
      for (const side of ['N', 'E', 'S', 'W']) {
        const rect = { x, y: FEED.y, w: FEED.w, h: FEED.h };
        x += FEED.w + FEED.gap;
        if (!node.in[side]) continue;
        app.feed.renderInset(app.world.renderer, app.world.scene, node, side, rect, H);
        shown.push({ side, rect });
      }
    }

    // --- composite ---
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A light grade on the way into the compositor. The renderer's ACES curve
    // is neutral by design; a touch of contrast and saturation is the
    // difference between "a WebGL scene" and "a shot". Chrome runs canvas
    // filters on the GPU, so this is effectively free.
    ctx.filter = 'contrast(1.07) saturate(1.13) brightness(1.02)';
    ctx.drawImage(this.gl, 0, 0, W, H);
    ctx.filter = 'none';

    this.collect();
    for (const s of shown) {
      const vc = app.ai.vision.get(node, s.side);
      app.feed.drawOverlay(ctx, node, s.side, vc, this.simTime, true);
    }
    this.drawOverlay(ctx, shot, shown, node, i, local);

    // --- encode and ship ---
    await this.ship(i);
  }

  //  toDataURL, not toBlob. toBlob hands the encode to another thread and its
  //  callback comes back through the task queue; measured here that is 1030 ms
  //  a frame against 20 ms for the synchronous call. Over a 2,700-frame shoot
  //  that is the difference between six minutes and an hour.
  async ship(i) {
    const url = this.film.toDataURL('image/jpeg', 0.92);
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    await fetch(`${SINK}/frame?n=${i}`, { method: 'POST', body: bytes });
  }

  // ---- rolling message log -------------------------------------------------
  collect() {
    const chat = this.app.ai.coordinator.chat;
    const recs = this.app.laya ? this.app.laya.records : [];

    for (let i = this.seen.chat; i < chat.length; i++) {
      const m = chat[i];
      this.msgs.push({ kind: 'link', from: m.fromId, to: m.toId, text: m.text });
    }
    this.seen.chat = chat.length;

    for (let i = this.seen.recs; i < recs.length; i++) {
      const r = recs[i];
      this.msgs.push({
        kind: 'laya', where: r.junction,
        text: `next road → ${String(r.answer || '?').toUpperCase()}`,
        sub: r.extra || '', p: typeof r.prob === 'number' ? r.prob : null
      });
    }
    this.seen.recs = recs.length;

    if (this.msgs.length > 14) this.msgs.splice(0, this.msgs.length - 14);
  }

  // ==========================================================================
  //  Overlay
  // ==========================================================================
  drawOverlay(ctx, shot, shown, node, i, local) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // a soft vignette so the panels sit on the image rather than float over it
    const g = ctx.createRadialGradient(W / 2, H * 0.46, H * 0.52, W / 2, H * 0.5, H * 1.15);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(2,4,8,0.30)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const tg = ctx.createLinearGradient(0, 0, 0, 150);
    tg.addColorStop(0, 'rgba(3,6,12,0.52)');
    tg.addColorStop(1, 'rgba(3,6,12,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(0, 0, W, 150);

    if (shot.card === 'title') this.drawTitleCard(ctx, shot, i);
    else if (shot.card === 'end') this.drawEndCard(ctx, shot, i);
    else {
      this.drawBrand(ctx);
      if (shot.panel === 'problem') this.drawProblem(ctx, local);
      else if (shot.panel === 'stack') this.drawStack(ctx, local);
      else if (shot.panel === 'share') this.drawShare(ctx, local, node);
      else { this.drawHero(ctx); this.drawWaste(ctx); }
      this.drawEngine(ctx);
      this.drawScore(ctx);
      this.drawChat(ctx);
      this.drawFeeds(ctx, shown, node);
      if (shot.panel !== 'stack') this.drawCaption(ctx, shot, local);
    }

    // progress
    const p = i / this.frames;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, H - 3, W, 3);
    ctx.fillStyle = C.cyan;
    ctx.fillRect(0, H - 3, W * p, 3);

    ctx.restore();
  }

  // ---- cards ---------------------------------------------------------------
  drawTitleCard(ctx, shot, i) {
    const t = i / FPS;
    const a = clamp01(t / 0.9) * (1 - clamp01((t - (shot.dur - 0.7)) / 0.7));
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(3,6,12,${0.34 * a + 0.05})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';

    ctx.font = `700 118px ${MONO}`;
    ctx.letterSpacing = '26px';
    ctx.fillStyle = C.txt;
    ctx.fillText('ARTERIA', W / 2 + 13, H / 2 - 22);
    ctx.letterSpacing = '0px';

    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 132, H / 2 + 14);
    ctx.lineTo(W / 2 + 132, H / 2 + 14);
    ctx.stroke();

    ctx.font = `500 27px ${SANS}`;
    ctx.fillStyle = C.txt;
    ctx.fillText(shot.text, W / 2, H / 2 + 66);

    ctx.font = `600 14px ${MONO}`;
    ctx.letterSpacing = '5px';
    ctx.fillStyle = C.cyan;
    ctx.fillText('HITEC CITY, HYDERABAD  ·  SIMULATED IN REAL TIME', W / 2, H / 2 + 116);
    ctx.letterSpacing = '0px';
    ctx.restore();
  }

  drawEndCard(ctx, shot, i) {
    const t0 = this.total - shot.dur;
    const t = i / FPS - t0;
    const a = clamp01(t / 1.0);
    const cmp = compare(this.app.ai.metrics, this.app.baseline.metrics);
    const pct = Math.max(0, cmp.wait);

    ctx.save();
    ctx.fillStyle = `rgba(3,6,12,${0.46 * a})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';

    ctx.font = `700 150px ${MONO}`;
    ctx.fillStyle = C.cyan;
    ctx.fillText(`−${pct.toFixed(0)}%`, W / 2, H / 2 - 24);

    ctx.font = `600 30px ${SANS}`;
    ctx.fillStyle = C.txt;
    ctx.fillText('driver delay, against fixed-time signals', W / 2, H / 2 + 28);

    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 300, H / 2 + 72);
    ctx.lineTo(W / 2 + 300, H / 2 + 72);
    ctx.stroke();

    ctx.font = `700 38px ${MONO}`;
    ctx.letterSpacing = '13px';
    ctx.fillStyle = C.txt;
    ctx.fillText('ARTERIA', W / 2 + 7, H / 2 + 128);
    ctx.letterSpacing = '0px';

    ctx.font = `400 17px ${SANS}`;
    ctx.fillStyle = C.txt2;
    ctx.fillText(shot.text, W / 2, H / 2 + 166);
    ctx.restore();
  }

  // ---- brand strip ---------------------------------------------------------
  drawBrand(ctx) {
    const app = this.app;
    ctx.save();
    ctx.font = `700 30px ${MONO}`;
    ctx.letterSpacing = '7px';
    ctx.fillStyle = C.txt;
    ctx.fillText('ARTERIA', 52, 84);
    ctx.letterSpacing = '0px';

    ctx.font = `400 14px ${SANS}`;
    ctx.fillStyle = C.txt2;
    ctx.fillText('AI density-adaptive signal control', 52, 108);

    // Laya pill, right-aligned with the right column
    const live = !!(app.laya && app.laya.available);
    const label = live ? `LAYA · DECIDING` : 'HEURISTIC FALLBACK';
    ctx.font = `600 13px ${MONO}`;
    const tw = ctx.measureText(label).width;
    const pw = tw + 58, px = ENGINE.x + ENGINE.w - pw, py = 58;
    panel(ctx, px, py, pw, 34, { r: 17, fill: 'rgba(9,14,23,0.92)' });

    ctx.beginPath();
    ctx.arc(px + 21, py + 17, 9, 0, Math.PI * 2);
    ctx.fillStyle = live ? 'rgba(53,230,208,0.16)' : 'rgba(255,176,32,0.16)';
    ctx.fill();
    ctx.fillStyle = live ? C.cyan : C.amber;
    ctx.beginPath();
    ctx.arc(px + 21, py + 17, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = live ? C.txt : C.amber;
    ctx.fillText(label, px + 38, py + 22);

    // clock
    const t = this.app.ai.t;
    const mm = String(Math.floor(t / 60) % 60).padStart(2, '0');
    const ss = String(Math.floor(t) % 60).padStart(2, '0');
    ctx.font = `500 13px ${MONO}`;
    ctx.fillStyle = C.txt3;
    ctx.textAlign = 'right';
    ctx.fillText(`SIMULATED  ${mm}:${ss}`, px - 18, py + 22);
    ctx.restore();
  }

  // ---- the problem, as a measured number ----------------------------------
  //  Asserting "fixed timers waste green" in a caption is a claim. Putting the
  //  fixed-time twin's own live figure on screen next to the adaptive one is
  //  evidence, and it costs nothing because the twin is already running.
  drawProblem(ctx, local) {
    const sum = (sim, f) => sim.controllers.reduce((a, c) => a + f(c), 0);
    const fxTot = sum(this.app.baseline, c => c.greenTotal) || 1;
    const fx = sum(this.app.baseline, c => c.greenWasted) / fxTot;
    const aiTot = sum(this.app.ai, c => c.greenTotal) || 1;
    const ai = sum(this.app.ai, c => c.greenWasted) / aiTot;

    const e = smooth(clamp01(local / 0.7));
    const x = HERO.x, y = HERO.y, w = 430, h = 452;
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(0, (1 - e) * 26);

    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 22, y + 30, w - 44, 'ON AN ORDINARY FIXED TIMER');

    // the headline number, counted up so the eye lands on it
    const shown = fx * Math.min(1, local / 1.5);
    ctx.font = `700 118px ${MONO}`;
    ctx.fillStyle = C.red;
    const num = `${(shown * 100).toFixed(0)}`;
    ctx.fillText(num, x + 22, y + 152);
    const nw = ctx.measureText(num).width;
    ctx.font = `600 40px ${MONO}`;
    ctx.fillText('%', x + 28 + nw, y + 152);

    ctx.font = `400 17px ${SANS}`;
    ctx.fillStyle = C.txt;
    wrap(ctx, 'of its green time is given to a road with nobody waiting on it',
      x + 22, y + 186, w - 44, 24);

    ctx.strokeStyle = C.line2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 22, y + 258.5);
    ctx.lineTo(x + w - 22, y + 258.5);
    ctx.stroke();

    ctx.font = `600 12px ${MONO}`;
    ctx.fillStyle = C.txt3;
    ctx.letterSpacing = '1.6px';
    ctx.fillText('WITH ARTERIA', x + 22, y + 290);
    ctx.letterSpacing = '0px';

    ctx.font = `700 54px ${MONO}`;
    ctx.fillStyle = C.cyan;
    ctx.fillText(`${(ai * 100).toFixed(0)}%`, x + 22, y + 348);

    ctx.font = `400 15px ${SANS}`;
    ctx.fillStyle = C.txt2;
    wrap(ctx, 'Both figures are measured live, right now, from the two networks '
      + 'running side by side on identical traffic.', x + 22, y + 384, w - 44, 21);

    ctx.restore();
  }

  // ---- how a surge actually gets cleared ----------------------------------
  //  The load shots set up a problem; without this one the film never shows the
  //  mechanism that answers it. Green time per approach, decayed over about a
  //  minute, for this junction and for its fixed-time twin. Under a one-way
  //  surge the adaptive bars go visibly lopsided while the fixed ones cannot.
  drawShare(ctx, local, node) {
    if (!node) return;
    const ai = this.app.ai.controllers.find(c => c.node.id === node.id);
    if (!ai || !ai.queueRecent) return;

    const share = arr => {
      const t = arr.reduce((x, y) => x + y, 0) || 1;
      return arr.map(v => v / t);
    };
    const green = share(ai.greenRecent);
    const want = share(ai.queueRecent);
    const peak = Math.max(0.40, ...green, ...want);

    const e = smooth(clamp01(local / 0.7));
    const x = HERO.x, y = HERO.y, w = 430, h = 462;
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(0, (1 - e) * 26);

    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 22, y + 30, w - 44, 'DEMAND, AND THE GREEN IT GETS', 'LAST MINUTE');

    let ry = y + 68;
    PHASES.forEach((ph, i) => {
      const ke = smooth(clamp01((local - 0.3 - i * 0.1) / 0.5));
      ctx.save();
      ctx.globalAlpha = ke;

      ctx.font = `600 12px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.letterSpacing = '1.4px';
      ctx.fillText(SIDE_FULL[ph.key] || ph.label, x + 22, ry);
      ctx.letterSpacing = '0px';

      ctx.font = `700 13px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = C.cyan;
      ctx.fillText(`${(green[i] * 100).toFixed(0)}%`, x + w - 22, ry);
      ctx.textAlign = 'left';

      bar(ctx, x + 22, ry + 9, w - 44, 7, want[i] / peak, C.amber);
      bar(ctx, x + 22, ry + 21, w - 44, 7, green[i] / peak, C.cyan);
      ctx.restore();
      ry += 54;
    });

    ctx.font = `500 11px ${MONO}`;
    ctx.fillStyle = C.amber;
    ctx.fillText('▬ VEHICLES WAITING', x + 22, y + h - 62);
    ctx.fillStyle = C.cyan;
    ctx.fillText('▬ GREEN TIME GIVEN', x + 210, y + h - 62);

    ctx.font = `400 14px ${SANS}`;
    ctx.fillStyle = C.txt2;
    wrap(ctx, 'Green chases the queue, cycle by cycle. A fixed timer cannot — it '
      + 'splits its cycle the same way every time.', x + 22, y + h - 36, w - 44, 19);
    ctx.restore();
  }

  // ---- what it is built from ----------------------------------------------
  drawStack(ctx, local) {
    const rows = [
      ['Three.js / WebGL', 'the city, the traffic and the camera feeds, rendered live at 1080p', C.blue],
      ['IDM + MOBIL', 'car-following and lane-changing physics for every vehicle', C.blue],
      ['Simulated detector', 'counts vehicles per approach — with a real miss rate, like a real camera', C.cyan],
      ['Max-pressure control', 'picks the road, sizes the green from the queue, cuts it short early', C.cyan],
      ['V2I messaging', 'each junction warns the next one what is heading its way', C.cyan],
      ['Laya, fine-tuned', 'the decision model · PyTorch · GRPO · trained on a single GPU in 32 min', C.violet],
      ['FastAPI sidecar', 'serves calibrated decisions to all six junctions in ~30 ms', C.violet]
    ];
    const x = 52, y = 142, w = 648, h = 88 + rows.length * 62;
    const e = smooth(clamp01(local / 0.7));

    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(0, (1 - e) * 26);
    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 24, y + 32, w - 48, 'EVERYTHING IT IS BUILT FROM', 'NO GAME ENGINE');

    let ry = y + 84;
    rows.forEach((r, k) => {
      // each row wipes in just after the one above it
      const ke = smooth(clamp01((local - 0.35 - k * 0.075) / 0.5));
      ctx.save();
      ctx.globalAlpha = ke;
      ctx.translate((1 - ke) * -16, 0);

      ctx.fillStyle = r[2];
      roundRect(ctx, x + 24, ry - 11, 4, 30, 2);
      ctx.fill();

      ctx.font = `700 19px ${SANS}`;
      ctx.fillStyle = C.txt;
      ctx.fillText(r[0], x + 42, ry + 4);

      ctx.font = `400 14.5px ${SANS}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText(r[1], x + 42, ry + 26);
      ctx.restore();
      ry += 62;
    });
    ctx.restore();
  }

  // ---- hero: the A/B result ----------------------------------------------
  drawHero(ctx) {
    const ai = this.app.ai.metrics, fx = this.app.baseline.metrics;
    const cmp = compare(ai, fx);
    const pct = Math.max(0, cmp.wait);
    const { x, y, w, h } = HERO;

    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 20, y + 28, w - 40, 'DRIVERS WAIT');

    ctx.save();
    ctx.font = `700 76px ${MONO}`;
    ctx.fillStyle = C.cyan;
    ctx.fillText(`−${pct.toFixed(0)}`, x + 20, y + 112);
    const nw = ctx.measureText(`−${pct.toFixed(0)}`).width;
    ctx.font = `600 26px ${MONO}`;
    ctx.fillText('%', x + 24 + nw, y + 112);

    ctx.font = `400 14px ${SANS}`;
    ctx.fillStyle = C.txt2;
    wrap(ctx, 'less than with the ordinary fixed-timer signals most cities run today',
      x + 20, y + 140, w - 40, 19);

    // the two raw numbers
    const rows = [
      { k: 'With AI control', v: ai.avgWait, col: C.cyan },
      { k: 'Fixed timers', v: fx.avgWait, col: C.txt3 }
    ];
    let ry = y + 198;
    const maxV = Math.max(ai.avgWait, fx.avgWait, 1);
    for (const r of rows) {
      ctx.fillStyle = r.col;
      ctx.beginPath();
      ctx.arc(x + 25, ry - 5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `400 14px ${SANS}`;
      ctx.fillStyle = C.txt2;
      ctx.textAlign = 'left';
      ctx.fillText(r.k, x + 38, ry);
      ctx.font = `700 19px ${MONO}`;
      ctx.fillStyle = r.col === C.cyan ? C.txt : C.txt2;
      ctx.textAlign = 'right';
      ctx.fillText(`${r.v.toFixed(1)}`, x + w - 46, ry);
      ctx.font = `400 12px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText('sec', x + w - 20, ry);
      ctx.textAlign = 'left';
      bar(ctx, x + 38, ry + 7, w - 86, 4, r.v / maxV, r.col);
      ry += 34;
    }
    ctx.restore();
  }

  // ---- wasted green -------------------------------------------------------
  drawWaste(ctx) {
    const { x, y, w, h } = WASTE;
    const sum = (sim, f) => sim.controllers.reduce((s, c) => s + f(c), 0);
    const aiTot = sum(this.app.ai, c => c.greenTotal) || 1;
    const aiWaste = sum(this.app.ai, c => c.greenWasted) / aiTot;
    const fxTot = sum(this.app.baseline, c => c.greenTotal) || 1;
    const fxWaste = sum(this.app.baseline, c => c.greenWasted) / fxTot;
    const saved = sum(this.app.ai, c => c.greenSaved || 0);

    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 20, y + 28, w - 40, 'GREEN SHOWN TO AN EMPTY ROAD');

    const rows = [
      { k: 'AI control', v: aiWaste, col: C.cyan },
      { k: 'Fixed timers', v: fxWaste, col: C.red }
    ];
    let ry = y + 60;
    for (const r of rows) {
      ctx.font = `400 13px ${SANS}`;
      ctx.fillStyle = C.txt2;
      ctx.textAlign = 'left';
      ctx.fillText(r.k, x + 20, ry + 10);
      ctx.font = `700 15px ${MONO}`;
      ctx.fillStyle = r.col;
      ctx.textAlign = 'right';
      ctx.fillText(`${(r.v * 100).toFixed(1)}%`, x + w - 20, ry + 10);
      ctx.textAlign = 'left';
      bar(ctx, x + 20, ry + 19, w - 40, 6, r.v / 0.5, r.col);
      ry += 42;
    }

    ctx.font = `700 24px ${MONO}`;
    ctx.fillStyle = C.green;
    ctx.fillText(`${Math.round(saved)}`, x + 20, y + 158);
    const sw = ctx.measureText(`${Math.round(saved)}`).width;
    ctx.font = `400 13px ${SANS}`;
    ctx.fillStyle = C.txt2;
    ctx.fillText('seconds of pointless green cut short', x + 26 + sw, y + 158);
  }

  // ---- decision engine ----------------------------------------------------
  drawEngine(ctx) {
    const { x, y, w, h } = ENGINE;
    const l = this.app.laya;
    const live = !!(l && l.available);
    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 20, y + 28, w - 40, 'DECISION ENGINE',
      live ? `${Math.round(l.lastLatency)} ms` : 'OFFLINE');

    ctx.font = `600 19px ${SANS}`;
    ctx.fillStyle = C.txt;
    ctx.fillText(live ? 'Laya · laya-arteria' : 'Built-in heuristic', x + 20, y + 62);

    ctx.font = `400 13.5px ${SANS}`;
    ctx.fillStyle = C.txt2;
    wrap(ctx, live
      ? 'Non-autoregressive decision model, fine-tuned on this network. Answers a typed question per junction with a calibrated probability.'
      : 'Max-pressure selection with actuated gap-out. The sidecar is not running.',
      x + 20, y + 86, w - 40, 19, 3);

    if (live) {
      const acc = (l.accepted || 0), rej = (l.rejected || 0);
      const tot = acc + rej;
      ctx.font = `500 12px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(
        `${l.rounds || 0} rounds · ${tot ? ((acc / tot) * 100).toFixed(0) : '100'}% of answers accepted by the safety guard`,
        x + 20, y + h - 18);
    }
  }

  // ---- scoreboard ---------------------------------------------------------
  drawScore(ctx) {
    const { x, y, w, h } = SCORE;
    const ai = this.app.ai.metrics, fx = this.app.baseline.metrics;
    panel(ctx, x, y, w, h);
    cardHead(ctx, x + 20, y + 28, w - 40, 'SIDE BY SIDE', 'SAME TRAFFIC');

    const rows = [
      ['Vehicles cleared / hour', ai.throughputPerHour, fx.throughputPerHour, 0, false],
      ['Average speed  km/h', ai.avgSpeedKmh, fx.avgSpeedKmh, 1, false],
      ['Stopped vehicles now', ai.queue, fx.queue, 0, true],
      ['Stops per junction', ai.stopsPerJunction, fx.stopsPerJunction, 2, true]
    ];
    const colA = x + w - 168, colB = x + w - 62;

    ctx.font = `600 10.5px ${MONO}`;
    ctx.fillStyle = C.cyan;
    ctx.textAlign = 'right';
    ctx.letterSpacing = '1.2px';
    ctx.fillText('AI', colA, y + 52);
    ctx.fillStyle = C.txt3;
    ctx.fillText('FIXED', colB, y + 52);
    ctx.letterSpacing = '0px';

    let ry = y + 76;
    for (const [k, a, b, dp, lower] of rows) {
      ctx.textAlign = 'left';
      ctx.font = `400 13.5px ${SANS}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText(k, x + 20, ry);

      const better = lower ? a < b : a > b;
      ctx.textAlign = 'right';
      ctx.font = `700 15px ${MONO}`;
      ctx.fillStyle = better ? C.cyan : C.txt;
      ctx.fillText(a.toFixed(dp), colA, ry);
      ctx.font = `500 15px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(b.toFixed(dp), colB, ry);
      ry += 25;
    }
    ctx.textAlign = 'left';
  }

  // ---- control room -------------------------------------------------------
  drawChat(ctx) {
    const { x, y, w, h } = CHAT;
    panel(ctx, x, y, w, h);

    ctx.fillStyle = C.cyan;
    ctx.beginPath();
    ctx.arc(x + 22, y + 24, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 12px ${MONO}`;
    ctx.letterSpacing = '1.6px';
    ctx.fillStyle = C.txt2;
    ctx.fillText('CONTROL ROOM', x + 34, y + 28);
    ctx.letterSpacing = '0px';
    ctx.font = `400 11.5px ${SANS}`;
    ctx.fillStyle = C.txt3;
    ctx.textAlign = 'right';
    ctx.fillText('what the junctions say to each other', x + w - 20, y + 28);
    ctx.textAlign = 'left';
    ctx.strokeStyle = C.line2;
    ctx.beginPath();
    ctx.moveTo(x + 20, y + 40.5);
    ctx.lineTo(x + w - 20, y + 40.5);
    ctx.stroke();

    ctx.save();
    roundRect(ctx, x + 1, y + 44, w - 2, h - 46, 9);
    ctx.clip();

    // newest at the top, oldest fading out at the bottom
    let my = y + 62;
    const list = this.msgs.slice().reverse();
    const iw = w - 40;

    for (const m of list) {
      if (my > y + h - 26) break;
      const top = my;

      if (m.kind === 'laya') {
        ctx.fillStyle = 'rgba(166,123,255,0.14)';
        roundRect(ctx, x + 20, top - 13, 19, 19, 5);
        ctx.fill();
        ctx.font = `700 11px ${MONO}`;
        ctx.fillStyle = C.violet;
        ctx.fillText('L', x + 26, top + 1);

        ctx.font = `600 12px ${MONO}`;
        ctx.fillStyle = C.violet;
        ctx.fillText('LAYA', x + 46, top);
        ctx.font = `400 11.5px ${SANS}`;
        ctx.fillStyle = C.txt3;
        ctx.fillText(m.where || '', x + 88, top);

        ctx.font = `600 14px ${SANS}`;
        ctx.fillStyle = C.txt;
        ctx.fillText(m.text, x + 46, top + 21);
        if (m.p !== null) {
          const tw = ctx.measureText(m.text).width;
          ctx.font = `500 11.5px ${MONO}`;
          ctx.fillStyle = C.violet;
          ctx.fillText(`p=${m.p.toFixed(2)}`, x + 54 + tw, top + 21);
        }
        ctx.font = `400 12px ${SANS}`;
        ctx.fillStyle = C.txt3;
        my = wrap(ctx, m.sub, x + 46, top + 39, iw - 26, 16, 1) + 14;
      } else {
        ctx.font = `600 12px ${MONO}`;
        ctx.fillStyle = C.blue;
        ctx.fillText(m.from, x + 20, top);
        const fw = ctx.measureText(m.from).width;
        ctx.fillStyle = C.txt3;
        ctx.fillText('→', x + 26 + fw, top);
        ctx.fillStyle = C.blue;
        ctx.fillText(m.to, x + 42 + fw, top);

        ctx.font = `400 13.5px ${SANS}`;
        ctx.fillStyle = C.txt;
        my = wrap(ctx, m.text, x + 20, top + 20, iw, 18, 3) + 16;
      }

      ctx.strokeStyle = 'rgba(31,45,66,0.55)';
      ctx.beginPath();
      ctx.moveTo(x + 20, my - 9.5);
      ctx.lineTo(x + w - 20, my - 9.5);
      ctx.stroke();
    }

    // fade the bottom so clipped messages do not look cut off
    const fg = ctx.createLinearGradient(0, y + h - 96, 0, y + h);
    fg.addColorStop(0, 'rgba(9,14,23,0)');
    fg.addColorStop(1, 'rgba(9,14,23,0.95)');
    ctx.fillStyle = fg;
    ctx.fillRect(x + 1, y + h - 96, w - 2, 95);
    ctx.restore();
  }

  // ---- the four approach cameras ------------------------------------------
  drawFeeds(ctx, shown, node) {
    if (!node) return;
    const ctrl = this.app.ai.controllers.find(c => c.node.id === node.id);

    ctx.font = `600 12px ${MONO}`;
    ctx.fillStyle = C.txt3;
    ctx.letterSpacing = '1.6px';
    ctx.fillText(`${node.name.toUpperCase()}  ·  FOUR APPROACH CAMERAS`, FEED.x0, FEED.y - 16);
    ctx.letterSpacing = '0px';

    for (const s of shown) {
      const { x, y, w, h } = s.rect;
      const vc = this.app.ai.vision.get(node, s.side);
      let state = 'red', frac = 0, left = 0;
      if (ctrl) {
        state = ctrl.stateFor(s.side, 'through');
        const serving = PHASES[ctrl.phase].heads.includes(s.side);
        if (serving && state !== 'red') {
          frac = clamp01(ctrl.timer / Math.max(ctrl.plannedGreen, 1));
          left = Math.max(0, ctrl.plannedGreen - ctrl.timer);
        }
      }
      const col = state === 'green' ? C.green : state === 'yellow' ? C.amber : C.red;

      // frame
      ctx.strokeStyle = state === 'green' ? 'rgba(61,220,132,0.75)' : C.line;
      ctx.lineWidth = state === 'green' ? 2 : 1;
      roundRect(ctx, x - 0.5, y - 0.5, w + 1, h + 1, 7);
      ctx.stroke();

      // header inside the top of the picture
      ctx.fillStyle = 'rgba(4,8,14,0.78)';
      ctx.fillRect(x, y, w, 24);
      ctx.font = `600 11.5px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.letterSpacing = '1.1px';
      ctx.fillText(SIDE_FULL[s.side], x + 9, y + 16);
      ctx.letterSpacing = '0px';

      ctx.textAlign = 'right';
      ctx.fillStyle = col;
      ctx.font = `700 11.5px ${MONO}`;
      ctx.fillText(state === 'green' ? `GREEN  ${left.toFixed(0)}s`
        : state === 'yellow' ? 'CHANGING' : 'RED', x + w - 9, y + 16);
      ctx.textAlign = 'left';

      // footer: what the camera counted, and the green's progress
      ctx.fillStyle = 'rgba(4,8,14,0.80)';
      ctx.fillRect(x, y + h - 26, w, 26);
      ctx.font = `500 11.5px ${MONO}`;
      ctx.fillStyle = C.txt2;
      const q = vc ? vc.queue : 0, c = vc ? vc.count : 0;
      ctx.fillText(`${c} seen  ·  ${q} waiting`, x + 9, y + h - 9);

      if (state === 'green') {
        bar(ctx, x + w - 82, y + h - 16, 72, 5, frac, C.green, 'rgba(255,255,255,0.12)');
      }

      // a bold light chip, so the state reads at a glance on a phone
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x + w - 15, y + h - 34, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- caption -------------------------------------------------------------
  drawCaption(ctx, shot, local) {
    const { x, y, w } = CAP;
    // Captions that simply appear read as a slide deck. A short rise and fade
    // reads as film, and costs one transform.
    const e = smooth(clamp01(local / 0.62));
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(0, (1 - e) * 22);
    let cy = y;

    // Body copy over a sunlit rooftop is unreadable at phone size, and a drop
    // shadow alone does not carry it. A gradient anchored to the left edge
    // darkens only the column the text occupies.
    const sc = ctx.createLinearGradient(0, 0, w * 0.96, 0);
    sc.addColorStop(0, 'rgba(3,6,12,0.70)');
    sc.addColorStop(0.55, 'rgba(3,6,12,0.44)');
    sc.addColorStop(1, 'rgba(3,6,12,0)');
    ctx.fillStyle = sc;
    ctx.fillRect(0, y - 52, w * 0.96, 232);

    if (shot.kicker) {
      ctx.font = `700 13px ${MONO}`;
      ctx.letterSpacing = '4px';
      ctx.fillStyle = C.cyan;
      ctx.fillText(shot.kicker, x + 14, cy);
      ctx.letterSpacing = '0px';
      cy += 30;
    }

    ctx.font = `700 40px ${SANS}`;
    ctx.fillStyle = C.txt;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 16;
    cy = wrap(ctx, shot.title, x + 14, cy + 10, w - 20, 46, 2);
    ctx.shadowBlur = 0;

    ctx.font = `400 19px ${SANS}`;
    ctx.fillStyle = C.txt2;
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 12;
    cy = wrap(ctx, shot.text, x + 14, cy + 16, w - 20, 27, 3);
    ctx.shadowBlur = 0;

    // accent rule down the left of the caption, drawn last so it wipes in
    ctx.fillStyle = C.cyan;
    ctx.fillRect(x, y - 14, 3, (cy - y + 4) * e);
    ctx.restore();
  }

  // --------------------------------------------------------------------------
  //  Probe: one representative frame per shot, written as n = 0..shots-1.
  //  A full shoot is thousands of frames; this checks that every panel in the
  //  overlay lands where it should, in well under a minute.
  // --------------------------------------------------------------------------
  async probe() {
    this.prepare();
    let acc = 0;
    for (let s = 0; s < this.shots.length; s++) {
      const sh = this.shots[s];
      // jump the frame clock to 62% through this shot, so the camera is where
      // the shot actually sits rather than still easing in from the last one
      const i = Math.round((acc + sh.dur * 0.62) * FPS);
      acc += sh.dur;
      this.lastShot = -1;
      // settle: let queues build and the message log fill before the picture
      for (let k = 0; k < 70; k++) {
        this.app.schedule.ensure(this.app.ai.t);
        this.app.ai.step(1 / FPS);
        this.app.baseline.step(1 / FPS);
        this.simTime += 1 / FPS;
      }
      await this.frame(i);
      await this.ship(s);
      await new Promise(r => setTimeout(r, 0));
    }
    this.teardown();
    return this.shots.length;
  }

  // ==========================================================================
  async run(onProgress) {
    this.prepare();
    await fetch(`${SINK}/begin`, { method: 'POST' });

    for (let i = 0; i < this.frames; i++) {
      await this.frame(i);
      if (i % 15 === 0) {
        onProgress && onProgress(i, this.frames);
        await new Promise(r => setTimeout(r, 0));   // let the tab breathe
      }
    }

    await fetch(`${SINK}/end`, { method: 'POST' });
    this.teardown();
    return this.frames;
  }
}
