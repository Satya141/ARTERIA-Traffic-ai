import { CFG } from '../core/config.js';
import { makeRng } from '../core/rng.js';

// ============================================================================
//  Demand generator.
//
//  The arrival schedule is produced ONCE and shared, read-only, by both the
//  AI-controlled world and the fixed-time baseline twin. Each arrival carries
//  its own pre-drawn randomness (vehicle class, driver aggression, turn rolls),
//  so the two worlds see literally the same traffic. Without that the A/B
//  numbers would be comparing two different days.
// ============================================================================

// `skew` multiplies demand per direction of travel. A fixed-time plan is drawn
// up for the average day, so a strongly directional load — a stadium emptying,
// a factory shift change — is exactly where it falls apart and where adaptive
// control earns its keep.
export const PROFILES = {
  offpeak: {
    label: 'OFF-PEAK', scale: 0.48, bias: 1.15,
    skew: { N: 1, S: 1, E: 1, W: 1 },
    note: 'Light, balanced demand'
  },
  normal: {
    label: 'NORMAL FLOW', scale: 0.86, bias: 1.35,
    skew: { N: 1, S: 1, E: 1.1, W: 1.1 },
    note: 'Typical weekday inter-peak'
  },
  peak: {
    label: 'EVENING PEAK', scale: 1.02, bias: 1.70,
    skew: { N: 0.85, S: 1.15, E: 1.25, W: 1.0 },
    note: 'Heavy, arterial-dominated'
  },
  surge: {
    label: 'EVENT EGRESS', scale: 0.92, bias: 1.55,
    skew: { N: 0.55, S: 1.35, E: 0.45, W: 2.60 },
    note: 'Sharply directional — the case fixed plans cannot see'
  }
};

export class DemandSchedule {
  constructor(network, seed = 20250925) {
    this.network = network;
    this.rng = makeRng(seed);
    this.items = [];
    this.horizon = 0;
    this.profileKey = 'normal';
    this.lastEmergency = -60;
    this.classEntries = Object.entries(CFG.classes)
      .filter(([k, c]) => c.share > 0)
      .map(([k, c]) => [k, c.share]);
    this.extend(180);
  }

  setProfile(key) {
    if (PROFILES[key]) this.profileKey = key;
  }

  // Generate arrivals up to `untilT` seconds of simulated time.
  extend(untilT) {
    const net = this.network;
    const rng = this.rng;
    const prof = PROFILES[this.profileKey];
    while (this.horizon < untilT) {
      const t0 = this.horizon;
      const t1 = this.horizon + 5;              // 5-second generation bucket
      for (let si = 0; si < net.sources.length; si++) {
        const src = net.sources[si];
        const arterial = src.isArterial ? CFG.demand.arterialBias : 1.0;
        const skew = (prof.skew && prof.skew[src.heading]) || 1;
        const vph = CFG.demand.baseVph * prof.scale * (src.isArterial ? prof.bias : 1) * arterial * skew;
        const lambda = (vph / 3600) * (t1 - t0);
        // Poisson arrivals thinned into the bucket
        let k = 0, p = Math.exp(-lambda), cum = p, r = rng();
        while (r > cum && k < 20) { k++; p *= lambda / k; cum += p; }
        for (let i = 0; i < k; i++) {
          const cls = rng.weighted(this.classEntries);
          this.items.push({
            t: t0 + rng() * (t1 - t0),
            src: si,
            cls,
            rolls: [rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng()]
          });
        }
      }
      // periodic emergency vehicle, always from a random edge
      if (t0 - this.lastEmergency >= CFG.demand.emergencyEveryS) {
        this.lastEmergency = t0;
        this.items.push({
          t: t0 + rng() * 4,
          src: rng.int(0, net.sources.length - 1),
          cls: 'ambulance',
          rolls: [rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng()]
        });
      }
      this.horizon = t1;
    }
    this.items.sort((a, b) => a.t - b.t);
  }

  ensure(t) {
    if (t + 30 > this.horizon) this.extend(t + 90);
  }
}
