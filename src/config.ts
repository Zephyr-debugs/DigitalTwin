export type Vec3 = [number, number, number];
export type Range = [number, number];
export type SubsystemId = 'head' | 'torso' | 'arms' | 'legs';
export type Side = 'L' | 'R' | 'C';

/** Blender bone names. Everything in the app is keyed by these. */
export const JOINT_IDS = [
  'pelvis',
  'spine',
  'chest',
  'neck',
  'head',
  'upper_arm.L',
  'forearm.L',
  'hand.L',
  'upper_arm.R',
  'forearm.R',
  'hand.R',
  'thigh.L',
  'shin.L',
  'foot.L',
  'thigh.R',
  'shin.R',
  'foot.R',
] as const;

export type JointId = (typeof JOINT_IDS)[number];
export const ROOT_BONE = 'root';
export const ALL_BONES: readonly string[] = [ROOT_BONE, ...JOINT_IDS];

export interface JointDef {
  id: JointId;
  label: string;
  side: Side;
  subsystem: SubsystemId;
  /** Per logical axis X, Y, Z. */
  limits: [Range, Range, Range];
  axisNames: [string, string, string];
  /** Rated continuous torque used for load and alert ratios. */
  ratedTorque: number;
}

const SPINE_AXES: [string, string, string] = ['pitch', 'twist', 'lean'];

const LIMITS = {
  pelvis: [[-15, 15], [-30, 30], [-15, 15]],
  spine: [[-20, 35], [-30, 30], [-20, 20]],
  chest: [[-15, 25], [-35, 35], [-15, 15]],
  neck: [[-30, 30], [-60, 60], [-25, 25]],
  head: [[-30, 35], [-70, 70], [-25, 25]],
  upper_arm: [[-100, 100], [-90, 90], [-110, 60]],
  forearm: [[-40, 40], [-90, 90], [-145, 0]],
  hand: [[-60, 60], [-80, 80], [-40, 40]],
  thigh: [[-100, 30], [-40, 40], [-30, 30]],
  shin: [[0, 140], [-10, 10], [-10, 10]],
  foot: [[-45, 45], [-20, 20], [-20, 20]],
} satisfies Record<string, [Range, Range, Range]>;

function def(
  id: JointId,
  base: keyof typeof LIMITS,
  subsystem: SubsystemId,
  axisNames: [string, string, string],
  ratedTorque: number,
): JointDef {
  const side: Side = id.endsWith('.L') ? 'L' : id.endsWith('.R') ? 'R' : 'C';
  const label = base.replace('_', ' ');
  return { id, label, side, subsystem, limits: LIMITS[base], axisNames, ratedTorque };
}

export const JOINTS: Record<JointId, JointDef> = {
  pelvis: def('pelvis', 'pelvis', 'torso', SPINE_AXES, 60),
  spine: def('spine', 'spine', 'torso', SPINE_AXES, 55),
  chest: def('chest', 'chest', 'torso', SPINE_AXES, 45),
  neck: def('neck', 'neck', 'head', SPINE_AXES, 8),
  head: def('head', 'head', 'head', SPINE_AXES, 5),
  'upper_arm.L': def('upper_arm.L', 'upper_arm', 'arms', ['raise', 'twist', 'swing'], 18),
  'forearm.L': def('forearm.L', 'forearm', 'arms', ['lateral', 'twist', 'flex'], 10),
  'hand.L': def('hand.L', 'hand', 'arms', ['flex', 'twist', 'deviation'], 3),
  'upper_arm.R': def('upper_arm.R', 'upper_arm', 'arms', ['raise', 'twist', 'swing'], 18),
  'forearm.R': def('forearm.R', 'forearm', 'arms', ['lateral', 'twist', 'flex'], 10),
  'hand.R': def('hand.R', 'hand', 'arms', ['flex', 'twist', 'deviation'], 3),
  'thigh.L': def('thigh.L', 'thigh', 'legs', ['pitch', 'twist', 'abduct'], 70),
  'shin.L': def('shin.L', 'shin', 'legs', ['knee', 'twist', 'lateral'], 55),
  'foot.L': def('foot.L', 'foot', 'legs', ['pitch', 'twist', 'roll'], 25),
  'thigh.R': def('thigh.R', 'thigh', 'legs', ['pitch', 'twist', 'abduct'], 70),
  'shin.R': def('shin.R', 'shin', 'legs', ['knee', 'twist', 'lateral'], 55),
  'foot.R': def('foot.R', 'foot', 'legs', ['pitch', 'twist', 'roll'], 25),
};

export const SUBSYSTEMS: { id: SubsystemId; label: string; meshPrefix: string }[] = [
  { id: 'head', label: 'Head', meshPrefix: 'Head_' },
  { id: 'torso', label: 'Torso', meshPrefix: 'Torso_' },
  { id: 'arms', label: 'Arms', meshPrefix: 'Arm_' },
  { id: 'legs', label: 'Legs', meshPrefix: 'Leg_' },
];

export function jointsOf(subsystem: SubsystemId): JointDef[] {
  return JOINT_IDS.map((id) => JOINTS[id]).filter((j) => j.subsystem === subsystem);
}

export const ROOT_BOB_RANGE: Range = [-0.08, 0.08];

/** Robot height after normalization, in metres. The asset is authored at about this size. */
export const TARGET_HEIGHT = 1.8;
export const MODEL_URL = `${import.meta.env.BASE_URL}models/worker_bot.glb`;
export const MODEL_PROBE_INTERVAL_MS = 2000;
export const CLIP_FPS = 24;

/** Clips the brief promises. Anything else in the file is still listed. */
export const EXPECTED_CLIPS = ['Idle', 'Wave', 'Walk', 'Look_Around', 'Arms_Raise', 'TPose'];
export const LOOPING_CLIPS = new Set(['Idle', 'Walk', 'Look_Around']);

export interface Band {
  warn: number;
  fault: number;
}

/**
 * Alert thresholds. Edit here or override at runtime with
 * `?thresholds={"temp_c":{"warn":55,"fault":70}}` (URL-encoded JSON).
 */
export interface Thresholds {
  temp_c: Band;
  current_a: Band;
  /** Fraction of rated torque. */
  torque_ratio: Band;
  /** Degrees between commanded and measured angle. */
  tracking_deg: Band;
  /** Degrees of margin left before a joint limit. Lower is worse. */
  limit_margin_deg: Band;
  /** Lower is worse. */
  battery_pct: Band;
  latency_ms: Band;
  controller_load_pct: Band;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  temp_c: { warn: 60, fault: 75 },
  current_a: { warn: 4.5, fault: 6.5 },
  torque_ratio: { warn: 0.85, fault: 1.1 },
  tracking_deg: { warn: 6, fault: 14 },
  limit_margin_deg: { warn: 2, fault: 0.25 },
  battery_pct: { warn: 25, fault: 10 },
  latency_ms: { warn: 60, fault: 150 },
  controller_load_pct: { warn: 80, fault: 95 },
};

export function loadThresholds(): Thresholds {
  const raw = new URLSearchParams(location.search).get('thresholds');
  if (!raw) return DEFAULT_THRESHOLDS;
  try {
    const parsed = JSON.parse(raw) as Partial<Thresholds>;
    const merged = { ...DEFAULT_THRESHOLDS };
    for (const key of Object.keys(merged) as (keyof Thresholds)[]) {
      const band = parsed[key];
      if (band && typeof band.warn === 'number' && typeof band.fault === 'number') merged[key] = band;
    }
    return merged;
  } catch {
    console.warn('[config] could not parse ?thresholds, using defaults');
    return DEFAULT_THRESHOLDS;
  }
}

export const DEBUG = new URLSearchParams(location.search).has('debug');

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampJoint(id: JointId, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const lim = JOINTS[id].limits;
  out[0] = clamp(v[0], lim[0][0], lim[0][1]);
  out[1] = clamp(v[1], lim[1][0], lim[1][1]);
  out[2] = clamp(v[2], lim[2][0], lim[2][1]);
  return out;
}
