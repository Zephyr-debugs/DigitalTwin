import * as THREE from 'three';
import { CLIP_FPS, EXPECTED_CLIPS, LOOPING_CLIPS } from '../config';

export interface ClipInfo {
  name: string;
  sourceName: string;
  clip: THREE.AnimationClip;
  duration: number;
  frames: number;
  loopsByDefault: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Blender often exports actions as "Armature|Idle" or "Idle.001"; map them back to the names we expect. */
function canonicalName(source: string): string {
  const tail = source.split('|').pop() ?? source;
  const n = norm(tail).replace(/\d+$/, '');
  return EXPECTED_CLIPS.find((e) => norm(e) === n) ?? tail;
}

export class ClipPlayer {
  readonly mixer: THREE.AnimationMixer;
  readonly clips: ClipInfo[];
  private action: THREE.AnimationAction | null = null;
  private currentInfo: ClipInfo | null = null;
  private loop = true;
  private speed = 1;
  private paused = false;
  private finishedListeners: ((name: string) => void)[] = [];

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = clips.map((clip) => {
      const name = canonicalName(clip.name);
      return {
        name,
        sourceName: clip.name,
        clip,
        duration: clip.duration,
        frames: Math.round(clip.duration * CLIP_FPS) + 1,
        loopsByDefault: LOOPING_CLIPS.has(name),
      };
    });
    const order = (n: string) => {
      const i = EXPECTED_CLIPS.indexOf(n);
      return i < 0 ? 99 : i;
    };
    this.clips.sort((a, b) => order(a.name) - order(b.name));

    const missing = EXPECTED_CLIPS.filter((e) => !this.clips.some((c) => c.name === e));
    if (missing.length) console.warn('[clips] expected clips not found:', missing);
    console.info('[clips]', this.clips.map((c) => `${c.name} (${c.sourceName}, ${c.frames} f)`).join(', '));

    this.mixer.addEventListener('finished', () => {
      if (this.currentInfo) for (const fn of this.finishedListeners) fn(this.currentInfo.name);
    });
  }

  find(name: string): ClipInfo | undefined {
    return this.clips.find((c) => c.name === name);
  }

  get current(): ClipInfo | null {
    return this.currentInfo;
  }

  get time(): number {
    return this.action ? this.action.time : 0;
  }

  get frame(): number {
    return Math.floor(this.time * CLIP_FPS + 1e-4) + 1;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isLooping(): boolean {
    return this.loop;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  onFinished(fn: (name: string) => void): void {
    this.finishedListeners.push(fn);
  }

  play(name: string, crossfade = 0.3): void {
    const info = this.find(name);
    if (!info) return;
    if (info === this.currentInfo && this.action) {
      this.action.reset().play();
      this.paused = false;
      this.action.paused = false;
      return;
    }
    this.loop = info.loopsByDefault;
    const next = this.mixer.clipAction(info.clip);
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(this.speed);
    next.setEffectiveWeight(1);
    this.applyLoop(next);
    next.play();
    if (this.action && this.action !== next && crossfade > 0) {
      this.action.crossFadeTo(next, crossfade, false);
    } else if (this.action && this.action !== next) {
      this.action.stop();
    }
    this.action = next;
    this.currentInfo = info;
    this.paused = false;
  }

  private applyLoop(a: THREE.AnimationAction): void {
    a.setLoop(this.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = true;
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    if (this.action) this.applyLoop(this.action);
  }

  setSpeed(s: number): void {
    this.speed = s;
    if (this.action) this.action.setEffectiveTimeScale(s);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!this.action) return;
    // A clip that ran to its end under LoopOnce needs a restart, not an unpause.
    if (!p && !this.action.isRunning() && this.action.time >= (this.currentInfo?.duration ?? 0) - 1e-3) this.action.reset();
    this.action.paused = p;
    if (!p) this.action.play();
  }

  scrub(time: number): void {
    if (!this.action || !this.currentInfo) return;
    const t = THREE.MathUtils.clamp(time, 0, this.currentInfo.duration);
    this.action.paused = false;
    this.action.enabled = true;
    this.action.play();
    this.action.time = t;
    this.mixer.update(0);
    this.action.paused = this.paused;
  }

  stepFrames(n: number): void {
    if (!this.currentInfo) return;
    const t = (this.frame - 1 + n) / CLIP_FPS;
    this.scrub(this.loop ? ((t % this.currentInfo.duration) + this.currentInfo.duration) % this.currentInfo.duration : t);
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  stop(): void {
    this.mixer.stopAllAction();
    this.action = null;
    this.currentInfo = null;
    this.paused = false;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const c of this.clips) this.mixer.uncacheClip(c.clip);
  }
}
