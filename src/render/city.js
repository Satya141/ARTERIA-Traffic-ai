import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG, HALF_ROAD, JUNCTION_HALF } from '../core/config.js';
import { makeRng } from '../core/rng.js';
import { buildCyberTowers, buildITPark, buildMall, buildLakeAndBridge } from './landmarks.js';

// ============================================================================
//  Procedural city.
//
//  Every texture is drawn into a canvas at load time, so the scene ships with
//  no external assets. Everything static is batched: all the street furniture
//  in the city is a single draw call, and buildings are merged by facade, which
//  is what makes it affordable to render the whole scene five times a frame
//  (the main view plus the four approach cameras).
// ============================================================================

const ROAD_W = HALF_ROAD * 2;          // kerb to kerb, both directions
const SIDEWALK_W = 5.4;
const KERB_H = 0.17;

// ---------------------------------------------------------------------------
//  Small geometry helpers. Props carry their colour in vertex attributes so
//  hundreds of different objects can share one material and one draw call.
// ---------------------------------------------------------------------------
function tint(g, rgb) {
  // Boxes and cylinders come back indexed, the icosahedra used for foliage do
  // not, and mergeGeometries refuses a mixture. Flattening everything here
  // keeps every prop mergeable into one batch.
  if (g.index) g = g.toNonIndexed();
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
// Vertex colours are consumed as LINEAR values, but the literals above are
// sRGB like every other colour in the project. Feeding them through raw makes
// everything look bleached — concrete goes white, foliage goes mint — so they
// are converted here, which is exactly what THREE.Color.setHex does for the
// colours passed to a material.
const srgbToLinear = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const hex = h => [
  srgbToLinear(((h >> 16) & 255) / 255),
  srgbToLinear(((h >> 8) & 255) / 255),
  srgbToLinear((h & 255) / 255)
];

function pbox(out, w, h, d, x, y, z, col, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  out.push(tint(g, col));
}
function pcyl(out, rTop, rBot, h, x, y, z, col, segs = 8, ry = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, segs);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  out.push(tint(g, col));
}

const C = {
  pole:     hex(0x3c4149),
  poleDark: hex(0x24282e),
  metal:    hex(0x6d747d),
  rail:     hex(0x8d949c),
  concrete: hex(0x8a8f95),
  kerb:     hex(0x9aa0a6),
  wood:     hex(0x6b5138),
  bin:      hex(0x2f3a33),
  shelter:  hex(0x2b3138),
  glassPr:  hex(0x38414d),
  trunk:    hex(0x4a3a2c),
  leafA:    hex(0x2f5134),
  leafB:    hex(0x3a6340),
  leafC:    hex(0x28462f),
  signW:    hex(0xdfe3e6),
  signR:    hex(0xb3352f),
  signB:    hex(0x1f4f86),
  planter:  hex(0x6f6a62),
  soil:     hex(0x3a3028),
  hedge:    hex(0x314e34),
  tank:     hex(0x1c1c1e),      // the black Sintex roof tank on every building
  tankW:    hex(0xb8bcc0),
  cable:    hex(0x141518),
  tarpA:    hex(0x1f6fa8),      // blue poly tarpaulin
  tarpB:    hex(0xc4562f),
  tarpC:    hex(0x2f8055),
  cart:     hex(0x7a5a34),
  wall:     hex(0xa89a80),
  board:    hex(0xd8d2c4)
};

// ---------------------------------------------------------------------------
//  Textures
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw, repeat = [1, 1], aniso = 8) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function asphaltBase(ctx, w, h, rng) {
  ctx.fillStyle = '#3a3e45';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < w * h * 0.06; i++) {
    const v = 40 + rng() * 48;
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.3 + rng() * 0.4})`;
    ctx.fillRect(rng() * w, rng() * h, 1 + (rng() < 0.15 ? 1 : 0), 1);
  }
  // darker polished strips where wheels track, and a few tar seams
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.16)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(20,22,26,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const y = rng() * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.3, y + (rng() - 0.5) * 12, w * 0.7, y + (rng() - 0.5) * 12, w, y + (rng() - 0.5) * 8);
    ctx.stroke();
  }
  // resurfacing patches
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = `rgba(${28 + rng() * 14 | 0},${30 + rng() * 14 | 0},${34 + rng() * 14 | 0},0.5)`;
    ctx.fillRect(rng() * w * 0.7, rng() * h * 0.8, 20 + rng() * 50, 14 + rng() * 40);
  }
}

function makeRoadTexture() {
  const PX = 16;
  const w = Math.round(ROAD_W * PX), h = 16 * PX;
  const rng = makeRng(7);
  return canvasTex(w, h, (ctx) => {
    asphaltBase(ctx, w, h, rng);
    const lw = CFG.laneWidth * PX;

    ctx.strokeStyle = 'rgba(228,228,222,0.66)';
    ctx.lineWidth = 0.14 * PX;
    ctx.setLineDash([3 * PX, 4.2 * PX]);
    for (let side = 0; side < 2; side++) {
      for (let k = 1; k < CFG.lanesPerDir; k++) {
        const x = side === 0 ? (w / 2) - k * lw : (w / 2) + k * lw;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(224,224,218,0.5)';
    ctx.lineWidth = 0.13 * PX;
    for (const x of [0.45 * PX, w - 0.45 * PX]) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(232,196,84,0.8)';
    ctx.lineWidth = 0.13 * PX;
    for (const dx of [-0.22 * PX, 0.22 * PX]) {
      ctx.beginPath(); ctx.moveTo(w / 2 + dx, 0); ctx.lineTo(w / 2 + dx, h); ctx.stroke();
    }

    // manhole covers and drain gratings
    for (let i = 0; i < 2; i++) {
      const cx = rng() * w, cy = rng() * h;
      ctx.fillStyle = 'rgba(30,32,36,0.75)';
      ctx.beginPath(); ctx.arc(cx, cy, 0.34 * PX, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(96,100,106,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, 0.34 * PX, 0, Math.PI * 2); ctx.stroke();
    }
  }, [1, 1], 16);
}

function makeJunctionTexture() {
  const PX = 14;
  const size = Math.round(JUNCTION_HALF * 2 * PX + 2 * 3.6 * PX);
  const rng = makeRng(19);
  return canvasTex(size, size, (ctx, w, h) => {
    asphaltBase(ctx, w, h, rng);
    const band = 3.6 * PX;
    const bar = 0.55 * PX;
    const stripes = 9;
    for (let s = 0; s < 4; s++) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate((s * Math.PI) / 2);
      ctx.translate(-w / 2, -h / 2);
      const inset = band * 0.28;
      ctx.fillStyle = 'rgba(236,236,230,0.78)';
      for (let i = 0; i < stripes; i++) {
        const sw = (w - inset * 2) / (stripes * 2 - 1);
        ctx.fillRect(inset + i * sw * 2, inset * 0.5, sw, band * 0.72);
      }
      ctx.fillStyle = 'rgba(238,238,232,0.88)';
      ctx.fillRect(w / 2, inset * 0.5 + band * 0.95, w / 2 - inset, bar * 1.6);
      ctx.restore();
    }
  }, [1, 1], 16);
}

function makeSidewalkTexture() {
  const rng = makeRng(31);
  return canvasTex(128, 128, (ctx, W, H) => {
    ctx.fillStyle = '#7d8187';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 4200; i++) {
      const v = 110 + rng() * 44;
      ctx.fillStyle = `rgba(${v},${v},${v - 5},${0.2 + rng() * 0.3})`;
      ctx.fillRect(rng() * W, rng() * H, 1, 1);
    }
    // paving slabs, with a slightly uneven joint line
    ctx.strokeStyle = 'rgba(48,50,55,0.5)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * W;
      ctx.beginPath(); ctx.moveTo(p + (rng() - 0.5), 0); ctx.lineTo(p + (rng() - 0.5), H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p + (rng() - 0.5)); ctx.lineTo(W, p + (rng() - 0.5)); ctx.stroke();
    }
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rng() * 0.05})`;
      ctx.fillRect(rng() * W, rng() * H, 4 + rng() * 14, 4 + rng() * 14);
    }
  }, [1, 1], 8);
}

function makeGroundTexture() {
  const rng = makeRng(53);
  return canvasTex(256, 256, (ctx, W, H) => {
    ctx.fillStyle = '#2b3128';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 11000; i++) {
      const v = 34 + rng() * 30;
      ctx.fillStyle = `rgba(${v},${v + 12},${v + 2},${0.3 + rng() * 0.4})`;
      ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 2, 1 + rng() * 2);
    }
  }, [70, 70], 4);
}

// A glass curtain wall, kept for the handful of genuine high-rises. Most of
// the city is painted render; these are the exception, not the rule.
function makeCurtainWallTexture(seed, cols, rows, base, lit) {
  const rng = makeRng(seed);
  const W = 256, H = 512;
  const cw = W / cols, ch = H / rows;
  return canvasTex(W, H, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw, y = r * ch;
        const g = ctx.createLinearGradient(x, y, x + cw * 0.4, y + ch);
        if (rng() < lit) {
          g.addColorStop(0, `rgba(${236 + rng() * 18 | 0},${206 + rng() * 34 | 0},${152 + rng() * 50 | 0},1)`);
          g.addColorStop(1, 'rgba(160,132,92,1)');
        } else {
          const tr = 40 + rng() * 26, tg = 70 + rng() * 34, tb = 88 + rng() * 40;
          g.addColorStop(0, `rgba(${tr + 46 | 0},${tg + 52 | 0},${tb + 58 | 0},1)`);
          g.addColorStop(0.5, `rgba(${tr | 0},${tg | 0},${tb | 0},1)`);
          g.addColorStop(1, `rgba(${tr * 0.5 | 0},${tg * 0.55 | 0},${tb * 0.6 | 0},1)`);
        }
        ctx.fillStyle = g;
        ctx.fillRect(x + 1, y + ch * 0.06, cw - 2, ch * 0.70);
      }
      ctx.fillStyle = 'rgba(22,26,32,0.92)';
      ctx.fillRect(0, r * ch + ch * 0.78, W, ch * 0.22);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, r * ch + ch * 0.78, W, 2);
    }
    ctx.fillStyle = 'rgba(26,30,36,0.9)';
    for (let c = 0; c <= cols; c++) ctx.fillRect(c * cw - 1, 0, 2.5, H);
    const gh = ch * 1.15;
    ctx.fillStyle = 'rgba(18,22,28,0.95)';
    ctx.fillRect(0, H - gh, W, gh);
    ctx.fillStyle = 'rgba(150,180,200,0.35)';
    ctx.fillRect(6, H - gh + gh * 0.24, W - 12, gh * 0.52);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, H - gh, W, 4);
  }, [1, 1], 8);
}

// A painted-render facade: sunshade ledges over every window, barred grilles,
// small balconies, monsoon staining, and a bright signboard band at street
// level. This is what actually lines an Indian arterial.
function makeFacadeTexture(seed, cols, rows, tint, lit) {
  const rng = makeRng(seed);
  const W = 256, H = 512;
  const cw = W / cols, ch = H / rows;
  return canvasTex(W, H, (ctx) => {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, W, H);

    // uneven paint and damp patches
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(${rng() < 0.5 ? 0 : 255},${rng() < 0.5 ? 0 : 255},${rng() < 0.5 ? 0 : 255},${rng() * 0.05})`;
      ctx.fillRect(rng() * W, rng() * H, 8 + rng() * 40, 10 + rng() * 60);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw, y = r * ch;
        const wx = x + cw * 0.20, wy = y + ch * 0.26;
        const ww = cw * 0.60, wh = ch * 0.44;

        // reveal, then glass or a lit room
        ctx.fillStyle = 'rgba(0,0,0,0.40)';
        ctx.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
        if (rng() < lit) {
          ctx.fillStyle = `rgb(250,${214 + rng() * 26 | 0},${152 + rng() * 44 | 0})`;
        } else {
          const g = ctx.createLinearGradient(wx, wy, wx, wy + wh);
          g.addColorStop(0, `rgba(${104 + rng() * 30 | 0},${124 + rng() * 30 | 0},${140 + rng() * 30 | 0},1)`);
          g.addColorStop(1, 'rgba(24,28,34,1)');
          ctx.fillStyle = g;
        }
        ctx.fillRect(wx, wy, ww, wh);

        // window grille: the vertical bars you see on every flat
        ctx.strokeStyle = 'rgba(28,30,34,0.75)';
        ctx.lineWidth = 1.4;
        for (let b = 1; b < 5; b++) {
          const bx = wx + (ww / 5) * b;
          ctx.beginPath(); ctx.moveTo(bx, wy); ctx.lineTo(bx, wy + wh); ctx.stroke();
        }
        ctx.beginPath(); ctx.moveTo(wx, wy + wh * 0.5); ctx.lineTo(wx + ww, wy + wh * 0.5); ctx.stroke();

        // chajja — the concrete sunshade ledge over the opening
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(wx - 5, wy - 7, ww + 10, 5);
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(wx - 5, wy - 2, ww + 10, 3);

        // rain staining running from the ledge
        if (rng() < 0.5) {
          const sg = ctx.createLinearGradient(0, wy + wh, 0, wy + wh + ch * 0.5);
          sg.addColorStop(0, 'rgba(60,54,44,0.30)');
          sg.addColorStop(1, 'rgba(60,54,44,0)');
          ctx.fillStyle = sg;
          ctx.fillRect(wx + ww * 0.1, wy + wh, ww * 0.8, ch * 0.5);
        }
      }
      // floor band
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(0, r * ch + ch * 0.95, W, ch * 0.05);
    }

    // ---- street level: shutters and a painted signboard ------------------
    const gh = ch * 1.35;
    ctx.fillStyle = 'rgba(38,34,30,0.95)';
    ctx.fillRect(0, H - gh, W, gh);
    const bays = Math.max(2, Math.round(cols * 0.9));
    for (let b = 0; b < bays; b++) {
      const bw = W / bays, bx = b * bw;
      // roller shutter or open shop
      if (rng() < 0.45) {
        ctx.fillStyle = `rgba(${96 + rng() * 40 | 0},${100 + rng() * 40 | 0},${104 + rng() * 40 | 0},1)`;
        ctx.fillRect(bx + 3, H - gh + gh * 0.34, bw - 6, gh * 0.50);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 8; k++) {
          const yy = H - gh + gh * 0.34 + (gh * 0.50 / 8) * k;
          ctx.beginPath(); ctx.moveTo(bx + 3, yy); ctx.lineTo(bx + bw - 3, yy); ctx.stroke();
        }
      } else {
        ctx.fillStyle = `rgba(${226 + rng() * 28 | 0},${196 + rng() * 40 | 0},${140 + rng() * 60 | 0},0.9)`;
        ctx.fillRect(bx + 4, H - gh + gh * 0.36, bw - 8, gh * 0.46);
      }
      // signboard: the single most Indian thing about a shopfront
      const hue = rng() * 360 | 0;
      ctx.fillStyle = `hsl(${hue},72%,44%)`;
      ctx.fillRect(bx + 1, H - gh + gh * 0.06, bw - 2, gh * 0.24);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let k = 0; k < 3; k++) {
        ctx.fillRect(bx + 6 + k * (bw - 14) / 3, H - gh + gh * 0.14, (bw - 18) / 3, gh * 0.07);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, H - gh, W, 3);
  }, [1, 1], 8);
}

const BUILDING_TINTS = [
  '#c9a24a', '#b4653c', '#c88e6a', '#8fae86', '#d9c9a3',
  '#a8543f', '#7f9bb0', '#cfa98c', '#9c7f5c', '#b98aa0',
  '#d4b877', '#6f8f7a', '#c46a4e', '#e0d3b4', '#96796a'
];
const GLASS_TINTS = ['#1d2a33', '#22303a', '#1a2733', '#26343d', '#1f2b30'];

// ===========================================================================
//  City builder
// ===========================================================================
export function buildCity(scene, net, extent) {
  const rng = makeRng(2024);
  const group = new THREE.Group();
  group.name = 'city';
  scene.add(group);

  const roadTex = makeRoadTexture();
  const junctionTex = makeJunctionTexture();
  const walkTex = makeSidewalkTexture();
  const groundTex = makeGroundTexture();

  const roadMat = new THREE.MeshStandardMaterial({
    map: roadTex, roughness: 0.74, metalness: 0.06, envMapIntensity: 0.55 });
  const junctionMat = new THREE.MeshStandardMaterial({
    map: junctionTex, roughness: 0.74, metalness: 0.06, envMapIntensity: 0.55 });
  const walkMat = new THREE.MeshStandardMaterial({ map: walkTex, roughness: 0.92, envMapIntensity: 0.4 });

  const props = [];          // everything batched into one vertex-coloured mesh
  const lampHeads = [];      // emissive, batched separately so they can be dimmed

  // ---- ground --------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(extent.x * 8, extent.z * 8),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  group.add(ground);

  // ---- carriageways, kerbs and footways ------------------------------------
  const seen = new Set();
  const corridors = [];
  const walkLines = [];      // centre lines of every footway, for pedestrians
  for (const link of net.links) {
    const key = [link.from.id, link.to.id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const a = link.from.pos, b = link.to.pos;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const ang = Math.atan2(dx, dz);

    const m = roadMat.clone();
    m.map = roadTex.clone();
    m.map.repeat.set(1, len / 16);
    m.map.needsUpdate = true;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, len), m);
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = -ang;
    road.position.set(mid.x, 0, mid.z);
    road.receiveShadow = true;
    group.add(road);
    corridors.push({ a, b, ang, len, mid });

    // Raised planted median down the centreline. Kept to 0.7 m wide so it sits
    // inside the 1.8 m gap between the innermost lanes of each direction and no
    // vehicle ever clips it.
    const clear = JUNCTION_HALF + 4.2;
    const mLen = Math.max(0, len - clear * 2);
    if (mLen > 10) {
      pbox(props, 0.7, 0.26, mLen, mid.x, 0.13, mid.z, C.kerb, ang);
      const ux0 = dx / len, uz0 = dz / len;
      const nSh = Math.floor(mLen / 7);
      for (let k = 0; k <= nSh; k++) {
        const dd = clear + (mLen / Math.max(nSh, 1)) * k;
        const hx = a.x + ux0 * dd, hz = a.z + uz0 * dd;
        if (k % 4 === 0) {
          addTree(props, hx, hz, rng);
        } else {
          const g = new THREE.IcosahedronGeometry(0.42 + rng() * 0.18, 0);
          g.scale(1, 0.8, 1);
          g.translate(hx, 0.55, hz);
          props.push(tint(g, C.hedge));
        }
      }
    }

    const nx = Math.cos(ang), nz = -Math.sin(ang);
    const ux = dx / len, uz = dz / len;

    for (const side of [-1, 1]) {
      const off = (ROAD_W / 2 + SIDEWALK_W / 2) * side;
      const wx = mid.x + nx * off, wz = mid.z + nz * off;

      const walk = new THREE.Mesh(new THREE.BoxGeometry(SIDEWALK_W, KERB_H, len), walkMat);
      walk.position.set(wx, KERB_H / 2, wz);
      walk.rotation.y = ang;
      walk.receiveShadow = true;
      group.add(walk);

      pbox(props, 0.34, KERB_H + 0.06, len,
        mid.x + nx * (ROAD_W / 2 * side), (KERB_H + 0.06) / 2, mid.z + nz * (ROAD_W / 2 * side),
        C.kerb, ang);

      walkLines.push({
        x0: a.x + nx * off, z0: a.z + nz * off,
        x1: b.x + nx * off, z1: b.z + nz * off
      });

      addStreetFurniture(props, lampHeads, rng, {
        ax: a.x, az: a.z, ux, uz, nx, nz, len, side, ang, off
      });
    }
  }

  // ---- junction boxes ------------------------------------------------------
  const jSize = JUNCTION_HALF * 2 + 2 * 3.6;
  for (const n of net.signals) {
    const box = new THREE.Mesh(new THREE.PlaneGeometry(jSize, jSize), junctionMat);
    box.rotation.x = -Math.PI / 2;
    box.position.set(n.pos.x, 0.012, n.pos.z);
    box.receiveShadow = true;
    group.add(box);

    // pedestrian guard railing on each corner, and a bollard line
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = n.pos.x + sx * (JUNCTION_HALF + 4.6);
        const cz = n.pos.z + sz * (JUNCTION_HALF + 4.6);
        addRailing(props, cx, cz, 9, 0, rng);
        addRailing(props, cx, cz, 9, Math.PI / 2, rng);
      }
    }
  }

  buildBlocks(group, props, net, rng, walkMat);

  // ---- batch the props -----------------------------------------------------
  if (props.length) {
    const merged = mergeGeometries(props, false);
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.68, metalness: 0.18, envMapIntensity: 0.8
    }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (lampHeads.length) {
    const merged = mergeGeometries(lampHeads, false);
    merged.computeVertexNormals();
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x2a2f36, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0, roughness: 0.4
    });
    const mesh = new THREE.Mesh(merged, lampMat);
    group.add(mesh);
    group.userData.lamps = [lampMat];
  }

  group.userData.walkLines = walkLines;
  return { group, corridors, walkLines };
}

// ---------------------------------------------------------------------------
//  Street furniture along one side of one link
// ---------------------------------------------------------------------------
function addStreetFurniture(props, lampHeads, rng, s) {
  const { ax, az, ux, uz, nx, nz, len, side, ang, off } = s;
  const at = (d, lateral) => ({
    x: ax + ux * d + nx * lateral,
    z: az + uz * d + nz * lateral
  });

  const step = 32;
  const count = Math.max(1, Math.floor((len - 44) / step));
  let prevPole = null;
  for (let i = 0; i <= count; i++) {
    const d = 24 + i * step;
    if (d > len - 24) break;
    const kerbSide = ROAD_W / 2 + 1.5;
    const p = at(d, kerbSide * side);

    // lighting column with a mast arm out over the carriageway
    pcyl(props, 0.15, 0.22, 9.0, p.x, 4.5, p.z, C.pole);
    pbox(props, 0.34, 0.34, 0.34, p.x, 0.17, p.z, C.poleDark);
    const armLen = 2.8;
    const ar = at(d, (kerbSide - armLen / 2) * side);
    pbox(props, armLen, 0.17, 0.2, ar.x, 8.95, ar.z, C.pole, ang + Math.PI / 2);
    const hp = at(d, (kerbSide - armLen) * side);
    const head = new THREE.BoxGeometry(1.5, 0.22, 0.62);
    head.rotateY(ang);
    head.translate(hp.x, 8.8, hp.z);
    lampHeads.push(head);

    // Overhead power and telecom cables slung pole to pole. Buried services are
    // the exception here, and the drooping cable lines are a large part of what
    // the street actually looks like from any angle.
    if (prevPole) {
      for (let c = 0; c < 4; c++) {
        const yy = 7.5 - c * 0.42;
        addCable(props, prevPole.x, prevPole.z, yy, p.x, p.z, yy, 0.9 + c * 0.22);
      }
    }
    prevPole = { x: p.x, z: p.z };

    // alternate the kerbside clutter so it does not read as a repeating pattern
    const q = at(d + 9, (ROAD_W / 2 + 3.0) * side);
    const pick = (i + (side > 0 ? 0 : 1)) % 5;
    if (pick === 0) addBench(props, q.x, q.z, ang, rng);
    else if (pick === 1) addBin(props, q.x, q.z);
    else if (pick === 2) addTree(props, q.x, q.z, rng);
    else if (pick === 3) addSign(props, q.x, q.z, ang, side, rng);
    else addPlanter(props, q.x, q.z, ang, rng);

    if (i % 3 === 1) {
      const b = at(d + 17, (ROAD_W / 2 + 3.4) * side);
      addTree(props, b.x, b.z, rng);
    }
    if (i % 4 === 2) {
      const sh = at(d + 4, (ROAD_W / 2 + 3.6) * side);
      addShelter(props, sh.x, sh.z, ang);
    }
    if (i % 3 === 0) {
      const st = at(d + 22, (ROAD_W / 2 + 3.2) * side);
      addStall(props, st.x, st.z, ang, rng);
    }
    if (i % 2 === 0) {
      const ub = at(d - 6, (ROAD_W / 2 + 4.4) * side);
      pbox(props, 0.7, 1.1, 0.45, ub.x, 0.72, ub.z, C.metal, ang);
    }
    // kerbside bollards
    for (let k = 0; k < 4; k++) {
      const bp = at(d + 3 + k * 2.4, (ROAD_W / 2 + 0.95) * side);
      pcyl(props, 0.09, 0.11, 0.95, bp.x, 0.48, bp.z, C.poleDark, 6);
    }
  }
}

// A drooping catenary between two poles, drawn as a short chain of segments.
function addCable(props, x0, z0, y0, x1, z1, y1, sag) {
  const N = 5;
  let px = x0, pz = z0, py = y0;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
    const dx = x - px, dy = y - py, dz = z - pz;
    const len = Math.hypot(dx, dy, dz);
    const g = new THREE.BoxGeometry(0.045, 0.045, len);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx, dy, dz).normalize());
    m.compose(new THREE.Vector3(px + dx / 2, py + dy / 2, pz + dz / 2), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    props.push(tint(g, C.cable));
    px = x; py = y; pz = z;
  }
}

// A roadside stall: a cart under a poly tarpaulin. The tarp colours are the
// blue, orange and green you see on every pavement.
function addStall(props, x, z, ang, rng) {
  const tarps = [C.tarpA, C.tarpB, C.tarpC];
  const tarp = tarps[Math.floor(rng() * tarps.length)];
  const w = 2.4, d = 1.6;
  pbox(props, w, 0.10, d, x, 2.30, z, tarp, ang);                  // canopy
  pbox(props, w, 0.34, 0.06, x, 2.10, z + d * 0.5, tarp, ang);     // valance
  for (const ex of [-1, 1]) for (const ez of [-1, 1]) {
    pcyl(props, 0.04, 0.04, 2.3,
      x + Math.cos(ang) * (w / 2 - 0.1) * ex - Math.sin(ang) * (d / 2 - 0.1) * ez, 1.15,
      z - Math.sin(ang) * (w / 2 - 0.1) * ex - Math.cos(ang) * (d / 2 - 0.1) * ez, C.pole, 4);
  }
  pbox(props, w * 0.85, 0.72, d * 0.7, x, 0.62, z, C.cart, ang);   // counter
  pbox(props, w * 0.8, 0.16, d * 0.6, x, 1.04, z, tarp, ang);      // goods
  for (const e of [-1, 1]) {
    pcyl(props, 0.26, 0.26, 0.1,
      x + Math.cos(ang) * (w / 2 - 0.3) * e, 0.26,
      z - Math.sin(ang) * (w / 2 - 0.3) * e, C.poleDark, 8, Math.PI / 2);
  }
}

function addBench(props, x, z, ang, rng) {
  pbox(props, 1.9, 0.10, 0.52, x, 0.52, z, C.wood, ang);
  pbox(props, 1.9, 0.44, 0.09, x, 0.78, z, C.wood, ang);
  pbox(props, 0.09, 0.44, 0.48, x - Math.cos(ang) * 0.8, 0.3, z + Math.sin(ang) * 0.8, C.poleDark, ang);
  pbox(props, 0.09, 0.44, 0.48, x + Math.cos(ang) * 0.8, 0.3, z - Math.sin(ang) * 0.8, C.poleDark, ang);
}

function addBin(props, x, z) {
  pcyl(props, 0.29, 0.25, 0.95, x, 0.65, z, C.bin, 8);
  pcyl(props, 0.32, 0.32, 0.08, x, 1.16, z, C.poleDark, 8);
}

function addPlanter(props, x, z, ang, rng) {
  pbox(props, 1.5, 0.55, 0.9, x, 0.45, z, C.planter, ang);
  pbox(props, 1.3, 0.12, 0.72, x, 0.76, z, C.soil, ang);
  for (let i = 0; i < 3; i++) {
    const g = new THREE.IcosahedronGeometry(0.30 + rng() * 0.16, 0);
    g.translate(x + (rng() - 0.5) * 1.0, 0.95, z + (rng() - 0.5) * 0.55);
    props.push(tint(g, C.hedge));
  }
}

function addSign(props, x, z, ang, side, rng) {
  pcyl(props, 0.055, 0.065, 2.7, x, 1.35, z, C.pole, 6);
  const face = ang + (side > 0 ? Math.PI : 0);
  if (rng() < 0.5) {
    const g = new THREE.CylinderGeometry(0.30, 0.30, 0.05, 14);
    g.rotateX(Math.PI / 2);
    g.rotateY(face);
    g.translate(x, 2.45, z);
    props.push(tint(g, C.signW));
    const r = new THREE.TorusGeometry(0.28, 0.045, 6, 16);
    r.rotateY(face);
    r.translate(x, 2.45, z);
    props.push(tint(r, C.signR));
  } else {
    pbox(props, 1.15, 0.34, 0.05, x, 2.5, z, C.signB, face);
  }
}

function addShelter(props, x, z, ang) {
  const w = 3.6, d = 1.5;
  pbox(props, w, 0.12, d, x, 2.55, z, C.shelter, ang);            // roof
  pbox(props, w * 0.96, 1.9, 0.07, x - Math.sin(ang) * (d / 2 - 0.05), 1.5,
       z - Math.cos(ang) * (d / 2 - 0.05), C.glassPr, ang);       // back panel
  for (const e of [-1, 1]) {
    pcyl(props, 0.06, 0.06, 2.5, x + Math.cos(ang) * (w / 2 - 0.1) * e, 1.25,
         z - Math.sin(ang) * (w / 2 - 0.1) * e, C.pole, 6);
  }
  pbox(props, w * 0.7, 0.08, 0.42, x, 0.55, z, C.wood, ang);      // bench
}

const LEAF_COLS = [C.leafA, C.leafB, C.leafC];
function addTree(props, x, z, rng) {
  const hT = 2.8 + rng() * 1.4;
  pcyl(props, 0.18, 0.28, hT, x, hT / 2, z, C.trunk, 6);
  const s = 1.9 + rng() * 1.3;
  const col = LEAF_COLS[Math.floor(rng() * LEAF_COLS.length)];
  for (let i = 0; i < 2; i++) {
    const g = new THREE.IcosahedronGeometry(s * (i ? 0.72 : 1), 0);
    g.scale(1, 0.86, 1);
    g.rotateY(rng() * 3);
    g.translate(x + (rng() - 0.5) * 0.7, hT + s * (i ? 0.75 : 0.45), z + (rng() - 0.5) * 0.7);
    props.push(tint(g, col));
  }
}

function addRailing(props, x, z, len, rot, rng) {
  const n = Math.max(2, Math.round(len / 1.6));
  for (let i = 0; i <= n; i++) {
    const t = (i / n - 0.5) * len;
    pcyl(props, 0.035, 0.04, 1.05, x + Math.cos(rot) * t, 0.55, z - Math.sin(rot) * t, C.rail, 5);
  }
  pbox(props, len, 0.06, 0.06, x, 1.02, z, C.rail, rot);
  pbox(props, len, 0.05, 0.05, x, 0.62, z, C.rail, rot);
}

// ---------------------------------------------------------------------------
//  Blocks: buildings with real massing, plus plazas, car parks and planting
// ---------------------------------------------------------------------------
// Which block index carries which landmark. The block grid runs one wider than
// the junction grid in each direction, so these indices sit between and around
// the junctions rather than on them.
const LANDMARK_BLOCKS = {
  '1,0': 'cyber',
  '2,0': 'itpark',
  '3,1': 'lake',
  '1,2': 'mall',
  '2,2': 'itpark',
  '0,1': 'itpark'
};

function buildBlocks(group, props, net, rng, walkMat) {
  const { cols, rows, spacing } = CFG.grid;
  // The block boundary sits immediately behind the footpath. Anything more and
  // a strip of empty paving opens up between the kerb and the buildings, which
  // is what made the city read as detached from its own roads.
  const edge = ROAD_W / 2 + SIDEWALK_W + 0.4;

  const facades = [];
  for (let i = 0; i < 12; i++) {
    facades.push({
      tex: makeFacadeTexture(100 + i * 17, 4 + (i % 3), 10 + (i % 5) * 3,
        BUILDING_TINTS[i % BUILDING_TINTS.length], 0.26 + rng() * 0.26),
      glass: false
    });
  }
  for (let i = 0; i < 5; i++) {
    facades.push({
      tex: makeCurtainWallTexture(900 + i * 31, 5 + (i % 3), 14 + (i % 4) * 4,
        GLASS_TINTS[i % GLASS_TINTS.length], 0.16 + rng() * 0.18),
      glass: true
    });
  }
  const matPool = new Map();
  const lit = [];
  const buckets = new Map();           // material -> geometry[]
  const facadeMaterial = (texIdx, rx, ry) => {
    const key = `${texIdx}:${rx}:${ry}`;
    let m = matPool.get(key);
    if (m) return m;
    const base = facades[texIdx];
    const map = base.tex.clone(); map.needsUpdate = true; map.repeat.set(rx, ry);
    const emis = base.tex.clone(); emis.needsUpdate = true; emis.repeat.set(rx, ry);
    m = new THREE.MeshStandardMaterial({
      map, emissiveMap: emis, emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0,
      // glazed towers are smooth and mirror the sky; masonry is not
      roughness: base.glass ? 0.14 : 0.66,
      metalness: base.glass ? 0.72 : 0.12,
      envMapIntensity: base.glass ? 1.6 : 0.8
    });
    matPool.set(key, m);
    buckets.set(m, []);
    lit.push(m);
    return m;
  };
  const addMass = (w, h, d, x, y, z) => {
    const glassy = h > 42 && rng() < 0.30;
    const idx = glassy
      ? 12 + Math.floor(rng() * 5)
      : Math.floor(rng() * 12);
    const m = facadeMaterial(idx,
      Math.max(1, Math.round(w / 9)), Math.max(1, Math.round(h / 8)));
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    buckets.get(m).push(g);
  };

  const xs = [];
  for (let i = 0; i <= cols; i++) xs.push((i - cols / 2) * spacing);
  const zs = [];
  for (let j = 0; j <= rows; j++) zs.push((j - rows / 2) * spacing);

  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < zs.length; j++) {
      const cx = xs[i], cz = zs[j];
      const halfX = spacing / 2 - edge;
      const halfZ = spacing / 2 - edge;
      if (halfX < 8 || halfZ < 8) continue;

      // ---- named HITEC City landmarks on their own blocks ----------------
      const lm = LANDMARK_BLOCKS[`${i},${j}`];
      if (lm === 'cyber') {
        buildCyberTowers(group, props, cx, cz, rng);
        continue;
      }
      if (lm === 'lake') {
        buildLakeAndBridge(group, props, cx, cz, halfX * 0.92, halfZ * 0.92, rng);
        continue;
      }
      if (lm === 'mall') {
        buildMall(group, props, cx, cz, halfX * 1.75, halfZ * 1.5, rng);
        continue;
      }
      if (lm === 'itpark') {
        buildITPark(group, props, cx, cz, halfX * 1.55, halfZ * 1.45, rng);
        continue;
      }

      if (rng() < 0.09) { buildPark(group, props, cx, cz, halfX, halfZ, rng); continue; }

      // paved forecourt so buildings do not sprout straight out of the grass
      const plaza = new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2, halfZ * 2), walkMat);
      plaza.rotation.x = -Math.PI / 2;
      plaza.position.set(cx, 0.02, cz);
      plaza.receiveShadow = true;
      group.add(plaza);

      const plotsX = Math.max(1, Math.round(halfX * 2 / 52));
      const plotsZ = Math.max(1, Math.round(halfZ * 2 / 52));
      for (let px = 0; px < plotsX; px++) {
        for (let pz = 0; pz < plotsZ; pz++) {
          const pw = (halfX * 2) / plotsX, pd = (halfZ * 2) / plotsZ;
          let bx = cx - halfX + pw * (px + 0.5);
          let bz = cz - halfZ + pd * (pz + 0.5);

          // A real block is built as a PERIMETER: shops and flats front the
          // footpath in a near-continuous street wall, and whatever open space
          // there is sits in the middle where you cannot see it from the road.
          // Scattering buildings evenly across the block instead leaves gaps on
          // the street frontage and reads as a model, not a city.
          const onWest = px === 0, onEast = px === plotsX - 1;
          const onNorth = pz === 0, onSouth = pz === plotsZ - 1;
          const perimeter = onWest || onEast || onNorth || onSouth;

          let w, d;
          if (perimeter) {
            // almost fills its plot, and is pushed flush against the frontage
            w = pw * (0.92 + rng() * 0.07);
            d = pd * (0.92 + rng() * 0.07);
            if (onWest) bx -= (pw - w) / 2;
            else if (onEast) bx += (pw - w) / 2;
            if (onNorth) bz -= (pd - d) / 2;
            else if (onSouth) bz += (pd - d) / 2;
          } else {
            const use = rng();
            if (use < 0.30) { buildCourtyard(group, props, bx, bz, pw * 0.82, pd * 0.82, rng); continue; }
            if (use < 0.38) continue;                                // interior yard
            w = pw * (0.72 + rng() * 0.20);
            d = pd * (0.72 + rng() * 0.20);
          }

          // Densely packed and mostly low-rise: three to seven storeys is the
          // texture of an Indian arterial, with the occasional tower.
          const centrality = 1 - Math.min(1, Math.hypot(cx, cz * 1.5) / (spacing * cols * 0.55));
          const tail = Math.pow(rng(), 3.0);
          // the street wall stays low and even; towers go behind it
          const h = perimeter
            ? 10 + rng() * 9 + centrality * 5 + Math.pow(rng(), 4) * 16
            : 11 + rng() * 10 + centrality * 8 + tail * (24 + centrality * 48);

          buildMassing(group, props, addMass, bx, bz, w, d, h, rng, perimeter);
        }
      }
    }
  }

  // merge each facade's buildings into a single mesh
  for (const [mat, geos] of buckets) {
    if (!geos.length) continue;
    const merged = mergeGeometries(geos, false);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.litFacades = lit;
}

// A building is a podium, a tower stepped back from it, a parapet and whatever
// ends up on the roof. Plain extruded boxes are the single biggest reason a
// procedural city reads as a model rather than a place.
function buildMassing(group, props, addMass, x, z, w, d, h, rng, perimeter = false) {
  const tall = h > 34;
  const podiumH = tall ? 7 + rng() * 6 : Math.min(h * 0.45, 9);

  addMass(w, podiumH, d, x, 0, z);
  pbox(props, w + 0.5, 0.35, d + 0.5, x, podiumH + 0.17, z, C.concrete);   // podium cornice

  // canopy over the pavement on the street-facing side
  const side = rng() < 0.5 ? 1 : -1;
  pbox(props, w * 0.8, 0.14, 1.6, x, 3.6, z + (d / 2 + 0.8) * side, C.metal);

  // Compound walls belong to plots set back from the road. A building that
  // fronts the footpath has its shopfront on the boundary instead.
  if (!perimeter && rng() < 0.55) {
    const cw = w * 0.5 + 2.2, cd = d * 0.5 + 2.2;
    pbox(props, cw * 2, 1.5, 0.22, x, 0.75, z + cd, C.wall);
    pbox(props, 0.22, 1.5, cd * 2, x + cw, 0.75, z, C.wall);
    pbox(props, 0.22, 1.5, cd * 2, x - cw, 0.75, z, C.wall);
    pbox(props, cw * 0.55, 1.75, 0.16, x + cw * 0.5, 0.88, z - cd, C.pole);   // gate
    pbox(props, cw * 1.2, 1.5, 0.22, x - cw * 0.4, 0.75, z - cd, C.wall);
  }

  let topY = podiumH;
  if (tall) {
    const tw = w * (0.68 + rng() * 0.14);
    const td = d * (0.68 + rng() * 0.14);
    const towerH = h - podiumH;
    const ox = (rng() - 0.5) * (w - tw) * 0.5;
    const oz = (rng() - 0.5) * (d - td) * 0.5;
    addMass(tw, towerH, td, x + ox, podiumH, z + oz);
    pbox(props, tw + 0.4, 0.5, td + 0.4, x + ox, podiumH + towerH + 0.25, z + oz, C.concrete);
    topY = podiumH + towerH + 0.5;
    addRoofClutter(props, x + ox, z + oz, tw, td, topY, rng, h);
  } else {
    if (h > podiumH + 2) addMass(w * 0.94, h - podiumH, d * 0.94, x, podiumH, z);
    pbox(props, w * 0.96, 0.45, d * 0.96, x, h + 0.22, z, C.concrete);
    topY = h + 0.45;
    addRoofClutter(props, x, z, w * 0.94, d * 0.94, topY, rng, h);
  }
}

function addRoofClutter(props, x, z, w, d, y, rng, h) {
  // parapet
  const t = 0.35;
  pbox(props, w, 1.0, t, x, y + 0.5, z + d / 2, C.concrete);
  pbox(props, w, 1.0, t, x, y + 0.5, z - d / 2, C.concrete);
  pbox(props, t, 1.0, d, x + w / 2, y + 0.5, z, C.concrete);
  pbox(props, t, 1.0, d, x - w / 2, y + 0.5, z, C.concrete);

  // stair head
  pbox(props, w * 0.26, 2.4, d * 0.24, x - w * 0.2, y + 1.2, z - d * 0.16, C.concrete);

  // Water tanks. Almost every roof in an Indian city carries one or two, and
  // their silhouette is more of a giveaway than anything else up there.
  const tanks = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < tanks; i++) {
    const tx = x + (rng() - 0.5) * (w - 2.2);
    const tz = z + (rng() - 0.5) * (d - 2.2);
    const r = 0.52 + rng() * 0.30;
    // stand
    pbox(props, r * 2.2, 0.75, r * 2.2, tx, y + 0.38, tz, C.concrete);
    const black = rng() < 0.7;
    pcyl(props, r, r * 0.92, 1.15, tx, y + 1.35, tz, black ? C.tank : C.tankW, 10);
    pcyl(props, r * 0.55, r * 0.55, 0.12, tx, y + 1.98, tz, black ? C.tank : C.tankW, 8);
  }

  // dish antenna and a TV mast
  if (rng() < 0.6) {
    const dx = x + (rng() - 0.5) * w * 0.6, dz = z + (rng() - 0.5) * d * 0.6;
    pcyl(props, 0.04, 0.05, 1.0, dx, y + 0.5, dz, C.pole, 5);
    const dish = new THREE.SphereGeometry(0.34, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.4);
    dish.rotateX(-0.9);
    dish.translate(dx, y + 1.1, dz);
    props.push(tint(dish, C.tankW));
  }
  if (rng() < 0.35) {
    pcyl(props, 0.04, 0.06, 3.2, x + w * 0.3, y + 1.6, z - d * 0.3, C.pole, 4);
  }

  // rooftop hoarding facing the street
  if (rng() < 0.30 && w > 9) {
    const hw = Math.min(w * 0.8, 11), hh = 2.6;
    const side = rng() < 0.5 ? 1 : -1;
    pbox(props, hw, hh, 0.22, x, y + 1.0 + hh / 2, z + (d / 2 - 0.4) * side, C.board);
    for (const e of [-1, 1]) {
      pcyl(props, 0.06, 0.06, hh, x + e * hw * 0.4, y + 1.0 + hh / 2, z + (d / 2 - 0.1) * side, C.pole, 5);
    }
  }

  // water pipes down the parapet and a laundry line
  if (rng() < 0.5) {
    pcyl(props, 0.05, 0.05, 2.0, x + w * 0.42, y + 1.0, z + d * 0.42, C.tankW, 5);
  }
}

// A planted courtyard between buildings: lawn, trees, a bench.
function buildCourtyard(group, props, cx, cz, w, d, rng) {
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0x3b4a2c, roughness: 1 })
  );
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.set(cx, 0.03, cz);
  lawn.receiveShadow = true;
  group.add(lawn);
  const n = Math.max(2, Math.round((w * d) / 240));
  for (let i = 0; i < n; i++) {
    addTree(props, cx + (rng() - 0.5) * w * 0.82, cz + (rng() - 0.5) * d * 0.82, rng);
  }
  if (rng() < 0.6) addBench(props, cx, cz, rng() * 3, rng);
}

function buildPark(group, props, cx, cz, halfX, halfZ, rng) {
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(halfX * 2, halfZ * 2),
    new THREE.MeshStandardMaterial({ color: 0x33472f, roughness: 1 })
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(cx, 0.03, cz);
  grass.receiveShadow = true;
  group.add(grass);

  const n = Math.round((halfX * halfZ) / 170);
  for (let i = 0; i < n; i++) {
    addTree(props, cx + (rng() - 0.5) * halfX * 1.8, cz + (rng() - 0.5) * halfZ * 1.8, rng);
  }
  for (let i = 0; i < 3; i++) {
    addBench(props, cx + (rng() - 0.5) * halfX * 1.4, cz + (rng() - 0.5) * halfZ * 1.4, rng() * 3, rng);
  }
}

// ---------------------------------------------------------------------------
export function updateCityLighting(cityGroup, nightFactor, time) {
  const k = Math.pow(nightFactor, 0.7);
  for (const m of cityGroup.userData.lamps || []) m.emissiveIntensity = k * 2.4;
  for (const m of cityGroup.userData.litFacades || []) m.emissiveIntensity = k * 0.95;
}
