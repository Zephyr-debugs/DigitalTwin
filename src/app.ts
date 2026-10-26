import * as THREE from 'three';
import {
  ALL_BONES,
  DEBUG,
  JOINT_IDS,
  JOINTS,
  MODEL_PROBE_INTERVAL_MS,
  MODEL_URL,
  ROOT_BOB_RANGE,
  SUBSYSTEMS,
  clamp,
  loadThresholds,
  type JointId,
  type SubsystemId,
} from './config';
import { Emitter } from './emitter';
import { AlertEngine, LEVEL_NAME, type Level } from './telemetry/alerts';
import { SimulatedSource } from './telemetry/simulated-source';
import { HISTORY_HZ, TelemetryStore } from './telemetry/store';
import type { LinkStatus, TelemetrySource } from './telemetry/types';
import { WebSocketSource } from './telemetry/websocket-source';
import { runAxisCheck, type AxisCheckResult } from './twin/axis-check';
import { ClipPlayer } from './twin/clip-player';
import { ModelMissingError, disposeObject, loadModel, probeModel, sampleAccent, type LoadProgress, type LoadedModel } from './twin/loader';
import { JointMarkers, type MarkerPalette, type PickHit } from './twin/markers';
import { copyPose, createPose, smoothPose, type Pose } from './twin/pose';
import { PoseDriver } from './twin/pose-driver';
import { SkeletonMap } from './twin/skeleton-map';
import { SubsystemShading } from './twin/subsystems';
import { Viewport } from './twin/viewport';

export type Mode = 'live' | 'manual' | 'playback';
export type Selection = { kind: 'joint'; id: JointId } | { kind: 'subsystem'; id: SubsystemId } | null;

export type ModelState =
  | { kind: 'probing' }
  | { kind: 'missing'; lastCheck: number }
  | { kind: 'loading'; progress: LoadProgress }
  | { kind: 'ready'; model: LoadedModel; skeleton: SkeletonMap; axis: AxisCheckResult[] }
  | { kind: 'error'; message: string; detail: string };

export interface LogEntry {
  time: Date;
  level: Level;
  source: string;
  message: string;
}

interface Events extends Record<string, unknown> {
  mode: Mode;
  selection: Selection;
  hover: PickHit | null;
  model: ModelState;
  link: LinkStatus;
  source: TelemetrySource;
  tick: void;
  frame: void;
  log: LogEntry;
  accent: string;
  options: void;
  clip: void;
}

const LIVE_SMOOTH_TAU = 0.07;
const FALLBACK_ACCENT = '#C2362B';

export class App {
  readonly bus = new Emitter<Events>();
  readonly store = new TelemetryStore();
  readonly alerts = new AlertEngine(loadThresholds());
  readonly viewport: Viewport;
  readonly logEntries: LogEntry[] = [];
  readonly startedAt = Date.now();

  mode: Mode = 'live';
  selection: Selection = null;
  hover: PickHit | null = null;
  modelState: ModelState = { kind: 'probing' };
  source: TelemetrySource;
  tintAlerts = true;
  showMarkers = true;
  accent = FALLBACK_ACCENT;

  /** Manual mode setpoints. */
  readonly manualPose: Pose = createPose();
  /** What the twin is showing right now, whatever drives it. Inspector reads this. */
  readonly displayPose: Pose = createPose();
  neutralPose: Pose = createPose();
  readonly tPose: Pose = createPose();

  clips: ClipPlayer | null = null;
  private driver: PoseDriver | null = null;
  private markers: JointMarkers | null = null;
  private shading: SubsystemShading | null = null;
  private model: LoadedModel | null = null;
  private manualDirty = true;
  private probeTimer: number | undefined;
  private tickTimer: number | undefined;
  private frameEmitAcc = 0;
  private unsubSource: (() => void)[] = [];
  private pointerDown: { x: number; y: number } | null = null;
  private loadAbort: AbortController | null = null;

  constructor(viewportHost: HTMLElement) {
    this.viewport = new Viewport(viewportHost);
    this.source = this.createSource(new URLSearchParams(location.search).has('ws') ? 'websocket' : 'simulated');
    this.bindPointer();
    this.viewport.onFrame((dt) => this.frame(dt));
  }

  start(): void {
    this.viewport.start();
    this.attachSource(this.source);
    this.source.connect();
    this.tickTimer = window.setInterval(() => this.tick(), 1000 / HISTORY_HZ);
    this.log(0, 'twin', `session started, telemetry ${this.source.label.toLowerCase()}`);
    void this.probeLoop();
  }

  // ---- telemetry source ----

  private createSource(kind: 'simulated' | 'websocket'): TelemetrySource {
    return kind === 'websocket' ? new WebSocketSource() : new SimulatedSource();
  }

  private attachSource(src: TelemetrySource): void {
    this.unsubSource.forEach((u) => u());
    this.unsubSource = [
      src.onFrame((f) => this.store.ingest(f)),
      src.onStatus((s) => {
        const level: Level = s.state === 'connected' ? 0 : s.state === 'error' || s.state === 'disconnected' ? 2 : 1;
        this.log(level, 'link', `${s.state}${s.detail ? `, ${s.detail}` : ''}`);
        this.bus.emit('link', s);
      }),
    ];
  }

  switchSource(kind: 'simulated' | 'websocket'): void {
    if (this.source.kind === kind) return;
    this.source.disconnect();
    this.store.reset();
    this.alerts.reset();
    this.source = this.createSource(kind);
    this.attachSource(this.source);
    this.bus.emit('source', this.source);
    this.source.connect();
  }

  // ---- model lifecycle ----

  private async probeLoop(): Promise<void> {
    window.clearTimeout(this.probeTimer);
    const present = await probeModel(MODEL_URL);
    if (present) {
      await this.load();
      return;
    }
    if (this.modelState.kind !== 'missing') this.log(1, 'model', `no file at ${MODEL_URL}, polling every ${MODEL_PROBE_INTERVAL_MS / 1000} s`);
    this.setModelState({ kind: 'missing', lastCheck: Date.now() });
    this.probeTimer = window.setTimeout(() => void this.probeLoop(), MODEL_PROBE_INTERVAL_MS);
  }

  retryLoad(): void {
    void this.probeLoop();
  }

  private setModelState(s: ModelState): void {
    this.modelState = s;
    this.bus.emit('model', s);
  }

  private async load(): Promise<void> {
    this.loadAbort?.abort();
    this.loadAbort = new AbortController();
    this.setModelState({ kind: 'loading', progress: { phase: 'download', loaded: 0, total: 0 } });
    const t0 = performance.now();
    let loaded: LoadedModel;
    try {
      loaded = await loadModel(MODEL_URL, (p) => this.setModelState({ kind: 'loading', progress: p }), this.loadAbort.signal);
    } catch (e) {
      if (e instanceof ModelMissingError) {
        this.setModelState({ kind: 'missing', lastCheck: Date.now() });
        this.probeTimer = window.setTimeout(() => void this.probeLoop(), MODEL_PROBE_INTERVAL_MS);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[model] load failed', e);
      this.log(2, 'model', `load failed: ${msg}`);
      this.setModelState({ kind: 'error', message: 'The model file could not be parsed.', detail: msg });
      return;
    }

    const skeleton = SkeletonMap.resolve(loaded.root);
    if (skeleton.foundCount === 0) {
      this.log(2, 'model', `no expected bones found among ${skeleton.unexpected.length} bones in file`);
      disposeObject(loaded.root);
      this.setModelState({
        kind: 'error',
        message: 'None of the 18 expected bones were found.',
        detail: `Expected Blender names such as ${ALL_BONES.slice(0, 4).join(', ')}. The file contains: ${skeleton.unexpected.slice(0, 12).join(', ') || 'no bones'}.`,
      });
      return;
    }

    this.setModelState({ kind: 'loading', progress: { phase: 'upload', loaded: 0, total: 0 } });
    this.model = loaded;
    this.viewport.setModel(loaded.root);
    const axis = runAxisCheck(skeleton, loaded.root);
    this.driver = new PoseDriver(skeleton);
    this.shading = new SubsystemShading(loaded.root);

    this.applyAccent(sampleAccent(loaded.root));
    this.markers = new JointMarkers(skeleton, this.markerPalette());
    this.markers.setVisible(this.showMarkers);

    this.clips = new ClipPlayer(loaded.root, loaded.gltf.animations);
    this.clips.onFinished((name) => this.log(0, 'playback', `${name} finished`));
    const idle = this.clips.find('Idle');
    this.neutralPose = idle ? this.driver.poseFromFirstFrame(idle.clip) : createPose();
    copyPose(this.neutralPose, this.manualPose);
    copyPose(this.neutralPose, this.displayPose);
    this.manualDirty = true;
    this.driver.apply(this.neutralPose);

    try {
      await this.viewport.warmUp();
    } catch (e) {
      console.warn('[model] warm-up skipped', e);
    }

    const ms = performance.now() - t0;
    const st = loaded.stats;
    const tris = st.triangles >= 10_000 ? `${(st.triangles / 1000).toFixed(0)}k` : String(st.triangles);
    this.log(0, 'model', `loaded ${st.meshes} meshes, ${tris} tris, ${st.textures} textures in ${(ms / 1000).toFixed(1)} s`);
    if (skeleton.missing.length) this.log(2, 'model', `bones not found: ${skeleton.missing.join(', ')}`);
    else this.log(0, 'model', `all ${ALL_BONES.length} bones resolved`);
    for (const r of axis) if (r.status !== 'pass') this.log(r.status === 'corrected' ? 1 : 2, 'axis-check', `${r.bone}: ${r.status}, ${r.detail}`);
    if (axis.every((r) => r.status === 'pass')) this.log(0, 'axis-check', 'arm raise and knee direction match the rig convention');
    if (!idle) this.log(1, 'model', 'no Idle clip, neutral pose falls back to rest');
    if (st.maxTextureSize > 2048 || st.triangles > 250_000) {
      this.log(1, 'model', `heavy asset (${st.maxTextureSize}px textures), run npm run optimize`);
    }
    if (DEBUG) this.debugHelpers(loaded.root);

    this.setModelState({ kind: 'ready', model: loaded, skeleton, axis });
    if (this.mode === 'playback') this.playClip('Idle', 0);
    this.refreshHighlight();
  }

  private debugHelpers(root: THREE.Object3D): void {
    const helper = new THREE.SkeletonHelper(root);
    this.viewport.scene.add(helper, new THREE.AxesHelper(0.5));
    console.info('[debug] skeleton helper and axes added');
  }

  private applyAccent(c: THREE.Color | null): void {
    if (c) {
      this.accent = '#' + c.getHexString(THREE.SRGBColorSpace);
      this.log(0, 'model', `accent sampled from materials: ${this.accent.toUpperCase()}`);
    } else {
      this.log(1, 'model', `no red found in materials, accent stays ${FALLBACK_ACCENT}`);
    }
    this.bus.emit('accent', this.accent);
  }

  markerPalette(): MarkerPalette {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    return { idle: v('--marker', '#9A9C9F'), hover: v('--text', '#E6E4DF'), accent: this.accent, warn: v('--warn', '#D19A3A'), fault: v('--fault', '#E5554A') };
  }

  // ---- modes and pose ----

  setMode(m: Mode): void {
    if (m === this.mode) return;
    const prev = this.mode;
    if (m === 'manual') {
      copyPose(this.displayPose, this.manualPose);
      this.manualDirty = true;
    }
    if (prev === 'playback') this.clips?.stop();
    this.mode = m;
    if (m === 'playback' && this.clips && !this.clips.current) this.playClip('Idle', 0);
    this.log(0, 'mode', `${prev} to ${m}`);
    this.bus.emit('mode', m);
  }

  setJointAxis(id: JointId, axis: 0 | 1 | 2, value: number): void {
    const [lo, hi] = JOINTS[id].limits[axis];
    this.manualPose.joints[id][axis] = clamp(value, lo, hi);
    this.manualDirty = true;
  }

  setRootBob(v: number): void {
    this.manualPose.rootBob = clamp(v, ROOT_BOB_RANGE[0], ROOT_BOB_RANGE[1]);
    this.manualDirty = true;
  }

  /** Reset a single joint (or all, if omitted) to the neutral pose. */
  resetPose(id?: JointId): void {
    if (id) {
      const n = this.neutralPose.joints[id];
      const m = this.manualPose.joints[id];
      m[0] = n[0];
      m[1] = n[1];
      m[2] = n[2];
    } else {
      copyPose(this.neutralPose, this.manualPose);
    }
    this.manualDirty = true;
    if (this.mode !== 'manual') this.setMode('manual');
    copyPose(this.manualPose, this.displayPose);
    this.bus.emit('frame', undefined);
  }

  applyTPose(): void {
    copyPose(this.tPose, this.manualPose);
    this.manualDirty = true;
    if (this.mode !== 'manual') this.setMode('manual');
    copyPose(this.manualPose, this.displayPose);
    this.bus.emit('frame', undefined);
  }

  playClip(name: string, crossfade = 0.3): void {
    if (!this.clips) return;
    if (this.mode !== 'playback') this.setMode('playback');
    this.clips.play(name, crossfade);
    this.log(0, 'playback', `${name}${crossfade > 0 ? `, crossfade ${crossfade.toFixed(2)} s` : ''}`);
    this.bus.emit('clip', undefined);
  }

  private frame(dt: number): void {
    const driver = this.driver;
    if (this.mode === 'playback') {
      if (this.clips && driver) {
        this.clips.update(dt);
        driver.read(this.displayPose);
      }
    } else if (this.mode === 'manual') {
      if (this.manualDirty) {
        driver?.apply(this.manualPose);
        copyPose(this.manualPose, this.displayPose);
        this.manualDirty = false;
      }
    } else if (this.store.frames > 0) {
      // Hold the last pose until the first frame arrives rather than snapping to rest.
      smoothPose(this.displayPose, this.store.target, dt, LIVE_SMOOTH_TAU);
      driver?.apply(this.displayPose);
    }
    this.shading?.update(dt);
    this.markers?.update(this.viewport.camera);

    // UI readouts that follow the pose do not need 60 Hz.
    this.frameEmitAcc += dt;
    if (this.frameEmitAcc >= 1 / 30) {
      this.frameEmitAcc = 0;
      this.bus.emit('frame', undefined);
    }
  }

  private tick(): void {
    this.store.sampleHistory();
    const events = this.alerts.evaluate(this.store);
    for (const e of events) this.log(e.level, e.source, e.message);
    if (this.markers) for (const id of JOINT_IDS) this.markers.setStatus(id, LEVEL_NAME[this.alerts.joint.get(id)!.level]);
    this.applyTint();
    this.bus.emit('tick', undefined);
  }

  // ---- selection, hover, overlays ----

  select(sel: Selection): void {
    const same =
      sel && this.selection && sel.kind === this.selection.kind && sel.id === this.selection.id;
    this.selection = same ? null : sel;
    this.refreshHighlight();
    this.bus.emit('selection', this.selection);
  }

  setHover(h: PickHit | null): void {
    const a = this.hover;
    if (a?.joint === h?.joint && a?.subsystem === h?.subsystem) return;
    this.hover = h;
    this.refreshHighlight();
    this.bus.emit('hover', h);
  }

  setShowMarkers(v: boolean): void {
    this.showMarkers = v;
    this.markers?.setVisible(v);
    this.bus.emit('options', undefined);
  }

  setTintAlerts(v: boolean): void {
    this.tintAlerts = v;
    this.applyTint();
    this.bus.emit('options', undefined);
  }

  private applyTint(): void {
    if (!this.shading) return;
    const p = this.markerPalette();
    for (const s of SUBSYSTEMS) {
      const level = this.alerts.subsystem.get(s.id) ?? 0;
      this.shading.setTint(s.id, this.tintAlerts && level > 0 ? (level === 2 ? p.fault : p.warn) : null, level === 2 ? 0.5 : 0.36);
    }
  }

  private refreshHighlight(): void {
    if (!this.shading || !this.markers) return;
    const sel = this.selection;
    const selSub = sel?.kind === 'subsystem' ? sel.id : null;
    const hovSub = this.hover?.subsystem ?? null;
    for (const s of SUBSYSTEMS) {
      if (s.id === selSub) this.shading.setRim(s.id, this.accent, 1);
      else if (s.id === hovSub) this.shading.setRim(s.id, '#E6E4DF', 0.55);
      else this.shading.setRim(s.id, null);
    }
    this.markers.setSelected(sel?.kind === 'joint' ? sel.id : null);
    this.markers.setHovered(this.hover?.joint ?? null);
    this.markers.setSubsystemFocus(selSub);
  }

  private bindPointer(): void {
    const canvas = this.viewport.canvas;
    let pending: PointerEvent | null = null;
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      if (!pending) requestAnimationFrame(() => {
        if (pending && this.markers) this.setHover(this.viewport.pick(pending.clientX, pending.clientY, this.markers.pickables));
        pending = null;
      });
      pending = e;
    });
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      const d = this.pointerDown;
      this.pointerDown = null;
      // A drag is an orbit, not a click.
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !this.markers) return;
      const hit = this.viewport.pick(e.clientX, e.clientY, this.markers.pickables);
      if (!hit) {
        if (this.selection) this.select(null);
        return;
      }
      // Clicking a marker selects the joint; clicking a body part selects the subsystem.
      const marker = hit.joint && this.hitWasMarker(e);
      this.select(marker ? { kind: 'joint', id: hit.joint! } : { kind: 'subsystem', id: hit.subsystem });
    });
  }

  private hitWasMarker(e: PointerEvent): boolean {
    if (!this.markers) return false;
    const markersOnly = this.markers.pickables.filter((o) => o.name.startsWith('marker:'));
    return this.viewport.pick(e.clientX, e.clientY, markersOnly) !== null;
  }

  log(level: Level, source: string, message: string): void {
    const entry: LogEntry = { time: new Date(), level, source, message };
    this.logEntries.push(entry);
    if (this.logEntries.length > 400) this.logEntries.splice(0, this.logEntries.length - 400);
    this.bus.emit('log', entry);
  }

  dispose(): void {
    window.clearTimeout(this.probeTimer);
    window.clearInterval(this.tickTimer);
    this.loadAbort?.abort();
    this.source.disconnect();
    this.clips?.dispose();
    this.markers?.dispose();
    this.shading?.dispose();
    if (this.model) {
      this.viewport.clearModel();
      disposeObject(this.model.root);
    }
    this.viewport.dispose();
  }
}
