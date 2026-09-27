import { CFG, HEADINGS, RIGHT_OF, LEFT_OF, OPPOSITE, JUNCTION_HALF } from '../core/config.js';

// ============================================================================
//  Road network: a grid of signalised junctions joined by directed links.
//  Each link carries `lanesPerDir` lanes; every lane is an ordered queue of
//  vehicles (index 0 = the one furthest downstream) so car-following is O(1).
// ============================================================================

const add = (a, b, s = 1) => ({ x: a.x + b.x * s, z: a.z + b.z * s });
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const rightVec = h => ({ x: -HEADINGS[h].z, z: HEADINGS[h].x });

export function turnTypeOf(hIn, hOut) {
  if (hIn === hOut) return 'through';
  if (RIGHT_OF[hIn] === hOut) return 'right';
  if (LEFT_OF[hIn] === hOut) return 'left';
  return 'uturn';
}

// The network is laid out over the Madhapur / Kothaguda stretch of HITEC City,
// Hyderabad, so the junctions carry the names they actually have on the ground.
// Keyed by grid position, "gi,gj", west to east and north to south.
const JUNCTION_NAMES = {
  '0,0': 'Kothaguda',
  '1,0': 'Cyber Towers',
  '2,0': 'Mindspace',
  '0,1': 'Botanical Garden',
  '1,1': 'Shilpa Layout',
  '2,1': 'Durgam Cheruvu'
};

export function buildNetwork() {
  const { cols, rows, spacing } = CFG.grid;
  const nodes = [];
  const byGrid = new Map();

  // ---- signalised junctions -------------------------------------------------
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const node = {
        id: `J${i + 1}${j + 1}`,
        name: JUNCTION_NAMES[`${i},${j}`] || `J${i + 1}${j + 1}`,
        idx: nodes.length,
        type: 'signal',
        gi: i, gj: j,
        pos: { x: (i - (cols - 1) / 2) * spacing, z: (j - (rows - 1) / 2) * spacing },
        out: {}, in: {},
        neighbours: {}
      };
      nodes.push(node);
      byGrid.set(`${i},${j}`, node);
    }
  }

  // ---- boundary terminals (sources and sinks) -------------------------------
  const terminals = [];
  const mkTerminal = (sig, heading) => {
    const pos = add(sig.pos, HEADINGS[heading], CFG.terminalOffset);
    const t = {
      id: `T-${sig.id}-${heading}`, idx: nodes.length, type: 'terminal',
      pos, out: {}, in: {}, neighbours: {}, gateFor: sig.id, gateDir: heading
    };
    nodes.push(t); terminals.push(t);
    return t;
  };

  for (const n of nodes.filter(n => n.type === 'signal')) {
    const step = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
    for (const h of ['N', 'S', 'E', 'W']) {
      const [di, dj] = step[h];
      const nb = byGrid.get(`${n.gi + di},${n.gj + dj}`);
      n.neighbours[h] = nb || mkTerminal(n, h);
    }
  }

  // ---- directed links -------------------------------------------------------
  const links = [];
  const mkLink = (from, to, heading) => {
    const f = HEADINGS[heading];
    const r = rightVec(heading);
    const startClip = from.type === 'signal' ? JUNCTION_HALF : 0;
    const endClip = to.type === 'signal' ? JUNCTION_HALF + CFG.stopLineSetback : 0;
    const p0 = add(from.pos, f, startClip);
    const p1 = add(to.pos, f, -endClip);
    const length = dist(p0, p1);

    const link = {
      id: `${from.id}>${to.id}`, idx: links.length,
      from, to, heading, f, r, p0, p1, length,
      isArterial: heading === 'E' || heading === 'W',
      entersSignal: to.type === 'signal',
      lanes: [],
      capacity: 0
    };

    for (let k = 0; k < CFG.lanesPerDir; k++) {
      link.lanes.push({
        id: `${link.id}#${k}`, link, index: k,
        offset: (k + 0.5) * CFG.laneWidth,   // lane 0 hugs the centreline
        length, vehicles: [], occupancy: 0
      });
    }
    link.capacity = (length / 7.0) * CFG.lanesPerDir;
    links.push(link);
    from.out[heading] = link;
    to.in[heading] = link;
    return link;
  };

  for (const n of nodes) {
    if (n.type !== 'signal') continue;
    for (const h of ['N', 'S', 'E', 'W']) {
      const nb = n.neighbours[h];
      if (!n.out[h]) mkLink(n, nb, h);
      if (!n.in[OPPOSITE[h]]) mkLink(nb, n, OPPOSITE[h]);
    }
  }

  // ---- junction movements ---------------------------------------------------
  for (const n of nodes) {
    if (n.type !== 'signal') continue;
    n.movements = {};
    for (const hIn of ['N', 'S', 'E', 'W']) {
      const inLink = n.in[hIn];
      if (!inLink) continue;
      n.movements[hIn] = {};
      for (const hOut of ['N', 'S', 'E', 'W']) {
        if (hOut === OPPOSITE[hIn]) continue;      // no U-turns
        const outLink = n.out[hOut];
        if (!outLink) continue;
        const turn = turnTypeOf(hIn, hOut);
        if (turn === 'uturn') continue;
        n.movements[hIn][turn] = { turn, hIn, hOut, inLink, outLink, node: n };
      }
    }
    n.upstream = {};
    n.downstream = {};
    for (const h of ['N', 'S', 'E', 'W']) {
      const inL = n.in[h];
      if (inL && inL.from.type === 'signal') n.upstream[h] = inL.from;
      const outL = n.out[h];
      if (outL && outL.to.type === 'signal') n.downstream[h] = outL.to;
    }
  }

  const signals = nodes.filter(n => n.type === 'signal');
  const sources = links.filter(l => l.from.type === 'terminal');
  const sinks = links.filter(l => l.to.type === 'terminal');

  const extent = {
    x: ((cols - 1) / 2) * spacing + CFG.terminalOffset,
    z: ((rows - 1) / 2) * spacing + CFG.terminalOffset
  };

  return {
    nodes, links, signals, terminals, sources, sinks, extent,
    byId: Object.fromEntries(nodes.map(n => [n.id, n]))
  };
}

// Lane-centre world position at longitudinal distance s along a link.
export function lanePoint(lane, s, out = { x: 0, z: 0 }) {
  const L = lane.link;
  out.x = L.p0.x + L.f.x * s + L.r.x * lane.offset;
  out.z = L.p0.z + L.f.z * s + L.r.z * lane.offset;
  return out;
}

// Entry point (stop line) and exit point for a movement, plus the bezier
// control vertex, placed where the two lane centrelines intersect. That is how
// a real turning path is struck, so opposing left turns never clash.
export function buildTurnPath(movement, inLane, outLane) {
  const a = lanePoint(inLane, inLane.length);
  const b = lanePoint(outLane, 0);
  const fi = movement.inLink.f;
  let c;
  if (movement.turn === 'through') {
    c = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  } else {
    const t = (b.x - a.x) * fi.x + (b.z - a.z) * fi.z;
    c = { x: a.x + fi.x * t, z: a.z + fi.z * t };
  }
  let len = 0, px = a.x, pz = a.z;
  const N = 12;
  for (let i = 1; i <= N; i++) {
    const u = i / N, iu = 1 - u;
    const x = iu * iu * a.x + 2 * iu * u * c.x + u * u * b.x;
    const z = iu * iu * a.z + 2 * iu * u * c.z + u * u * b.z;
    len += Math.hypot(x - px, z - pz); px = x; pz = z;
  }
  return { a, b, c, length: len };
}

export function bezierAt(path, u, out = { x: 0, z: 0 }) {
  const iu = 1 - u;
  out.x = iu * iu * path.a.x + 2 * iu * u * path.c.x + u * u * path.b.x;
  out.z = iu * iu * path.a.z + 2 * iu * u * path.c.z + u * u * path.b.z;
  return out;
}

export function bezierTangent(path, u) {
  const iu = 1 - u;
  const x = 2 * iu * (path.c.x - path.a.x) + 2 * u * (path.b.x - path.c.x);
  const z = 2 * iu * (path.c.z - path.a.z) + 2 * u * (path.b.z - path.c.z);
  const m = Math.hypot(x, z) || 1;
  return { x: x / m, z: z / m };
}
