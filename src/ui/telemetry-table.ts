import type { App } from '../app';
import { JOINT_IDS, JOINTS, type JointId, type Thresholds } from '../config';
import { LEVEL_NAME } from '../telemetry/alerts';
import { fixed, h, setAttr, setText, signed } from './dom';

interface Row {
  id: JointId;
  tr: HTMLTableRowElement;
  x: HTMLElement;
  y: HTMLElement;
  z: HTMLElement;
  vel: HTMLElement;
  temp: HTMLElement;
  cur: HTMLElement;
  tq: HTMLElement;
  err: HTMLElement;
}

function bandLevel(v: number, warn: number, fault: number): string | null {
  if (!Number.isFinite(v)) return null;
  return v >= fault ? 'fault' : v >= warn ? 'warning' : null;
}

export function mountTelemetryTable(host: HTMLElement, app: App): void {
  const rows: Row[] = [];
  const cols: [string, string][] = [
    ['Joint', ''],
    ['X', '°'],
    ['Y', '°'],
    ['Z', '°'],
    ['ω', '°/s'],
    ['Temp', '°C'],
    ['Current', 'A'],
    ['Torque', 'N·m'],
    ['Cmd Δ', '°'],
  ];
  const thead = h(
    'thead',
    {},
    h(
      'tr',
      {},
      ...cols.map(([name, unit], i) =>
        h('th', { scope: 'col', class: `${i === 0 ? 'col-name' : 'col-num'}${name.length === 1 && name !== name.toUpperCase() ? ' th-symbol' : ''}` }, name, unit ? h('span', { class: 'unit', text: ` ${unit}` }) : null),
      ),
    ),
  );
  const tbody = h('tbody');
  const rateEl = h('span', { class: 'num muted' });
  const unknownEl = h('span', { class: 'num state-warn', hidden: true });

  for (const id of JOINT_IDS) {
    const td = () => h('td', { class: 'num col-num' });
    const r: Row = { id, tr: h('tr', { tabindex: 0, 'data-joint': id }), x: td(), y: td(), z: td(), vel: td(), temp: td(), cur: td(), tq: td(), err: td() };
    const name = h('td', { class: 'col-name' }, h('span', { class: 'status-mark', 'aria-hidden': 'true' }), h('span', { class: 'num', text: id }));
    r.tr.append(name, r.x, r.y, r.z, r.vel, r.temp, r.cur, r.tq, r.err);
    const pick = () => app.select({ kind: 'joint', id });
    r.tr.addEventListener('click', pick);
    r.tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    tbody.append(r.tr);
    rows.push(r);
  }

  const table = h('table', { class: 'data-table' }, thead, tbody);
  host.append(
    h('div', { class: 'panel-head' }, h('h2', { class: 'label', text: 'Joint telemetry' }), rateEl, unknownEl),
    h('div', { class: 'table-scroll' }, table),
  );

  const render = () => {
    const t: Thresholds = app.alerts.thresholds;
    const live = app.mode === 'live';
    for (const r of rows) {
      const j = app.store.joints.get(r.id)!;
      const def = JOINTS[r.id];
      const has = j.seen;
      setText(r.x, has ? signed(j.angle[0], 1) : '–');
      setText(r.y, has ? signed(j.angle[1], 1) : '–');
      setText(r.z, has ? signed(j.angle[2], 1) : '–');
      setText(r.vel, has ? fixed(j.vel, 1) : '–');
      setText(r.temp, fixed(j.temp, 1));
      setText(r.cur, fixed(j.current, 2));
      setText(r.tq, fixed(j.torque, 1));
      setText(r.err, j.trackErr === null ? '–' : fixed(j.trackErr, 2));
      setAttr(r.temp, 'data-level', bandLevel(j.temp, t.temp_c.warn, t.temp_c.fault));
      setAttr(r.cur, 'data-level', bandLevel(j.current, t.current_a.warn, t.current_a.fault));
      setAttr(r.tq, 'data-level', bandLevel(Math.abs(j.torque) / def.ratedTorque, t.torque_ratio.warn, t.torque_ratio.fault));
      setAttr(r.err, 'data-level', j.trackErr === null ? null : bandLevel(j.trackErr, t.tracking_deg.warn, t.tracking_deg.fault));
      setAttr(r.err, 'data-dim', live ? null : 'true');
      const lvl = app.alerts.joint.get(r.id)!.level;
      setAttr(r.tr.querySelector('.status-mark')!, 'data-level', LEVEL_NAME[lvl]);
    }
    setText(rateEl, app.store.frames ? `${app.store.rateHz} Hz, ${app.store.frames.toLocaleString('en-US')} frames` : 'waiting for frames');
    const unknown = app.store.unknownKeys;
    unknownEl.hidden = unknown.size === 0;
    if (unknown.size) setText(unknownEl, `unknown keys: ${[...unknown].slice(0, 3).join(', ')}${unknown.size > 3 ? '…' : ''}`);
  };

  const renderSelection = () => {
    const sel = app.selection;
    for (const r of rows) {
      const on = sel?.kind === 'joint' ? sel.id === r.id : sel?.kind === 'subsystem' ? JOINTS[r.id].subsystem === sel.id : false;
      setAttr(r.tr, 'aria-selected', on ? 'true' : null);
      if (on && sel?.kind === 'joint' && document.activeElement !== r.tr) r.tr.scrollIntoView({ block: 'nearest' });
    }
  };

  app.bus.on('tick', render);
  app.bus.on('selection', renderSelection);
  render();
}
