import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG } from '../core/config.js';
import { makeRng } from '../core/rng.js';

// ============================================================================
//  Vehicle rendering.
//
//  Bodies are not assembled from boxes. Each class has a SIDE PROFILE — the
//  outline you would see looking at the car side-on — which is extruded across
//  the vehicle's width with a bevelled edge, then deformed in plan so it is
//  narrower at the nose and tail and pulled in above the waistline. That plan
//  taper plus the tumblehome is what separates a car silhouette from a brick,
//  and it is the reason a bevelled extrusion reads as sheet metal where stacked
//  boxes never will.
//
//  Glazing is not separate geometry: vertices sitting in the greenhouse band
//  are tinted dark, so the glasshouse wraps the body exactly and costs nothing.
//
//  One InstancedMesh per class, so several hundred vehicles are a handful of
//  draw calls. Paint varies per instance through instanceColor; the baked
//  vertex colours multiply against it, which is why a dark windscreen stays
//  dark on a white car.
// ============================================================================

const MAX_PER_CLASS = 420;

// vertex colours act as a multiplier on the per-instance paint colour
const PAINT  = [1, 1, 1];
const GLASS  = [0.10, 0.12, 0.15];
const TYRE   = [0.045, 0.045, 0.05];
const TRIM   = [0.34, 0.35, 0.37];
const TRIM2  = [0.72, 0.73, 0.75];
const DARK   = [0.08, 0.09, 0.10];
const RIM    = [0.66, 0.68, 0.72];
const ARCH   = [0.14, 0.15, 0.16];
const LIGHT  = [1.55, 1.48, 1.32];
const TAIL   = [1.35, 0.16, 0.16];
const RIDER  = [0.20, 0.22, 0.26];
const HELMET = [0.90, 0.92, 0.95];
const STRIPE = [1.30, 0.22, 0.26];
const BEACON = [0.55, 0.60, 0.70];

function tint(g, rgb) {
  if (g.index) g = g.toNonIndexed();
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function box(w, h, d, x, y, z, rgb, rotX = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX) g.rotateX(rotX);
  g.translate(x, y, z);
  return tint(g, rgb);
}

function disc(r, thick, x, y, z, rgb, segs = 14) {
  const g = new THREE.CylinderGeometry(r, r, thick, segs);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return tint(g, rgb);
}

// ---------------------------------------------------------------------------
//  Side profiles. Each point is [z, y] as a fraction of length and height,
//  traced clockwise from the rear sill round the roof to the front sill.
// ---------------------------------------------------------------------------
const PROFILES = {
  sedan: {
    belt: 0.60, roof: 0.99, noseTaper: 0.86, tailTaper: 0.88, tumble: 0.84,
    pts: [
      [-0.500, 0.170], [-0.500, 0.430], [-0.487, 0.520], [-0.455, 0.562],
      [-0.330, 0.590], [-0.246, 0.625], [-0.170, 0.800], [-0.085, 0.948],
      [ 0.010, 0.990], [ 0.090, 0.985], [ 0.150, 0.940], [ 0.232, 0.755],
      [ 0.296, 0.640], [ 0.360, 0.598], [ 0.452, 0.530], [ 0.492, 0.430],
      [ 0.500, 0.300], [ 0.500, 0.170]
    ]
  },
  hatch: {
    belt: 0.60, roof: 0.99, noseTaper: 0.87, tailTaper: 0.90, tumble: 0.85,
    pts: [
      [-0.500, 0.170], [-0.500, 0.520], [-0.494, 0.720], [-0.474, 0.870],
      [-0.430, 0.955], [-0.340, 0.990], [-0.130, 0.998], [ 0.040, 0.990],
      [ 0.128, 0.945], [ 0.222, 0.760], [ 0.292, 0.640], [ 0.358, 0.598],
      [ 0.452, 0.530], [ 0.492, 0.430], [ 0.500, 0.300], [ 0.500, 0.170]
    ]
  },
  suv: {
    belt: 0.58, roof: 1.00, noseTaper: 0.90, tailTaper: 0.92, tumble: 0.90,
    pts: [
      [-0.500, 0.150], [-0.500, 0.560], [-0.496, 0.800], [-0.484, 0.930],
      [-0.450, 0.985], [-0.330, 1.000], [ 0.080, 1.000], [ 0.175, 0.962],
      [ 0.262, 0.800], [ 0.320, 0.665], [ 0.392, 0.625], [ 0.478, 0.575],
      [ 0.500, 0.470], [ 0.500, 0.150]
    ]
  },
  van: {
    belt: 0.55, roof: 1.00, noseTaper: 0.93, tailTaper: 0.97, tumble: 0.94,
    pts: [
      [-0.500, 0.130], [-0.500, 0.930], [-0.492, 0.985], [-0.460, 1.000],
      [ 0.250, 1.000], [ 0.300, 0.975], [ 0.360, 0.760], [ 0.420, 0.620],
      [ 0.480, 0.560], [ 0.500, 0.450], [ 0.500, 0.130]
    ]
  },
  bus: {
    belt: 0.50, roof: 1.00, noseTaper: 0.97, tailTaper: 0.97, tumble: 0.97,
    pts: [
      [-0.500, 0.120], [-0.500, 0.940], [-0.494, 0.988], [-0.470, 1.000],
      [ 0.470, 1.000], [ 0.494, 0.988], [ 0.500, 0.940], [ 0.500, 0.120]
    ]
  }
};

// ---------------------------------------------------------------------------
//  Extrude a side profile across the body width, taper it in plan, and bake
//  the glasshouse in as vertex colour.
// ---------------------------------------------------------------------------
function extrudeBody(spec, prof, opts = {}) {
  const { w, l, h } = spec;
  const shape = new THREE.Shape();
  const P = prof.pts;
  shape.moveTo(P[0][0] * l, P[0][1] * h);
  for (let i = 1; i < P.length; i++) shape.lineTo(P[i][0] * l, P[i][1] * h);
  shape.closePath();

  const bevel = Math.min(0.07, w * 0.055);
  const depth = Math.max(0.1, w - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 3
  });
  geo.rotateY(-Math.PI / 2);
  geo.translate(depth / 2, 0, 0);

  const pos = geo.attributes.position;
  const beltY = prof.belt * h;
  const roofY = prof.roof * h;
  const glassTop = roofY - h * 0.055;
  const colours = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);

    // plan taper: pull the nose and tail in, and the roof in over the waist
    const tz = Math.abs(z) / (l * 0.5);
    const lon = z > 0
      ? 1 - (1 - prof.noseTaper) * Math.pow(Math.max(0, tz - 0.42) / 0.58, 1.6)
      : 1 - (1 - prof.tailTaper) * Math.pow(Math.max(0, tz - 0.42) / 0.58, 1.6);
    const ty = Math.max(0, (y - beltY) / Math.max(roofY - beltY, 0.001));
    const lat = 1 - (1 - prof.tumble) * Math.pow(Math.min(1, ty), 1.3);
    pos.setX(i, x * lon * lat);

    // glasshouse band, sills and bumper zone
    let c = PAINT;
    if (y > beltY + h * 0.012 && y < glassTop && !opts.noGlass) c = GLASS;
    else if (y < h * 0.215) c = TRIM;
    colours[i * 3] = c[0]; colours[i * 3 + 1] = c[1]; colours[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  return geo;
}

// A proper wheel: a torus tyre with a sidewall, a rim face, a hub, and a dark
// arch liner so the wheel sits in the body rather than beside it.
function wheelSet(len, wid, r, insetZ = 0.70, tyreW = 0.24) {
  const parts = [];
  for (const z of [len * 0.5 * insetZ, -len * 0.5 * insetZ]) {
    for (const x of [wid * 0.5, -wid * 0.5]) {
      const t = new THREE.TorusGeometry(r * 0.76, r * 0.26, 6, 16);
      t.rotateY(Math.PI / 2);
      t.translate(x, r, z);
      parts.push(tint(t, TYRE));
      parts.push(disc(r * 0.56, tyreW * 0.92, x, r, z, RIM, 12));
      parts.push(disc(r * 0.20, tyreW * 1.0, x, r, z, DARK, 8));
      parts.push(box(tyreW * 0.45, r * 0.5, r * 2.3, x * 1.03, r * 1.16, z, ARCH));
    }
  }
  return parts;
}

function lamps(w, l, y, frontY) {
  return [
    box(w * 0.26, 0.15, 0.06, w * 0.30, frontY, l * 0.495, LIGHT),
    box(w * 0.26, 0.15, 0.06, -w * 0.30, frontY, l * 0.495, LIGHT),
    box(w * 0.28, 0.17, 0.06, w * 0.29, y, -l * 0.495, TAIL),
    box(w * 0.28, 0.17, 0.06, -w * 0.29, y, -l * 0.495, TAIL)
  ];
}

// --- body builders ---------------------------------------------------------
// Local frame: +Z is forward, Y is up, origin on the road surface.

function carBody(spec, style) {
  const prof = PROFILES[style] || PROFILES.sedan;
  const { w, l, h } = spec;
  const wheelR = style === 'suv' ? 0.36 : 0.315;
  const parts = [
    extrudeBody(spec, prof),
    // grille, plate, mirrors, roof seam
    box(w * 0.62, h * 0.11, 0.06, 0, h * 0.40, l * 0.497, DARK),
    box(w * 0.30, 0.12, 0.04, 0, h * 0.30, -l * 0.503, TRIM2),
    box(0.17, 0.09, 0.08, w * 0.50, h * 0.63, l * 0.10, TRIM),
    box(0.17, 0.09, 0.08, -w * 0.50, h * 0.63, l * 0.10, TRIM),
    ...lamps(w, l, h * 0.52, h * 0.46),
    ...wheelSet(l, w, wheelR, 0.70)
  ];
  return mergeGeometries(parts, false);
}

function busBody(spec) {
  const { w, l, h } = spec;
  const wheelR = 0.47;
  const body = extrudeBody(spec, PROFILES.bus, { noGlass: true });
  const parts = [
    body,
    // continuous glazing band, windscreen and rear screen
    box(w * 1.004, h * 0.30, l * 0.90, 0, h * 0.70, -l * 0.01, GLASS),
    box(w * 0.92, h * 0.34, 0.07, 0, h * 0.70, l * 0.498, GLASS),
    box(w * 0.90, h * 0.28, 0.07, 0, h * 0.72, -l * 0.498, GLASS),
    // doors, skirt, roof pods
    box(0.08, h * 0.62, 1.05, w * 0.503, h * 0.36, l * 0.24, DARK),
    box(0.08, h * 0.62, 1.05, w * 0.503, h * 0.36, -l * 0.18, DARK),
    box(w * 1.006, 0.26, l * 0.94, 0, h * 0.17, 0, TRIM),
    box(w * 0.5, 0.18, l * 0.18, 0, h + 0.07, -l * 0.10, TRIM),
    ...lamps(w, l, h * 0.26, h * 0.22),
    ...wheelSet(l, w, wheelR, 0.78, 0.30)
  ];
  return mergeGeometries(parts, false);
}

function truckBody(spec) {
  const { w, l, h } = spec;
  const wheelR = 0.46;
  const cabL = l * 0.32;
  const cabZ = l * 0.5 - cabL / 2;
  const boxL = l - cabL - 0.3;
  const boxZ = -cabL / 2 - 0.15;
  const cab = extrudeBody({ w, l: cabL, h: h * 0.82 }, PROFILES.van);
  cab.translate(0, 0, cabZ);
  const parts = [
    cab,
    box(w * 0.92, 0.18, l * 0.9, 0, 0.30, -l * 0.02, DARK),           // chassis
    box(w, h * 0.78, boxL, 0, 0.30 + h * 0.39, boxZ, TRIM2),           // load box
    box(w * 1.006, h * 0.70, 0.06, 0, 0.30 + h * 0.40, boxZ + boxL * -0.30, TRIM),
    box(w * 1.006, h * 0.70, 0.06, 0, 0.30 + h * 0.40, boxZ + boxL * -0.06, TRIM),
    box(w * 1.006, h * 0.70, 0.06, 0, 0.30 + h * 0.40, boxZ + boxL * 0.18, TRIM),
    box(w * 0.60, h * 0.10, 0.06, 0, h * 0.30, l * 0.497, DARK),
    ...lamps(w, l, h * 0.28, h * 0.26),
    ...wheelSet(l, w, wheelR, 0.80, 0.30)
  ];
  return mergeGeometries(parts, false);
}

function ambulanceBody(spec) {
  const { w, l, h } = spec;
  const wheelR = 0.40;
  const parts = [
    extrudeBody(spec, PROFILES.van),
    box(w * 1.012, 0.24, l * 0.94, 0, h * 0.36, 0, STRIPE),            // livery
    box(w * 0.66, 0.15, 0.40, 0, h + 0.09, l * 0.24, BEACON),          // light bar
    box(w * 0.60, h * 0.10, 0.06, 0, h * 0.34, l * 0.497, DARK),
    ...lamps(w, l, h * 0.40, h * 0.36),
    ...wheelSet(l, w, wheelR, 0.74, 0.26)
  ];
  return mergeGeometries(parts, false);
}

function autoBody(spec) {
  const { w, l, h } = spec;
  const wheelR = 0.29;
  const base = wheelR * 0.5;
  // the tub, then a rounded canopy made from a half cylinder
  const canopy = new THREE.CylinderGeometry(w * 0.48, w * 0.48, l * 0.56, 12, 1, false, 0, Math.PI);
  canopy.rotateZ(Math.PI / 2);
  canopy.rotateY(Math.PI / 2);
  canopy.translate(0, base + h * 0.40, -l * 0.10);
  const parts = [
    box(w, h * 0.42, l * 0.84, 0, base + h * 0.21, -l * 0.04, PAINT),
    tint(canopy, PAINT),
    box(w * 0.965, h * 0.24, l * 0.40, 0, base + h * 0.50, -l * 0.16, DARK),
    box(w * 0.78, h * 0.28, 0.07, 0, base + h * 0.50, l * 0.22, GLASS, -0.32),
    box(0.18, h * 0.30, 0.18, 0, wheelR + h * 0.18, l * 0.34, TRIM),
    disc(0.14, 0.09, 0, wheelR + h * 0.36, l * 0.39, LIGHT, 10),
    box(w * 0.46, 0.13, 0.06, 0, base + h * 0.20, -l * 0.44, TAIL),
    ...(() => {
      const ps = [];
      const front = new THREE.TorusGeometry(wheelR * 0.76, wheelR * 0.26, 6, 14);
      front.rotateY(Math.PI / 2); front.translate(0, wheelR, l * 0.40);
      ps.push(tint(front, TYRE), disc(wheelR * 0.5, 0.17, 0, wheelR, l * 0.40, RIM, 10));
      for (const x of [w * 0.5, -w * 0.5]) {
        const t = new THREE.TorusGeometry(wheelR * 0.76, wheelR * 0.26, 6, 14);
        t.rotateY(Math.PI / 2); t.translate(x, wheelR, -l * 0.30);
        ps.push(tint(t, TYRE), disc(wheelR * 0.5, 0.21, x, wheelR, -l * 0.30, RIM, 10));
      }
      return ps;
    })()
  ];
  return mergeGeometries(parts, false);
}

function bikeBody(spec) {
  const { w, l, h } = spec;
  const wheelR = 0.30;
  const tank = new THREE.SphereGeometry(0.26, 10, 8);
  tank.scale(1, 0.72, 1.7);
  tank.translate(0, wheelR + 0.50, l * 0.06);
  const head = new THREE.SphereGeometry(0.15, 10, 8);
  head.scale(1, 1.15, 1.05);
  head.translate(0, wheelR + 1.33, -l * 0.02);
  const parts = [
    box(w * 0.48, 0.26, l * 0.46, 0, wheelR + 0.32, l * 0.02, PAINT),
    tint(tank, PAINT),
    box(w * 0.44, 0.14, 0.44, 0, wheelR + 0.58, -l * 0.14, DARK),
    box(0.34, 0.12, 0.30, 0, wheelR + 0.68, l * 0.30, TRIM),
    disc(0.10, 0.08, 0, wheelR + 0.54, l * 0.38, LIGHT, 10),
    box(0.38, 0.60, 0.28, 0, wheelR + 0.92, -l * 0.06, RIDER),
    tint(head, HELMET),
    box(0.14, 0.38, 0.14, 0.21, wheelR + 0.94, l * 0.12, RIDER),
    box(0.14, 0.38, 0.14, -0.21, wheelR + 0.94, l * 0.12, RIDER),
    box(w * 0.44, 0.11, 0.06, 0, wheelR + 0.40, -l * 0.34, TAIL),
    ...(() => {
      const ps = [];
      for (const z of [l * 0.36, -l * 0.34]) {
        const t = new THREE.TorusGeometry(wheelR * 0.78, wheelR * 0.22, 6, 14);
        t.rotateY(Math.PI / 2); t.translate(0, wheelR, z);
        ps.push(tint(t, TYRE), disc(wheelR * 0.46, 0.14, 0, wheelR, z, RIM, 10));
      }
      return ps;
    })()
  ];
  return mergeGeometries(parts, false);
}

const BUILDERS = {
  hatchback: s => carBody(s, 'hatch'),
  sedan: s => carBody(s, 'sedan'),
  suv: s => carBody(s, 'suv'),
  auto: autoBody,
  bike: bikeBody,
  bus: busBody,
  truck: truckBody,
  ambulance: ambulanceBody
};

// Believable vehicle paint: mostly monochrome with a few saturated cars.
// Real traffic is mostly white, silver, grey and black, with a minority of
// strong colours. Keeping the greys deep rather than near-white stops the whole
// stream blowing out to pale under a bright sky.
const PALETTES = {
  common: [0xd7dbe0, 0xeef1f4, 0x14171b, 0x1b1f25, 0x6f767e, 0x424a54, 0x8e959d, 0x2b323b],
  colour: [0xa62a20, 0x14568f, 0x1f6b42, 0xc06a12, 0x5e3a87, 0x0d6270, 0x8e2a48, 0x1c4f74],
  auto:   [0xf2c200, 0xf5d020, 0xe8b400],
  bus:    [0xd94f3d, 0x2f7fbf, 0x3f8f5f, 0xe0e4e8],
  truck:  [0xdfe3e8, 0x3a4450, 0x8b9198, 0x2f6f9f],
  ambulance: [0xf4f6f8]
};

export class VehicleRenderer {
  constructor(scene) {
    this.scene = scene;
    this.meshes = {};
    this.rng = makeRng(4242);
    this.dummy = new THREE.Object3D();
    this.colour = new THREE.Color();

    // Real car paint is pigment under a clear lacquer, which is why it shows a
    // sharp white highlight on top of its own colour. A plain rough/metal
    // surface cannot do that and always reads as moulded plastic. The clearcoat
    // layer, lit by the scene's environment map, is most of what makes these
    // look like vehicles rather than painted boxes.
    // Car paint is a pigmented DIELECTRIC base under a clear lacquer, not a
    // metal. Giving it metalness plus a bright sky probe made every car wash
    // out to the colour of the sky; the sheen belongs in the clearcoat layer,
    // which reflects without bleaching the colour underneath.
    const bodyMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.42,
      metalness: 0.04,
      // A mirror-smooth lacquer reflects the whole sky at grazing angles, which
      // is correct and looks terrible: every car turns pale blue regardless of
      // its paint. Softening the coat keeps the highlight but lets the colour
      // underneath survive.
      clearcoat: 0.55,
      clearcoatRoughness: 0.15,
      envMapIntensity: 0.45
    });

    for (const [cls, spec] of Object.entries(CFG.classes)) {
      const geo = BUILDERS[cls](spec);
      geo.computeVertexNormals();
      const mesh = new THREE.InstancedMesh(geo, bodyMat.clone(), MAX_PER_CLASS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      const colours = new Float32Array(MAX_PER_CLASS * 3);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
      this.meshes[cls] = mesh;
    }

    this.buildLamps(scene);
  }

  // Head and tail lamps are unlit quads driven by instanceColor, so they read
  // as emissive and feed the bloom pass without costing a real light each.
  buildLamps(scene) {
    const mk = (geo, max) => {
      const m = new THREE.InstancedMesh(
        geo,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
        max
      );
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      return m;
    };
    const MAXL = 1400;
    this.tail = mk(new THREE.PlaneGeometry(1, 0.20), MAXL);
    this.head = mk(new THREE.PlaneGeometry(1, 0.18), MAXL);
  }

  paintFor(v) {
    const r = v.colorSeed;
    const pick = arr => arr[Math.floor(r * arr.length) % arr.length];
    switch (v.cls) {
      case 'auto': return pick(PALETTES.auto);
      case 'bus': return pick(PALETTES.bus);
      case 'truck': return pick(PALETTES.truck);
      case 'ambulance': return PALETTES.ambulance[0];
      case 'bike': return r < 0.5 ? pick(PALETTES.colour) : pick(PALETTES.common);
      default: return r < 0.26 ? pick(PALETTES.colour) : pick(PALETTES.common);
    }
  }

  sync(vehicles, nightFactor, time) {
    const counts = {};
    for (const k in this.meshes) counts[k] = 0;
    let tailN = 0, headN = 0;
    const d = this.dummy;

    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const mesh = this.meshes[v.cls];
      if (!mesh) continue;
      const idx = counts[v.cls];
      if (idx >= MAX_PER_CLASS) continue;

      d.position.set(v.x, 0, v.z);
      d.rotation.set(0, v.heading, 0);
      // body roll under lateral movement, squat under braking
      d.rotation.z = -v.yawBias * 0.35;
      d.rotation.x = v.braking * 0.012;
      d.updateMatrix();
      mesh.setMatrixAt(idx, d.matrix);

      if (v.paint === undefined) v.paint = this.paintFor(v);
      this.colour.setHex(v.paint);
      mesh.setColorAt(idx, this.colour);
      counts[v.cls] = idx + 1;

      // ---- lamps ----------------------------------------------------------
      const halfL = v.len / 2;
      const cosH = Math.cos(v.heading), sinH = Math.sin(v.heading);
      const lampY = v.cls === 'bus' || v.cls === 'truck' ? 0.95 : 0.66;

      if (tailN < this.tail.count + 1400) {
        const braking = v.braking > 0.02 || v.v < 0.4;
        const lit = braking ? 1 : 0.30 + nightFactor * 0.5;
        d.position.set(v.x - sinH * (halfL + 0.02), lampY, v.z - cosH * (halfL + 0.02));
        d.rotation.set(0, v.heading + Math.PI, 0);
        d.scale.set(v.wid * 0.82, 1, 1);
        d.updateMatrix();
        d.scale.set(1, 1, 1);
        this.tail.setMatrixAt(tailN, d.matrix);
        this.colour.setRGB(lit * 1.5, lit * 0.10, lit * 0.10);
        this.tail.setColorAt(tailN, this.colour);
        tailN++;
      }

      const headlightsOn = nightFactor > 0.18 || v.emergency;
      if (headlightsOn && headN < 1400) {
        d.position.set(v.x + sinH * (halfL + 0.02), lampY, v.z + cosH * (halfL + 0.02));
        d.rotation.set(0, v.heading, 0);
        d.scale.set(v.wid * 0.80, 1, 1);
        d.updateMatrix();
        d.scale.set(1, 1, 1);
        this.head.setMatrixAt(headN, d.matrix);
        if (v.emergency) {
          // alternating red/blue beacon
          const f = Math.sin(time * 14) > 0;
          this.colour.setRGB(f ? 2.4 : 0.2, 0.25, f ? 0.3 : 2.4);
        } else {
          const k = 0.75 + nightFactor * 1.15;
          this.colour.setRGB(k, k * 0.97, k * 0.86);
        }
        this.head.setColorAt(headN, this.colour);
        headN++;
      }
    }

    for (const k in this.meshes) {
      const m = this.meshes[k];
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.tail.count = tailN;
    this.tail.instanceMatrix.needsUpdate = true;
    this.tail.instanceColor.needsUpdate = true;
    this.head.count = headN;
    this.head.instanceMatrix.needsUpdate = true;
    this.head.instanceColor.needsUpdate = true;
  }
}
