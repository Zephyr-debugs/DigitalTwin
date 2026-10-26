import type { App, LogEntry } from '../app';
import { JOINT_IDS, JOINTS, type JointId } from '../config';
import { HISTORY_SECONDS } from '../telemetry/store';
import { LineChart } from './chart';
import { clockTime, h, setAttr, setText } from './dom';

const LEVEL_TAG = ['info', 'warn', 'fault'] as const;
const MAX_ROWS = 200;

function cssVar(n: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

export function mountTrendsPanel(host: HTMLElement, app: App): void {
  const tabTrends = h('button', { class: 'tab', role: 'tab', type: 'button', id: 'tab-trends', 'aria-controls': 'pane-trends', text: 'Trends' });
  const eventCount = h('span', { class: 'num tab-count' });
  const tabEvents = h('button', { class: 'tab', role: 'tab', type: 'button', id: 'tab-events', 'aria-controls': 'pane-events' }, 'Events', eventCount);
  const focusLabel = h('span', { class: 'num muted trends-focus' });

  const t = app.alerts.thresholds;
  const temp = new LineChart({ title: 'Motor temp', unit: '°C', digits: 1, minSpan: 6, thresholds: [{ value: t.temp_c.warn, level: 'warn' }, { value: t.temp_c.fault, level: 'fault' }] });
  const current = new LineChart({ title: 'Current', unit: 'A', digits: 2, minSpan: 0.5, thresholds: [{ value: t.current_a.warn, level: 'warn' }] });
  const angle = new LineChart({ title: 'Angle XYZ', unit: '°', digits: 0, minSpan: 10 });
  const battery = new LineChart({ title: 'Battery', unit: '%', digits: 1, minSpan: 2, thresholds: [{ value: t.battery_pct.warn, level: 'warn' }] });
  const latency = new LineChart({ title: 'Link latency', unit: 'ms', digits: 0, minSpan: 10, thresholds: [{ value: t.latency_ms.warn, level: 'warn' }, { value: t.latency_ms.fault, level: 'fault' }] });
  const load = new LineChart({ title: 'Controller load', unit: '%', digits: 0, range: [0, 100], thresholds: [{ value: t.controller_load_pct.warn, level: 'warn' }] });
  const charts = [temp, current, angle, battery, latency, load];

  const paneTrends = h(
    'div',
    { class: 'pane', role: 'tabpanel', id: 'pane-trends', 'aria-labelledby': 'tab-trends' },
    h('div', { class: 'chart-grid' }, ...charts.map((c) => c.el)),
  );

  const warnOnly = h('input', { type: 'checkbox', id: 'log-warn-only' });
  const logList = h('ol', { class: 'log', 'aria-live': 'off' });
  const paneEvents = h(
    'div',
    { class: 'pane', role: 'tabpanel', id: 'pane-events', 'aria-labelledby': 'tab-events', hidden: true },
    h('div', { class: 'log-tools' }, h('label', { class: 'check' }, warnOnly, h('span', { text: 'Warnings and faults only' }))),
    h('div', { class: 'log-scroll' }, logList),
  );

  host.append(
    h('div', { class: 'panel-head' }, h('div', { class: 'tabs', role: 'tablist' }, tabTrends, tabEvents), focusLabel),
    paneTrends,
    paneEvents,
  );

  let active: 'trends' | 'events' = 'trends';
  const setTab = (tab: 'trends' | 'events') => {
    active = tab;
    setAttr(tabTrends, 'aria-selected', String(tab === 'trends'));
    setAttr(tabEvents, 'aria-selected', String(tab === 'events'));
    tabTrends.tabIndex = tab === 'trends' ? 0 : -1;
    tabEvents.tabIndex = tab === 'events' ? 0 : -1;
    paneTrends.hidden = tab !== 'trends';
    paneEvents.hidden = tab !== 'events';
    focusLabel.hidden = tab !== 'trends';
    if (tab === 'trends') drawCharts();
  };
  tabTrends.addEventListener('click', () => setTab('trends'));
  tabEvents.addEventListener('click', () => setTab('events'));
  for (const tab of [tabTrends, tabEvents]) {
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = active === 'trends' ? 'events' : 'trends';
      setTab(next);
      (next === 'trends' ? tabTrends : tabEvents).focus();
    });
  }

  /** Charts follow the selected joint; otherwise the worst, then hottest, joint (within a selected subsystem). */
  const focusJoint = (): JointId => {
    const sel = app.selection;
    if (sel?.kind === 'joint') return sel.id;
    let best: JointId = 'upper_arm.L';
    let bestScore = -1;
    for (const id of JOINT_IDS) {
      if (sel?.kind === 'subsystem' && JOINTS[id].subsystem !== sel.id) continue;
      const a = app.alerts.joint.get(id)!;
      const tempNow = app.store.joints.get(id)!.temp;
      const score = a.level * 1000 + (Number.isFinite(tempNow) ? tempNow : 0);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  };

  const colors = () => ({ a: cssVar('--text'), b: cssVar('--muted'), c: cssVar('--accent') });

  let lastFocus: JointId | null = null;
  const drawCharts = () => {
    if (active !== 'trends') return;
    const id = focusJoint();
    const hist = app.store.history.get(id)!;
    const c = colors();
    if (id !== lastFocus) {
      lastFocus = id;
      setText(focusLabel, `${id}${app.selection?.kind === 'joint' ? '' : ' (auto)'}, last ${HISTORY_SECONDS} s`);
    }
    temp.setSeries([{ buf: hist.temp, color: c.c, name: 'temp' }]);
    current.setSeries([{ buf: hist.current, color: c.a, name: 'current' }]);
    angle.setSeries([
      { buf: hist.ax, color: c.a, name: 'x' },
      { buf: hist.ay, color: c.b, name: 'y' },
      { buf: hist.az, color: c.c, name: 'z' },
    ]);
    battery.setSeries([{ buf: app.store.systemHistory.battery, color: c.a, name: 'battery' }]);
    latency.setSeries([{ buf: app.store.systemHistory.latency, color: c.a, name: 'latency' }]);
    load.setSeries([{ buf: app.store.systemHistory.load, color: c.a, name: 'load' }]);
    for (const ch of charts) ch.draw();
  };

  // ---- event log ----
  let warnCount = 0;
  const renderEntry = (e: LogEntry): HTMLElement =>
    h(
      'li',
      { class: 'log-row', 'data-level': LEVEL_TAG[e.level] },
      h('span', { class: 'num log-time', text: clockTime(e.time, true) }),
      h('span', { class: 'log-level', text: LEVEL_TAG[e.level] }),
      h('span', { class: 'num log-source', text: e.source }),
      h('span', { class: 'log-msg', text: e.message }),
    );

  const rebuildLog = () => {
    logList.replaceChildren();
    const entries = app.logEntries.filter((e) => !warnOnly.checked || e.level > 0).slice(-MAX_ROWS).reverse();
    for (const e of entries) logList.append(renderEntry(e));
  };

  app.bus.on('log', (e) => {
    if (e.level > 0) {
      warnCount++;
      setText(eventCount, String(warnCount));
    }
    if (warnOnly.checked && e.level === 0) return;
    logList.prepend(renderEntry(e));
    while (logList.childElementCount > MAX_ROWS) logList.lastElementChild?.remove();
  });
  warnOnly.addEventListener('change', rebuildLog);

  app.bus.on('tick', drawCharts);
  app.bus.on('selection', () => {
    lastFocus = null;
    drawCharts();
  });
  app.bus.on('accent', () => charts.forEach((c) => c.readColors()));

  rebuildLog();
  setTab('trends');
}
