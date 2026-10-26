#!/usr/bin/env node
// Writes a crude stand-in for worker_bot.glb with the same bone names, mesh prefixes,
// clip names and pose conventions, so the app can be exercised before the real export
// exists. Boxes only, no textures. Bone frames follow the rig spec: +X raises the left
// upper arm, +X on the shin bends the knee backward, and so on.
//
//   npm run make-test-rig                 writes public/models/worker_bot.glb if absent
//   npm run make-test-rig -- --force      overwrites
//   npm run make-test-rig -- --out x.glb  writes elsewhere

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';

const args = process.argv.slice(2);
const force = args.includes('--force');
const outIdx = args.indexOf('--out');
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : 'public/models/worker_bot.glb');

if (existsSync(out) && !force) {
  console.error(`${out} exists. Pass --force to overwrite it.`);
  process.exit(1);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// World-space rest frames: [x axis, y axis (along the bone)], z = x cross y.
const UP = [V(0, 0, -1), V(0, 1, 0)];
const DOWN = [V(0, 0, -1), V(0, -1, 0)];
const FWD = [V(0, 0, -1), V(1, 0, 0)];
const LEFT = [V(1, 0, 0), V(0, 0, -1)];
const RIGHT = [V(1, 0, 0), V(0, 0, 1)];

const BONES = [
  ['root', null, V(0, 0, 0), UP],
  ['pelvis', 'root', V(0, 0.95, 0), UP],
  ['spine', 'pelvis', V(0, 1.08, 0), UP],
  ['chest', 'spine', V(0, 1.25, 0), UP],
  ['neck', 'chest', V(0, 1.48, 0), UP],
  ['head', 'neck', V(0, 1.57, 0), UP],
  ['upper_arm.L', 'chest', V(0, 1.42, -0.21), LEFT],
  ['forearm.L', 'upper_arm.L', V(0, 1.42, -0.5), LEFT],
  ['hand.L', 'forearm.L', V(0, 1.42, -0.78), LEFT],
  ['upper_arm.R', 'chest', V(0, 1.42, 0.21), RIGHT],
  ['forearm.R', 'upper_arm.R', V(0, 1.42, 0.5), RIGHT],
  ['hand.R', 'forearm.R', V(0, 1.42, 0.78), RIGHT],
  ['thigh.L', 'pelvis', V(0, 0.92, -0.1), DOWN],
  ['shin.L', 'thigh.L', V(0, 0.5, -0.1), DOWN],
  ['foot.L', 'shin.L', V(0, 0.08, -0.1), FWD],
  ['thigh.R', 'pelvis', V(0, 0.92, 0.1), DOWN],
  ['shin.R', 'thigh.R', V(0, 0.5, 0.1), DOWN],
  ['foot.R', 'shin.R', V(0, 0.08, 0.1), FWD],
];

const world = new Map();
for (const [name, , pos, [x, y]] of BONES) {
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  world.set(name, { pos, q, mat: new THREE.Matrix4().compose(pos, q, V(1, 1, 1)) });
}

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('Scene');
const armature = doc.createNode('Armature');
scene.addChild(armature);

const nodes = new Map();
const rest = new Map();
for (const [name, parent, pos] of BONES) {
  const w = world.get(name);
  let lp = pos.clone();
  let lq = w.q.clone();
  if (parent) {
    const pw = world.get(parent);
    const inv = pw.q.clone().invert();
    lp = pos.clone().sub(pw.pos).applyQuaternion(inv);
    lq = inv.multiply(w.q);
  }
  rest.set(name, { t: lp, q: lq });
  const node = doc.createNode(name).setTranslation(lp.toArray()).setRotation(lq.toArray());
  nodes.set(name, node);
  if (parent) nodes.get(parent).addChild(node);
  else armature.addChild(node);
}

const skin = doc.createSkin('Armature').setSkeleton(nodes.get('root'));
const jointIndex = new Map();
const ibm = new Float32Array(BONES.length * 16);
BONES.forEach(([name], i) => {
  skin.addJoint(nodes.get(name));
  jointIndex.set(name, i);
  new THREE.Matrix4().copy(world.get(name).mat).invert().toArray(ibm, i * 16);
});
skin.setInverseBindMatrices(doc.createAccessor('ibm').setType('MAT4').setArray(ibm).setBuffer(buffer));

// THREE.Color converts the sRGB hex into linear, which is what glTF base colour factors are.
const mat = (name, hex, rough, metal) => {
  const c = new THREE.Color(hex);
  return doc.createMaterial(name).setBaseColorFactor([c.r, c.g, c.b, 1]).setRoughnessFactor(rough).setMetallicFactor(metal);
};
const graphite = mat('graphite', 0x3a3c40, 0.55, 0.35);
const dark = mat('visor', 0x101113, 0.25, 0.1);
const red = mat('robot_red', 0xb2342a, 0.42, 0.15);
const joint = mat('joint', 0x5d6064, 0.5, 0.6);

// [mesh name, material, parts: [bone, centre, size]]
const L = -1;
const R = 1;
const pair = (fn) => [fn(L, 'L'), fn(R, 'R')];
const MESHES = [
  ['Head_Shell', graphite, [['head', V(0, 1.68, 0), V(0.22, 0.23, 0.2)], ['neck', V(0, 1.52, 0), V(0.08, 0.08, 0.08)]]],
  ['Head_Visor', dark, [['head', V(0.105, 1.69, 0), V(0.025, 0.06, 0.16)]]],
  ['Torso_Core', graphite, [['pelvis', V(0, 0.99, 0), V(0.2, 0.16, 0.32)], ['spine', V(0, 1.15, 0), V(0.18, 0.16, 0.28)]]],
  ['Torso_Shell', red, [['chest', V(0, 1.34, 0), V(0.27, 0.27, 0.4)]]],
  ['Arm_Shoulder', red, pair((s, k) => [`upper_arm.${k}`, V(0, 1.42, s * 0.25), V(0.14, 0.14, 0.09)])],
  ['Arm_Upper', graphite, pair((s, k) => [`upper_arm.${k}`, V(0, 1.42, s * 0.37), V(0.1, 0.1, 0.24)])],
  ['Arm_Fore', graphite, pair((s, k) => [`forearm.${k}`, V(0, 1.42, s * 0.64), V(0.09, 0.09, 0.26)])],
  ['Arm_Hand', joint, pair((s, k) => [`hand.${k}`, V(0, 1.42, s * 0.91), V(0.05, 0.09, 0.27)])],
  ['Leg_Thigh', graphite, pair((s, k) => [`thigh.${k}`, V(0, 0.71, s * 0.1), V(0.13, 0.4, 0.13)])],
  ['Leg_Knee', red, pair((s, k) => [`shin.${k}`, V(0.055, 0.5, s * 0.1), V(0.05, 0.09, 0.09)])],
  ['Leg_Shin', graphite, pair((s, k) => [`shin.${k}`, V(0, 0.29, s * 0.1), V(0.11, 0.4, 0.11)])],
  ['Leg_Foot', joint, pair((s, k) => [`foot.${k}`, V(0.05, 0.04, s * 0.1), V(0.25, 0.08, 0.11)])],
];

const FACES = [
  [V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)],
  [V(-1, 0, 0), V(0, 1, 0), V(0, 0, -1)],
  [V(0, 1, 0), V(0, 0, 1), V(1, 0, 0)],
  [V(0, -1, 0), V(0, 0, -1), V(1, 0, 0)],
  [V(0, 0, 1), V(1, 0, 0), V(0, 1, 0)],
  [V(0, 0, -1), V(-1, 0, 0), V(0, 1, 0)],
];

for (const [meshName, material, parts] of MESHES) {
  const pos = [];
  const nrm = [];
  const jnt = [];
  const wgt = [];
  const idx = [];
  for (const [bone, c, size] of parts) {
    const hsz = size.clone().multiplyScalar(0.5);
    for (const [n, u, v] of FACES) {
      const base = pos.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = c.clone()
          .addScaledVector(n, hsz.dot(V(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z))))
          .addScaledVector(u, a * hsz.dot(V(Math.abs(u.x), Math.abs(u.y), Math.abs(u.z))))
          .addScaledVector(v, b * hsz.dot(V(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z))));
        pos.push(p.x, p.y, p.z);
        nrm.push(n.x, n.y, n.z);
        jnt.push(jointIndex.get(bone), 0, 0, 0);
        wgt.push(1, 0, 0, 0);
      }
      // Wind counter-clockwise when seen from outside.
      const flip = new THREE.Vector3().crossVectors(u, v).dot(n) < 0;
      if (flip) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(pos)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(nrm)))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array(jnt)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array(wgt)))
    .setIndices(acc('SCALAR', new Uint16Array(idx)))
    .setMaterial(material);
  const mesh = doc.createMesh(meshName).addPrimitive(prim);
  armature.addChild(doc.createNode(meshName).setMesh(mesh).setSkin(skin));
}

// ---- clips, authored as delta Euler degrees in the rig's convention ----
const FPS = 24;
const D2R = Math.PI / 180;
const NEUTRAL = { 'upper_arm.L': [-40, 0, 0], 'upper_arm.R': [40, 0, 0], 'forearm.L': [0, 0, -12], 'forearm.R': [0, 0, -12] };

function deltaQuat(name, d) {
  const e = new THREE.Euler(d[0] * D2R, d[1] * D2R, d[2] * D2R, 'ZYX');
  return rest.get(name).q.clone().multiply(new THREE.Quaternion().setFromEuler(e));
}

function addClip(clipName, frames, poseAt, bob) {
  const anim = doc.createAnimation(clipName);
  const n = frames;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i / FPS;
  const input = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  for (const [name] of BONES) {
    if (name === 'root') continue;
    const values = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const phase = n > 1 ? i / (n - 1) : 0;
      const p = poseAt(phase)[name] ?? NEUTRAL[name] ?? [0, 0, 0];
      deltaQuat(name, p).toArray(values, i * 4);
    }
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(doc.createAccessor().setType('VEC4').setArray(values).setBuffer(buffer)).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes.get(name)).setTargetPath('rotation').setSampler(sampler));
  }
  const tv = new Float32Array(n * 3);
  const rt = rest.get('root').t;
  for (let i = 0; i < n; i++) {
    const phase = n > 1 ? i / (n - 1) : 0;
    tv.set([rt.x, rt.y + (bob ? bob(phase) : 0), rt.z], i * 3);
  }
  const ts = doc.createAnimationSampler().setInput(input).setOutput(doc.createAccessor().setType('VEC3').setArray(tv).setBuffer(buffer)).setInterpolation('LINEAR');
  anim.addSampler(ts).addChannel(doc.createAnimationChannel().setTargetNode(nodes.get('root')).setTargetPath('translation').setSampler(ts));
}

const TAU = Math.PI * 2;
const sin = (p, k = 1, o = 0) => Math.sin(TAU * k * p + o);

addClip('Idle', 97, (p) => ({
  chest: [1.5 * sin(p), 0, 0],
  head: [2 * sin(p, 1, 1), 3 * sin(p), 0],
  'upper_arm.L': [-40 + 2 * sin(p), 0, 1.5 * sin(p)],
  'upper_arm.R': [40 - 2 * sin(p), 0, 1.5 * sin(p)],
}), (p) => -0.004 * (0.5 - 0.5 * Math.cos(TAU * p)));

addClip('Wave', 73, (p) => {
  const up = Math.min(1, Math.sin(Math.PI * p) * 1.6);
  return {
    'upper_arm.R': [40 - 125 * up, 0, -10 * up],
    'forearm.R': [0, 0, -12 - 70 * up + 25 * up * sin(p, 3)],
    'hand.R': [0, 0, 20 * up * sin(p, 3, 0.5)],
    head: [0, -12 * up, 4 * up],
  };
});

addClip('Walk', 25, (p) => {
  const s = sin(p);
  return {
    'thigh.L': [-28 * s, 0, 0],
    'thigh.R': [28 * s, 0, 0],
    'shin.L': [12 + 30 * Math.max(0, sin(p, 1, Math.PI * 0.6)), 0, 0],
    'shin.R': [12 + 30 * Math.max(0, sin(p, 1, Math.PI * 1.6)), 0, 0],
    'foot.L': [-6 * s, 0, 0],
    'foot.R': [6 * s, 0, 0],
    'upper_arm.L': [-55, 0, 22 * s],
    'upper_arm.R': [55, 0, -22 * s],
    pelvis: [0, 6 * s, 0],
    chest: [3, -8 * s, 0],
  };
}, (p) => -0.02 * Math.abs(Math.cos(TAU * p)));

addClip('Look_Around', 97, (p) => ({
  neck: [0, 30 * sin(p), 0],
  head: [6 * sin(p, 2), 45 * sin(p), 0],
  chest: [0, 10 * sin(p), 0],
}));

addClip('Arms_Raise', 73, (p) => {
  const u = Math.sin(Math.PI * p);
  return {
    'upper_arm.L': [-40 + 130 * u, 0, 0],
    'upper_arm.R': [40 - 130 * u, 0, 0],
    spine: [-4 * u, 0, 0],
    head: [-15 * u, 0, 0],
  };
});

addClip('TPose', 1, () => ({ 'upper_arm.L': [0, 0, 0], 'upper_arm.R': [0, 0, 0], 'forearm.L': [0, 0, 0], 'forearm.R': [0, 0, 0] }));

mkdirSync(dirname(out), { recursive: true });
await new NodeIO().write(out, doc);
console.log(`wrote ${out}`);
