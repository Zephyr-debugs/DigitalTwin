import type { App } from '../app';
import { CLIP_FPS } from '../config';
import { fixed, h, setAttr, setText } from './dom';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const FADES = [0, 0.15, 0.3, 0.6];

export function mountAnimationPanel(host: HTMLElement, app: App): void {
  const clipName = h('span', { class: 'clip-current num' });
  const readout = h('span', { class: 'num clip-readout' });
  const clipList = h('div', { class: 'clip-list', role: 'group', 'aria-label': 'Clips' });
  const empty = h('p', { class: 'empty', text: 'Clips are read from the model. Load worker_bot.glb to enable playback.' });

  const playBtn = h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Play', text: 'Play' });
  const backBtn = h('button', { class: 'btn btn-step', type: 'button', 'aria-label': 'Previous frame', title: 'Previous frame (Left)', text: '‹' });
  const fwdBtn = h('button', { class: 'btn btn-step', type: 'button', 'aria-label': 'Next frame', title: 'Next frame (Right)', text: '›' });
  const loopBtn = h('button', { class: 'btn', type: 'button', text: 'Loop' });
  const speedSel = h('select', { class: 'select', 'aria-label': 'Playback speed' }, ...SPEEDS.map((s) => h('option', { value: s, text: `Speed ${s}×` })));
  speedSel.value = '1';
  const fadeSel = h('select', { class: 'select', 'aria-label': 'Crossfade' }, ...FADES.map((f) => h('option', { value: f, text: f ? `Fade ${f} s` : 'Fade off' })));
  fadeSel.value = '0.3';

  const ruler = h('canvas', { class: 'ruler-canvas', 'aria-hidden': 'true' });
  const head = h('div', { class: 'playhead', 'aria-hidden': 'true' });
  const timeline = h('div', { class: 'timeline', role: 'slider', tabindex: 0, 'aria-label': 'Timeline, frame' }, ruler, head);

  const controls = h(
    'div',
    { class: 'transport' },
    playBtn,
    backBtn,
    fwdBtn,
    loopBtn,
    h('span', { class: 'transport-gap' }),
    speedSel,
    fadeSel,
  );

  host.append(
    h('div', { class: 'panel-head' }, h('h2', { class: 'label', text: 'Playback' }), clipName, readout),
    clipList,
    empty,
    controls,
    timeline,
  );

  const clipButtons = new Map<string, HTMLButtonElement>();

  const buildClips = () => {
    clipList.replaceChildren();
    clipButtons.clear();
    const clips = app.clips?.clips ?? [];
    empty.hidden = clips.length > 0;
    controls.hidden = timeline.hidden = clips.length === 0;
    for (const c of clips) {
      const b = h(
        'button',
        { class: 'clip-btn', type: 'button', title: c.sourceName, onclick: () => app.playClip(c.name, Number(fadeSel.value)) },
        h('span', { class: 'clip-name', text: c.name }),
        h('span', { class: 'num muted', text: `${c.frames}f` }),
      );
      clipButtons.set(c.name, b);
      clipList.append(b);
    }
    renderState();
  };

  const renderState = () => {
    const p = app.clips;
    const cur = app.mode === 'playback' ? p?.current : null;
    clipButtons.forEach((b, name) => setAttr(b, 'aria-pressed', String(cur?.name === name)));
    setText(clipName, cur ? cur.name : app.mode === 'playback' ? 'none' : `inactive in ${app.mode}`);
    const paused = !p || p.isPaused || !cur;
    setText(playBtn, paused ? 'Play' : 'Pause');
    setAttr(playBtn, 'aria-label', paused ? 'Play' : 'Pause');
    setAttr(loopBtn, 'aria-pressed', String(p?.isLooping ?? false));
    host.dataset.active = String(Boolean(cur));
  };

  const drawRuler = () => {
    const cur = app.clips?.current;
    const r = ruler.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width));
    const hh = Math.max(1, Math.round(r.height));
    if (ruler.width !== w * dpr || ruler.height !== hh * dpr) {
      ruler.width = w * dpr;
      ruler.height = hh * dpr;
    }
    const ctx = ruler.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const css = getComputedStyle(document.documentElement);
    const hair = css.getPropertyValue('--hairline').trim();
    const muted = css.getPropertyValue('--muted').trim();
    ctx.fillStyle = hair;
    ctx.fillRect(0, hh - 1, w, 1);
    if (!cur) return;
    const frames = cur.frames;
    const pad = 6;
    const span = w - pad * 2;
    // Label every second at 24 fps, half-second majors, frame minors when there is room.
    const showMinor = span / Math.max(1, frames - 1) >= 3;
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let f = 1; f <= frames; f++) {
      const x = Math.round(pad + ((f - 1) / Math.max(1, frames - 1)) * span) + 0.5;
      const major = (f - 1) % 12 === 0;
      const label = (f - 1) % 24 === 0;
      if (!major && !showMinor) continue;
      ctx.fillStyle = label ? muted : hair;
      const len = label ? 9 : major ? 6 : 3;
      ctx.fillRect(x - 0.5, hh - 1 - len, 1, len);
      if (label) {
        ctx.fillStyle = muted;
        ctx.fillText(String(f), Math.min(Math.max(x, 8), w - 8), 1);
      }
    }
  };

  const renderTime = () => {
    const p = app.clips;
    const cur = app.mode === 'playback' ? p?.current : null;
    if (!p || !cur) {
      setText(readout, '');
      head.hidden = true;
      return;
    }
    const frame = Math.min(p.frame, cur.frames);
    setText(readout, `F ${String(frame).padStart(3, ' ')} / ${cur.frames}   ${fixed(p.time, 2)} / ${fixed(cur.duration, 2)} s`);
    const w = timeline.clientWidth;
    const pad = 6;
    const frac = cur.duration > 0 ? p.time / cur.duration : 0;
    head.hidden = false;
    head.style.transform = `translateX(${(pad + frac * (w - pad * 2)).toFixed(1)}px)`;
    timeline.setAttribute('aria-valuemin', '1');
    timeline.setAttribute('aria-valuemax', String(cur.frames));
    timeline.setAttribute('aria-valuenow', String(frame));
    timeline.setAttribute('aria-valuetext', `frame ${frame} of ${cur.frames}, ${fixed(p.time, 2)} seconds`);
  };

  const scrubTo = (clientX: number) => {
    const p = app.clips;
    const cur = p?.current;
    if (!p || !cur) return;
    const r = timeline.getBoundingClientRect();
    const pad = 6;
    const frac = Math.min(1, Math.max(0, (clientX - r.left - pad) / (r.width - pad * 2)));
    const frame = Math.round(frac * (cur.frames - 1));
    p.scrub(frame / CLIP_FPS);
    renderTime();
  };

  let scrubbing = false;
  let wasPaused = false;
  timeline.addEventListener('pointerdown', (e) => {
    if (!app.clips?.current) {
      if (app.clips) app.playClip('Idle', 0);
      else return;
    }
    if (app.mode !== 'playback') app.setMode('playback');
    scrubbing = true;
    wasPaused = app.clips.isPaused;
    app.clips.setPaused(true);
    timeline.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
  });
  timeline.addEventListener('pointermove', (e) => scrubbing && scrubTo(e.clientX));
  timeline.addEventListener('pointerup', () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (!wasPaused) app.clips?.setPaused(false);
    renderState();
  });
  timeline.addEventListener('keydown', (e) => {
    const p = app.clips;
    if (!p?.current) return;
    const step = e.shiftKey ? 12 : 1;
    if (e.key === 'ArrowRight') p.stepFrames(step);
    else if (e.key === 'ArrowLeft') p.stepFrames(-step);
    else if (e.key === 'Home') p.scrub(0);
    else if (e.key === 'End') p.scrub(p.current.duration);
    else return;
    e.preventDefault();
    if (!p.isPaused) p.setPaused(true);
    renderState();
    renderTime();
  });

  playBtn.addEventListener('click', () => {
    const p = app.clips;
    if (!p) return;
    if (app.mode !== 'playback' || !p.current) {
      app.playClip(p.current?.name ?? 'Idle', 0);
    } else {
      p.setPaused(!p.isPaused);
    }
    renderState();
  });
  backBtn.addEventListener('click', () => {
    app.clips?.setPaused(true);
    app.clips?.stepFrames(-1);
    renderState();
    renderTime();
  });
  fwdBtn.addEventListener('click', () => {
    app.clips?.setPaused(true);
    app.clips?.stepFrames(1);
    renderState();
    renderTime();
  });
  loopBtn.addEventListener('click', () => {
    app.clips?.setLoop(!app.clips.isLooping);
    renderState();
  });
  speedSel.addEventListener('change', () => app.clips?.setSpeed(Number(speedSel.value)));

  new ResizeObserver(() => {
    drawRuler();
    renderTime();
  }).observe(timeline);

  app.bus.on('model', (st) => {
    if (st.kind === 'ready' || st.kind === 'missing' || st.kind === 'error') buildClips();
  });
  app.bus.on('clip', () => {
    renderState();
    drawRuler();
  });
  app.bus.on('mode', () => {
    renderState();
    drawRuler();
  });
  app.bus.on('frame', renderTime);
  app.bus.on('tick', renderState);

  buildClips();
}
