import type { Vec3 } from '../config';
import { BaseSource, type MotorSample, type TelemetryFrame } from './types';

const STALE_MS = 1000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length >= 3 && v.every((n, i) => i > 2 || Number.isFinite(n));
}

function parseVecMap(raw: unknown): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isVec3(v)) out[k] = [v[0], v[1], v[2]];
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Accepts the documented frame shape; anything unrecognised is ignored rather than fatal. */
export function parseFrame(text: string): TelemetryFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const motors: Record<string, MotorSample> = {};
  if (r.motors && typeof r.motors === 'object') {
    for (const [k, v] of Object.entries(r.motors as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const m = v as Record<string, unknown>;
      motors[k] = { temp_c: num(m.temp_c) ?? NaN, current_a: num(m.current_a) ?? NaN, torque_nm: num(m.torque_nm) ?? NaN };
    }
  }
  const sys = (r.system && typeof r.system === 'object' ? r.system : {}) as Record<string, unknown>;
  const frame: TelemetryFrame = {
    t: num(r.t) ?? Date.now() / 1000,
    joints: parseVecMap(r.joints),
    motors,
    system: {
      battery_pct: num(sys.battery_pct),
      latency_ms: num(sys.latency_ms),
      controller_load_pct: num(sys.controller_load_pct),
    },
  };
  if (r.commanded) frame.commanded = parseVecMap(r.commanded);
  return frame;
}

export function defaultWebSocketUrl(): string {
  const q = new URLSearchParams(location.search).get('ws');
  const env = import.meta.env.VITE_TELEMETRY_WS as string | undefined;
  return q || env || 'ws://localhost:8765';
}

export class WebSocketSource extends BaseSource {
  readonly kind = 'websocket' as const;
  readonly label: string;
  private ws: WebSocket | null = null;
  private wanted = false;
  private backoff = BACKOFF_MIN_MS;
  private retryTimer: number | undefined;
  private staleTimer: number | undefined;
  private lastFrameAt = 0;
  private malformed = 0;

  constructor(readonly url: string = defaultWebSocketUrl()) {
    super();
    this.label = url.replace(/^wss?:\/\//, '');
  }

  connect(): void {
    this.wanted = true;
    this.open();
    if (this.staleTimer === undefined) this.staleTimer = window.setInterval(() => this.checkStale(), 250);
  }

  disconnect(): void {
    this.wanted = false;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.staleTimer);
    this.staleTimer = undefined;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected', 'closed by operator');
  }

  private open(): void {
    if (this.ws) return;
    this.setStatus('connecting', this.url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setStatus('error', `invalid URL ${this.url}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = BACKOFF_MIN_MS;
      this.setStatus('connected', this.url);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const frame = parseFrame(ev.data);
      if (!frame) {
        this.malformed++;
        if (this.malformed === 1 || this.malformed % 100 === 0) console.warn(`[ws] ${this.malformed} malformed frames`);
        return;
      }
      if (frame.system.latency_ms === undefined) {
        // Only meaningful if both clocks are synchronised; better than nothing.
        const est = Date.now() - frame.t * 1000;
        if (est >= 0 && est < 10000) frame.system.latency_ms = est;
      }
      this.lastFrameAt = performance.now();
      if (this.status.state !== 'connected') this.setStatus('connected', this.url);
      this.emitFrame(frame);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (!this.wanted) return;
      const secs = (this.backoff / 1000).toFixed(1);
      this.setStatus('disconnected', `closed (code ${ev.code}), retry in ${secs} s`);
      this.retryTimer = window.setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    };
    ws.onerror = () => {
      // onclose follows with the code; nothing useful to add here.
    };
  }

  private checkStale(): void {
    if (this.status.state === 'connected' && this.lastFrameAt && performance.now() - this.lastFrameAt > STALE_MS) {
      this.setStatus('stale', `no frames for over ${STALE_MS / 1000} s`);
    }
  }

  get malformedFrames(): number {
    return this.malformed;
  }
}
