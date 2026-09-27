import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

// ============================================================================
//  HITEC City landmarks.
//
//  The network is roughly the size of the Madhapur / Kothaguda stretch of
//  Hyderabad, so the blocks around it carry the buildings that actually sit
//  there: Cyber Towers at the centre, the IT park slabs around it, a mall, and
//  Durgam Cheruvu with its cable-stayed bridge on the eastern edge.
//
//  These are recognisable massing studies, not surveyed models — the point is
//  that someone who knows the area places it immediately.
// ============================================================================

// local prop helpers: landmarks contribute into the same batched prop array
function tint(g, rgb) {
  if (g.index) g = g.toNonIndexed();
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
const sl = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const hex = h => [sl(((h >> 16) & 255) / 255), sl(((h >> 8) & 255) / 255), sl((h & 255) / 255)];

function pbox(out, w, h, d, x, y, z, col, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  out.push(tint(g, col));
}
function pcyl(out, rt, rb, h, x, y, z, col, segs = 8) {
  const g = new THREE.CylinderGeometry(rt, rb, h, segs);
  g.translate(x, y, z);
  out.push(tint(g, col));
}

const L = {
  concrete: hex(0x9b9689),
  pier:     hex(0x8d8a84),
  steel:    hex(0xb9bec4),
  cable:    hex(0x2a2d31),
  deck:     hex(0x53575c),
  rail:     hex(0xcfd3d6),
  lawn:     hex(0x3d5232),
  path:     hex(0x9a9488),
  signW:    hex(0xf0f2f4),
  signBlue: hex(0x14548c),
  crown:    hex(0x2b4f6e),
  mall:     hex(0xd9cdb6),
  trim:     hex(0x4a4f56)
};

// Blue-green reflective curtain wall, shared by every glazed landmark.
let glassMat = null;
function glass() {
  if (!glassMat) {
    glassMat = new THREE.MeshStandardMaterial({
      color: 0x2c4a5c, roughness: 0.09, metalness: 0.86, envMapIntensity: 1.9
    });
  }
  return glassMat;
}
let spandrelMat = null;
function spandrel() {
  if (!spandrelMat) {
    spandrelMat = new THREE.MeshStandardMaterial({
      color: 0x1b2730, roughness: 0.55, metalness: 0.35, envMapIntensity: 0.7
    });
  }
  return spandrelMat;
}

// A glazed slab with banded floors: the base unit of every IT block here.
function glazedSlab(group, w, h, d, x, y, z, ry = 0, floorH = 3.6) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glass());
  box.position.set(x, y + h / 2, z);
  box.rotation.y = ry;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);

  // floor bands, inset slightly so they catch their own shadow line
  const floors = Math.max(1, Math.floor(h / floorH));
  const bandGeo = new THREE.BoxGeometry(w * 1.004, 0.34, d * 1.004);
  for (let i = 1; i < floors; i++) {
    const b = new THREE.Mesh(bandGeo, spandrel());
    b.position.set(x, y + i * floorH, z);
    b.rotation.y = ry;
    group.add(b);
  }
  return box;
}

// ---------------------------------------------------------------------------
//  CYBER TOWERS — the one everybody recognises. A tall central core with a
//  stepped glass crown and a mast, flanked by two wings splayed out from it.
// ---------------------------------------------------------------------------
export function buildCyberTowers(group, props, cx, cz, rng) {
  const podH = 7.5;
  pbox(props, 72, podH, 46, cx, podH / 2, cz, L.concrete);
  pbox(props, 75, 0.6, 49, cx, podH + 0.3, cz, L.concrete);

  // central core
  const coreH = 50;
  glazedSlab(group, 22, coreH, 22, cx, podH, cz);
  pbox(props, 23.2, 1.0, 23.2, cx, podH + coreH + 0.5, cz, L.trim);

  // stepped crown
  let y = podH + coreH + 1;
  let s = 18;
  for (let i = 0; i < 3; i++) {
    glazedSlab(group, s, 3.2, s, cx, y, cz, Math.PI / 4 * (i % 2 ? 1 : 0), 3.2);
    pbox(props, s * 1.06, 0.5, s * 1.06, cx, y + 3.45, cz, L.trim, Math.PI / 4 * (i % 2 ? 1 : 0));
    y += 3.7; s *= 0.72;
  }
  const cap = new THREE.Mesh(new THREE.ConeGeometry(7.5, 8, 4), glass());
  cap.position.set(cx, y + 4, cz);
  cap.rotation.y = Math.PI / 4;
  cap.castShadow = true;
  group.add(cap);
  pcyl(props, 0.16, 0.26, 12, cx, y + 14, cz, L.steel, 6);
  pbox(props, 0.9, 0.9, 0.9, cx, y + 20.2, cz, [1.4, 0.2, 0.2]);

  // two wings splayed off the core
  for (const side of [-1, 1]) {
    const ang = side * 0.30;
    const wx = cx + side * 25, wz = cz + 4;
    glazedSlab(group, 30, 34, 17, wx, podH, wz, ang);
    pbox(props, 31.4, 1.0, 18.4, wx, podH + 34.5, wz, L.trim, ang);
    // roof plant
    pbox(props, 6, 2.2, 5, wx, podH + 35.6, wz, L.steel, ang);
    // the glazed entrance link back to the core
    glazedSlab(group, 12, 9, 10, cx + side * 13, podH, cz + 9, 0);
  }

  // forecourt: lawn, path, flagpoles and the signboard on the boundary
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(78, 22),
    new THREE.MeshStandardMaterial({ color: 0x3d5232, roughness: 1 })
  );
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.set(cx, 0.04, cz - 33);
  lawn.receiveShadow = true;
  group.add(lawn);
  for (let i = -2; i <= 2; i++) {
    pcyl(props, 0.09, 0.11, 10, cx + i * 7, 5, cz - 26, L.steel, 6);
  }
  pbox(props, 20, 2.0, 0.5, cx, 2.4, cz - 42, L.signBlue);
  pbox(props, 19, 1.3, 0.2, cx, 2.4, cz - 42.3, L.signW);
  for (const e of [-1, 1]) pcyl(props, 0.18, 0.2, 3, cx + e * 9.4, 1.5, cz - 42, L.concrete, 6);
}

// ---------------------------------------------------------------------------
//  Generic IT-park block: paired glazed slabs on a shared podium.
// ---------------------------------------------------------------------------
export function buildITPark(group, props, cx, cz, w, d, rng) {
  const podH = 6;
  pbox(props, w, podH, d, cx, podH / 2, cz, L.concrete);
  pbox(props, w + 1.5, 0.5, d + 1.5, cx, podH + 0.25, cz, L.concrete);

  // Two rows of slabs across the podium rather than one line of them, so the
  // deck is built on instead of being a bare plane with a few blocks at the back.
  const cols = 3 + (rng() < 0.5 ? 1 : 0);
  const rows = 2;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      if (rng() < 0.18) continue;
      const tw = (w * 0.90) / cols;
      const td = (d * 0.80) / rows;
      const th = 22 + rng() * 30;
      const tx = cx - w * 0.45 + tw * (i + 0.5);
      const tz = cz - d * 0.40 + td * (r + 0.5);
      glazedSlab(group, tw * 0.84, th, td * 0.78, tx, podH, tz);
      pbox(props, tw * 0.90, 0.9, td * 0.84, tx, podH + th + 0.45, tz, L.trim);
      pbox(props, 4.5, 2, 4, tx, podH + th + 1.9, tz, L.steel);
      if (rng() < 0.4) pcyl(props, 0.1, 0.14, 7, tx + tw * 0.28, podH + th + 4, tz, L.steel, 5);
    }
  }
  // service road, boundary wall and a gate
  pbox(props, w + 4, 1.6, 0.3, cx, 0.8, cz + d / 2 + 2, L.concrete);
  pbox(props, 0.3, 1.6, d + 4, cx + w / 2 + 2, 0.8, cz, L.concrete);
  pbox(props, 0.3, 1.6, d + 4, cx - w / 2 - 2, 0.8, cz, L.concrete);
}

// ---------------------------------------------------------------------------
//  A wide low mall block with a curved glazed entrance — the Inorbit massing.
// ---------------------------------------------------------------------------
export function buildMall(group, props, cx, cz, w, d, rng) {
  const h = 17;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.92, h, d * 0.78),
    new THREE.MeshStandardMaterial({ color: 0xd9cdb6, roughness: 0.78, envMapIntensity: 0.6 })
  );
  body.position.set(cx, h / 2, cz);
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  // glazed drum over the entrance
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, h + 4, 18, 1, false), glass());
  drum.position.set(cx - w * 0.3, (h + 4) / 2, cz + d * 0.34);
  drum.castShadow = true;
  group.add(drum);
  pcyl(props, 10, 10, 0.8, cx - w * 0.3, h + 4.4, cz + d * 0.34, L.trim, 18);

  pbox(props, w * 0.94, 1.0, d * 0.82, cx, h + 0.5, cz, L.trim);
  // rooftop plant deck
  for (let i = 0; i < 5; i++) {
    pbox(props, 3 + rng() * 3, 1.6, 2.5 + rng() * 2,
      cx + (rng() - 0.5) * w * 0.7, h + 1.8, cz + (rng() - 0.5) * d * 0.5, L.steel);
  }
  // porte-cochere
  pbox(props, w * 0.4, 0.5, 7, cx + w * 0.16, 6, cz + d * 0.42, L.trim);
  for (let i = -2; i <= 2; i++) {
    pcyl(props, 0.35, 0.4, 6, cx + w * 0.16 + i * 6, 3, cz + d * 0.42 + 2.6, L.concrete, 8);
  }
  pbox(props, w * 0.5, 2.4, 0.4, cx, h + 2.5, cz + d * 0.40, L.signW);
}

// ---------------------------------------------------------------------------
//  DURGAM CHERUVU — the lake, with the cable-stayed bridge across it.
// ---------------------------------------------------------------------------
export function buildLakeAndBridge(group, props, cx, cz, halfX, halfZ, rng) {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(halfX * 2, halfZ * 2),
    new THREE.MeshStandardMaterial({
      color: 0x24414a, roughness: 0.06, metalness: 0.5, envMapIntensity: 1.7
    })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, 0.08, cz);
  water.receiveShadow = true;
  group.add(water);

  // rocky bank
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const rx = cx + Math.cos(a) * halfX * 0.97;
    const rz = cz + Math.sin(a) * halfZ * 0.97;
    const g = new THREE.IcosahedronGeometry(1.4 + rng() * 1.8, 0);
    g.scale(1, 0.55, 1);
    g.rotateY(rng() * 3);
    g.translate(rx, 0.4, rz);
    props.push(tint(g, L.pier));
  }

  // --- cable-stayed bridge across the short axis --------------------------
  const deckY = 9.5, span = halfZ * 2 + 16, deckW = 11;
  pbox(props, deckW, 1.1, span, cx, deckY, cz, L.deck);
  pbox(props, deckW + 0.6, 0.5, span, cx, deckY + 0.8, cz, L.deck);
  for (const e of [-1, 1]) {
    for (let t = -0.48; t <= 0.48; t += 0.035) {
      pcyl(props, 0.05, 0.05, 1.2, cx + e * deckW / 2, deckY + 1.5, cz + span * t, L.rail, 4);
    }
    pbox(props, 0.09, 0.09, span, cx + e * deckW / 2, deckY + 2.05, cz, L.rail);
  }

  // A-frame pylons
  const pylons = [cz - span * 0.26, cz + span * 0.26];
  for (const pz of pylons) {
    for (const e of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.55, 0.85, 30, 8);
      g.rotateZ(-e * 0.14);
      g.translate(cx + e * 4.4, deckY + 14, pz);
      props.push(tint(g, L.concrete));
      pcyl(props, 0.9, 1.1, deckY + 2, cx + e * 4.4, (deckY + 2) / 2 - 1, pz, L.pier, 8);
    }
    pbox(props, 8, 1.2, 1.6, cx, deckY + 27.5, pz, L.concrete);

    // fanned stays
    for (let k = 1; k <= 7; k++) {
      const topY = deckY + 27 - k * 0.7;
      for (const dir of [-1, 1]) {
        const zEnd = pz + dir * (4 + k * 5.2);
        for (const e of [-1, 1]) {
          const x0 = cx + e * 2.6, y0 = topY, z0 = pz;
          const x1 = cx + e * (deckW / 2 - 0.6), y1 = deckY + 1.4, z1 = zEnd;
          const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
          const len = Math.hypot(dx, dy, dz);
          const g = new THREE.BoxGeometry(0.11, 0.11, len);
          const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx, dy, dz).normalize());
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(x0 + dx / 2, y0 + dy / 2, z0 + dz / 2), q, new THREE.Vector3(1, 1, 1));
          g.applyMatrix4(m);
          props.push(tint(g, L.cable));
        }
      }
    }
  }

  // lakeside promenade
  const walk = new THREE.Mesh(
    new THREE.RingGeometry(Math.min(halfX, halfZ) * 0.99, Math.min(halfX, halfZ) * 1.06, 40),
    new THREE.MeshStandardMaterial({ color: 0x8d8778, roughness: 0.95 })
  );
  walk.rotation.x = -Math.PI / 2;
  walk.position.set(cx, 0.05, cz);
  walk.receiveShadow = true;
  group.add(walk);
}
