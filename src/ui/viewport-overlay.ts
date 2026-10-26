import type { App, ModelState } from '../app';
import { JOINTS, MODEL_PROBE_INTERVAL_MS, MODEL_URL, SUBSYSTEMS } from '../config';
import { LEVEL_NAME } from '../telemetry/alerts';
import { bytes, clockTime, fixed, h, setAttr, setText } from './dom';

export function mountViewportOverlay(host: HTMLElement, app: App): void {
  // ---- subsystem status strip ----
  const statusRows = SUBSYSTEMS.map((s) => {
    const mark = h('span', { class: 'status-mark', 'aria-hidden': 'true' });
    const word = h('span', { class: 'status-word' });
    const btn = h('button', { class: 'status-row', type: 'button', onclick: () => app.select({ kind: 'subsystem', id: s.id }) }, mark, h('span', { class: 'status-name', text: s.label }), word);
    return { s, btn, mark, word };
  });
  const sysMark = h('span', { class: 'status-mark', 'aria-hidden': 'true' });
  const sysWord = h('span', { class: 'status-word' });
  const strip = h(
    'div',
    { class: 'vp-status', role: 'group', 'aria-label': 'Subsystem status' },
    h('div', { class: 'label vp-status-title', text: 'Status' }),
    ...statusRows.map((r) => r.btn),
    h('div', { class: 'status-row status-row-static' }, sysMark, h('span', { class: 'status-name', text: 'System' }), sysWord),
  );

  // ---- toolbar ----
  const markersBtn = h('button', { class: 'tool-btn', type: 'button', onclick: () => app.setShowMarkers(!app.showMarkers), text: 'Joints' });
  const tintBtn = h('button', { class: 'tool-btn', type: 'button', onclick: () => app.setTintAlerts(!app.tintAlerts), text: 'Alert tint' });
  const viewBtn = h('button', { class: 'tool-btn', type: 'button', onclick: () => app.viewport.resetView(), text: 'Reset view' });
  const toolbar = h('div', { class: 'vp-tools', role: 'toolbar', 'aria-label': 'Viewport' }, markersBtn, tintBtn, viewBtn);

  // ---- hover readout ----
  const hoverJoint = h('span', { class: 'num' });
  const hoverSub = h('span', { class: 'muted' });
  const hoverBox = h('div', { class: 'vp-hover', hidden: true }, hoverJoint, hoverSub);
  let lastPointer = { x: 0, y: 0 };
  app.viewport.canvas.addEventListener('pointermove', (e) => {
    const r = host.getBoundingClientRect();
    lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    hoverBox.style.transform = `translate(${lastPointer.x + 14}px, ${lastPointer.y + 14}px)`;
  });

  // ---- stats ----
  const stats = h('div', { class: 'vp-stats num', 'aria-hidden': 'true' });

  // ---- model state panel ----
  const stateBox = h('div', { class: 'vp-state', role: 'status', 'aria-live': 'polite' });

  host.append(strip, toolbar, hoverBox, stats, stateBox);

  const renderStatus = () => {
    for (const r of statusRows) {
      const lvl = app.alerts.subsystem.get(r.s.id) ?? 0;
      setAttr(r.mark, 'data-level', LEVEL_NAME[lvl]);
      setText(r.word, app.store.frames ? LEVEL_NAME[lvl] : 'no data');
      const sel = app.selection?.kind === 'subsystem' && app.selection.id === r.s.id;
      setAttr(r.btn, 'aria-pressed', String(sel));
    }
    setAttr(sysMark, 'data-level', LEVEL_NAME[app.alerts.system.level]);
    setText(sysWord, app.store.frames ? LEVEL_NAME[app.alerts.system.level] : 'no data');
  };

  const renderTools = () => {
    setAttr(markersBtn, 'aria-pressed', String(app.showMarkers));
    setAttr(tintBtn, 'aria-pressed', String(app.tintAlerts));
  };

  const renderHover = () => {
    const hv = app.hover;
    hoverBox.hidden = !hv;
    if (!hv) return;
    setText(hoverJoint, hv.joint ?? '');
    const sub = SUBSYSTEMS.find((s) => s.id === hv.subsystem)!.label;
    setText(hoverSub, hv.joint ? `${sub}, ${JOINTS[hv.joint].side === 'C' ? 'centre' : JOINTS[hv.joint].side === 'L' ? 'left' : 'right'}` : sub);
  };

  const renderStats = () => {
    const s = app.viewport.stats;
    if (!app.viewport.hasModel) {
      setText(stats, '');
      return;
    }
    setText(stats, `${fixed(s.fps, 0)} fps   ${fixed(s.frameMs, 1)} ms cpu   ${s.drawCalls} calls   ${fixed(s.triangles / 1000, 0)}k tris`);
  };

  const renderState = (st: ModelState) => {
    stateBox.replaceChildren();
    stateBox.hidden = st.kind === 'ready';
    host.dataset.model = st.kind;
    if (st.kind === 'probing') {
      stateBox.append(h('p', { class: 'state-title', text: 'Checking for model' }), h('p', { class: 'state-body num', text: MODEL_URL }));
    } else if (st.kind === 'missing') {
      stateBox.append(
        h('p', { class: 'state-title', text: 'No model loaded' }),
        h('p', { class: 'state-body' }, 'Place the exported GLB at ', h('code', { text: 'public/models/worker_bot.glb' }), '. It loads as soon as the file appears.'),
        h('p', { class: 'state-meta num', text: `Checked ${clockTime(new Date(st.lastCheck))}, every ${MODEL_PROBE_INTERVAL_MS / 1000} s` }),
        h('p', { class: 'state-meta', text: 'Telemetry keeps running without the model.' }),
      );
    } else if (st.kind === 'loading') {
      const p = st.progress;
      const frac = p.phase === 'download' ? (p.total ? p.loaded / p.total : 0) : 1;
      const phases: [string, string][] = [
        ['download', 'Download'],
        ['parse', 'Parse'],
        ['upload', 'Upload to GPU'],
      ];
      const idx = phases.findIndex(([k]) => k === p.phase);
      const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(frac * 100) });
      const fill = h('div', { class: 'progress-fill' });
      fill.style.transform = `scaleX(${p.phase === 'download' ? frac : 1})`;
      if (p.phase === 'download' && !p.total) bar.dataset.indeterminate = 'true';
      bar.append(fill);
      stateBox.append(
        h('p', { class: 'state-title', text: 'Loading worker_bot.glb' }),
        bar,
        h('p', { class: 'state-meta num', text: p.phase === 'download' ? (p.total ? `${bytes(p.loaded)} of ${bytes(p.total)}` : `${bytes(p.loaded)}`) : '' }),
        h(
          'ol',
          { class: 'phases' },
          ...phases.map(([, label], i) => h('li', { 'data-state': i < idx ? 'done' : i === idx ? 'active' : 'todo', text: label })),
        ),
      );
    } else if (st.kind === 'error') {
      stateBox.append(
        h('p', { class: 'state-title state-fault', text: st.message }),
        h('p', { class: 'state-body num', text: st.detail }),
        h('button', { class: 'btn', type: 'button', onclick: () => app.retryLoad(), text: 'Retry load' }),
      );
    }
  };

  const renderReadyWarnings = (st: ModelState) => {
    host.querySelector('.vp-warning')?.remove();
    if (st.kind !== 'ready' || !st.skeleton.missing.length) return;
    host.append(
      h(
        'div',
        { class: 'vp-warning', role: 'alert' },
        h('span', { class: 'state-fault', text: `${st.skeleton.missing.length} of 18 bones not found` }),
        h('span', { class: 'num muted', text: st.skeleton.missing.join(', ') }),
      ),
    );
  };

  app.bus.on('model', (st) => {
    renderState(st);
    renderReadyWarnings(st);
  });
  app.bus.on('tick', () => {
    renderStatus();
    renderStats();
  });
  app.bus.on('selection', renderStatus);
  app.bus.on('hover', renderHover);
  app.bus.on('options', renderTools);

  renderState(app.modelState);
  renderStatus();
  renderTools();
}
