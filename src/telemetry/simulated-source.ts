import { JOINT_IDS, JOINTS, clampJoint, type JointId, type Vec3 } from '../config';
import { BaseSource, type MotorSample } from './types';

const RATE_HZ = 50;
const SUBSTEPS = 4;
const AMBIENT_C = 27;
const WINDING_OHM = 1.2;
const THERMAL_C_PER_W = 4.5;
const THERMAL_TAU_S = 45;
const BATTERY_WH = 2000;
const BUS_V = 48;
const D2R = Math.PI / 180;

interface Servo {
  pos: Vec3;
  vel: Vec3;
  acc: Vec3;
  /** Natural frequency, rad/s. */
  omega: number;
  zeta: number;
  /** Extra current from friction, amps. Used to make one joint run warm. */
  frictionA: number;
  temp: number;
}

function gauss(): number {
  // Irwin-Hall approximation is plenty for sensor noise.
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.866;
}

const wave = (t: number, period: number, phase = 0) => Math.sin((2 * Math.PI * t) / period + phase);
/** 0..1 raised cosine, a smooth reach/return cycle. */
const pulse = (t: number, period: number, phase = 0) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period + phase);

/**
 * A plausible pick-and-place work cycle. Actual joints follow commands through a
 * second-order servo, torque comes from gravity, inertia and viscous terms, current
 * follows torque, and winding temperature integrates I^2R with a 45 s time constant,
 * so temperature trails load. upper_arm.R has extra friction and runs warm.
 */
export class SimulatedSource extends BaseSource {
  readonly kind = 'simulated' as const;
  readonly label = 'Simulated';
  private timer: number | undefined;
  private last = 0;
  private simT = 0;
  private servos = new Map<JointId, Servo>();
  private cmd = new Map<JointId, Vec3>();
  private battery = 87;
  private latency = 10;
  private spikeUntil = 0;
  private nextSpike = 25 + Math.random() * 30;

  constructor() {
    super();
    for (const id of JOINT_IDS) {
      const slow = id === 'upper_arm.R';
      this.servos.set(id, {
        pos: [0, 0, 0],
        vel: [0, 0, 0],
        acc: [0, 0, 0],
        omega: (slow ? 2.1 : id.startsWith('thigh') || id.startsWith('shin') ? 3.6 : 3.0) * 2 * Math.PI,
        zeta: slow ? 0.7 : 0.85,
        frictionA: slow ? 0.42 : 0,
        temp: AMBIENT_C + 8 + Math.random() * 4 + (slow ? 14 : 0),
      });
      this.cmd.set(id, [0, 0, 0]);
    }
    this.command(0);
    this.servos.forEach((s, id) => {
      const c = this.cmd.get(id)!;
      s.pos = [c[0], c[1], c[2]];
    });
  }

  connect(): void {
    if (this.timer !== undefined) return;
    this.setStatus('connected', 'local simulation, 50 Hz');
    this.last = performance.now();
    this.timer = window.setInterval(() => this.tick(), 1000 / RATE_HZ);
  }

  disconnect(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.setStatus('disconnected', 'simulation stopped');
  }

  private command(t: number): void {
    const rL = pulse(t, 6.4);
    const rR = pulse(t, 6.4, Math.PI * 0.85);
    const both = (rL + rR) / 2;
    const look = wave(t, 11);
    const set = (id: JointId, x: number, y: number, z: number) => clampJoint(id, [x, y, z], this.cmd.get(id)!);

    set('pelvis', 1.5 * wave(t, 6.4), 4 * look, 3 * wave(t, 6.4, 0.4));
    set('spine', 4 + 6 * both, 6 * wave(t, 12.8), 2 * wave(t, 6.4, 1.2));
    set('chest', 2 + 5 * both, 10 * (rL - rR), 1.5 * wave(t, 9));
    set('neck', 6 * both + 3 * wave(t, 7), 22 * look, 3 * wave(t, 8.5));
    set('head', 4 * wave(t, 7, 1) + 8 * both, 30 * look + 6 * wave(t, 3.7), 2 * wave(t, 5));

    // Neutral arms hang about 40 deg below horizontal; L raises with +X, R with -X.
    set('upper_arm.L', -40 + 34 * rL, 8 * rL, -48 * rL);
    set('forearm.L', 4 * rL, -10 * rL, -14 - 68 * rL);
    set('hand.L', 12 * wave(t, 6.4, 1.6), -20 * rL, 6 * wave(t, 3.2));
    set('upper_arm.R', 40 - 34 * rR, -8 * rR, -48 * rR);
    set('forearm.R', -4 * rR, 10 * rR, -14 - 68 * rR);
    set('hand.R', 12 * wave(t, 6.4, 4.3), 20 * rR, 6 * wave(t, 3.2, 2));

    const shift = wave(t, 6.4, 0.4);
    set('thigh.L', -3 - 5 * both + 2 * shift, 1.5 * look, 1.5 * shift);
    set('shin.L', 5 + 9 * both - 2 * shift, 0, 0);
    set('foot.L', -2 - 4 * both, 0, -1.5 * shift);
    set('thigh.R', -3 - 5 * both - 2 * shift, -1.5 * look, -1.5 * shift);
    set('shin.R', 5 + 9 * both + 2 * shift, 0, 0);
    set('foot.R', -2 - 4 * both, 0, 1.5 * shift);
  }

  private gravityTorque(id: JointId, p: Vec3): number {
    switch (id) {
      case 'upper_arm.L':
      case 'upper_arm.R': {
        const elev = id === 'upper_arm.L' ? p[0] : -p[0];
        return 9.6 * Math.max(0.05, Math.cos(elev * D2R)) * (0.8 + 0.2 * Math.cos(p[2] * D2R));
      }
      case 'forearm.L':
      case 'forearm.R':
        return 1.1 + 3.4 * Math.abs(Math.sin(p[2] * D2R));
      case 'hand.L':
      case 'hand.R':
        return 0.45 + 0.3 * Math.abs(Math.sin(p[0] * D2R));
      case 'pelvis':
        return 9 + 0.5 * Math.abs(p[0]);
      case 'spine':
        return 7 + 0.9 * Math.abs(p[0]);
      case 'chest':
        return 5 + 0.8 * Math.abs(p[0]);
      case 'neck':
        return 1.6 + 0.09 * Math.abs(p[0]);
      case 'head':
        return 0.7 + 0.05 * Math.abs(p[0]);
      case 'thigh.L':
      case 'thigh.R':
        return 16 + 0.55 * Math.abs(p[0]);
      case 'shin.L':
      case 'shin.R':
        return 9 + 0.42 * p[0];
      case 'foot.L':
      case 'foot.R':
        return 8 + 0.2 * Math.abs(p[0]);
    }
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.simT += dt;
    const t = this.simT;
    this.command(t);

    const h = dt / SUBSTEPS;
    const joints: Record<string, Vec3> = {};
    const commanded: Record<string, Vec3> = {};
    const motors: Record<string, MotorSample> = {};
    let totalCurrent = 0;
    let motion = 0;

    for (const id of JOINT_IDS) {
      const s = this.servos.get(id)!;
      const c = this.cmd.get(id)!;
      const w2 = s.omega * s.omega;
      for (let k = 0; k < SUBSTEPS; k++) {
        for (let i = 0; i < 3; i++) {
          const a = w2 * (c[i]! - s.pos[i]!) - 2 * s.zeta * s.omega * s.vel[i]!;
          s.acc[i] = a;
          s.vel[i] = s.vel[i]! + a * h;
          s.pos[i] = s.pos[i]! + s.vel[i]! * h;
        }
      }
      const speed = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
      const accel = Math.hypot(s.acc[0], s.acc[1], s.acc[2]);
      motion += speed;

      const def = JOINTS[id];
      const inertia = def.ratedTorque * 0.00012;
      const viscous = def.ratedTorque * 0.0009;
      const torque = this.gravityTorque(id, s.pos) + inertia * accel + viscous * speed + 0.08 * gauss();
      const kt = def.ratedTorque / 4.2;
      const current = Math.abs(torque) / kt + 0.15 + s.frictionA * (0.6 + 0.4 * Math.min(1, speed / 40)) + 0.02 * gauss();

      const heat = current * current * WINDING_OHM * THERMAL_C_PER_W;
      s.temp += ((AMBIENT_C + heat - s.temp) / THERMAL_TAU_S) * dt;
      totalCurrent += current;

      joints[id] = [s.pos[0] + 0.04 * gauss(), s.pos[1] + 0.04 * gauss(), s.pos[2] + 0.04 * gauss()];
      commanded[id] = [c[0], c[1], c[2]];
      motors[id] = { temp_c: s.temp + 0.05 * gauss(), current_a: Math.max(0, current), torque_nm: torque };
    }

    this.battery = Math.max(0, this.battery - ((totalCurrent * BUS_V * dt) / 3600 / BATTERY_WH) * 100);

    if (t > this.nextSpike) {
      this.spikeUntil = t + 1.2 + Math.random() * 1.5;
      this.nextSpike = t + 35 + Math.random() * 50;
    }
    const target = t < this.spikeUntil ? 70 + Math.random() * 45 : 9 + 2.5 * Math.abs(gauss());
    this.latency += (target - this.latency) * 0.35;

    const load = 34 + 0.12 * motion + 4 * gauss();
    const both = (pulse(t, 6.4) + pulse(t, 6.4, Math.PI * 0.85)) / 2;
    const rootBob = -0.012 * both;

    joints.root = [0, rootBob, 0];
    this.emitFrame({
      t: Date.now() / 1000,
      joints,
      commanded,
      motors,
      system: {
        battery_pct: this.battery,
        latency_ms: this.latency,
        controller_load_pct: Math.min(100, Math.max(0, load)),
      },
    });
  }
}
