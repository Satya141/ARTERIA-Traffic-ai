import * as THREE from 'three';
import { CFG, PHASES, HEADINGS, OPPOSITE, JUNCTION_HALF } from '../core/config.js';
import { rightVec } from '../sim/network.js';

// ============================================================================
//  Signal heads, approach cameras, and the V2I message wire.
//
//  Each approach gets a mast-arm signal with three lamps plus a small pan-tilt
//  camera housing, which is where the vision system is notionally looking from.
//  Lamp glow is unlit geometry so the bloom pass turns it into a real light
//  bleed at night without paying for six dynamic lights per junction.
// ============================================================================

const RED = new THREE.Color(0xff3b30);
const AMBER = new THREE.Color(0xffb020);
const GREEN = new THREE.Color(0x2fdc6e);
const OFF = new THREE.Color(0x141a22);

const poleMat = new THREE.MeshStandardMaterial({ color: 0x2f353d, roughness: 0.55, metalness: 0.55 });
const housingMat = new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.7, metalness: 0.3 });
const camMat = new THREE.MeshStandardMaterial({ color: 0x1b2028, roughness: 0.4, metalness: 0.6 });

export class SignalRenderer {
  constructor(scene, net) {
    this.scene = scene;
    this.net = net;
    this.heads = [];            // one per (junction, approach)
    this.group = new THREE.Group();
    this.group.name = 'signals';
    scene.add(this.group);

    const lampGeo = new THREE.SphereGeometry(0.30, 12, 10);
    const glowGeo = new THREE.SphereGeometry(0.52, 10, 8);
    const poleGeo = new THREE.CylinderGeometry(0.17, 0.24, 7.2, 8);
    const boxGeo = new THREE.BoxGeometry(0.72, 2.05, 0.46);

    for (const node of net.signals) {
      for (const h of ['N', 'S', 'E', 'W']) {
        const link = node.in[h];
        if (!link) continue;

        // The head faces the drivers on this approach, so it stands on the
        // far side of the junction, on their right.
        const f = HEADINGS[h];
        const r = rightVec(h);
        const baseX = node.pos.x - f.x * (JUNCTION_HALF + 1.2) + r.x * (JUNCTION_HALF + 2.6);
        const baseZ = node.pos.z - f.z * (JUNCTION_HALF + 1.2) + r.z * (JUNCTION_HALF + 2.6);
        const facing = Math.atan2(-f.x, -f.z);

        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(baseX, 3.6, baseZ);
        pole.castShadow = true;
        this.group.add(pole);

        // mast arm reaching out over the carriageway
        const armLen = JUNCTION_HALF + 3.0;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, armLen), poleMat);
        arm.position.set(baseX - r.x * armLen / 2, 7.0, baseZ - r.z * armLen / 2);
        arm.rotation.y = Math.atan2(-r.x, -r.z);
        this.group.add(arm);

        const hx = baseX - r.x * armLen * 0.78;
        const hz = baseZ - r.z * armLen * 0.78;

        const housing = new THREE.Mesh(boxGeo, housingMat);
        housing.position.set(hx, 5.9, hz);
        housing.rotation.y = facing;
        housing.castShadow = true;
        this.group.add(housing);

        const lamps = [];
        const glows = [];
        for (let i = 0; i < 3; i++) {
          const mat = new THREE.MeshBasicMaterial({ color: OFF.clone() });
          const lamp = new THREE.Mesh(lampGeo, mat);
          const y = 6.6 - i * 0.66;
          lamp.position.set(hx - Math.sin(facing) * 0.26, y, hz - Math.cos(facing) * 0.26);
          this.group.add(lamp);
          lamps.push(mat);

          const gmat = new THREE.MeshBasicMaterial({
            color: OFF.clone(), transparent: true, opacity: 0, depthWrite: false,
            blending: THREE.AdditiveBlending
          });
          const glow = new THREE.Mesh(glowGeo, gmat);
          glow.position.copy(lamp.position);
          this.group.add(glow);
          glows.push(gmat);
        }

        // detection camera on the mast arm
        const cam = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.26, 0.6), camMat);
        cam.position.set(hx + r.x * 0.9, 6.95, hz + r.z * 0.9);
        cam.rotation.y = Math.atan2(f.x, f.z) + Math.PI;
        cam.rotation.x = 0.28;
        this.group.add(cam);
        const lens = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8),
          new THREE.MeshBasicMaterial({ color: 0x1a4a5a })
        );
        lens.rotation.x = Math.PI / 2;
        lens.position.copy(cam.position);
        lens.position.x -= f.x * 0.3; lens.position.z -= f.z * 0.3;
        lens.position.y -= 0.06;
        this.group.add(lens);

        this.heads.push({
          node, heading: h, lamps, glows,
          pos: new THREE.Vector3(hx, 6.3, hz),
          camPos: new THREE.Vector3(cam.position.x, cam.position.y, cam.position.z)
        });
      }
    }

    this.buildWire(net);
    this.buildDetectionZones(net);
  }

  // ---- V2I packets ---------------------------------------------------------
  buildWire(net) {
    this.wireGroup = new THREE.Group();
    this.scene.add(this.wireGroup);
    const geo = new THREE.SphereGeometry(1.15, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x46e8ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.packets = new THREE.InstancedMesh(geo, mat, 64);
    this.packets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.packets.count = 0;
    this.packets.frustumCulled = false;
    this.wireGroup.add(this.packets);

    // faint standing link between neighbouring junctions: the comms backbone
    const pts = [];
    for (const n of net.signals) {
      for (const h of ['E', 'S']) {
        const d = n.downstream[h];
        if (!d) continue;
        pts.push(new THREE.Vector3(n.pos.x, 8.4, n.pos.z), new THREE.Vector3(d.pos.x, 8.4, d.pos.z));
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.backbone = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0x2a6f8a, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    this.wireGroup.add(this.backbone);
    this.dummy = new THREE.Object3D();
  }

  // ---- camera detection wedges --------------------------------------------
  buildDetectionZones(net) {
    this.zoneGroup = new THREE.Group();
    this.scene.add(this.zoneGroup);
    this.zones = [];
    const R = CFG.vision.range;
    for (const head of this.heads) {
      const link = head.node.in[head.heading];
      if (!link) continue;
      const f = link.f, r = link.r;
      const w = CFG.lanesPerDir * CFG.laneWidth;
      const start = Math.max(0, link.length - R);
      const shape = new THREE.PlaneGeometry(w, Math.min(R, link.length));
      const mat = new THREE.MeshBasicMaterial({
        color: 0x35e6d0, transparent: true, opacity: 0.0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(shape, mat);
      const mid = start + Math.min(R, link.length) / 2;
      mesh.position.set(
        link.p0.x + f.x * mid + r.x * (w / 2),
        0.05,
        link.p0.z + f.z * mid + r.z * (w / 2)
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(f.x, f.z);
      this.zoneGroup.add(mesh);
      this.zones.push({ head, mat });
    }
  }

  setZonesVisible(on) {
    for (const z of this.zones) z.mat.opacity = on ? 0.055 : 0;
  }

  // ---- per-frame -----------------------------------------------------------
  update(sim, time, nightFactor, selectedNodeId) {
    for (const head of this.heads) {
      const ctrl = head.node.ctrl;
      // the face a driver sees is the best state across that approach's turns
      let state = 'red';
      for (const turn of ['through', 'right', 'left']) {
        const mv = head.node.movements[head.heading] && head.node.movements[head.heading][turn];
        if (!mv) continue;
        const s = ctrl.stateFor(head.heading, turn);
        if (s === 'green') { state = 'green'; break; }
        if (s === 'yellow') state = 'yellow';
      }
      const idx = state === 'red' ? 0 : state === 'yellow' ? 1 : 2;
      const col = state === 'red' ? RED : state === 'yellow' ? AMBER : GREEN;
      for (let i = 0; i < 3; i++) {
        const on = i === idx;
        head.lamps[i].color.copy(on ? col : OFF);
        head.glows[i].color.copy(col);
        head.glows[i].opacity = on ? 0.20 + nightFactor * 0.30 : 0;
      }
    }

    // V2I packets in flight
    const coord = sim.coordinator;
    let n = 0;
    if (coord && sim.coordination) {
      for (const w of coord.wire) {
        if (n >= 64) break;
        const t = Math.min(1, w.life / w.duration);
        const e = t * t * (3 - 2 * t);
        const a = w.from.pos, b = w.to.pos;
        this.dummy.position.set(
          a.x + (b.x - a.x) * e,
          8.4 + Math.sin(e * Math.PI) * 5.5,
          a.z + (b.z - a.z) * e
        );
        const s = 0.7 + Math.sin(e * Math.PI) * 0.9;
        this.dummy.scale.set(s, s, s);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.packets.setMatrixAt(n, this.dummy.matrix);
        n++;
      }
    }
    this.packets.count = n;
    this.packets.instanceMatrix.needsUpdate = true;
    this.backbone.material.opacity = sim.coordination ? 0.18 + Math.sin(time * 1.6) * 0.06 : 0.05;
  }
}

// ---------------------------------------------------------------------------
//  Floating junction labels drawn as sprites so they stay readable at any zoom
// ---------------------------------------------------------------------------
export function makeJunctionLabels(scene, net) {
  const sprites = [];
  for (const n of net.signals) {
    const label = (n.name || n.id).toUpperCase();
    const c = document.createElement('canvas');
    c.width = 640; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 40px ui-monospace, Menlo, Consolas, monospace';
    const tw = Math.min(600, ctx.measureText(label).width + 44);
    const bx = (640 - tw) / 2;
    ctx.fillStyle = 'rgba(8,14,22,0.84)';
    roundRect(ctx, bx, 30, tw, 64, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(53,230,208,0.55)';
    ctx.lineWidth = 2;
    roundRect(ctx, bx, 30, tw, 64, 12);
    ctx.stroke();
    ctx.fillStyle = '#eaf6ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 320, 63);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, opacity: 0.9
    }));
    sp.position.set(n.pos.x, 26, n.pos.z);
    sp.scale.set(60, 12, 1);
    sp.renderOrder = 10;
    scene.add(sp);
    sprites.push({ node: n, sprite: sp });
  }
  return sprites;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
