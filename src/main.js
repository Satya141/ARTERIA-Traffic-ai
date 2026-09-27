import * as THREE from 'three';
import { CFG, FILM } from './core/config.js';
import { buildNetwork } from './sim/network.js';
import { Simulation } from './sim/simulation.js';
import { DemandSchedule, PROFILES } from './sim/demand.js';
import { World } from './render/world.js';
import { buildCity, updateCityLighting } from './render/city.js';
import { VehicleRenderer } from './render/vehicles.js';
import { Crowd } from './render/pedestrians.js';
import { SignalRenderer, makeJunctionLabels } from './render/signals.js';
import { VisionFeed } from './ui/visionfeed.js';
import { Hud } from './ui/hud.js';
import { Reel } from './ui/reel.js';
import { LayaClient } from './ai/laya.js';

// ============================================================================
//  ARTERIA — application shell.
//
//  Two worlds run in lockstep on one shared demand schedule:
//    ai       — density-adaptive control with V2I corridor coordination (drawn)
//    baseline — a well-tuned fixed-time plan (headless, for the comparison)
// ============================================================================

const VIEWS = ['ORBIT', 'CORRIDOR', 'JUNCTION', 'DRIVER'];
const VIEW_LABEL = { ORBIT: 'WHOLE CITY', CORRIDOR: 'MAIN ROAD', JUNCTION: 'THIS JUNCTION', DRIVER: 'RIDE ALONG' };
// Late morning. Earlier than this and the towers throw long shadows straight
// down the streets, which is accurate but leaves the junctions in the dark.
const MORNING_HOUR = 10.9;

class App {
  constructor() {
    this.speed = 1;
    // Lighting is locked to mid-morning. A moving sun looked good in a video
    // but made the network harder to read, and the point of this view is to
    // watch traffic behaviour, not weather.
    this.hour = MORNING_HOUR;
    this.viewIndex = 0;
    this.selected = null;
    this.accum = 0;
    this.time = 0;
    this.stageSize = { w: 0, h: 0 };
    this.chase = null;
  }

  async boot() {
    const step = t => { document.getElementById('bootStep').textContent = t; };
    step('building road network');
    await frame();

    this.schedule = new DemandSchedule(buildNetwork());
    this.schedule.setProfile('normal');

    // Laya runs as a local sidecar. If it is not up, `available` stays false
    // and every controller quietly uses its own heuristic instead.
    this.laya = new LayaClient();
    this.laya.probe();

    this.ai = new Simulation({
      schedule: this.schedule, mode: 'adaptive', label: 'AI', laya: this.laya
    });
    this.baseline = new Simulation({ schedule: this.schedule, mode: 'fixed', label: 'FIXED' });
    this.selected = this.ai.net.signals[Math.floor(this.ai.net.signals.length / 2)].id;

    step('raising the city');
    await frame();
    const canvas = document.getElementById('scene');
    this.world = new World(canvas, this.ai.net.extent);
    this.city = buildCity(this.world.scene, this.ai.net, this.ai.net.extent);

    step('placing signals and cameras');
    await frame();
    this.signals = new SignalRenderer(this.world.scene, this.ai.net);
    this.labels = makeJunctionLabels(this.world.scene, this.ai.net);
    this.vehicles = new VehicleRenderer(this.world.scene);
    this.crowd = new Crowd(this.world.scene, this.city.walkLines);
    this.feed = new VisionFeed(this.ai.net);

    step('warming the controllers');
    await frame();
    // Headless warm-up before the first frame. This is not cosmetic: the
    // comparison against the baseline is meaningless until both networks have
    // filled and their queues have reached a steady state, and a short warm-up
    // produces wildly flattering numbers that then drift for minutes.
    const WARMUP = 240;
    for (let i = 0; i < WARMUP * 30; i++) {
      this.schedule.ensure(this.ai.t);
      this.ai.step(1 / 30);
      this.baseline.step(1 / 30);
      if (i % 2400 === 0) step(`warming the controllers  ${Math.round((i / (WARMUP * 30)) * 100)}%`);
    }
    this.ai.events.length = 0;

    step('starting render loop');
    await frame();
    this.overlay = document.getElementById('overlay');
    this.octx = this.overlay.getContext('2d');
    this.reel = new Reel(this);
    this.hud = new Hud(this);
    this.frameNetwork();
    this.setHour(this.hour);
    // Bake the sky into a reflection probe once the sun is in position. Every
    // metal, glass and painted surface samples this; without it they have
    // nothing to reflect and render flat.
    this.world.buildEnvironment();
    this.bindPicking(canvas);

    setTimeout(() => {
      const h = document.getElementById('hint');
      if (h) h.classList.add('gone');
    }, 9000);

    document.getElementById('app').hidden = false;
    // Size the renderer only once the layout is actually on screen. Measuring
    // while #app is still hidden yields 0x0 and leaves the post-processing
    // chain with zero-size framebuffers, which WebGL rejects every frame.
    this.resize();
    addEventListener('resize', () => this.resize());
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(document.getElementById('stage'));
    }
    document.getElementById('boot').classList.add('gone');
    setTimeout(() => document.getElementById('boot').remove(), 700);

    this.last = performance.now();
    if (FILM) { this.film(); return; }
    requestAnimationFrame(t => this.loop(t));
  }

  // ---- offline film render (?film=1) ---------------------------------------
  //  Renders a 1920x1080 / 30 fps explainer frame by frame to disk instead of
  //  running the interactive loop. See src/ui/film.js for why this is not a
  //  screen recording.
  async film() {
    const note = document.createElement('div');
    note.id = 'filmNote';
    note.textContent = 'waiting for the decision engine';
    document.body.appendChild(note);

    // Give the Laya sidecar a moment to answer its first round, so the control
    // room panel has real decision records in it from the opening frame rather
    // than filling up thirty seconds in.
    for (let i = 0; i < 60 && !this.laya.available; i++) {
      this.laya.maybeProbe && this.laya.maybeProbe();
      await new Promise(r => setTimeout(r, 200));
      if (this.laya.status && this.laya.status !== 'checking' && !this.laya.available) break;
    }

    await (document.fonts ? document.fonts.ready : Promise.resolve());
    const { Film } = await import('./ui/film.js');
    const film = new Film(this);
    window.__film = film;

    if (new URLSearchParams(location.search).has('probe')) {
      note.textContent = 'probing layout';
      const n = await film.probe();
      note.textContent = `probe done — ${n} sample frames`;
      window.__filmDone = n;
      return;
    }

    const t0 = performance.now();
    await film.run((i, n) => {
      const secs = (performance.now() - t0) / 1000;
      const eta = i ? (secs / i) * (n - i) : 0;
      note.textContent =
        `filming  ${i}/${n}   ${(i / 30).toFixed(1)}s of video   eta ${Math.round(eta)}s`;
    });
    note.textContent = `done — ${film.frames} frames written`;
    window.__filmDone = film.frames;
  }

  // ---- interaction ---------------------------------------------------------
  bindPicking(canvas) {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    canvas.addEventListener('pointerdown', e => {
      const r = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ndc, this.world.camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(plane, hit)) return;
      // Pick tolerance scales with how far out the camera is, so a junction is
      // as easy to hit zoomed out over the whole network as it is up close.
      // Junctions are 230 m apart, so staying under ~115 m is unambiguous.
      const camDist = this.world.camera.position.distanceTo(this.world.controls.target);
      let best = null, bestD = Math.min(110, Math.max(55, camDist * 0.12));
      for (const n of this.ai.net.signals) {
        const d = Math.hypot(n.pos.x - hit.x, n.pos.z - hit.z);
        if (d < bestD) { bestD = d; best = n; }
      }
      if (best) this.selectJunction(best.id);
    });

    addEventListener('keydown', e => {
      // space still pauses, it just no longer has a control of its own
      if (e.key === ' ') { e.preventDefault(); this.speed = this.speed ? 0 : 1; }
      if (e.key === 'v') this.cycleView();
    });
  }

  selectJunction(id) {
    this.selected = id;
    const hint = document.getElementById('hint');
    if (hint) hint.classList.add('gone');
    if (VIEWS[this.viewIndex] === 'JUNCTION') this.frameJunction();
  }

  setProfile(key) {
    this.schedule.setProfile(key);
    const p = PROFILES[key];
    if (p) this.pushBanner(`${p.label} — ${p.note}`);
  }

  pushBanner(text) {
    this.hud && this.hud.pushAlert({ kind: 'good', text, level: 'info' });
  }

  toggleCoordination() {
    const on = !this.ai.coordination;
    this.ai.coordination = on;
    for (const c of this.ai.controllers) c.useCoord = on;
    this.pushBanner(on
      ? 'V2I corridor coordination ENABLED — junctions now advertise platoons downstream'
      : 'V2I corridor coordination DISABLED — junctions now act in isolation');
  }

  setHour(h) {
    this.hour = h;
    this.world.setHour(h);
  }

  cycleView() {
    this.viewIndex = (this.viewIndex + 1) % VIEWS.length;
    const v = VIEWS[this.viewIndex];
    document.getElementById('btnView').textContent = `VIEW: ${VIEW_LABEL[v]}`;
    const ctr = this.world.controls;
    const span = Math.max(this.ai.net.extent.x, this.ai.net.extent.z);
    this.chase = null;

    if (v === 'ORBIT') {
      this.frameNetwork();
      ctr.enabled = true;
    } else if (v === 'CORRIDOR') {
      const row = this.ai.net.signals.filter(n => n.gj === 0);
      const mid = row[Math.floor(row.length / 2)];
      ctr.target.set(mid.pos.x, 2, mid.pos.z);
      // down the arterial itself, low enough to read the traffic on it
      this.world.camera.position.set(mid.pos.x - CFG.grid.spacing * 1.35, 34, mid.pos.z + 14);
      ctr.enabled = true;
    } else if (v === 'JUNCTION') {
      this.frameJunction();
      ctr.enabled = true;
    } else {
      // DRIVER: ride along with a vehicle on the arterial
      ctr.enabled = false;
      this.pickChase();
    }
  }

  // ---------------------------------------------------------------------------
  //  Pull the camera back until every junction is inside the part of the stage
  //  that is actually free. A hard-coded distance looked fine on one window
  //  size and left half the network off-screen on another, with the remaining
  //  junctions sitting underneath the overlay panels where they could not even
  //  be clicked.
  // ---------------------------------------------------------------------------
  frameNetwork() {
    const cam = this.world.camera;
    const ctr = this.world.controls;
    const target = new THREE.Vector3(0, 0, 0);
    const dir = new THREE.Vector3(0.40, 0.33, 0.58).normalize();
    const pts = this.ai.net.signals.map(n => new THREE.Vector3(n.pos.x, 0, n.pos.z));

    // Fit into the clear band above the panels that float along the bottom of
    // the stage. Testing every junction against every panel rectangle was the
    // obvious thing to do and was wrong: with a panel in each bottom corner the
    // only way to satisfy it is to retreat until the city is a postage stamp.
    // Constraining to the band keeps the network large and still clickable.
    const BOX = { x0: 0.06, x1: 0.94, y0: 0.07, y1: 0.58 };

    ctr.target.copy(target);
    let d = 240;
    for (let i = 0; i < 70; i++) {
      cam.position.copy(dir).multiplyScalar(d).add(target);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();

      let fits = true;
      for (const p of pts) {
        const v = p.clone().project(cam);
        const nx = v.x * 0.5 + 0.5, ny = -v.y * 0.5 + 0.5;
        if (v.z > 1 || nx < BOX.x0 || nx > BOX.x1 || ny < BOX.y0 || ny > BOX.y1) {
          fits = false; break;
        }
      }
      if (fits) break;
      d *= 1.04;
      if (d > 2600) break;
    }
    this.orbitDistance = d;
  }

  // Sit over the carriageway, not over the block. A diagonal offset put the
  // camera inside whatever building occupied the corner and filled the screen
  // with a parapet.
  frameJunction() {
    const n = this.ai.net.byId[this.selected];
    if (!n) return;
    this.world.controls.target.set(n.pos.x, 2, n.pos.z);
    this.world.camera.position.set(n.pos.x + 66, 27, n.pos.z + 9);
  }

  pickChase() {
    const pool = this.ai.vehicles.filter(v =>
      v.state === 'link' && v.lane && v.lane.link.isArterial && v.cls !== 'bike');
    this.chase = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  // ---- layout --------------------------------------------------------------
  resize() {
    // The film renderer owns the drawing buffer while it is running: it is a
    // fixed 1920x1080 at pixel ratio 1, and a stray layout event resizing it
    // mid-shoot would change the frame size halfway through the sequence.
    if (this._filming) return;
    const stage = document.getElementById('stage');
    const w = stage.clientWidth, h = stage.clientHeight;
    if (w < 2 || h < 2) return;                  // not laid out yet
    if (this.stageSize && this.stageSize.w === w && this.stageSize.h === h) return;
    this.world.resize(w, h);
    const dpr = Math.min(devicePixelRatio, 2);
    this.overlay.width = w * dpr;
    this.overlay.height = h * dpr;
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.stageSize = { w, h };
    if (this.hud && VIEWS[this.viewIndex] === 'ORBIT') this.frameNetwork();
  }

  // ---- main loop -----------------------------------------------------------
  loop(now) {
    requestAnimationFrame(t => this.loop(t));
    const real = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += real;

    // Fixed-step physics so behaviour is identical regardless of frame rate,
    // with a work cap so a slow machine degrades to slow motion rather than
    // freezing while it tries to catch up.
    const dt = CFG.sim.dt;
    this.accum += real * this.speed;
    let steps = 0;
    const maxSteps = Math.ceil((CFG.sim.maxSpeedMultiplier * 1.4) / (dt * 60));
    while (this.accum >= dt && steps < maxSteps * 6) {
      this.schedule.ensure(this.ai.t);
      this.ai.step(dt);
      this.baseline.step(dt);
      this.accum -= dt;
      steps++;
    }
    if (this.accum > dt * 8) this.accum = 0;

    this.updateCamera(real);
    this.vehicles.sync(this.ai.vehicles, this.world.nightFactor, this.time);
    this.crowd.update(real * (this.speed ? 1 : 0), this.time);
    this.signals.update(this.ai, this.time, this.world.nightFactor, this.selected);
    updateCityLighting(this.city.group, this.world.nightFactor, this.time);
    this.updateLabels();

    this.world.render();
    this.renderFeed();
    this.hud.update(this, real);
  }

  updateCamera(dt) {
    if (this.reelActive) return;          // the reel owns the camera
    if (VIEWS[this.viewIndex] !== 'DRIVER') return;
    if (!this.chase || this.chase.state === 'done' || !this.ai.vehicles.includes(this.chase)) this.pickChase();
    const v = this.chase;
    if (!v) return;
    const back = 13, up = 5.2;
    const tx = v.x - Math.sin(v.heading) * back;
    const tz = v.z - Math.cos(v.heading) * back;
    const cam = this.world.camera;
    cam.position.lerp(new THREE.Vector3(tx, up, tz), Math.min(1, dt * 3.4));
    const look = new THREE.Vector3(v.x + Math.sin(v.heading) * 16, 1.6, v.z + Math.cos(v.heading) * 16);
    this.world.controls.target.lerp(look, Math.min(1, dt * 3.4));
    cam.lookAt(this.world.controls.target);
  }

  // Labels are billboards in world space, so without this they balloon as the
  // camera moves in. Scaling by distance keeps them a constant size on screen.
  updateLabels() {
    const cam = this.world.camera;
    const driving = VIEWS[this.viewIndex] === 'DRIVER';
    for (const l of this.labels) {
      const sel = l.node.id === this.selected;
      const d = Math.hypot(cam.position.x - l.node.pos.x, cam.position.y - 26, cam.position.z - l.node.pos.z);
      l.sprite.visible = !driving && d < 1200;
      l.sprite.material.opacity = sel ? 0.96 : 0.45;
      const s = Math.max(9, d * 0.052) * (sel ? 1.18 : 1);
      l.sprite.scale.set(s * 2.2, s * 0.44, 1);
    }
  }

  // Render the four approach cameras of the selected junction, each into its
  // own slot in the detail strip. These are scissored insets of the same scene,
  // so they cost four extra scene renders and no render targets.
  renderFeed() {
    const node = this.ai.net.byId[this.selected];
    if (!node || this.stageSize.h < 2) return;
    const stage = document.getElementById('stage').getBoundingClientRect();
    const h = this.stageSize.h;
    this.feed.clearRects();

    const shown = [];
    for (const side of ['N', 'E', 'S', 'W']) {
      const slot = document.querySelector(`.road-slot[data-h="${side}"]`);
      if (!slot || !node.in[side]) continue;
      const r = slot.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      // The detail strip sits below the stage, so its slots are in a different
      // element. Draw into the stage canvas only where the two overlap.
      const rect = {
        x: Math.round(r.left - stage.left),
        y: Math.round(r.top - stage.top),
        w: Math.round(r.width),
        h: Math.round(r.height)
      };
      shown.push({ side, rect });
    }

    for (const s of shown) {
      this.feed.renderInset(this.world.renderer, this.world.scene, node, s.side, s.rect, h);
    }

    this.octx.clearRect(0, 0, this.stageSize.w, this.stageSize.h);
    for (const s of shown) {
      const vcam = this.ai.vision.get(node, s.side);
      this.feed.drawOverlay(this.octx, node, s.side, vcam, this.time, true);
    }
  }
}

const frame = () => new Promise(r => setTimeout(r, 24));

const app = new App();
window.__arteria = app;
app.boot().catch(err => {
  console.error(err);
  document.getElementById('bootStep').textContent = 'failed: ' + err.message;
});
