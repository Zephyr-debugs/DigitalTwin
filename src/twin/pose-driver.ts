import * as THREE from 'three';
import { JOINT_IDS, ROOT_BONE, type JointId, type Vec3 } from '../config';
import { createPose, type Pose } from './pose';
import type { BoneEntry, SkeletonMap } from './skeleton-map';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
// Blender's "XYZ" Euler (X applied first) is three.js "ZYX" in its naming.
export const EULER_ORDER: THREE.EulerOrder = 'ZYX';

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _phys: Vec3 = [0, 0, 0];

export function logicalToPhysical(entry: BoneEntry, logical: Vec3, out: Vec3): Vec3 {
  const { perm, sign } = entry.axis;
  out[perm[0]] = sign[0] * logical[0];
  out[perm[1]] = sign[1] * logical[1];
  out[perm[2]] = sign[2] * logical[2];
  return out;
}

export function physicalToLogical(entry: BoneEntry, phys: Vec3, out: Vec3): Vec3 {
  const { perm, sign } = entry.axis;
  out[0] = sign[0] * phys[perm[0]]!;
  out[1] = sign[1] * phys[perm[1]]!;
  out[2] = sign[2] * phys[perm[2]]!;
  return out;
}

/** q = qRest * qDelta(physical Euler, degrees). */
export function deltaQuat(entry: BoneEntry, phys: Vec3, out: THREE.Quaternion): THREE.Quaternion {
  _e.set(phys[0] * D2R, phys[1] * D2R, phys[2] * D2R, EULER_ORDER);
  return out.copy(entry.restQuat).multiply(_q.setFromEuler(_e));
}

/** Inverse of deltaQuat, expressed in logical axes. */
export function logicalFromQuat(entry: BoneEntry, q: THREE.Quaternion, out: Vec3): Vec3 {
  _qi.copy(entry.restQuat).invert().multiply(q);
  _e.setFromQuaternion(_qi, EULER_ORDER);
  _phys[0] = _e.x * R2D;
  _phys[1] = _e.y * R2D;
  _phys[2] = _e.z * R2D;
  return physicalToLogical(entry, _phys, out);
}

export class PoseDriver {
  /** World up expressed in the root bone's parent space, per metre of bob. */
  private readonly bobAxis = new THREE.Vector3(0, 0, 0);
  private readonly ordered: { id: JointId; entry: BoneEntry }[] = [];
  private readonly root: BoneEntry | undefined;

  constructor(map: SkeletonMap) {
    for (const id of JOINT_IDS) {
      const entry = map.get(id);
      if (entry) this.ordered.push({ id, entry });
    }
    this.root = map.get(ROOT_BONE);
    this.computeBobAxis();
  }

  /** Call after the model has been scaled and placed. */
  computeBobAxis(): void {
    const root = this.root;
    if (!root || !root.bone.parent) return;
    const parent = root.bone.parent;
    parent.updateWorldMatrix(true, false);
    const pq = new THREE.Quaternion();
    const ps = new THREE.Vector3();
    parent.matrixWorld.decompose(new THREE.Vector3(), pq, ps);
    this.bobAxis.set(0, 1, 0).applyQuaternion(pq.invert()).divideScalar(ps.y || 1);
  }

  apply(pose: Pose): void {
    for (const { id, entry } of this.ordered) {
      logicalToPhysical(entry, pose.joints[id], _phys);
      deltaQuat(entry, _phys, entry.bone.quaternion);
    }
    if (this.root) {
      this.root.bone.quaternion.copy(this.root.restQuat);
      this.root.bone.position.copy(this.root.restPos).addScaledVector(this.bobAxis, pose.rootBob);
    }
  }

  /** Read whatever is currently on the bones (e.g. written by the AnimationMixer). */
  read(out: Pose): Pose {
    for (const { id, entry } of this.ordered) logicalFromQuat(entry, entry.bone.quaternion, out.joints[id]);
    out.rootBob = this.root ? this.bobFromPosition(this.root.bone.position) : 0;
    return out;
  }

  bobFromPosition(p: THREE.Vector3): number {
    if (!this.root) return 0;
    const len2 = this.bobAxis.lengthSq();
    if (len2 < 1e-12) return 0;
    return _v.copy(p).sub(this.root.restPos).dot(this.bobAxis) / len2;
  }

  /** Neutral pose = first keyframe of a clip, converted into logical deltas. */
  poseFromFirstFrame(clip: THREE.AnimationClip): Pose {
    const pose = createPose();
    const byNode = new Map<string, { id: string; entry: BoneEntry }>();
    for (const o of this.ordered) byNode.set(o.entry.bone.name, o);
    if (this.root) byNode.set(this.root.bone.name, { id: ROOT_BONE, entry: this.root });

    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const node = track.name.slice(0, dot);
      const prop = track.name.slice(dot + 1);
      const hit = byNode.get(node);
      if (!hit) continue;
      const v = track.values;
      if (prop === 'quaternion' && hit.id !== ROOT_BONE) {
        _q.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
        logicalFromQuat(hit.entry, _q, pose.joints[hit.id as JointId]);
      } else if (prop === 'position' && hit.id === ROOT_BONE) {
        pose.rootBob = this.bobFromPosition(_v.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0));
      }
    }
    return pose;
  }
}
