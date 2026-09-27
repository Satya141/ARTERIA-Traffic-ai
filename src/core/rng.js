// Deterministic PRNG (mulberry32) so the AI run and the fixed-time baseline
// twin receive byte-identical demand — the A/B comparison is only fair if the
// two worlds see exactly the same vehicles arriving at exactly the same times.
export function makeRng(seed = 1337) {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  rng.pick = arr => arr[Math.floor(rng() * arr.length)];
  rng.gauss = (mu = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.weighted = (entries) => {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = rng() * total;
    for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  };
  return rng;
}
