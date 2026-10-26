import * as THREE from 'three';
import { ALL_BONES, type Vec3 } from '../config';

/**
 * Maps a logical axis (as documented in the rig spec) onto the bone's physical
 * Euler component. physical[perm[i]] = sign[i] * logical[i].
 * Starts as identity and is corrected by the axis check if the export disagrees.
 */
export interface AxisMap {
  perm: [number, number, number];
  sign: Vec3;
}

export interface BoneEntry {
  id: string;
  bone: THREE.Bone;
  restQuat: THREE.Quaternion;
  restPos: THREE.Vector3;
  axis: AxisMap;
  /** The node name as it arrived from GLTFLoader, for diagnostics. */
  sourceName: string;
}

/** Lowercase and drop everything that is not a letter or digit: "upper_arm.L" and "upper_armL" both become "upperarml". */
export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class SkeletonMap {
  readonly entries = new Map<string, BoneEntry>();
  readonly missing: string[] = [];
  readonly unexpected: string[] = [];

  get(id: string): BoneEntry | undefined {
    return this.entries.get(id);
  }

  get foundCount(): number {
    return this.entries.size;
  }

  static resolve(model: THREE.Object3D): SkeletonMap {
    const map = new SkeletonMap();
    const bones: THREE.Bone[] = [];
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });

    const byNorm = new Map<string, THREE.Bone>();
    for (const b of bones) {
      const n = normalizeBoneName(b.name);
      if (!byNorm.has(n)) byNorm.set(n, b);
    }

    const claimed = new Set<THREE.Bone>();
    for (const id of ALL_BONES) {
      const want = normalizeBoneName(id);
      // 1. exact after normalization, 2. with a Blender ".001" or loader "_1" suffix,
      // 3. with an armature prefix such as "Armature_".
      let hit = byNorm.get(want);
      if (!hit) hit = bones.find((b) => !claimed.has(b) && normalizeBoneName(b.name).replace(/\d+$/, '') === want);
      if (!hit) hit = bones.find((b) => !claimed.has(b) && normalizeBoneName(b.name).endsWith(want));
      if (!hit || claimed.has(hit)) {
        map.missing.push(id);
        continue;
      }
      claimed.add(hit);
      map.entries.set(id, {
        id,
        bone: hit,
        restQuat: hit.quaternion.clone(),
        restPos: hit.position.clone(),
        axis: { perm: [0, 1, 2], sign: [1, 1, 1] },
        sourceName: hit.name,
      });
    }
    for (const b of bones) if (!claimed.has(b)) map.unexpected.push(b.name);

    map.log();
    return map;
  }

  private log(): void {
    const rows = ALL_BONES.map((id) => {
      const e = this.entries.get(id);
      return { expected: id, found: e ? 'yes' : 'NO', node: e ? e.sourceName : '' };
    });
    const head = `[skeleton] ${this.entries.size}/${ALL_BONES.length} expected bones resolved`;
    if (this.missing.length) {
      console.warn(`${head}. Missing: ${this.missing.join(', ')}`);
    } else {
      console.info(head);
    }
    console.table(rows);
    if (this.unexpected.length) console.info('[skeleton] bones in file not used by the twin:', this.unexpected);
  }
}
