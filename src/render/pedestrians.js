import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/rng.js';

// ============================================================================
//  Pavement crowd.
//
//  Purely decorative — these people never interact with the signals — but an
//  empty pavement is one of the strongest cues that a city is a model rather
//  than a place. One instanced mesh, so the whole crowd is a single draw call.
//
//  There is no skeletal animation here: each figure bobs on its stride and
//  leans slightly into it, which at street distance reads as walking.
// ============================================================================

const MAX = 260;

const SKIN = [0xe8b98e, 0xc98d5f, 0x8d5a34, 0x5d3a22, 0xf0cba6];
const TOPS = [0x2f3a4a, 0x7c3b3b, 0x33553f, 0x4a4560, 0xb8b2a6, 0x2b2b30, 0x8a6a3a, 0x37607a];
const LEGS = [0x2b3140, 0x1f2229, 0x3c3a35, 0x4a4f58];

function personGeometry() {
  const parts = [];
  const put = (g, rgb) => {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  };
  // Vertex colours are multiplied by the per-instance colour, so the torso is
  // left white (it takes the clothing colour) while head and legs are tinted
  // relative to it.
  const torso = new THREE.BoxGeometry(0.42, 0.62, 0.25);
  torso.translate(0, 1.12, 0);
  put(torso, [1, 1, 1]);

  const head = new THREE.SphereGeometry(0.115, 8, 6);
  head.scale(1, 1.15, 1);
  head.translate(0, 1.58, 0);
  put(head, [1.35, 1.2, 1.05]);

  const hips = new THREE.BoxGeometry(0.36, 0.2, 0.24);
  hips.translate(0, 0.78, 0);
  put(hips, [0.45, 0.46, 0.5]);

  for (const s of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.15, 0.72, 0.17);
    leg.translate(s * 0.10, 0.36, 0);
    put(leg, [0.42, 0.43, 0.48]);

    const arm = new THREE.BoxGeometry(0.11, 0.54, 0.13);
    arm.translate(s * 0.27, 1.12, 0);
    put(arm, [0.92, 0.92, 0.94]);
  }
  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return merged;
}

export class Crowd {
  constructor(scene, walkLines, count = MAX) {
    this.rng = makeRng(8181);
    this.dummy = new THREE.Object3D();
    this.colour = new THREE.Color();

    // Trim the footway segments to keep people off the junction boxes.
    this.lines = walkLines
      .map(l => {
        const dx = l.x1 - l.x0, dz = l.z1 - l.z0;
        const len = Math.hypot(dx, dz);
        return { x0: l.x0, z0: l.z0, ux: dx / len, uz: dz / len, len };
      })
      .filter(l => l.len > 40);

    const geo = personGeometry();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.82, metalness: 0.02, envMapIntensity: 0.6
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    scene.add(this.mesh);

    this.people = [];
    if (!this.lines.length) { this.mesh.count = 0; return; }
    for (let i = 0; i < count; i++) this.people.push(this.spawn());
    this.mesh.count = count;

    for (let i = 0; i < count; i++) {
      this.colour.setHex(TOPS[Math.floor(this.rng() * TOPS.length)]);
      this.mesh.setColorAt(i, this.colour);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  spawn() {
    const rng = this.rng;
    const line = this.lines[Math.floor(rng() * this.lines.length)];
    return {
      line,
      s: 12 + rng() * (line.len - 24),
      dir: rng() < 0.5 ? 1 : -1,
      speed: 1.05 + rng() * 0.55,
      lat: (rng() - 0.5) * 2.6,
      phase: rng() * Math.PI * 2,
      scale: 0.93 + rng() * 0.16
    };
  }

  update(dt, time) {
    if (!this.people.length) return;
    const d = this.dummy;
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      p.s += p.speed * p.dir * dt;
      if (p.s < 8 || p.s > p.line.len - 8) {
        // turn around rather than teleport, and occasionally move elsewhere
        if (this.rng() < 0.25) { this.people[i] = this.spawn(); continue; }
        p.dir *= -1;
        p.s = Math.max(8, Math.min(p.line.len - 8, p.s));
      }
      const L = p.line;
      const nx = -L.uz, nz = L.ux;
      const x = L.x0 + L.ux * p.s + nx * p.lat;
      const z = L.z0 + L.uz * p.s + nz * p.lat;

      const stride = time * p.speed * 3.4 + p.phase;
      d.position.set(x, 0.17 + Math.abs(Math.sin(stride)) * 0.045, z);
      d.rotation.set(0, Math.atan2(L.ux * p.dir, L.uz * p.dir), Math.sin(stride) * 0.055);
      d.scale.setScalar(p.scale);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
