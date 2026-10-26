#!/usr/bin/env node
// Shrinks the Blender export for the web: textures resized and re-encoded as WebP,
// geometry welded, quantized and meshopt-compressed, animation keys resampled.
//
//   npm run optimize                       2048 px textures
//   npm run optimize -- --size 1024        1024 px textures (npm run optimize:1k)
//   npm run optimize -- --simplify 0.6     also decimate to ~60% of triangles
//   npm run optimize -- --in a.glb --out b.glb
//
// Without --in, the untouched export is kept as models-src/worker_bot.original.glb and
// every run starts from that copy, so running twice never re-compresses output.
// Node names are preserved: the app relies on bone names and on the Head_/Torso_/Arm_/Leg_
// mesh prefixes, so join/flatten/palette steps are deliberately not used.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const size = Number(arg('size', '2048'));
const ratio = Number(arg('simplify', '1'));
if (![512, 1024, 2048, 4096].includes(size)) {
  console.error('--size must be 512, 1024, 2048 or 4096');
  process.exit(1);
}
if (!(ratio > 0 && ratio <= 1)) {
  console.error('--simplify must be in (0, 1]');
  process.exit(1);
}

const published = resolve('public/models/worker_bot.glb');
const archived = resolve('models-src/worker_bot.original.glb');
let input = arg('in', '');
const output = resolve(arg('out', published));

if (!input) {
  if (!existsSync(archived)) {
    if (!existsSync(published)) {
      console.error(`Nothing to optimize: ${published} does not exist.`);
      process.exit(1);
    }
    mkdirSync(resolve('models-src'), { recursive: true });
    copyFileSync(published, archived);
    console.log(`kept original as ${archived}`);
  }
  input = archived;
}
input = resolve(input);

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);

if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === EXTMeshoptCompression.EXTENSION_NAME)) {
  console.warn('input is already meshopt-compressed; results may be poor. Optimize from the original export.');
}

const before = summarize(doc);
const t0 = Date.now();

const steps = [
  dedup(),
  prune({ keepAttributes: false, keepLeaves: true }),
  resample({ tolerance: 1e-4 }),
  weld(),
];
if (ratio < 1) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.0015, lockBorder: true }));
steps.push(
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 86 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);

await doc.transform(...steps);
mkdirSync(resolve(output, '..'), { recursive: true });
await io.write(output, doc);

const after = summarize(doc);
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`
input   ${input}  ${mb(input)} MB
output  ${output}  ${mb(output)} MB  (${((Date.now() - t0) / 1000).toFixed(1)} s)
meshes      ${before.meshes} -> ${after.meshes}
triangles   ${before.tris.toLocaleString()} -> ${after.tris.toLocaleString()}
textures    ${before.textures} -> ${after.textures}, max ${before.maxTex}px -> ${after.maxTex}px
animations  ${after.animations}`);

function summarize(d) {
  const root = d.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
    }
  }
  let maxTex = 0;
  for (const t of root.listTextures()) {
    const s = t.getSize();
    if (s) maxTex = Math.max(maxTex, s[0], s[1]);
  }
  return {
    meshes: root.listMeshes().length,
    tris: Math.round(tris),
    textures: root.listTextures().length,
    maxTex,
    animations: root.listAnimations().length,
  };
}
