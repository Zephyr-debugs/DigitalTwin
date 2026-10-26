import type { RingBuffer } from '../telemetry/store';
import { fixed, h, setText } from './dom';

export interface ChartSeries {
  buf: RingBuffer;
  color: string;
  name: string;
}

export interface ChartOptions {
  title: string;
  unit: string;
  digits: number;
  /** Fixed range; otherwise autoscale with at least minSpan. */
  range?: [number, number];
  minSpan?: number;
  thresholds?: { value: number; level: 'warn' | 'fault' }[];
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** A small history plot: hairline frame, two value ticks, dashed thresholds, latest value at right. */
export class LineChart {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly valueEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private series: ChartSeries[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private colors = { hair: '#2A2D31', muted: '#8A8D91', warn: '#D19A3A', fault: '#E5554A' };
  private readonly ro: ResizeObserver;

  constructor(private opts: ChartOptions) {
    this.canvas = h('canvas', { class: 'chart-canvas', 'aria-hidden': 'true' });
    this.titleEl = h('span', { class: 'chart-title', text: opts.title });
    this.valueEl = h('span', { class: 'chart-value num' });
    this.el = h('figure', { class: 'chart' }, h('figcaption', { class: 'chart-head' }, this.titleEl, this.valueEl), this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.readColors();
  }

  readColors(): void {
    this.colors = {
      hair: cssVar('--hairline', '#2A2D31'),
      muted: cssVar('--muted', '#8A8D91'),
      warn: cssVar('--warn', '#D19A3A'),
      fault: cssVar('--fault', '#E5554A'),
    };
  }

  setTitle(t: string): void {
    setText(this.titleEl, t);
  }

  setSeries(s: ChartSeries[], opts?: Partial<ChartOptions>): void {
    this.series = s;
    if (opts) this.opts = { ...this.opts, ...opts };
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.draw();
  }

  draw(): void {
    const { ctx, w, h: H, dpr } = this;
    if (w < 4 || H < 4) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);

    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    for (const s of this.series) {
      n = Math.max(n, s.buf.size);
      for (let i = 0; i < s.buf.size; i++) {
        const v = s.buf.at(i);
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (this.opts.range) {
      [lo, hi] = this.opts.range;
    } else if (lo === Infinity) {
      lo = 0;
      hi = 1;
    } else {
      const span = Math.max(hi - lo, this.opts.minSpan ?? 1);
      const mid = (hi + lo) / 2;
      lo = mid - span * 0.6;
      hi = mid + span * 0.6;
    }

    const padL = 30;
    const padR = 4;
    const padT = 3;
    const padB = 3;
    const pw = w - padL - padR;
    const ph = H - padT - padB;
    const y = (v: number) => padT + ph - ((v - lo) / (hi - lo || 1)) * ph;

    ctx.lineWidth = 1;
    ctx.strokeStyle = this.colors.hair;
    ctx.strokeRect(padL + 0.5, padT + 0.5, pw - 1, ph - 1);

    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillStyle = this.colors.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(fixed(hi, this.opts.digits), padL - 4, padT);
    ctx.textBaseline = 'bottom';
    ctx.fillText(fixed(lo, this.opts.digits), padL - 4, padT + ph);

    for (const t of this.opts.thresholds ?? []) {
      if (t.value < lo || t.value > hi) continue;
      ctx.strokeStyle = t.level === 'fault' ? this.colors.fault : this.colors.warn;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      const yy = Math.round(y(t.value)) + 0.5;
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + pw, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL + 1, padT + 1, pw - 2, ph - 2);
    ctx.clip();
    const cap = this.series[0]?.buf.capacity ?? 1;
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let pen = false;
      const offset = cap - s.buf.size;
      for (let i = 0; i < s.buf.size; i++) {
        const v = s.buf.at(i);
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const xx = padL + ((offset + i) / (cap - 1)) * pw;
        const yy = y(v);
        if (pen) ctx.lineTo(xx, yy);
        else ctx.moveTo(xx, yy);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.restore();

    const latest = this.series.map((s) => s.buf.last());
    const unit = this.opts.unit;
    setText(this.valueEl, latest.length === 1 ? `${fixed(latest[0]!, this.opts.digits)} ${unit}` : latest.map((v) => fixed(v, this.opts.digits)).join(' / ') + ` ${unit}`);
  }

  dispose(): void {
    this.ro.disconnect();
  }
}
