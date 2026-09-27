// ============================================================================
//  Demo reel.
//
//  A scripted sixty-second tour of the project, with camera moves, captions and
//  a one-click screen recording. Made for posting: someone scrolling LinkedIn
//  has no context, so every beat states what it is showing in plain words, and
//  the shots are slow enough to read.
//
//  The recording uses getDisplayMedia, so the whole interface is captured, not
//  just the 3D canvas. Choosing "this tab" when the browser asks gives the
//  cleanest result.
// ============================================================================

import * as THREE from 'three';

const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------------------
//  The script. Positions are derived from the network so the reel survives any
//  change to the layout.
// ---------------------------------------------------------------------------
function beats(app) {
  const net = app.ai.net;
  const byId = net.byId;
  const cyber = net.signals.find(n => n.name === 'Cyber Towers') || net.signals[1];
  const shilpa = net.signals.find(n => n.name === 'Shilpa Layout') || net.signals[4];
  const durgam = net.signals.find(n => n.name === 'Durgam Cheruvu') || net.signals[5];
  const span = Math.max(net.extent.x, net.extent.z);

  const at = (n, dx, dy, dz) => ({
    pos: new THREE.Vector3(n.pos.x + dx, dy, n.pos.z + dz),
    target: new THREE.Vector3(n.pos.x, 2, n.pos.z)
  });

  return [
    {
      t: 7,
      title: 'ARTERIA',
      text: 'Traffic signals that decide their own timing. HITEC City, Hyderabad.',
      cam: {
        pos: new THREE.Vector3(span * 0.44, span * 0.36, span * 0.62),
        target: new THREE.Vector3(0, 0, 0)
      }
    },
    {
      t: 8,
      title: 'Six junctions',
      text: 'Kothaguda, Cyber Towers, Mindspace, Botanical Garden, Shilpa Layout, Durgam Cheruvu.',
      cam: {
        pos: new THREE.Vector3(-span * 0.40, span * 0.30, span * 0.58),
        target: new THREE.Vector3(0, 0, 0)
      }
    },
    {
      t: 8,
      title: 'Every approach has a camera',
      text: 'Ten times a second it counts what is waiting, and how long it has waited.',
      action: () => app.selectJunction(shilpa.id),
      cam: at(shilpa, 66, 27, 9)
    },
    {
      t: 8,
      title: 'One road green at a time',
      text: 'The green is sized from the measured queue, then cut short the moment the road clears.',
      cam: at(shilpa, -52, 20, 44)
    },
    {
      t: 8,
      title: 'Junctions warn each other',
      text: 'Releasing a queue sends the next junction a heads-up, so its green can be ready.',
      action: () => app.selectJunction(cyber.id),
      cam: at(cyber, 78, 40, 96)
    },
    {
      t: 8,
      title: 'Rush hour',
      text: 'A fixed timer shows green to an empty road about a third of the time. That is the waste.',
      action: () => { app.setProfile('peak'); markProfile('peak'); },
      cam: at(durgam, -120, 58, 120)
    },
    {
      t: 8,
      title: 'Event egress',
      text: 'Sharply one-directional demand: the case a fixed plan cannot see coming.',
      action: () => { app.setProfile('surge'); markProfile('surge'); },
      cam: {
        pos: new THREE.Vector3(span * 0.30, span * 0.22, -span * 0.44),
        target: new THREE.Vector3(0, 0, 0)
      }
    },
    {
      t: 9,
      title: 'The result',
      text: 'Both systems run at once on identical traffic. Read the number on the left.',
      action: () => { app.setProfile('normal'); markProfile('normal'); },
      cam: {
        pos: new THREE.Vector3(span * 0.38, span * 0.30, span * 0.56),
        target: new THREE.Vector3(0, 0, 0)
      }
    }
  ];
}

function markProfile(key) {
  const seg = document.getElementById('segProfile');
  if (!seg) return;
  [...seg.children].forEach(b => b.classList.toggle('on', b.dataset.p === key));
}

// ---------------------------------------------------------------------------
export class Reel {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.recorder = null;
    this.chunks = [];
    this.buildDom();
  }

  buildDom() {
    const stage = document.getElementById('stage');
    const el = document.createElement('div');
    el.className = 'reel';
    el.innerHTML = `
      <div class="reel-caption">
        <div class="reel-title"></div>
        <div class="reel-text"></div>
      </div>
      <div class="reel-bar"><i></i></div>
      <div class="reel-brand">ARTERIA &middot; adaptive signal control</div>`;
    stage.appendChild(el);
    this.el = el;
    this.titleEl = el.querySelector('.reel-title');
    this.textEl = el.querySelector('.reel-text');
    this.barEl = el.querySelector('.reel-bar i');
  }

  // ---- recording ----------------------------------------------------------
  async startRecording() {
    if (!navigator.mediaDevices?.getDisplayMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: false,
        preferCurrentTab: true
      });
      const types = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
      ];
      const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
      this.chunks = [];
      this.recorder = new MediaRecorder(stream, {
        mimeType, videoBitsPerSecond: 12_000_000
      });
      this.recorder.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
      this.recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this.chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `arteria-demo-${new Date().toISOString().slice(0, 10)}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      // if the user stops sharing from the browser's own bar, end the reel too
      stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());
      this.recorder.start(1000);
      return true;
    } catch {
      return false;                       // user cancelled the picker
    }
  }

  // ---- the tour -----------------------------------------------------------
  async run({ record = true } = {}) {
    if (this.running) { this.stop(); return; }
    const app = this.app;
    this.running = true;
    this.el.classList.add('on');
    document.body.classList.add('reel-mode');

    if (record) {
      const ok = await this.startRecording();
      if (!ok) {
        // recording declined: still run the tour, it is worth watching
        this.recorder = null;
      }
      // give the picker's own UI a moment to disappear before the first beat
      await wait(700);
    }

    const script = beats(app);
    const total = script.reduce((s, b) => s + b.t, 0);
    app.world.controls.enabled = false;
    app.reelActive = true;

    const fromPos = app.world.camera.position.clone();
    const fromTgt = app.world.controls.target.clone();
    let elapsed = 0;

    for (let i = 0; i < script.length && this.running; i++) {
      const b = script[i];
      if (b.action) { try { b.action(); } catch {} }
      this.show(b);

      const p0 = i === 0 ? fromPos : script[i - 1].cam.pos;
      const t0 = i === 0 ? fromTgt : script[i - 1].cam.target;
      const start = performance.now();

      while (this.running) {
        const dt = (performance.now() - start) / 1000;
        const k = Math.min(1, dt / b.t);
        const e = ease(k);
        app.world.camera.position.lerpVectors(p0, b.cam.pos, e);
        app.world.controls.target.lerpVectors(t0, b.cam.target, e);
        app.world.camera.lookAt(app.world.controls.target);
        this.barEl.style.width = `${((elapsed + dt) / total) * 100}%`;
        if (k >= 1) break;
        await frame();
      }
      elapsed += b.t;
    }

    if (this.running) await wait(1200);
    this.stop();
  }

  show(b) {
    this.titleEl.textContent = b.title;
    this.textEl.textContent = b.text;
    const cap = this.el.querySelector('.reel-caption');
    cap.classList.remove('in');
    void cap.offsetWidth;                 // restart the animation
    cap.classList.add('in');
  }

  stop() {
    this.running = false;
    this.el.classList.remove('on');
    document.body.classList.remove('reel-mode');
    this.app.reelActive = false;
    this.app.world.controls.enabled = true;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    const btn = document.getElementById('btnReel');
    if (btn) { btn.classList.remove('on'); btn.textContent = 'RECORD DEMO'; }
  }
}

const frame = () => new Promise(r => requestAnimationFrame(r));
const wait = ms => new Promise(r => setTimeout(r, ms));
