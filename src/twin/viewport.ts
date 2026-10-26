import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ContactShadow, SHADOW_LAYER } from './contact-shadow';
import { PICK_LAYER, type PickHit } from './markers';

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

const BG = 0x111214;
const HAIRLINE = 0x34373c;
const TARGET = new THREE.Vector3(0, 0.92, 0);

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly canvas: HTMLCanvasElement;
  readonly stats: FrameStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };

  private readonly shadow = new ContactShadow();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly floor: THREE.Group;
  private model: THREE.Object3D | null = null;
  private raf = 0;
  private frameHooks: ((dt: number) => void)[] = [];

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral keeps the robot's red honest; ACES shifts saturated reds toward orange.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Robot viewport');
    container.appendChild(this.canvas);

    this.scene.background = new THREE.Color(BG);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
    this.camera.position.set(3.6, 1.55, 2.6);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 1.1;
    this.controls.maxDistance = 9;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.5 - 0.02;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => {
      // Keep the pivot on the robot so panning cannot lose it.
      const t = this.controls.target;
      t.x = THREE.MathUtils.clamp(t.x, -1.2, 1.2);
      t.y = THREE.MathUtils.clamp(t.y, 0.15, 1.8);
      t.z = THREE.MathUtils.clamp(t.z, -1.2, 1.2);
    });
    this.controls.update();

    this.addLights();
    this.floor = this.buildFloor();
    this.scene.add(this.floor);
    this.scene.add(this.shadow.group);

    this.raycaster.layers.set(PICK_LAYER);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private addLights(): void {
    const key = new THREE.DirectionalLight(0xfff4e8, 2.1);
    key.position.set(2.5, 4.2, 2.0);
    const fill = new THREE.DirectionalLight(0xe8eef5, 0.55);
    fill.position.set(-3, 1.8, 1.5);
    const rim = new THREE.DirectionalLight(0xffffff, 1.3);
    rim.position.set(-2.2, 2.6, -3.2);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x1a1b1d, 0.25));
  }

  /** A footprint circle and a short forward tick on +X. Orientation, not decoration. */
  private buildFloor(): THREE.Group {
    const g = new THREE.Group();
    // Lines are UI, not lit surfaces: keep them out of tone mapping so the hex values hold.
    const mat = new THREE.LineBasicMaterial({ color: HAIRLINE, toneMapped: false });

    // A faint disc a step lighter than the background. On near-black the contact
    // shadow has nothing to darken without it.
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.075)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.035)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const discTex = new THREE.CanvasTexture(cv);
    discTex.colorSpace = THREE.SRGBColorSpace;
    const disc = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: discTex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    disc.position.y = -0.0005;
    disc.renderOrder = 0;
    g.add(disc);

    const pts: THREE.Vector3[] = [];
    const R = 0.75;
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    const tick = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(R, 0, 0), new THREE.Vector3(R + 0.12, 0, 0)]);
    g.add(new THREE.Line(tick, new THREE.LineBasicMaterial({ color: 0x5d6064, toneMapped: false })));
    const cross = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.05, 0, 0), new THREE.Vector3(0.05, 0, 0),
      new THREE.Vector3(0, 0, -0.05), new THREE.Vector3(0, 0, 0.05),
    ]);
    g.add(new THREE.LineSegments(cross, mat));
    g.position.y = 0.001;
    return g;
  }

  setModel(root: THREE.Object3D): void {
    this.clearModel();
    this.model = root;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.layers.enable(SHADOW_LAYER);
    });
    this.scene.add(root);
  }

  clearModel(): void {
    if (this.model) this.scene.remove(this.model);
    this.model = null;
  }

  get hasModel(): boolean {
    return this.model !== null;
  }

  onFrame(fn: (dt: number) => void): () => void {
    this.frameHooks.push(fn);
    return () => {
      this.frameHooks = this.frameHooks.filter((f) => f !== fn);
    };
  }

  pick(clientX: number, clientY: number, objects: THREE.Object3D[]): PickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(objects, false);
    if (!hits.length) return null;
    // A visible marker beats the proxy it sits inside.
    const marker = hits.find((h) => h.object.name.startsWith('marker:'));
    return ((marker ?? hits[0]!).object.userData.pick as PickHit) ?? null;
  }

  /** Upload textures and compile programs before the first visible frame to avoid a hitch. */
  async warmUp(): Promise<void> {
    if (!this.model) return;
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) this.renderer.initTexture(v as THREE.Texture);
    });
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  start(): void {
    if (this.raf) return;
    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const t0 = performance.now();
      for (const fn of this.frameHooks) fn(dt);
      this.controls.update();
      this.renderer.info.reset();
      if (this.model) this.shadow.render(this.renderer, this.scene);
      this.renderer.render(this.scene, this.camera);
      const ms = performance.now() - t0;
      const fps = dt > 0 ? 1 / dt : 0;
      this.stats.fps += (fps - this.stats.fps) * 0.08;
      this.stats.frameMs += (ms - this.stats.frameMs) * 0.08;
      this.stats.drawCalls = this.renderer.info.render.calls;
      this.stats.triangles = this.renderer.info.render.triangles;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  resetView(): void {
    this.camera.position.set(3.6, 1.55, 2.6);
    this.controls.target.copy(TARGET);
    this.controls.update();
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.shadow.dispose();
    this.envTarget.dispose();
    this.floor.traverse((o) => {
      const l = o as THREE.Mesh;
      if (l.geometry) l.geometry.dispose();
      const m = l.material as THREE.MeshBasicMaterial | undefined;
      if (m) {
        m.map?.dispose();
        m.dispose();
      }
    });
    this.renderer.dispose();
    this.canvas.remove();
  }
}
