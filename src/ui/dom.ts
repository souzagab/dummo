// Minimal DOM helpers and form controls.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function icon(name: keyof typeof ICONS, size = 18): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return wrap.firstChild as SVGSVGElement;
}

export const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  share: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  focus: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  mirror: '<path d="M12 3v18"/><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  figure: '<circle cx="12" cy="4.5" r="2.5"/><path d="M12 7v7M7 10h10M9 22l3-8 3 8"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
} as const;

export type Control<T> = { el: HTMLElement; set: (v: T) => void };

export function slider(opts: {
  label: string; min: number; max: number; step: number; value: number; unit?: string; digits?: number;
  hint?: string; format?: (v: number) => string; onInput: (v: number) => void; onCommit?: () => void;
}): Control<number> {
  const digits = opts.digits ?? (opts.step < 0.1 ? 2 : opts.step < 1 ? 1 : 0);
  const range = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value, 'aria-label': opts.label });
  const num = h('input', { type: 'number', min: opts.min, max: opts.max, step: opts.step, value: opts.value.toFixed(digits), class: 'num', 'aria-label': `${opts.label} value` });
  const fill = () => {
    const t = ((Number(range.value) - opts.min) / (opts.max - opts.min)) * 100;
    range.style.setProperty('--fill', `${Math.max(0, Math.min(100, t))}%`);
  };
  range.addEventListener('input', () => {
    num.value = Number(range.value).toFixed(digits);
    fill();
    opts.onInput(Number(range.value));
  });
  range.addEventListener('change', () => opts.onCommit?.());
  num.addEventListener('change', () => {
    const v = Math.min(opts.max, Math.max(opts.min, Number(num.value) || 0));
    range.value = String(v);
    num.value = v.toFixed(digits);
    fill();
    opts.onInput(v);
    opts.onCommit?.();
  });
  fill();
  const readout = opts.format ? h('span', { class: 'readout' }, opts.format(opts.value)) : null;
  if (readout) range.addEventListener('input', () => { readout.textContent = opts.format!(Number(range.value)); });
  const el = h('label', { class: 'control slider', title: opts.hint ?? '' },
    h('span', { class: 'control-head' }, h('span', { class: 'control-label' }, opts.label),
      readout ?? h('span', { class: 'control-value' }, num, opts.unit ? h('span', { class: 'unit' }, opts.unit) : null)),
    range);
  return {
    el,
    set: (v: number) => {
      if (document.activeElement === range || document.activeElement === num) return;
      range.value = String(v);
      num.value = v.toFixed(digits);
      if (readout) readout.textContent = opts.format!(v);
      fill();
    },
  };
}

export function segmented<T extends string>(opts: { label?: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }): Control<T> {
  const buttons = opts.options.map((o) => h('button', { type: 'button', class: 'seg', 'data-v': o.value, onclick: () => opts.onChange(o.value) }, o.label));
  const set = (v: T) => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  set(opts.value);
  const el = h('div', { class: 'control' }, opts.label ? h('span', { class: 'control-label' }, opts.label) : null, h('div', { class: 'segmented', role: 'group' }, ...buttons));
  return { el, set };
}

export function toggle(opts: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }): Control<boolean> {
  const input = h('input', { type: 'checkbox' });
  input.checked = opts.value;
  input.addEventListener('change', () => opts.onChange(input.checked));
  const el = h('label', { class: 'control toggle', title: opts.hint ?? '' }, h('span', { class: 'control-label' }, opts.label), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
  return { el, set: (v) => { input.checked = v; } };
}

export function select<T extends string>(opts: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }): Control<T> {
  const sel = h('select', { 'aria-label': opts.label }, ...opts.options.map((o) => h('option', { value: o.value }, o.label)));
  sel.value = opts.value;
  sel.addEventListener('change', () => opts.onChange(sel.value as T));
  const el = h('label', { class: 'control select' }, h('span', { class: 'control-label' }, opts.label), sel);
  return { el, set: (v) => { sel.value = v; } };
}

export function colorPick(opts: { label: string; value: string; swatches: string[]; onChange: (v: string) => void }): Control<string> {
  const input = h('input', { type: 'color', value: opts.value, 'aria-label': opts.label });
  input.addEventListener('input', () => opts.onChange(input.value));
  const sw = opts.swatches.map((c) => h('button', { type: 'button', class: 'swatch', style: { background: c }, title: c, 'aria-label': c, onclick: () => { input.value = c; opts.onChange(c); } }));
  const el = h('div', { class: 'control color' }, h('span', { class: 'control-label' }, opts.label), h('div', { class: 'swatches' }, ...sw, input));
  return { el, set: (v) => { input.value = v; } };
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, h('h3', {}, title), ...children);
}

export function details(title: string, open: boolean, ...children: Child[]): HTMLDetailsElement {
  const d = h('details', { class: 'card' }, h('summary', {}, title), ...children);
  d.open = open;
  return d;
}

export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts') ?? document.body.appendChild(h('div', { id: 'toasts' }));
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  host.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

export function download(name: string, data: Uint8Array | string, mime: string): void {
  const blob = new Blob([typeof data === 'string' ? data : (data as BlobPart)], { type: mime });
  const url = URL.createObjectURL(blob);
  const save = () => {
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  };
  // browsers hold downloads that start long after the click (slow exports): ask for a click
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (!ua || ua.isActive) save();
  else readyToast(name, blob.size, save);
}

function readyToast(name: string, size: number, save: () => void): void {
  const host = document.getElementById('toasts') ?? document.body.appendChild(h('div', { id: 'toasts' }));
  const mb = size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1e3)} kB`;
  const t = h('div', { class: 'toast ready', role: 'status' });
  t.append(
    h('span', {}, `${name} is ready (${mb})`),
    h('button', { type: 'button', class: 'btn small', onclick: () => { save(); t.remove(); } }, 'Save file'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('close', 14)),
  );
  host.append(t);
}
