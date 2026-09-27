import * as THREE from 'three';
import { CFG, HEADINGS } from '../core/config.js';

// ============================================================================
//  Approach camera feeds.
//
//  Each approach has its own perspective camera sitting on the signal mast arm.
//  Feeds are drawn as picture-in-picture insets using the main renderer's
//  scissor rectangle — no extra render targets and no pixel readback — so all
//  four approaches of a junction can be shown live at once.
//
//  Detection boxes are projected through the same camera and drawn on the HTML
//  overlay. They are drawn from what the VISION SYSTEM reported, not from the
//  simulation: when the detector drops a vehicle its box disappears, which is
//  the honest picture of what the controller is actually working from.
// ============================================================================

const CLASS_COLOR = {
  car: '#35e6d0',
  'auto-rickshaw': '#ffb020',
  motorcycle: '#a67bff',
  bus: '#4aa8ff',
  truck: '#7fb3ff',
  emergency: '#ff4d5e'
};

export const SIDE_NAME = { N: 'NORTH', E: 'EAST', S: 'SOUTH', W: 'WEST' };

export class VisionFeed {
  constructor(net) {
    this.net = net;
    this.cameras = new Map();
    this.v = new THREE.Vector3();
    this.lastRect = new Map();
  }

  cameraFor(node, heading) {
    const key = `${node.id}-${heading}`;
    let cam = this.cameras.get(key);
    if (!cam) {
      // a short far plane keeps these four extra renders cheap: an approach
      // camera only ever needs to see a couple of blocks up its own road
      cam = new THREE.PerspectiveCamera(CFG.vision.fovDeg, 16 / 9, 0.6, 430);
      this.cameras.set(key, cam);
    }
    const link = node.in[heading];
    if (!link) return null;
    const f = HEADINGS[heading];
    const r = link.r;
    const lat = (CFG.lanesPerDir * CFG.laneWidth) / 2;
    const { mountHeight, aimDistance, standOff, aimOffset } = CFG.vision;
    // Mounted past the junction looking back along its own approach, so the
    // stop line sits at the bottom of frame and the queue runs away from the
    // lens. Aimed slightly kerbside to keep the opposing carriageway out.
    cam.position.set(
      link.p1.x + r.x * lat + f.x * standOff, mountHeight,
      link.p1.z + r.z * lat + f.z * standOff);
    cam.lookAt(
      link.p1.x - f.x * aimDistance + r.x * (lat + aimOffset), 0.6,
      link.p1.z - f.z * aimDistance + r.z * (lat + aimOffset));
    cam.updateMatrixWorld();
    return cam;
  }

  // Draw one inset straight into the main canvas.
  renderInset(renderer, scene, node, heading, rect, canvasH) {
    const cam = this.cameraFor(node, heading);
    if (!cam || rect.w < 8 || rect.h < 8) return;
    cam.aspect = rect.w / rect.h;
    cam.updateProjectionMatrix();
    this.lastRect.set(`${node.id}-${heading}`, { ...rect, cam });

    // three.js applies the pixel ratio itself, so these stay in CSS pixels.
    const y = canvasH - rect.y - rect.h;          // WebGL origin is bottom-left
    renderer.setScissorTest(true);
    renderer.setViewport(rect.x, y, rect.w, rect.h);
    renderer.setScissor(rect.x, y, rect.w, rect.h);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, cam);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setViewport(0, 0, size.x, size.y);
  }

  project(cam, rect, x, y, z) {
    this.v.set(x, y, z).project(cam);
    return {
      x: rect.x + (this.v.x * 0.5 + 0.5) * rect.w,
      y: rect.y + (-this.v.y * 0.5 + 0.5) * rect.h,
      z: this.v.z
    };
  }

  boxFor(cam, rect, d) {
    const hw = d.w / 2, hl = d.l / 2, hh = d.h;
    const cos = Math.cos(d.heading), sin = Math.sin(d.heading);
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, ok = false;
    for (let i = 0; i < 8; i++) {
      const sx = (i & 1) ? hw : -hw;
      const sz = (i & 2) ? hl : -hl;
      const sy = (i & 4) ? hh : 0.05;
      const p = this.project(cam, rect,
        d.x + sx * cos + sz * sin, sy, d.z - sx * sin + sz * cos);
      if (p.z > 1) continue;
      ok = true;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!ok) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ---- overlay for one feed ------------------------------------------------
  drawOverlay(ctx, node, heading, visionCam, time, compact = false) {
    const entry = this.lastRect.get(`${node.id}-${heading}`);
    if (!entry) return;
    const R = entry, cam = entry.cam;

    ctx.save();
    ctx.beginPath();
    ctx.rect(R.x, R.y, R.w, R.h);
    ctx.clip();

    // scanlines + vignette so the inset reads as a camera picture
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = '#000';
    for (let y = R.y; y < R.y + R.h; y += 3) ctx.fillRect(R.x, y, R.w, 1);
    ctx.globalAlpha = 1;

    const g = ctx.createRadialGradient(
      R.x + R.w / 2, R.y + R.h / 2, R.h * 0.22,
      R.x + R.w / 2, R.y + R.h / 2, R.h * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.40)');
    ctx.fillStyle = g;
    ctx.fillRect(R.x, R.y, R.w, R.h);

    if (visionCam) {
      const dets = visionCam.detections;
      ctx.font = '600 8.5px "JetBrains Mono", ui-monospace, monospace';
      ctx.lineWidth = compact ? 1 : 1.25;

      for (const d of dets) {
        const b = this.boxFor(cam, R, d);
        if (!b || b.w < 3 || b.h < 3) continue;
        if (b.x + b.w < R.x || b.x > R.x + R.w) continue;

        const col = CLASS_COLOR[d.label] || '#35e6d0';
        const pulse = d.emergency ? (Math.sin(time * 12) * 0.5 + 0.5) : 1;
        ctx.strokeStyle = col;
        ctx.globalAlpha = (d.stopped ? 0.95 : 0.70) * (0.55 + 0.45 * pulse);

        const c = Math.min(6, b.w * 0.34, b.h * 0.34);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + c); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x + c, b.y);
        ctx.moveTo(b.x + b.w - c, b.y); ctx.lineTo(b.x + b.w, b.y); ctx.lineTo(b.x + b.w, b.y + c);
        ctx.moveTo(b.x + b.w, b.y + b.h - c); ctx.lineTo(b.x + b.w, b.y + b.h); ctx.lineTo(b.x + b.w - c, b.y + b.h);
        ctx.moveTo(b.x + c, b.y + b.h); ctx.lineTo(b.x, b.y + b.h); ctx.lineTo(b.x, b.y + b.h - c);
        ctx.stroke();

        if (!compact && b.h > 16) {
          const label = `${d.label} ${(d.conf * 100).toFixed(0)}`;
          const tw = ctx.measureText(label).width + 7;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = 'rgba(4,8,14,.88)';
          ctx.fillRect(b.x, b.y - 11, tw, 10);
          ctx.fillStyle = col;
          ctx.globalAlpha = 1;
          ctx.fillText(label, b.x + 3.5, b.y - 3);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  clearRects() { this.lastRect.clear(); }
}
