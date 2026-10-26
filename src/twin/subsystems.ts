import * as THREE from 'three';
import { SUBSYSTEMS, type SubsystemId } from '../config';

interface ShadingUniforms {
  uTint: { value: THREE.Vector4 };
  uRim: { value: THREE.Vector4 };
}

interface Channel {
  color: THREE.Color;
  current: number;
  target: number;
}

interface Group {
  meshes: THREE.Mesh[];
  uniforms: ShadingUniforms;
  tint: Channel;
  rim: Channel;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const _srgb = new THREE.Color();

/**
 * Arms and legs share meshes across both sides, so subsystem is the finest grain we
 * can shade by mesh. Each subsystem gets its own material clones so a tint on the
 * legs never leaks onto a torso part that happens to share a material in the export.
 */
export class SubsystemShading {
  readonly groups = new Map<SubsystemId, Group>();
  readonly unassigned: string[] = [];
  private readonly clones: THREE.Material[] = [];

  constructor(root: THREE.Object3D) {
    for (const s of SUBSYSTEMS) {
      this.groups.set(s.id, {
        meshes: [],
        uniforms: { uTint: { value: new THREE.Vector4() }, uRim: { value: new THREE.Vector4() } },
        tint: { color: new THREE.Color(), current: 0, target: 0 },
        rim: { color: new THREE.Color(), current: 0, target: 0 },
      });
    }

    const cache = new Map<string, THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const id = subsystemOf(mesh);
      if (!id) {
        this.unassigned.push(mesh.name);
        return;
      }
      const group = this.groups.get(id)!;
      group.meshes.push(mesh);
      const swap = (m: THREE.Material) => {
        const key = `${id}:${m.uuid}`;
        let clone = cache.get(key);
        if (!clone) {
          clone = m.clone();
          installShading(clone, group.uniforms);
          cache.set(key, clone);
          this.clones.push(clone);
        }
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      mesh.userData.subsystem = id;
    });

    // The original materials are now unreferenced and were never uploaded, so there is
    // nothing to free. Textures are shared with the clones and disposed with them.

    if (this.unassigned.length) {
      console.warn(`[subsystems] ${this.unassigned.length} meshes do not start with Head_, Torso_, Arm_ or Leg_ and cannot be tinted:`, this.unassigned);
    }
    const counts = SUBSYSTEMS.map((s) => `${s.label} ${this.groups.get(s.id)!.meshes.length}`).join(', ');
    console.info(`[subsystems] meshes per subsystem: ${counts}`);
  }

  meshCount(id: SubsystemId): number {
    return this.groups.get(id)?.meshes.length ?? 0;
  }

  setTint(id: SubsystemId, color: string | null, strength = 0.42): void {
    const g = this.groups.get(id);
    if (!g) return;
    if (color) g.tint.color.set(color);
    g.tint.target = color ? strength : 0;
  }

  setRim(id: SubsystemId, color: string | null, strength = 1): void {
    const g = this.groups.get(id);
    if (!g) return;
    if (color) g.rim.color.set(color);
    g.rim.target = color ? strength : 0;
  }

  update(dt: number): void {
    const instant = reducedMotion();
    const a = instant ? 1 : 1 - Math.exp(-dt / 0.06);
    this.groups.forEach((g) => {
      for (const [ch, u] of [
        [g.tint, g.uniforms.uTint],
        [g.rim, g.uniforms.uRim],
      ] as const) {
        ch.current += (ch.target - ch.current) * a;
        if (Math.abs(ch.target - ch.current) < 1e-3) ch.current = ch.target;
        // The injection runs after colour-space conversion, so uniforms are sRGB values.
        ch.color.getRGB(_srgb, THREE.SRGBColorSpace);
        u.value.set(_srgb.r, _srgb.g, _srgb.b, ch.current);
      }
    });
  }

  dispose(): void {
    for (const m of this.clones) m.dispose();
    this.clones.length = 0;
  }
}

function subsystemOf(obj: THREE.Object3D): SubsystemId | null {
  // Multi-primitive meshes arrive as children of a group that carries the real name.
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    for (const s of SUBSYSTEMS) if (o.name.startsWith(s.meshPrefix)) return s.id;
  }
  return null;
}

function installShading(material: THREE.Material, uniforms: ShadingUniforms): void {
  const lit = (material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = uniforms.uTint;
    shader.uniforms.uRim = uniforms.uRim;
    const rim = lit
      ? 'float twinRim = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.4);'
      : 'float twinRim = 0.3;';
    shader.fragmentShader =
      'uniform vec4 uTint;\nuniform vec4 uRim;\n' +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `{
          float twinLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 twinTinted = uTint.rgb * (0.35 + 1.1 * twinLum);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, twinTinted, uTint.a);
          ${rim}
          gl_FragColor.rgb += uRim.rgb * twinRim * uRim.a * 0.85;
        }
        #include <dithering_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `twin-shading-${lit ? 'lit' : 'unlit'}`;
  material.needsUpdate = true;
}
