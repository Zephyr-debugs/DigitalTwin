import * as THREE from 'three';
import { JOINT_IDS, JOINTS, type JointId, type SubsystemId } from '../config';
import type { SkeletonMap } from './skeleton-map';

export const PICK_LAYER = 2;

export type Status = 'nominal' | 'warning' | 'fault';

export interface PickHit {
  joint?: JointId;
  subsystem: SubsystemId;
}

/** Segment each pick proxy spans, bone to child. Terminal bones get a sphere. */
const CHAIN: Partial<Record<JointId, JointId>> = {
  pelvis: 'spine',
  spine: 'chest',
  chest: 'neck',
  neck: 'head',
  'upper_arm.L': 'forearm.L',
  'forearm.L': 'hand.L',
  'upper_arm.R': 'forearm.R',
  'forearm.R': 'hand.R',
  'thigh.L': 'shin.L',
  'shin.L': 'foot.L',
  'thigh.R': 'shin.R',
  'shin.R': 'foot.R',
};

/** Proxy radius in metres, by subsystem. Coarse on purpose; these only need to catch the cursor. */
const PROXY_RADIUS: Record<SubsystemId, number> = { head: 0.12, torso: 0.15, arms: 0.055, legs: 0.08 };
const TERMINAL_RADIUS: Partial<Record<JointId, number>> = { head: 0.13, 'hand.L': 0.065, 'hand.R': 0.065, 'foot.L': 0.08, 'foot.R': 0.08 };

const MARKER_RADIUS = 0.013;
const RING_RADIUS = 0.034;

interface Marker {
  id: JointId;
  bone: THREE.Bone;
  dot: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  status: Status;
}

export interface MarkerPalette {
  idle: string;
  hover: string;
  accent: string;
  warn: string;
  fault: string;
}

const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();

export class JointMarkers {
  private readonly markers = new Map<JointId, Marker>();
  readonly proxies: THREE.Mesh[] = [];
  private readonly dotGeo = new THREE.SphereGeometry(1, 16, 10);
  private readonly proxyGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  private readonly proxySphereGeo = new THREE.SphereGeometry(1, 10, 8);
  private readonly proxyMat = new THREE.MeshBasicMaterial({ visible: true, colorWrite: false, depthWrite: false });
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private selected: JointId | null = null;
  private hovered: JointId | null = null;
  private subsystemFocus: SubsystemId | null = null;
  private visible = true;

  constructor(map: SkeletonMap, private palette: MarkerPalette) {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 40),
      new THREE.MeshBasicMaterial({ color: palette.accent, depthTest: false, transparent: true, side: THREE.DoubleSide }),
    );
    this.ring.renderOrder = 1001;
    this.ring.visible = false;
    this.ring.layers.set(0);

    for (const id of JOINT_IDS) {
      const entry = map.get(id);
      if (!entry) continue;
      const bone = entry.bone;
      bone.updateWorldMatrix(true, false);
      bone.getWorldScale(_ws);
      const inv = 1 / (_ws.x || 1);

      const dot = new THREE.Mesh(
        this.dotGeo,
        new THREE.MeshBasicMaterial({ color: palette.idle, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      dot.scale.setScalar(MARKER_RADIUS * inv);
      dot.renderOrder = 1000;
      dot.layers.enable(PICK_LAYER);
      dot.userData.pick = { joint: id, subsystem: JOINTS[id].subsystem } satisfies PickHit;
      dot.name = `marker:${id}`;
      bone.add(dot);
      this.markers.set(id, { id, bone, dot, status: 'nominal' });

      this.addProxy(map, id, bone, inv);
    }
  }

  private addProxy(map: SkeletonMap, id: JointId, bone: THREE.Bone, inv: number): void {
    const sub = JOINTS[id].subsystem;
    const childId = CHAIN[id];
    const child = childId ? map.get(childId)?.bone : undefined;
    let proxy: THREE.Mesh;
    if (child) {
      // Child position is already in this bone's local frame.
      const d = child.position.clone();
      const len = d.length();
      if (len < 1e-6) return;
      proxy = new THREE.Mesh(this.proxyGeo, this.proxyMat);
      proxy.position.copy(d).multiplyScalar(0.5);
      proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      const r = PROXY_RADIUS[sub] * inv;
      proxy.scale.set(r, len, r);
    } else {
      proxy = new THREE.Mesh(this.proxySphereGeo, this.proxyMat);
      const r = (TERMINAL_RADIUS[id] ?? 0.06) * inv;
      proxy.scale.setScalar(r);
      // Bones point along their local +Y in glTF exports from Blender.
      proxy.position.set(0, r * 0.6, 0);
    }
    proxy.layers.set(PICK_LAYER);
    proxy.userData.pick = { joint: id, subsystem: sub } satisfies PickHit;
    proxy.name = `pick:${id}`;
    bone.add(proxy);
    this.proxies.push(proxy);
  }

  get pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [...this.proxies];
    if (this.visible) this.markers.forEach((m) => out.push(m.dot));
    return out;
  }

  setPalette(p: MarkerPalette): void {
    this.palette = p;
    this.ring.material.color.set(p.accent);
    this.refresh();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.refresh();
  }

  setSelected(id: JointId | null): void {
    this.selected = id;
    if (this.ring.parent) this.ring.parent.remove(this.ring);
    if (id) {
      const m = this.markers.get(id);
      if (m) {
        m.bone.add(this.ring);
        m.bone.getWorldScale(_ws);
        this.ring.scale.setScalar(RING_RADIUS / (_ws.x || 1));
      }
    }
    this.refresh();
  }

  setHovered(id: JointId | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.refresh();
  }

  /** When a subsystem is selected its markers light up, which is how left and right read apart. */
  setSubsystemFocus(id: SubsystemId | null): void {
    this.subsystemFocus = id;
    this.refresh();
  }

  setStatus(id: JointId, s: Status): void {
    const m = this.markers.get(id);
    if (!m || m.status === s) return;
    m.status = s;
    this.refresh();
  }

  private refresh(): void {
    const p = this.palette;
    this.markers.forEach((m) => {
      const isSel = m.id === this.selected;
      const isHover = m.id === this.hovered;
      const inFocus = this.subsystemFocus !== null && JOINTS[m.id].subsystem === this.subsystemFocus;
      const color = isSel ? p.accent : m.status === 'fault' ? p.fault : m.status === 'warning' ? p.warn : isHover || inFocus ? p.hover : p.idle;
      m.dot.material.color.set(color);
      // Status markers stay visible even with markers hidden: an alert must not disappear.
      m.dot.visible = this.visible || isSel || m.status !== 'nominal';
      const base = m.dot.userData.baseScale ?? (m.dot.userData.baseScale = m.dot.scale.x);
      m.dot.scale.setScalar(base * (isSel || isHover ? 1.35 : inFocus ? 1.15 : 1));
    });
    this.ring.visible = this.selected !== null;
  }

  /** Keep the selection ring facing the camera. */
  update(camera: THREE.Camera): void {
    if (!this.ring.visible || !this.ring.parent) return;
    this.ring.parent.getWorldQuaternion(_wq);
    this.ring.quaternion.copy(_wq.invert()).multiply(camera.quaternion);
  }

  dispose(): void {
    this.markers.forEach((m) => {
      m.dot.material.dispose();
      m.bone.remove(m.dot);
    });
    for (const p of this.proxies) p.parent?.remove(p);
    this.ring.parent?.remove(this.ring);
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.dotGeo.dispose();
    this.proxyGeo.dispose();
    this.proxySphereGeo.dispose();
    this.proxyMat.dispose();
  }
}
