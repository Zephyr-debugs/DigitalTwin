import * as THREE from 'three';
import type { Vec3 } from '../config';
import { deltaQuat } from './pose-driver';
import type { BoneEntry, SkeletonMap } from './skeleton-map';

export interface AxisCheckResult {
  bone: string;
  expectation: string;
  status: 'pass' | 'corrected' | 'skipped';
  detail: string;
}

interface Probe {
  bone: string;
  /** Bone whose world position we watch. */
  tip: string;
  /** Logical axis being verified (always X here). */
  logical: 0;
  /** Logical sign that should produce the expected motion. */
  logicalSign: 1 | -1;
  /** World-space direction the tip should move. */
  want: THREE.Vector3;
  expectation: string;
}

// The robot faces +X and stands on +Y, so "raise" is +Y and "knee bends backward" moves the foot toward -X.
const PROBES: Probe[] = [
  { bone: 'upper_arm.L', tip: 'hand.L', logical: 0, logicalSign: 1, want: new THREE.Vector3(0, 1, 0), expectation: '+X raises the arm' },
  { bone: 'upper_arm.R', tip: 'hand.R', logical: 0, logicalSign: -1, want: new THREE.Vector3(0, 1, 0), expectation: '-X raises the arm' },
  { bone: 'shin.L', tip: 'foot.L', logical: 0, logicalSign: 1, want: new THREE.Vector3(-1, 0, 0), expectation: '+X bends the knee backward' },
  { bone: 'shin.R', tip: 'foot.R', logical: 0, logicalSign: 1, want: new THREE.Vector3(-1, 0, 0), expectation: '+X bends the knee backward' },
];

const TEST_DEG = 25;
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function tipDelta(entry: BoneEntry, tip: THREE.Object3D, physAxis: number, deg: number, top: THREE.Object3D): THREE.Vector3 {
  const saved = entry.bone.quaternion.clone();
  entry.bone.quaternion.copy(entry.restQuat);
  top.updateMatrixWorld(true);
  tip.getWorldPosition(_a);
  const phys: Vec3 = [0, 0, 0];
  phys[physAxis] = deg;
  deltaQuat(entry, phys, _q);
  entry.bone.quaternion.copy(_q);
  top.updateMatrixWorld(true);
  tip.getWorldPosition(_b);
  entry.bone.quaternion.copy(saved);
  top.updateMatrixWorld(true);
  return _b.clone().sub(_a);
}

/**
 * Rotates each probed bone about each physical axis from rest and watches where the
 * tip goes. The axis that moves the tip most along the expected direction becomes
 * logical X, and the sign is fixed so the documented convention holds. The bone's
 * axis map is corrected in place.
 */
export function runAxisCheck(map: SkeletonMap, top: THREE.Object3D): AxisCheckResult[] {
  const results: AxisCheckResult[] = [];
  const saved = new Map<THREE.Bone, THREE.Quaternion>();
  map.entries.forEach((e) => saved.set(e.bone, e.bone.quaternion.clone()));
  map.entries.forEach((e) => e.bone.quaternion.copy(e.restQuat));

  for (const p of PROBES) {
    const entry = map.get(p.bone);
    const tip = map.get(p.tip);
    if (!entry || !tip) {
      results.push({ bone: p.bone, expectation: p.expectation, status: 'skipped', detail: 'bone or tip bone not found' });
      continue;
    }
    const scores = [0, 1, 2].map((axis) => tipDelta(entry, tip.bone, axis, TEST_DEG, top).dot(p.want));
    let best = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(scores[i]!) > Math.abs(scores[best]!)) best = i;
    const bestScore = scores[best]!;
    if (Math.abs(bestScore) < 1e-5) {
      results.push({ bone: p.bone, expectation: p.expectation, status: 'skipped', detail: 'no measurable tip motion' });
      continue;
    }

    // With identity mapping, logical X drives physical X with sign +1.
    // We want logicalSign * logical X to move the tip along `want`.
    const physSign = Math.sign(bestScore) * p.logicalSign;
    const axis = entry.axis;
    const prevPerm = axis.perm[0];
    const prevSign = axis.sign[0];
    if (best !== axis.perm[0]) {
      const other = axis.perm.indexOf(best);
      axis.perm[other] = axis.perm[0];
      axis.perm[0] = best;
    }
    axis.sign[0] = physSign;

    const changed = prevPerm !== axis.perm[0] || prevSign !== axis.sign[0];
    const axisName = 'XYZ'[best];
    const moved = (bestScore * Math.sign(bestScore)).toFixed(3);
    results.push({
      bone: p.bone,
      expectation: p.expectation,
      status: changed ? 'corrected' : 'pass',
      detail: changed
        ? `logical X now drives physical ${physSign < 0 ? '-' : '+'}${axisName} (tip moved ${moved} m)`
        : `tip moved ${moved} m in the expected direction`,
    });
  }

  saved.forEach((q, bone) => bone.quaternion.copy(q));
  top.updateMatrixWorld(true);

  console.groupCollapsed('[axis-check] ' + results.map((r) => `${r.bone}:${r.status}`).join('  '));
  console.table(results);
  console.groupEnd();
  return results;
}
