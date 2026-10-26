import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

export const SHADOW_LAYER = 1;

/**
 * Orthographic depth render from below the floor, blurred twice and laid back on the
 * floor as a texture. Cheaper than a shadow-mapped light and it reads as contact,
 * not as a cast shadow from a particular lamp. Only objects on SHADOW_LAYER contribute.
 */
export class ContactShadow {
  readonly group = new THREE.Group();
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly rtBlur: THREE.WebGLRenderTarget;
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly blurPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly camera: THREE.OrthographicCamera;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
  private readonly hBlur: THREE.ShaderMaterial;
  private readonly vBlur: THREE.ShaderMaterial;
  private readonly clear = new THREE.Color();

  constructor(size = 2.6, height = 0.9, resolution = 512, private blur = 2.4, opacity = 0.62) {
    this.rt = new THREE.WebGLRenderTarget(resolution, resolution);
    this.rt.texture.generateMipmaps = false;
    this.rtBlur = new THREE.WebGLRenderTarget(resolution, resolution);
    this.rtBlur.texture.generateMipmaps = false;

    const geo = new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2);
    this.plane = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ map: this.rt.texture, opacity, transparent: true, depthWrite: false }),
    );
    this.plane.renderOrder = 1;
    // The shadow camera looks up, so its image is mirrored relative to the floor.
    this.plane.scale.y = -1;
    this.group.add(this.plane);

    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.hBlur.depthTest = false;
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.vBlur.depthTest = false;
    this.blurPlane = new THREE.Mesh(geo, this.hBlur);
    this.blurPlane.visible = false;
    this.group.add(this.blurPlane);

    this.camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
    this.camera.rotation.x = Math.PI / 2;
    this.camera.layers.set(SHADOW_LAYER);
    this.group.add(this.camera);

    this.depthMaterial = new THREE.MeshDepthMaterial();
    const darkness = { value: 1.4 };
    this.depthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = darkness;
      shader.fragmentShader =
        'uniform float darkness;\n' +
        shader.fragmentShader.replace(
          'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
        );
    };
    this.depthMaterial.depthTest = false;
    this.depthMaterial.depthWrite = false;
    this.group.position.y = 0.0015;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const bg = scene.background;
    scene.background = null;
    this.plane.visible = false;
    renderer.getClearColor(this.clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);

    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = null;

    this.blurPass(renderer, this.blur);
    this.blurPass(renderer, this.blur * 0.4);

    renderer.setRenderTarget(null);
    renderer.setClearColor(this.clear, alpha);
    this.plane.visible = true;
    scene.background = bg;
  }

  private blurPass(renderer: THREE.WebGLRenderer, amount: number): void {
    const res = this.rt.width;
    this.blurPlane.visible = true;
    // The blur plane lives on layer 0; the robot is on SHADOW_LAYER.
    this.camera.layers.set(0);

    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse!.value = this.rt.texture;
    this.hBlur.uniforms.h!.value = amount / res;
    renderer.setRenderTarget(this.rtBlur);
    renderer.render(this.blurPlane, this.camera);

    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse!.value = this.rtBlur.texture;
    this.vBlur.uniforms.v!.value = amount / res;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.blurPlane, this.camera);

    this.camera.layers.set(SHADOW_LAYER);
    this.blurPlane.visible = false;
  }

  dispose(): void {
    this.rt.dispose();
    this.rtBlur.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
    this.depthMaterial.dispose();
  }
}
