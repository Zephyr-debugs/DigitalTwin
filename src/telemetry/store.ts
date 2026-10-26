import { JOINT_IDS, ROOT_BONE, type JointId, type Vec3 } from '../config';
import { createPose, type Pose } from '../twin/pose';
import type { TelemetryFrame } from './types';

export const HISTORY_HZ = 10;
export const HISTORY_SECONDS = 60;
const HISTORY_LEN = HISTORY_HZ * HISTORY_SECONDS;

export class RingBuffer {
  private readonly data: Float32Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity);
  }

  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get size(): number {
    return this.count;
  }

  /** i = 0 is the oldest retained sample. */
  at(i: number): number {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity]!;
  }

  last(): number {
    return this.count ? this.data[(this.head - 1 + this.capacity) % this.capacity]! : NaN;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

export interface JointLive {
  angle: Vec3;
  cmd: Vec3 | null;
  /** Magnitude of angular velocity, deg/s. */
  vel: number;
  temp: number;
  current: number;
  torque: number;
  /** Largest per-axis |commanded - measured|, degrees. */
  trackErr: number | null;
  seen: boolean;
}

export interface JointHistory {
  temp: RingBuffer;
  current: RingBuffer;
  torque: RingBuffer;
  vel: RingBuffer;
  ax: RingBuffer;
  ay: RingBuffer;
  az: RingBuffer;
  err: RingBuffer;
}

export interface SystemLive {
  battery: number;
  latency: number;
  load: number;
}

function history(): JointHistory {
  const r = () => new RingBuffer(HISTORY_LEN);
  return { temp: r(), current: r(), torque: r(), vel: r(), ax: r(), ay: r(), az: r(), err: r() };
}

export class TelemetryStore {
  readonly joints = new Map<JointId, JointLive>();
  readonly history = new Map<JointId, JointHistory>();
  readonly system: SystemLive = { battery: NaN, latency: NaN, load: NaN };
  readonly systemHistory = { battery: new RingBuffer(HISTORY_LEN), latency: new RingBuffer(HISTORY_LEN), load: new RingBuffer(HISTORY_LEN) };
  /** Latest measured pose, as a pose target for Live mode. */
  readonly target: Pose = createPose();
  frames = 0;
  rateHz = 0;
  lastFrameAt = 0;
  /** Bone names present in frames that the twin does not know. */
  readonly unknownKeys = new Set<string>();

  private prevT = 0;
  private prevAngles = new Map<JointId, Vec3>();
  private rateWindow: number[] = [];
  private listeners: (() => void)[] = [];

  constructor() {
    for (const id of JOINT_IDS) {
      this.joints.set(id, { angle: [0, 0, 0], cmd: null, vel: 0, temp: NaN, current: NaN, torque: NaN, trackErr: null, seen: false });
      this.history.set(id, history());
    }
  }

  onFrame(fn: () => void): void {
    this.listeners.push(fn);
  }

  ingest(f: TelemetryFrame): void {
    const now = performance.now();
    this.frames++;
    this.lastFrameAt = now;
    this.rateWindow.push(now);
    while (this.rateWindow.length && now - this.rateWindow[0]! > 1000) this.rateWindow.shift();
    this.rateHz = this.rateWindow.length;

    const dt = this.prevT ? f.t - this.prevT : 0;
    this.prevT = f.t;

    for (const [key, v] of Object.entries(f.joints)) {
      if (key === ROOT_BONE) {
        this.target.rootBob = v[1];
        continue;
      }
      const live = this.joints.get(key as JointId);
      if (!live) {
        this.unknownKeys.add(key);
        continue;
      }
      const id = key as JointId;
      const prev = this.prevAngles.get(id);
      if (prev && dt > 1e-4 && dt < 1) {
        const w = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]) / dt;
        live.vel += (w - live.vel) * 0.25;
      }
      this.prevAngles.set(id, [v[0], v[1], v[2]]);
      live.angle[0] = v[0];
      live.angle[1] = v[1];
      live.angle[2] = v[2];
      live.seen = true;
      const t = this.target.joints[id];
      t[0] = v[0];
      t[1] = v[1];
      t[2] = v[2];

      const c = f.commanded?.[key];
      if (c) {
        live.cmd = [c[0], c[1], c[2]];
        live.trackErr = Math.max(Math.abs(c[0] - v[0]), Math.abs(c[1] - v[1]), Math.abs(c[2] - v[2]));
      } else {
        live.cmd = null;
        live.trackErr = null;
      }
    }

    for (const [key, m] of Object.entries(f.motors)) {
      const live = this.joints.get(key as JointId);
      if (!live) continue;
      live.temp = m.temp_c;
      live.current = m.current_a;
      live.torque = m.torque_nm;
    }

    const s = f.system;
    if (s.battery_pct !== undefined) this.system.battery = s.battery_pct;
    if (s.latency_ms !== undefined) this.system.latency = s.latency_ms;
    if (s.controller_load_pct !== undefined) this.system.load = s.controller_load_pct;

    for (const fn of this.listeners) fn();
  }

  /** Called at HISTORY_HZ so charts have an even time base regardless of frame rate. */
  sampleHistory(): void {
    this.joints.forEach((live, id) => {
      const h = this.history.get(id)!;
      h.temp.push(live.temp);
      h.current.push(live.current);
      h.torque.push(live.torque);
      h.vel.push(live.vel);
      h.ax.push(live.angle[0]);
      h.ay.push(live.angle[1]);
      h.az.push(live.angle[2]);
      h.err.push(live.trackErr ?? NaN);
    });
    this.systemHistory.battery.push(this.system.battery);
    this.systemHistory.latency.push(this.system.latency);
    this.systemHistory.load.push(this.system.load);
  }

  reset(): void {
    this.frames = 0;
    this.prevT = 0;
    this.prevAngles.clear();
    this.rateWindow = [];
    this.rateHz = 0;
    this.unknownKeys.clear();
    this.joints.forEach((j) => {
      j.vel = 0;
      j.temp = j.current = j.torque = NaN;
      j.cmd = null;
      j.trackErr = null;
      j.seen = false;
    });
    this.history.forEach((h) => Object.values(h).forEach((r: RingBuffer) => r.clear()));
    Object.values(this.systemHistory).forEach((r) => r.clear());
    this.system.battery = this.system.latency = this.system.load = NaN;
  }
}
