import type { App, Mode } from '../app';
import type { LinkStatus } from '../telemetry/types';
import { clockTime, duration, h, setAttr, setText } from './dom';

const MODES: { id: Mode; label: string; key: string }[] = [
  { id: 'live', label: 'Live', key: '1' },
  { id: 'manual', label: 'Manual', key: '2' },
  { id: 'playback', label: 'Playback', key: '3' },
];

function linkLevel(s: LinkStatus): 'ok' | 'warn' | 'fault' | 'idle' {
  if (s.state === 'connected') return 'ok';
  if (s.state === 'connecting' || s.state === 'stale') return 'warn';
  if (s.state === 'idle') return 'idle';
  return 'fault';
}

export function mountTopBar(host: HTMLElement, app: App): void {
  const linkState = h('span', { class: 'link-state' });
  const linkRate = h('span', { class: 'num link-rate' });
  const indicator = h('span', { class: 'indicator', 'aria-hidden': 'true' });
  const sourceSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Telemetry source' },
    h('option', { value: 'simulated', text: 'Simulated' }),
    h('option', { value: 'websocket', text: 'WebSocket' }),
  );
  sourceSelect.value = app.source.kind;
  sourceSelect.addEventListener('change', () => app.switchSource(sourceSelect.value as 'simulated' | 'websocket'));

  const modeButtons = MODES.map((m) =>
    h('button', {
      class: 'seg-btn',
      type: 'button',
      'data-mode': m.id,
      title: `${m.label} (${m.key})`,
      onclick: () => app.setMode(m.id),
      text: m.label,
    }),
  );
  const modeGroup = h('div', { class: 'seg', role: 'group', 'aria-label': 'Mode' }, ...modeButtons);

  const clock = h('span', { class: 'num clock' });
  const uptime = h('span', { class: 'num muted uptime', title: 'Session time' });

  host.append(
    h('div', { class: 'brand' }, h('span', { class: 'brand-name', text: 'worker_bot' }), h('span', { class: 'brand-sub', text: 'digital twin' })),
    h('div', { class: 'topbar-group' }, h('span', { class: 'label', text: 'Link' }), indicator, linkState, linkRate, sourceSelect),
    h('div', { class: 'topbar-group' }, h('span', { class: 'label', text: 'Mode' }), modeGroup),
    h('div', { class: 'topbar-group topbar-clock' }, clock, uptime),
  );

  const renderLink = () => {
    const s = app.source.status;
    const lvl = linkLevel(s);
    setAttr(indicator, 'data-level', lvl);
    const word = s.state === 'connected' ? (app.source.kind === 'simulated' ? 'Simulated' : app.source.label) : s.state[0]!.toUpperCase() + s.state.slice(1);
    setText(linkState, word);
    linkState.title = s.detail;
    sourceSelect.value = app.source.kind;
  };

  const renderMode = () => {
    for (const b of modeButtons) setAttr(b, 'aria-pressed', String(b.dataset.mode === app.mode));
  };

  const renderClock = () => {
    setText(clock, clockTime(new Date()));
    setText(uptime, `T+${duration((Date.now() - app.startedAt) / 1000)}`);
    setText(linkRate, app.source.status.state === 'connected' ? `${app.store.rateHz} Hz` : '');
  };

  app.bus.on('link', renderLink);
  app.bus.on('source', renderLink);
  app.bus.on('mode', renderMode);
  app.bus.on('tick', renderClock);

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, select, textarea')) return;
    const m = MODES.find((x) => x.key === e.key);
    if (m) app.setMode(m.id);
  });

  renderLink();
  renderMode();
  renderClock();
}
