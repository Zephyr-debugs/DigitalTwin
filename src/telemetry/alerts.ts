import { JOINT_IDS, JOINTS, SUBSYSTEMS, type Band, type JointId, type SubsystemId, type Thresholds } from '../config';
import type { TelemetryStore } from './store';

export type Level = 0 | 1 | 2;
export type StatusName = 'nominal' | 'warning' | 'fault';
export const LEVEL_NAME: Readonly<Record<Level, StatusName>> = { 0: 'nominal', 1: 'warning', 2: 'fault' };

export interface Finding {
  metric: string;
  level: Level;
  value: number;
  unit: string;
  limit: number;
}

export interface AlertEvent {
  level: Level;
  source: string;
  message: string;
}

/** Fraction of a threshold a value must retreat before a level clears, so alerts do not chatter. */
const HYSTERESIS = 0.04;

function evalBand(value: number, band: Band, prev: Level, higherIsWorse: boolean): Level {
  if (!Number.isFinite(value)) return 0;
  const worse = (v: number, th: number) => (higherIsWorse ? v >= th : v <= th);
  const clearOf = (v: number, th: number) => {
    const h = Math.abs(th) * HYSTERESIS + 1e-6;
    return higherIsWorse ? v < th - h : v > th + h;
  };
  if (worse(value, band.fault)) return 2;
  if (prev === 2 && !clearOf(value, band.fault)) return 2;
  if (worse(value, band.warn)) return 1;
  if (prev >= 1 && !clearOf(value, band.warn)) return 1;
  return 0;
}

interface MetricDef {
  key: string;
  label: string;
  unit: string;
  band: (t: Thresholds) => Band;
  higherIsWorse: boolean;
  value: (store: TelemetryStore, id: JointId) => number;
  /** Displayed threshold may differ from the band for ratio metrics. */
  display?: (id: JointId, th: number) => number;
}

const JOINT_METRICS: MetricDef[] = [
  { key: 'temp', label: 'motor temp', unit: '°C', band: (t) => t.temp_c, higherIsWorse: true, value: (s, id) => s.joints.get(id)!.temp },
  { key: 'current', label: 'current', unit: 'A', band: (t) => t.current_a, higherIsWorse: true, value: (s, id) => s.joints.get(id)!.current },
  {
    key: 'torque',
    label: 'torque',
    unit: 'N·m',
    band: (t) => t.torque_ratio,
    higherIsWorse: true,
    value: (s, id) => Math.abs(s.joints.get(id)!.torque) / JOINTS[id].ratedTorque,
    display: (id, th) => th * JOINTS[id].ratedTorque,
  },
  { key: 'track', label: 'tracking error', unit: '°', band: (t) => t.tracking_deg, higherIsWorse: true, value: (s, id) => s.joints.get(id)!.trackErr ?? NaN },
  {
    key: 'limit',
    label: 'limit margin',
    unit: '°',
    band: (t) => t.limit_margin_deg,
    higherIsWorse: false,
    value: (s, id) => {
      const live = s.joints.get(id)!;
      if (!live.seen) return NaN;
      const lim = JOINTS[id].limits;
      let m = Infinity;
      for (let i = 0; i < 3; i++) {
        const [lo, hi] = lim[i]!;
        // Axes with a zero-width side (shin X starts at 0) only count once they push past it.
        const a = live.angle[i]!;
        m = Math.min(m, lo === 0 && a >= 0 ? hi - a : Math.min(a - lo, hi - a));
      }
      return m;
    },
  },
];

const SYSTEM_METRICS = [
  { key: 'battery', label: 'battery', unit: '%', band: (t: Thresholds) => t.battery_pct, higherIsWorse: false, value: (s: TelemetryStore) => s.system.battery },
  { key: 'latency', label: 'link latency', unit: 'ms', band: (t: Thresholds) => t.latency_ms, higherIsWorse: true, value: (s: TelemetryStore) => s.system.latency },
  { key: 'load', label: 'controller load', unit: '%', band: (t: Thresholds) => t.controller_load_pct, higherIsWorse: true, value: (s: TelemetryStore) => s.system.load },
];

export class AlertEngine {
  readonly joint = new Map<JointId, { level: Level; findings: Finding[] }>();
  readonly subsystem = new Map<SubsystemId, Level>();
  system: { level: Level; findings: Finding[] } = { level: 0, findings: [] };
  private prev = new Map<string, Level>();

  constructor(public thresholds: Thresholds) {
    for (const id of JOINT_IDS) this.joint.set(id, { level: 0, findings: [] });
    for (const s of SUBSYSTEMS) this.subsystem.set(s.id, 0);
  }

  evaluate(store: TelemetryStore): AlertEvent[] {
    const events: AlertEvent[] = [];
    const t = this.thresholds;

    for (const id of JOINT_IDS) {
      const findings: Finding[] = [];
      let worst: Level = 0;
      for (const m of JOINT_METRICS) {
        const key = `${id}:${m.key}`;
        const value = m.value(store, id);
        const band = m.band(t);
        const prev = this.prev.get(key) ?? 0;
        const level = evalBand(value, band, prev, m.higherIsWorse);
        if (level !== prev) {
          const shown = m.key === 'torque' ? Math.abs(store.joints.get(id)!.torque) : value;
          const th = level > 0 ? (level === 2 ? band.fault : band.warn) : band.warn;
          const thShown = m.display ? m.display(id, th) : th;
          events.push({
            level,
            source: id,
            message:
              level > prev
                ? `${m.label} ${fmt(shown)} ${m.unit}, ${m.higherIsWorse ? 'above' : 'below'} ${LEVEL_NAME[level]} limit ${fmt(thShown)} ${m.unit}`
                : `${m.label} back ${level === 0 ? 'to nominal' : 'to warning'} at ${fmt(shown)} ${m.unit}`,
          });
          this.prev.set(key, level);
        }
        if (level > 0) {
          const th = level === 2 ? band.fault : band.warn;
          findings.push({ metric: m.label, level, value: m.key === 'torque' ? Math.abs(store.joints.get(id)!.torque) : value, unit: m.unit, limit: m.display ? m.display(id, th) : th });
        }
        if (level > worst) worst = level;
      }
      this.joint.set(id, { level: worst, findings });
    }

    for (const s of SUBSYSTEMS) {
      let worst: Level = 0;
      for (const id of JOINT_IDS) if (JOINTS[id].subsystem === s.id) worst = Math.max(worst, this.joint.get(id)!.level) as Level;
      const prev = this.subsystem.get(s.id) ?? 0;
      if (worst !== prev && worst > prev) events.push({ level: worst, source: s.label, message: `subsystem ${LEVEL_NAME[worst]}` });
      if (worst !== prev && worst < prev) events.push({ level: 0, source: s.label, message: `subsystem ${LEVEL_NAME[worst]}` });
      this.subsystem.set(s.id, worst);
    }

    const sysFindings: Finding[] = [];
    let sysWorst: Level = 0;
    for (const m of SYSTEM_METRICS) {
      const key = `system:${m.key}`;
      const value = m.value(store);
      const band = m.band(t);
      const prev = this.prev.get(key) ?? 0;
      const level = evalBand(value, band, prev, m.higherIsWorse);
      if (level !== prev) {
        const th = level === 2 ? band.fault : band.warn;
        events.push({
          level,
          source: 'system',
          message:
            level > prev
              ? `${m.label} ${fmt(value)} ${m.unit}, ${m.higherIsWorse ? 'above' : 'below'} ${LEVEL_NAME[level]} limit ${fmt(th)} ${m.unit}`
              : `${m.label} back ${level === 0 ? 'to nominal' : 'to warning'} at ${fmt(value)} ${m.unit}`,
        });
        this.prev.set(key, level);
      }
      if (level > 0) sysFindings.push({ metric: m.label, level, value, unit: m.unit, limit: level === 2 ? band.fault : band.warn });
      if (level > sysWorst) sysWorst = level;
    }
    this.system = { level: sysWorst, findings: sysFindings };
    return events;
  }

  reset(): void {
    this.prev.clear();
    this.joint.forEach((_, id) => this.joint.set(id, { level: 0, findings: [] }));
    this.subsystem.forEach((_, id) => this.subsystem.set(id, 0));
    this.system = { level: 0, findings: [] };
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}
