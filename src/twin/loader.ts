import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { TARGET_HEIGHT } from '../config';

export type LoadPhase = 'download' | 'parse' | 'upload';

export interface LoadProgress {
  phase: LoadPhase;
  loaded: number;
  /** 0 when the server sent no Content-Length. */
  total: number;
}

export interface LoadedModel {
  gltf: GLTF;
  root: THREE.Object3D;
  skinnedMeshes: THREE.SkinnedMesh[];
  stats: { meshes: number; triangles: number; textures: number; maxTextureSize: number; bytes: number };
  scale: number;
}

export class ModelMissingError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`No model at ${url} (${reason})`);
  }
}

/**
 * The dev server answers unknown paths with index.html and a 200, so "exists"
 * means: OK status and not HTML. The real check is the glTF magic in load().
 */
export async function probeModel(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    return !type.includes('text/html');
  } catch {
    return false;
  }
}

async function fetchWithProgress(url: string, onProgress: (p: LoadProgress) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) throw new ModelMissingError(url, `HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress({ phase: 'download', loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 50) {
      lastReport = now;
      onProgress({ phase: 'download', loaded, total });
    }
  }
  onProgress({ phase: 'download', loaded, total: total || loaded });
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

function isGlb(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const magic = new Uint8Array(buf, 0, 4);
  return magic[0] === 0x67 && magic[1] === 0x6c && magic[2] === 0x54 && magic[3] === 0x46; // "glTF"
}

export async function loadModel(url: string, onProgress: (p: LoadProgress) => void, signal?: AbortSignal): Promise<LoadedModel> {
  const buf = await fetchWithProgress(url, onProgress, signal);
  if (!isGlb(buf)) throw new ModelMissingError(url, 'response is not a binary glTF');

  onProgress({ phase: 'parse', loaded: 0, total: 0 });
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const gltf = await loader.parseAsync(buf, base);

  const root = gltf.scene;
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  const textures = new Set<THREE.Texture>();
  let triangles = 0;
  let meshes = 0;

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position!.count) / 3;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      skinnedMeshes.push(mesh as THREE.SkinnedMesh);
      // Bind-pose bounds are wrong as soon as the arms move; one character is always in frame anyway.
      mesh.frustumCulled = false;
    }
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
    }
  });

  let maxTextureSize = 0;
  textures.forEach((t) => {
    const img = t.image as { width?: number } | undefined;
    if (img?.width) maxTextureSize = Math.max(maxTextureSize, img.width);
  });

  const scale = normalize(root);

  return {
    gltf,
    root,
    skinnedMeshes,
    stats: { meshes, triangles: Math.round(triangles), textures: textures.size, maxTextureSize, bytes: buf.byteLength },
    scale,
  };
}

/** Scale to TARGET_HEIGHT from the rest-pose bounds, feet on y=0, centred on x/z. */
function normalize(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = size.y > 1e-6 ? TARGET_HEIGHT / size.y : 1;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  box.setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  return scale;
}

export function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) materials.add(m);
    }
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton.dispose();
  });
  materials.forEach((m) => {
    for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
    m.dispose();
  });
  textures.forEach((t) => t.dispose());
}

/**
 * Find the robot's red in its own materials. Base colour factors first; if the red
 * lives in a texture, sample a downscaled copy of it.
 */
export function sampleAccent(root: THREE.Object3D): THREE.Color | null {
  const candidates: { color: THREE.Color; weight: number; l: number }[] = [];
  const hsl = { h: 0, s: 0, l: 0 };
  const seen = new Set<THREE.Material>();

  const consider = (c: THREE.Color, weight: number) => {
    c.getHSL(hsl);
    const redHue = hsl.h < 0.045 || hsl.h > 0.96;
    if (redHue && hsl.s > 0.45 && hsl.l > 0.18 && hsl.l < 0.65) candidates.push({ color: c.clone(), weight: weight * hsl.s, l: hsl.l });
  };

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      const std = m as THREE.MeshStandardMaterial;
      if (!std.color) continue;
      if (!std.map) {
        consider(std.color.clone(), 4);
      } else {
        const texRed = sampleTextureRed(std.map);
        if (texRed) consider(texRed.multiply(std.color), 1);
      }
    }
  });

  if (!candidates.length) return null;
  // Weighted median by lightness keeps one odd decal from dragging the result.
  candidates.sort((a, b) => a.l - b.l);
  const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
  let acc = 0;
  for (const c of candidates) {
    acc += c.weight;
    if (acc >= totalWeight / 2) return c.color;
  }
  return candidates[candidates.length - 1]!.color;
}

function sampleTextureRed(tex: THREE.Texture): THREE.Color | null {
  const img = tex.image as CanvasImageSource & { width?: number; height?: number };
  if (!img || !img.width) return null;
  const N = 48;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, N, N);
  } catch {
    return null;
  }
  const data = ctx.getImageData(0, 0, N, N).data;
  const c = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    c.setRGB(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255, THREE.SRGBColorSpace);
    c.getHSL(hsl);
    if ((hsl.h < 0.045 || hsl.h > 0.96) && hsl.s > 0.45 && hsl.l > 0.18 && hsl.l < 0.65) {
      r += c.r; g += c.g; b += c.b; n++;
    }
  }
  // Ignore textures where red is a speck rather than a surface.
  if (n < N * N * 0.04) return null;
  return new THREE.Color(r / n, g / n, b / n);
}
