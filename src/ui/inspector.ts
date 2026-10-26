import type { App } from '../app';
import { JOINTS, ROOT_BOB_RANGE, SUBSYSTEMS, jointsOf, type JointId, type SubsystemId } from '../config';
import { LEVEL_NAME } from '../telemetry/alerts';
import { fixed, h, setAttr, setText, signed } from './dom';

interface AxisRow {
  id: JointId;
  axis: 0 | 1 | 2;
  input: HTMLInputElement;
  value: HTMLElement;
  delta: HTMLElement;
  cmdTick: HTMLElement;
  lo: number;
  hi: number;
  shown: number;
  shownCmd: number;
  block: string;
}

const AXES = ['X', 'Y', 'Z'] as const;

export function mountInspector(host: HTMLElement, app: App): void {
  const rows: AxisRow[] = [];
  const jointBlocks = new Map<JointId, { block: HTMLElement; mark: HTMLElement }>();
  const groupHeads = new Map<SubsystemId, { head: HTMLElement; mark: HTMLElement; word: HTMLElement }>();
  let dragging: HTMLInputElement | null = null;

  // ---- selection summary ----
  const selName = h('div', { class: 'sel-name num' });
  const selMeta = h('div', { class: 'sel-meta muted' });
  const selFindings = h('ul', { class: 'findings' });
  const summary = h('div', { class: 'sel-summary' }, selName, selMeta, selFindings);

  const neutralBtn = h('button', { class: 'btn', type: 'button', onclick: () => app.resetPose(), text: 'Reset pose', title: 'Neutral pose (first frame of Idle)' });
  const tposeBtn = h('button', { class: 'btn', type: 'button', onclick: () => app.applyTPose(), text: 'T-pose' });
  const modeHint = h('p', { class: 'mode-hint' });

  const list = h('div', { class: 'joint-list' });

  // Only joints scrolled into view are refreshed; 54 sliders at 30 Hz is a measurable cost.
  const visible = new Set<string>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.joint!;
        if (e.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
    },
    { root: list },
  );


  host.append(
    h('div', { class: 'panel-head' }, h('h2', { class: 'label', text: 'Joint inspector' }), h('div', { class: 'panel-actions' }, neutralBtn, tposeBtn)),
    summary,
    modeHint,
    list,
  );

  const makeRow = (id: JointId, axis: 0 | 1 | 2): HTMLElement => {
    const def = JOINTS[id];
    const [lo, hi] = def.limits[axis];
    const input = h('input', {
      type: 'range',
      class: 'slider',
      min: lo,
      max: hi,
      step: 0.1,
      value: 0,
      'aria-label': `${id} ${AXES[axis]} ${def.axisNames[axis]}`,
    });
    const value = h('span', { class: 'num axis-value' });
    const delta = h('span', { class: 'num axis-delta', title: 'Commanded minus measured' });
    const cmdTick = h('span', { class: 'cmd-tick', 'aria-hidden': 'true', hidden: true });
    const track = h('div', { class: 'slider-wrap' }, input, cmdTick);
    const row: AxisRow = { id, axis, input, value, delta, cmdTick, lo, hi, shown: NaN, shownCmd: NaN, block: id };
    rows.push(row);

    input.addEventListener('pointerdown', () => (dragging = input));
    input.addEventListener('pointerup', () => (dragging = null));
    input.addEventListener('input', () => {
      app.setJointAxis(id, axis, Number(input.value));
      if (app.mode !== 'manual') app.setMode('manual');
      select(id);
    });
    input.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      const cur = app.manualPose.joints[id][axis];
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step;
      else if (e.key === 'PageUp') next = cur + 10;
      else if (e.key === 'PageDown') next = cur - 10;
      else if (e.key === 'Home') next = lo;
      else if (e.key === 'End') next = hi;
      if (next === null) return;
      e.preventDefault();
      if (app.mode !== 'manual') app.setMode('manual');
      select(id);
      app.setJointAxis(id, axis, next);
      input.value = String(app.manualPose.joints[id][axis]);
    });

    return h(
      'div',
      { class: 'axis-row' },
      h('span', { class: 'axis-label' }, h('span', { class: 'axis-letter num', text: AXES[axis] }), h('span', { class: 'axis-name', text: def.axisNames[axis] })),
      track,
      value,
      delta,
    );
  };

  const select = (id: JointId) => {
    if (app.selection?.kind === 'joint' && app.selection.id === id) return;
    app.select({ kind: 'joint', id });
  };

  for (const s of SUBSYSTEMS) {
    const mark = h('span', { class: 'status-mark', 'aria-hidden': 'true' });
    const word = h('span', { class: 'group-status muted' });
    const head = h(
      'button',
      { class: 'group-head', type: 'button', onclick: () => app.select({ kind: 'subsystem', id: s.id }) },
      mark,
      h('span', { class: 'group-name', text: s.label }),
      word,
    );
    groupHeads.set(s.id, { head, mark, word });
    const group = h('section', { class: 'joint-group', 'aria-label': s.label }, head);

    if (s.id === 'torso') {
      const bobInput = h('input', { type: 'range', class: 'slider', min: ROOT_BOB_RANGE[0], max: ROOT_BOB_RANGE[1], step: 0.001, value: 0, 'aria-label': 'root vertical offset' });
      const bobValue = h('span', { class: 'num axis-value' });
      bobInput.addEventListener('input', () => {
        app.setRootBob(Number(bobInput.value));
        if (app.mode !== 'manual') app.setMode('manual');
      });
      group.append(
        h(
          'div',
          { class: 'joint-block' },
          h('div', { class: 'joint-head joint-head-static' }, h('span', { class: 'joint-name num', text: 'root' }), h('span', { class: 'joint-side muted', text: 'translation' })),
          h('div', { class: 'axis-row' }, h('span', { class: 'axis-label' }, h('span', { class: 'axis-letter num', text: 'Y' }), h('span', { class: 'axis-name', text: 'bob' })), h('div', { class: 'slider-wrap' }, bobInput), bobValue, h('span', { class: 'axis-delta' })),
        ),
      );
      app.bus.on('frame', () => {
        if (document.activeElement !== bobInput) bobInput.value = String(app.displayPose.rootBob);
        setText(bobValue, `${signed(app.displayPose.rootBob * 1000, 0)} mm`);
      });
    }

    for (const def of jointsOf(s.id)) {
      const mark = h('span', { class: 'status-mark', 'aria-hidden': 'true' });
      const headBtn = h(
        'button',
        { class: 'joint-head', type: 'button', onclick: () => app.select({ kind: 'joint', id: def.id }) },
        h('span', { class: 'joint-name num', text: def.id }),
        h('span', { class: 'joint-side muted', text: def.side === 'C' ? '' : def.side === 'L' ? 'left' : 'right' }),
        mark,
        h('span', {
          class: 'joint-reset',
          role: 'button',
          tabindex: 0,
          title: `Reset ${def.id} to neutral`,
          text: 'reset',
          onclick: (e: Event) => {
            e.stopPropagation();
            app.resetPose(def.id);
          },
          onkeydown: (e: Event) => {
            const k = (e as KeyboardEvent).key;
            if (k === 'Enter' || k === ' ') {
              e.preventDefault();
              e.stopPropagation();
              app.resetPose(def.id);
            }
          },
        }),
      );
      const block = h('div', { class: 'joint-block', 'data-joint': def.id }, headBtn, makeRow(def.id, 0), makeRow(def.id, 1), makeRow(def.id, 2));
      jointBlocks.set(def.id, { block, mark });
      io.observe(block);
      group.append(block);
    }
    list.append(group);
  }

  const renderValues = () => {
    const live = app.mode === 'live';
    for (const r of rows) {
      if (!visible.has(r.block)) continue;
      const v = app.displayPose.joints[r.id][r.axis];
      // Written as !(<=) so the initial NaN counts as changed.
      if (!(Math.abs(v - r.shown) <= 0.05)) {
        if (dragging !== r.input) r.input.value = String(v);
        r.shown = v;
        setText(r.value, `${signed(v, 1)}°`);
        r.input.setAttribute('aria-valuetext', `${fixed(v, 1)} degrees`);
      }
      const jl = app.store.joints.get(r.id)!;
      const cmd = jl.cmd?.[r.axis];
      if (live && cmd !== undefined) {
        setText(r.delta, signed(cmd - jl.angle[r.axis], 1));
        if (r.cmdTick.hidden) r.cmdTick.hidden = false;
        if (!(Math.abs(cmd - r.shownCmd) <= 0.1)) {
          r.shownCmd = cmd;
          const frac = Math.min(1, Math.max(0, (cmd - r.lo) / (r.hi - r.lo)));
          // The thumb centre travels between half a thumb width (3 px) from each end.
          r.cmdTick.style.left = `calc(3px + (100% - 6px) * ${frac.toFixed(4)})`;
        }
      } else if (!r.cmdTick.hidden) {
        setText(r.delta, '');
        r.cmdTick.hidden = true;
        r.shownCmd = NaN;
      }
    }
  };

  const renderSummary = () => {
    const sel = app.selection;
    selFindings.replaceChildren();
    if (!sel) {
      setText(selName, 'Nothing selected');
      setText(selMeta, 'Click a part or joint marker in the viewport, or a joint below.');
      return;
    }
    if (sel.kind === 'joint') {
      const def = JOINTS[sel.id];
      const a = app.alerts.joint.get(sel.id)!;
      const tel = app.store.joints.get(sel.id)!;
      setText(selName, sel.id);
      const side = def.side === 'C' ? 'centre' : def.side === 'L' ? 'left side' : 'right side';
      setText(selMeta, `${SUBSYSTEMS.find((s) => s.id === def.subsystem)!.label}, ${side}, ${app.store.frames ? LEVEL_NAME[a.level] : 'no data'}`);
      const facts = h(
        'li',
        { class: 'finding-facts num' },
        `${fixed(tel.temp, 1)} °C, ${fixed(tel.current, 2)} A, ${fixed(tel.torque, 1)} of ${def.ratedTorque} N·m`,
      );
      selFindings.append(facts);
      for (const f of a.findings) {
        selFindings.append(h('li', { 'data-level': LEVEL_NAME[f.level], class: 'num' }, `${f.metric} ${fixed(f.value, 1)} ${f.unit}, limit ${fixed(f.limit, 1)} ${f.unit}`));
      }
    } else {
      const s = SUBSYSTEMS.find((x) => x.id === sel.id)!;
      const lvl = app.alerts.subsystem.get(sel.id) ?? 0;
      setText(selName, s.label);
      const joints = jointsOf(sel.id);
      setText(selMeta, `${joints.length} joints, ${app.store.frames ? LEVEL_NAME[lvl] : 'no data'}`);
      for (const j of joints) {
        for (const f of app.alerts.joint.get(j.id)!.findings) {
          selFindings.append(h('li', { 'data-level': LEVEL_NAME[f.level], class: 'num' }, `${j.id} ${f.metric} ${fixed(f.value, 1)} ${f.unit}`));
        }
      }
    }
  };

  const renderStatus = () => {
    jointBlocks.forEach(({ mark }, id) => setAttr(mark, 'data-level', LEVEL_NAME[app.alerts.joint.get(id)!.level]));
    groupHeads.forEach(({ mark, word }, id) => {
      const lvl = app.alerts.subsystem.get(id) ?? 0;
      setAttr(mark, 'data-level', LEVEL_NAME[lvl]);
      setText(word, app.store.frames ? LEVEL_NAME[lvl] : '');
    });
  };

  const renderSelection = () => {
    const sel = app.selection;
    jointBlocks.forEach(({ block }, id) => setAttr(block, 'data-selected', sel?.kind === 'joint' && sel.id === id ? 'true' : null));
    groupHeads.forEach(({ head }, id) => setAttr(head, 'aria-pressed', String(sel?.kind === 'subsystem' && sel.id === id)));
    // Sticky group heads confuse scrollIntoView, so scroll the list ourselves.
    const target = sel?.kind === 'joint' ? jointBlocks.get(sel.id)?.block : sel?.kind === 'subsystem' ? groupHeads.get(sel.id)?.head.parentElement : null;
    if (target && !target.contains(document.activeElement)) {
      const headH = 28;
      const top = target.offsetTop - (sel?.kind === 'joint' ? headH : 0);
      const bottom = target.offsetTop + target.offsetHeight;
      const view = list.scrollTop;
      const viewH = list.clientHeight;
      let next: number | null = null;
      if (sel?.kind === 'subsystem' || top < view) next = top;
      else if (bottom > view + viewH) next = Math.min(top, bottom - viewH);
      // Instant: smooth scrolling gets cancelled by the 10 Hz summary re-render changing the list height.
      if (next !== null) list.scrollTop = next;
    }
    renderSummary();
  };

  const renderMode = () => {
    const text =
      app.mode === 'manual'
        ? 'Manual. Sliders drive the twin directly, clamped to joint limits.'
        : app.mode === 'live'
          ? 'Live. Sliders follow telemetry; the tick marks the commanded angle and the right column is commanded minus measured. Moving a slider switches to Manual.'
          : 'Playback. Sliders follow the clip. Moving a slider switches to Manual.';
    setText(modeHint, text);
    host.dataset.mode = app.mode;
  };

  app.bus.on('frame', renderValues);
  app.bus.on('tick', () => {
    renderStatus();
    renderSummary();
  });
  app.bus.on('selection', renderSelection);
  app.bus.on('mode', renderMode);
  window.addEventListener('pointerup', () => (dragging = null));

  renderMode();
  renderSelection();
  renderValues();
}
