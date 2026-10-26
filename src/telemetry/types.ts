import type { Vec3 } from '../config';

export interface MotorSample {
  temp_c: number;
  current_a: number;
  torque_nm: number;
}

export interface SystemSample {
  battery_pct?: number;
  latency_ms?: number;
  controller_load_pct?: number;
}

/**
 * One telemetry frame. `t` is seconds since the epoch, joint angles are degrees in
 * the rig's logical bone-local axes, keyed by Blender bone name. `commanded` is
 * optional: when present the UI shows tracking error against `joints`.
 * `joints.root`, if sent, is [x, y, z] metres and only y (vertical bob) is used.
 */
export interface TelemetryFrame {
  t: number;
  joints: Record<string, Vec3>;
  commanded?: Record<string, Vec3>;
  motors: Record<string, MotorSample>;
  system: SystemSample;
}

export type LinkState = 'idle' | 'connecting' | 'connected' | 'stale' | 'disconnected' | 'error';

export interface LinkStatus {
  state: LinkState;
  detail: string;
}

export interface TelemetrySource {
  readonly kind: 'simulated' | 'websocket';
  readonly label: string;
  readonly status: LinkStatus;
  connect(): void;
  disconnect(): void;
  onFrame(fn: (f: TelemetryFrame) => void): () => void;
  onStatus(fn: (s: LinkStatus) => void): () => void;
}

/** Small shared plumbing for sources. */
export abstract class BaseSource implements TelemetrySource {
  abstract readonly kind: 'simulated' | 'websocket';
  abstract readonly label: string;
  private frameFns: ((f: TelemetryFrame) => void)[] = [];
  private statusFns: ((s: LinkStatus) => void)[] = [];
  private _status: LinkStatus = { state: 'idle', detail: '' };

  get status(): LinkStatus {
    return this._status;
  }

  abstract connect(): void;
  abstract disconnect(): void;

  onFrame(fn: (f: TelemetryFrame) => void): () => void {
    this.frameFns.push(fn);
    return () => (this.frameFns = this.frameFns.filter((f) => f !== fn));
  }

  onStatus(fn: (s: LinkStatus) => void): () => void {
    this.statusFns.push(fn);
    return () => (this.statusFns = this.statusFns.filter((f) => f !== fn));
  }

  protected emitFrame(f: TelemetryFrame): void {
    for (const fn of this.frameFns) fn(f);
  }

  protected setStatus(state: LinkState, detail = ''): void {
    if (this._status.state === state && this._status.detail === detail) return;
    this._status = { state, detail };
    for (const fn of this.statusFns) fn(this._status);
  }
}
