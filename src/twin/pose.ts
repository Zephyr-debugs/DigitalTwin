import { JOINT_IDS, type JointId, type Vec3 } from '../config';

/** Logical pose: delta Euler degrees per joint (bone-local), plus vertical root offset in metres. */
export interface Pose {
  joints: Record<JointId, Vec3>;
  rootBob: number;
}

export function createPose(): Pose {
  const joints = {} as Record<JointId, Vec3>;
  for (const id of JOINT_IDS) joints[id] = [0, 0, 0];
  return { joints, rootBob: 0 };
}

export function copyPose(src: Pose, dst: Pose): Pose {
  for (const id of JOINT_IDS) {
    const s = src.joints[id];
    const d = dst.joints[id];
    d[0] = s[0];
    d[1] = s[1];
    d[2] = s[2];
  }
  dst.rootBob = src.rootBob;
  return dst;
}

/** Frame-rate independent exponential approach. */
export function smoothPose(current: Pose, target: Pose, dt: number, tau: number): void {
  const a = 1 - Math.exp(-dt / Math.max(tau, 1e-4));
  for (const id of JOINT_IDS) {
    const c = current.joints[id];
    const t = target.joints[id];
    c[0] += (t[0] - c[0]) * a;
    c[1] += (t[1] - c[1]) * a;
    c[2] += (t[2] - c[2]) * a;
  }
  current.rootBob += (target.rootBob - current.rootBob) * a;
}
