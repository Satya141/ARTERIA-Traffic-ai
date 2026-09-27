import { CFG } from '../core/config.js';

// ============================================================================
//  Network performance measurement.
//  Everything here is computed identically for the AI world and the baseline
//  twin, so the headline comparison numbers are apples to apples.
// ============================================================================

const RING = 240;   // ~2 minutes of samples at 2 Hz for the sparklines

export class Metrics {
  constructor() {
    this.completed = 0;
    this.sumTravel = 0;
    this.sumWait = 0;
    this.sumStops = 0;
    this.sumDist = 0;
    this.sumJunctions = 0;
    this.co2 = 0;
    this.fuel = 0;
    this.idleSeconds = 0;

    this.liveWait = 0;
    this.avgSpeed = 0;
    this.queue = 0;
    this.running = 0;
    this.throughputWindow = [];
    this.heldWait = 0;
    this.heldCount = 0;
    this.sampleAccum = 0;

    this.series = {
      wait: new Float32Array(RING),
      queue: new Float32Array(RING),
      speed: new Float32Array(RING),
      throughput: new Float32Array(RING)
    };
    this.idx = 0;
    this.filled = 0;
  }

  complete(v, t) {
    this.completed++;
    this.sumTravel += t - v.spawnT;
    this.sumWait += v.waitT;
    this.sumStops += v.stops;
    this.sumDist += v.dist;
    this.sumJunctions += v.junctions;
    this.throughputWindow.push(t);
  }

  sample(sim, dt) {
    let speed = 0, queue = 0, wait = 0;
    const veh = sim.vehicles;
    for (let i = 0; i < veh.length; i++) {
      const v = veh[i];
      speed += v.v;
      wait += v.waitT;
      if (v.v < 0.6) {
        queue++;
        this.co2 += CFG.emissions.idleGramsPerSec * dt * v.weight;
        this.fuel += CFG.emissions.fuelIdleMlPerSec * dt * v.weight;
        this.idleSeconds += dt;
      } else {
        this.co2 += CFG.emissions.cruiseGramsPerSec * dt * v.weight * (v.v / CFG.speedLimit);
        this.fuel += CFG.emissions.fuelIdleMlPerSec * 1.9 * dt * v.weight * (v.v / CFG.speedLimit);
      }
    }
    this.running = veh.length;
    this.avgSpeed = veh.length ? speed / veh.length : 0;
    this.queue = queue;
    this.liveWait = veh.length ? wait / veh.length : 0;

    // Traffic that could not even be admitted is still traffic that is waiting.
    // Leaving it out lets a failing network look good by turning drivers away
    // at the boundary, so its delay is carried in the same average.
    let heldWait = 0, heldCount = 0;
    for (const q of sim.backlog) {
      for (let k = 0; k < q.length; k++) { heldWait += sim.t - q[k].t; heldCount++; }
    }
    this.heldWait = heldWait;
    this.heldCount = heldCount;

    const cutoff = sim.t - 120;
    while (this.throughputWindow.length && this.throughputWindow[0] < cutoff) this.throughputWindow.shift();

    this.sampleAccum += dt;
    if (this.sampleAccum >= 0.5) {
      this.sampleAccum = 0;
      const i = this.idx % RING;
      this.series.wait[i] = this.avgWait;
      this.series.queue[i] = queue;
      this.series.speed[i] = this.avgSpeed * 3.6;
      this.series.throughput[i] = this.throughputPerHour;
      this.idx++;
      this.filled = Math.min(RING, this.filled + 1);
    }
  }

  //  Total system delay per vehicle: trips already finished, vehicles still on
  //  the network, and demand still held at the boundary. All three or none —
  //  any subset can be gamed by a controller that simply refuses traffic.
  get avgWait() {
    const liveCount = this.running;
    const total = this.completed + liveCount + this.heldCount;
    if (!total) return 0;
    return (this.sumWait + this.liveWait * liveCount + this.heldWait) / total;
  }

  get avgTravel() { return this.completed ? this.sumTravel / this.completed : 0; }
  get avgStops() { return this.completed ? this.sumStops / this.completed : 0; }
  // stops per junction traversed: the cleanest read on progression quality
  get stopsPerJunction() { return this.sumJunctions ? this.sumStops / this.sumJunctions : 0; }
  get avgJunctions() { return this.completed ? this.sumJunctions / this.completed : 0; }
  get throughputPerHour() { return this.throughputWindow.length * 30; }
  get avgSpeedKmh() { return this.avgSpeed * 3.6; }
  get co2Kg() { return this.co2 / 1000; }
  get fuelLitres() { return this.fuel / 1000; }

  // last N samples of a series, oldest first
  tail(name, n = 60) {
    const s = this.series[name];
    const out = [];
    const count = Math.min(n, this.filled);
    for (let k = count; k > 0; k--) out.push(s[(this.idx - k + RING * 4) % RING]);
    return out;
  }
}

export function compare(ai, base) {
  const pct = (a, b, lowerIsBetter = true) => {
    if (!b) return 0;
    const d = ((b - a) / b) * 100;
    return lowerIsBetter ? d : -d;
  };
  return {
    wait: pct(ai.avgWait, base.avgWait),
    travel: pct(ai.avgTravel, base.avgTravel),
    stops: pct(ai.avgStops, base.avgStops),
    queue: pct(ai.queue, base.queue),
    co2: pct(ai.co2, base.co2),
    fuel: pct(ai.fuel, base.fuel),
    throughput: base.throughputPerHour
      ? ((ai.throughputPerHour - base.throughputPerHour) / base.throughputPerHour) * 100 : 0,
    speed: base.avgSpeed ? ((ai.avgSpeed - base.avgSpeed) / base.avgSpeed) * 100 : 0
  };
}
