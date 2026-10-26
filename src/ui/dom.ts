type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
type Child = Node | string | number | null | undefined | false;

/** Minimal element factory. `on*` keys become listeners, `class` and `text` are shorthands. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Write text only when it changed; most readouts update at 10 Hz and rarely change every tick. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function fixed(v: number, digits: number, width = 0): string {
  if (!Number.isFinite(v)) return '–';
  // Avoid "-0.0" flicker around zero.
  const s = (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits);
  return width ? s.padStart(width, ' ') : s;
}

export function signed(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '–';
  const r = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return (r > 0 ? '+' : r < 0 ? '−' : '\u2007') + Math.abs(r).toFixed(digits);
}

export function clockTime(d: Date, ms = false): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return ms ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

export function duration(seconds: number): string {
  const s = Math.floor(seconds);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
