import { performance } from 'node:perf_hooks';

export class Timer {
  constructor() {
    this.t0 = performance.now();
    this.last = this.t0;
    this.laps = {};
  }
  lap(name) {
    const now = performance.now();
    this.laps[name + 'Us'] = Math.round((now - this.last) * 1000);
    this.last = now;
  }
  done() {
    this.laps.totalUs = Math.round((performance.now() - this.t0) * 1000);
    return this.laps;
  }
}
