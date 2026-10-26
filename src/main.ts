import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import * as THREE from 'three';
import { App } from './app';
import { h } from './ui/dom';
import { mountAnimationPanel } from './ui/animation-panel';
import { mountInspector } from './ui/inspector';
import { mountTelemetryTable } from './ui/telemetry-table';
import { mountTopBar } from './ui/topbar';
import { mountTrendsPanel } from './ui/trends-panel';
import { mountViewportOverlay } from './ui/viewport-overlay';

function luminance(c: THREE.Color): number {
  // Color stores linear components, which is what WCAG luminance wants.
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function contrast(a: THREE.Color, b: THREE.Color): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The sampled red is used as-is for fills; text and thin lines get a lifted variant that clears AA on the panel colour. */
function applyAccentTokens(hex: string): void {
  const base = new THREE.Color(hex);
  const panel = new THREE.Color('#17191C');
  const text = base.clone();
  const hsl = { h: 0, s: 0, l: 0 };
  text.getHSL(hsl);
  for (let i = 0; i < 30 && contrast(text, panel) < 4.6; i++) {
    hsl.l = Math.min(0.85, hsl.l + 0.02);
    text.setHSL(hsl.h, hsl.s, hsl.l);
  }
  const root = document.documentElement.style;
  root.setProperty('--accent', '#' + base.getHexString(THREE.SRGBColorSpace));
  root.setProperty('--accent-text', '#' + text.getHexString(THREE.SRGBColorSpace));
  const srgb = { r: 0, g: 0, b: 0 };
  base.getRGB(srgb, THREE.SRGBColorSpace);
  root.setProperty('--accent-wash', `rgb(${Math.round(srgb.r * 255)} ${Math.round(srgb.g * 255)} ${Math.round(srgb.b * 255)} / 0.14)`);
}

const appRoot = document.getElementById('app')!;
const topbar = h('header', { class: 'topbar' });
const stage = h('main', { class: 'stage', 'aria-label': 'Viewport' });
const inspector = h('aside', { class: 'inspector', 'aria-label': 'Joint inspector' });
const playback = h('section', { 'aria-label': 'Playback' });
const table = h('section', { 'aria-label': 'Joint telemetry' });
const trends = h('section', { 'aria-label': 'Trends and events' });
const dock = h('div', { class: 'dock' }, playback, table, trends);
appRoot.append(h('div', { class: 'shell' }, topbar, stage, inspector, dock));

const app = new App(stage);
app.bus.on('accent', (hex) => {
  applyAccentTokens(hex);
});

mountTopBar(topbar, app);
mountViewportOverlay(stage, app);
mountInspector(inspector, app);
mountAnimationPanel(playback, app);
mountTelemetryTable(table, app);
mountTrendsPanel(trends, app);

app.start();

// Exposed for console debugging.
(window as unknown as { twin: App }).twin = app;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    app.dispose();
    appRoot.replaceChildren();
  });
}
