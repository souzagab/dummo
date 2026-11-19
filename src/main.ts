import './style.css';
import { Box3, Matrix4, Vector3 } from 'three';
import { Store, specFromFile, type AppState } from './app/state.ts';
import { partList, restGround, skinActive, type PartDef } from './core/catalog.ts';
import { autoFit, ghostMatrix, parseModel, restoreModel, storeModel } from './app/models.ts';
import type { SkinModel } from './core/skinctx.ts';
import { escapeXml, slug, stlBinary, threeMF, zip, type TmfItem, type TmfObject } from './core/export.ts';
import { packPlates, placementMatrix, prepareForPrint, type Prepared } from './core/layout.ts';
import { buildRig, clampPose, type Rig } from './core/skeleton.ts';
import type { FigureSpec, MeshData, PartGroup } from './core/types.ts';
import { download, h, icon, toast } from './ui/dom.ts';
import { buildPanel, type PartStat } from './ui/panel.ts';
import { Viewer, type PlateView } from './viewer/viewer.ts';
import { GeometryClient } from './worker/client.ts';
import { strToU8 } from 'fflate';

const PREVIEW_SEGMENTS = 36;
const EXPORT_SEGMENTS: Record<AppState['view']['quality'], number> = { draft: 40, normal: 72, fine: 112 };
const ACCESSORY_COLOR = '#9a9286';

const store = new Store();

// ---------- layout ----------
const statusText = h('span', { class: 'status-text' }, 'Starting…');
const statusBar = h('span', { class: 'status-bar' });
const status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'status-track' }, statusBar), statusText);
const undoBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => store.undo() }, icon('undo'));
const redoBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: () => store.redo() }, icon('redo'));
const panelBtn = h('button', {
  type: 'button', class: 'icon-btn panel-toggle', title: 'Toggle panel', 'aria-label': 'Toggle panel',
  onclick: () => store.update({ view: { ...store.state.view, panelOpen: !store.state.view.panelOpen } }),
}, icon('menu'));

const header = h('header', { class: 'topbar' },
  h('div', { class: 'brand' }, logo(), h('span', { class: 'wordmark' }, 'dummo'), h('span', { class: 'tagline' }, 'articulated figure maker')),
  h('div', { class: 'top-actions' },
    undoBtn, redoBtn,
    h('button', { type: 'button', class: 'icon-btn', title: 'Copy a share link', 'aria-label': 'Share link', onclick: share }, icon('share')),
    h('button', { type: 'button', class: 'icon-btn', title: 'Save a screenshot', 'aria-label': 'Screenshot', onclick: screenshot }, icon('camera')),
    panelBtn,
  ),
);

const panel = h('aside', { class: 'panel', 'aria-label': 'Controls' });
const viewport = h('div', { class: 'viewport' });

const modeBtns = (['figure', 'plates'] as const).map((m) => h('button', {
  type: 'button', class: 'seg', 'data-v': m, onclick: () => store.update({ view: { ...store.state.view, mode: m } }),
}, icon(m === 'figure' ? 'figure' : 'grid', 15), h('span', {}, m === 'figure' ? 'Figure' : 'Print plates')));
const dispToggle = (key: 'armor' | 'frame' | 'outlines' | 'stand', label: string) => h('button', {
  type: 'button', class: 'pill', 'data-k': key,
  onclick: () => {
    const v = store.state.view;
    store.update({ view: { ...v, display: { ...v.display, [key]: !v.display[key] } } });
  },
}, label);
const explode = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Exploded view', class: 'mini-range' });
const explodeFill = () => explode.style.setProperty('--fill', `${Number(explode.value) * 100}%`);
explodeFill();
explode.addEventListener('input', () => {
  explodeFill();
  const v = store.state.view;
  store.update({ view: { ...v, display: { ...v.display, explode: Number(explode.value) } } });
});
const figureTools = h('div', { class: 'overlay-group figure-only' },
  dispToggle('armor', 'Armor'), dispToggle('frame', 'Frame'), dispToggle('outlines', 'Lines'), dispToggle('stand', 'Stand'),
  h('label', { class: 'pill range-pill', title: 'Exploded view' }, 'Explode', explode),
);
const overlay = h('div', { class: 'overlay' },
  h('div', { class: 'segmented compact' }, ...modeBtns),
  figureTools,
  h('button', { type: 'button', class: 'icon-btn floating', title: 'Frame the view (F)', 'aria-label': 'Frame view', onclick: () => refitView() }, icon('focus')),
);
viewport.append(overlay, status);

const app = document.getElementById('app')!;
app.append(header, h('main', { class: 'layout' }, panel, viewport));

// ---------- engine ----------
const viewer = new Viewer(viewport);
const preview = new GeometryClient();
let exporter: GeometryClient | null = null;
let model: SkinModel | null = null;
let restoring = true;
preview.onError = (m) => toast(`Geometry error: ${m}`, 'error');
preview.onSkin = (state, ms) => {
  if (state === 'building') setStatus('Fitting the skin to the frame…', 0.15);
  else if (state === 'missing' && !restoring) toast('The skin model is not loaded in this browser. Load it again in the Skin tab.', 'error');
  else if (ms !== undefined && ms > 0) setStatus(`Skin field ready (${(ms / 1000).toFixed(1)} s), building pieces…`, 0.3);
};

/** Live preview uses a coarser skin than exports. */
function previewSpec(spec: FigureSpec): FigureSpec {
  if (!skinActive(spec)) return spec;
  return { ...spec, skin: { ...spec.skin, detail: Math.max(spec.skin.detail, 0.7) } };
}

let rig: Rig = buildRig(store.state.spec);
let parts: PartDef[] = partList(store.state.spec);
const meshes = new Map<string, MeshData | null>();
let builtSpec = '';
let rebuildTimer = 0;
let building = false;
let lastFramedHeight = 0;
const prepCache = new Map<string, Prepared>();

viewer.onSelect = (node) => store.update({ view: { ...store.state.view, selected: node, tab: node ? 'pose' : store.state.view.tab } });

function geometryKey(spec: FigureSpec): string {
  return JSON.stringify({ ...spec, name: '' });
}

function applySpec(spec: FigureSpec): void {
  rig = buildRig(spec);
  parts = partList(spec);
  viewer.setParts(parts, rig, spec.scale, restGround(spec));
  const key = geometryKey(spec);
  if (key === builtSpec) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => rebuild(spec, key), building ? 60 : 140);
}

async function rebuild(spec: FigureSpec, key: string): Promise<void> {
  building = true;
  setStatus('Building parts…', 0);
  const t0 = performance.now();
  try {
    const pspec = previewSpec(spec);
    const res = await preview.build(pspec, PREVIEW_SEGMENTS, {
      skinEdge: Math.max(pspec.skin.detail, 0.8),
      onPart: (k, mesh, done, total) => {
        meshes.set(k, mesh);
        viewer.setGeometry(k, mesh);
        setStatus(`Building parts ${done}/${total}`, done / total);
      },
    });
    builtSpec = key;
    prepCache.clear();
    const hgt = figureHeight();
    if (!lastFramedHeight || Math.abs(hgt - lastFramedHeight) / hgt > 0.1) {
      lastFramedHeight = hgt;
      if (store.state.view.mode === 'figure') viewer.frameFigure();
    }
    for (const [k, m] of res) meshes.set(k, m);
    building = false;
    const n = parts.filter((p) => p.group !== 'accessory' && meshes.get(p.key)).length;
    setStatus(`${n} parts · ${((performance.now() - t0) / 1000).toFixed(1)} s`, 1);
    refreshDerived();
  } catch (e) {
    if ((e as Error).message !== 'superseded') { building = false; toast(String((e as Error).message), 'error'); }
  }
}

function setStatus(text: string, progress: number): void {
  statusText.textContent = text;
  statusBar.style.width = `${Math.round(progress * 100)}%`;
  status.classList.toggle('busy', progress < 1);
}

// ---------- derived data ----------
function prepared(key: string, part: PartDef, source = meshes, cache = prepCache): Prepared | null {
  const m = source.get(key);
  if (!m) return null;
  const ck = `${key}`;
  let p = cache.get(ck);
  if (!p) { p = prepareForPrint(m, part.printRot); cache.set(ck, p); }
  return p;
}

function instancesFor(group: PartGroup | 'all', source = meshes): PartDef[] {
  return parts.filter((p) => (group === 'all' || p.group === group) && source.get(p.key) &&
    (p.group !== 'accessory' || p.key === 'weapon' || store.state.print.stand || group === 'accessory'));
}

function stats(): PartStat[] {
  const byKey = new Map<string, PartStat>();
  for (const p of parts) {
    const m = meshes.get(p.key);
    if (!m) continue;
    const s = byKey.get(p.key);
    if (s) { s.qty++; continue; }
    const pr = prepared(p.key, p)!;
    byKey.set(p.key, { key: p.key, label: p.label.replace(/ \((left|right)\)/, ''), group: p.group, qty: 1, w: pr.w, h: pr.h, d: pr.d, volume: m.volume });
  }
  const order = { frame: 0, armor: 1, accessory: 2 } as Record<string, number>;
  return [...byKey.values()].sort((a, b) => order[a.group] - order[b.group]);
}

function figureHeight(): number {
  const box = new Box3();
  const v = new Vector3();
  for (const p of parts) {
    if (p.group === 'accessory') continue;
    const m = meshes.get(p.key);
    if (!m) continue;
    const pos = m.positions;
    for (let i = 0; i < pos.length; i += 24) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(p.mount));
  }
  return box.isEmpty() ? 0 : box.max.y + restGround(store.state.spec);
}

type PlatePlan = { group: PartGroup; plates: { items: { part: PartDef; prep: Prepared; matrix: Matrix4 }[] }[]; oversize: string[] };

function planPlates(group: PartGroup, source: Map<string, MeshData | null>, cache: Map<string, Prepared>): PlatePlan {
  const list = instancesFor(group, source);
  const preps = new Map<string, Prepared>();
  for (const p of list) preps.set(p.key, prepared(p.key, p, source, cache)!);
  const { bedX, bedY, spacing } = store.state.print;
  const packed = packPlates(list.map((p) => ({ id: p.id, key: p.key, w: preps.get(p.key)!.w, h: preps.get(p.key)!.h })), bedX, bedY, spacing);
  const byId = new Map(list.map((p) => [p.id, p]));
  return {
    group,
    oversize: packed.oversize,
    plates: packed.plates.map((pl) => ({ items: pl.items.map((it) => ({ part: byId.get(it.id)!, prep: preps.get(it.key)!, matrix: placementMatrix(it) })) })),
  };
}

function refreshPlates(): void {
  if (store.state.view.mode !== 'plates') return;
  const views: PlateView[] = [];
  const groups = exportGroups();
  const names = { frame: 'Frame', armor: 'Armor', accessory: 'Extras' };
  for (const g of groups) {
    const plan = planPlates(g, meshes, prepCache);
    plan.plates.forEach((pl, i) => views.push({
      label: `${names[g]}${plan.plates.length > 1 ? ` ${i + 1}` : ''} · ${pl.items.length} parts`,
      bedX: store.state.print.bedX, bedY: store.state.print.bedY,
      items: pl.items.map((it) => ({ positions: it.prep.positions, indices: it.prep.indices, matrix: it.matrix, group: g })),
    }));
  }
  viewer.showPlates(views);
}

function refreshDerived(): void {
  refreshPlates();
  store.update({});
}

function exportGroups(): PartGroup[] {
  const extras = store.state.print.stand || !!meshes.get('weapon');
  return extras ? ['frame', 'armor', 'accessory'] : ['frame', 'armor'];
}

// ---------- exports ----------
function getExporter(): GeometryClient {
  if (!exporter) {
    exporter = new GeometryClient();
    exporter.onError = (m) => toast(`Export error: ${m}`, 'error');
    exporter.onSkin = (state) => { if (state === 'building') setStatus('Fitting the skin at full detail…', 0.1); };
    exporter.setModel(model);
  }
  return exporter;
}

async function exportMeshes(): Promise<Map<string, MeshData | null> | null> {
  const ex = getExporter();
  const segs = EXPORT_SEGMENTS[store.state.view.quality];
  setStatus('Preparing print files…', 0);
  try {
    return await ex.build(store.state.spec, segs, {
      skinEdge: store.state.spec.skin.detail,
      onPart: (_k, _m, d, t) => setStatus(`Preparing print files ${d}/${t}`, d / t),
    });
  } catch (e) {
    toast(String((e as Error).message), 'error');
    return null;
  }
}

function tmfForPlate(title: string, items: PlatePlan['plates'][number]['items']): Uint8Array {
  const { colors } = store.state;
  const palette = [colors.frame, colors.armor, ACCESSORY_COLOR];
  const objIndex = new Map<string, number>();
  const objects: TmfObject[] = [];
  const tItems: TmfItem[] = [];
  for (const it of items) {
    let idx = objIndex.get(it.part.key);
    if (idx === undefined) {
      idx = objects.length;
      objIndex.set(it.part.key, idx);
      objects.push({ name: it.part.key, positions: it.prep.positions, indices: it.prep.indices, color: it.part.group === 'frame' ? 0 : it.part.group === 'armor' ? 1 : 2 });
    }
    // build coordinates are relative to the bed's front-left corner
    tItems.push({ object: idx, transform: it.matrix });
  }
  return threeMF(title, palette, objects, tItems);
}

function groupFiles(group: PartGroup, source: Map<string, MeshData | null>, cache: Map<string, Prepared>): Record<string, Uint8Array> {
  const name = slug(store.state.spec.name);
  const plan = planPlates(group, source, cache);
  if (plan.oversize.length) toast(`${plan.oversize.length} part(s) are larger than the bed`, 'error');
  const files: Record<string, Uint8Array> = {};
  plan.plates.forEach((pl, i) => {
    const suffix = plan.plates.length > 1 ? `-plate${i + 1}` : '';
    files[`${name}-${group}${suffix}.3mf`] = tmfForPlate(`${store.state.spec.name} ${group}${suffix}`, pl.items);
  });
  return files;
}

function stlFiles(source: Map<string, MeshData | null>, cache: Map<string, Prepared>): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const counts = new Map<string, { part: PartDef; n: number }>();
  for (const p of instancesFor('all', source)) {
    const c = counts.get(p.key);
    if (c) c.n++; else counts.set(p.key, { part: p, n: 1 });
  }
  for (const [key, { part, n }] of counts) {
    const pr = prepared(key, part, source, cache)!;
    files[`${part.group}/${key}${n > 1 ? `_x${n}` : ''}.stl`] = stlBinary(pr.positions, pr.indices);
  }
  return files;
}

async function exportGroup(group: PartGroup): Promise<void> {
  const src = await exportMeshes();
  if (!src) return;
  const files = groupFiles(group, src, new Map());
  const names = Object.keys(files);
  if (names.length === 1) download(names[0], files[names[0]], 'model/3mf');
  else download(`${slug(store.state.spec.name)}-${group}-plates.zip`, zip(files), 'application/zip');
  setStatus(`Exported ${names.length} plate${names.length > 1 ? 's' : ''}`, 1);
}

async function exportStl(): Promise<void> {
  const src = await exportMeshes();
  if (!src) return;
  download(`${slug(store.state.spec.name)}-stl.zip`, zip(stlFiles(src, new Map())), 'application/zip');
  setStatus('Exported STL zip', 1);
}

async function exportAll(): Promise<void> {
  const src = await exportMeshes();
  if (!src) return;
  const cache = new Map<string, Prepared>();
  const files: Record<string, Uint8Array> = {};
  for (const g of exportGroups()) for (const [n, f] of Object.entries(groupFiles(g, src, cache))) files[`3mf/${n}`] = f;
  for (const [n, f] of Object.entries(stlFiles(src, cache))) files[`stl/${n}`] = f;
  files[`${slug(store.state.spec.name)}.dummo.json`] = strToU8(specJson());
  files['README.txt'] = strToU8(readme());
  download(`${slug(store.state.spec.name)}-dummo.zip`, zip(files), 'application/zip');
  setStatus('Exported everything', 1);
}

async function exportCalibration(): Promise<void> {
  const ex = getExporter();
  setStatus('Building test coupon…', 0.3);
  try {
    const res = await ex.build(store.state.spec, EXPORT_SEGMENTS.normal, { calibration: true });
    const items: PlatePlan['plates'][number]['items'] = [];
    const prepList: { key: string; prep: Prepared }[] = [];
    for (const [k, m] of res) if (m) prepList.push({ key: k, prep: prepareForPrint(m, new Matrix4()) });
    const packed = packPlates(prepList.map((p) => ({ id: p.key, key: p.key, w: p.prep.w, h: p.prep.h })), store.state.print.bedX, store.state.print.bedY, 6);
    for (const it of packed.plates[0]?.items ?? []) {
      const pr = prepList.find((p) => p.key === it.key)!;
      const fake: PartDef = { id: it.key, key: it.key, label: it.key, group: 'frame', node: 'world', mount: new Matrix4(), printRot: new Matrix4(), explode: null };
      items.push({ part: fake, prep: pr.prep, matrix: placementMatrix(it) });
    }
    download('dummo-fit-test.3mf', tmfForPlate('dummo fit test', items), 'model/3mf');
    setStatus('Exported fit test coupon', 1);
    toast('Notches mark the variants: 1 notch = loosest. Sockets 0.10 / 0.20 / 0.30 / 0.40 mm; clips 0.05 / 0.10 / 0.15 mm.');
  } catch (e) {
    toast(String((e as Error).message), 'error');
  }
}

function specJson(): string {
  const s = store.state;
  return JSON.stringify({ app: 'dummo', v: 1, spec: s.spec, pose: s.pose, print: s.print, colors: s.colors }, null, 2);
}

function readme(): string {
  const s = store.state.spec;
  return [
    `${s.name}: made with dummo`, '',
    `Scale ${(s.scale * 100).toFixed(0)}%, frame material preset: ${s.material}.`,
    'Fits (mm): ' + Object.entries(s.tolerances).map(([k, v]) => `${k} ${v}`).join(', '), '',
    'Print frame parts in PETG, ABS or ASA. Armor can be any material.',
    'All parts are already oriented for printing. No supports needed.', '',
    'Folders: 3mf/ = ready-made plates, stl/ = individual parts (_xN = print N copies).',
    'Open the .dummo.json file in dummo to keep editing this figure.',
  ].join('\n');
}

function saveSpec(): void {
  download(`${slug(store.state.spec.name)}.dummo.json`, specJson(), 'application/json');
}

async function loadSpec(f: File): Promise<void> {
  try {
    const patch = specFromFile(await f.text());
    store.update(patch, true);
    toast(`Loaded ${escapeXml(patch.spec?.name ?? 'design')}`);
  } catch {
    toast('That file is not a dummo design.', 'error');
  }
}

async function share(): Promise<void> {
  const url = store.shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied to the clipboard');
  } catch {
    window.prompt('Copy this link:', url);
  }
}

function screenshot(): void {
  const data = viewer.screenshot();
  const a = h('a', { href: data, download: `${slug(store.state.spec.name)}.png` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- character model ----------
function setModel(m: SkinModel | null): void {
  model = m;
  preview.setModel(m);
  exporter?.setModel(m);
  viewer.setGhost(m);
  syncGhost(store.state);
}

function syncGhost(s: AppState): void {
  const show = !!model && s.view.ghost.show && !(s.spec.skin.enabled && s.view.mode === 'figure' && !s.view.display.frame);
  viewer.setGhostView(ghostMatrix(s.spec.skin.transform), show && s.view.mode === 'figure', s.view.ghost.opacity);
}

function fitTransform(m: SkinModel, keepRot = false): FigureSpec['skin']['transform'] {
  const spec = store.state.spec;
  const h = Math.max(60, figureHeight());
  return autoFit(m, h, -restGround(spec), keepRot ? spec.skin.transform.rot : undefined);
}

async function loadModel(f: File): Promise<void> {
  setStatus(`Reading ${f.name}…`, 0.2);
  try {
    const m = await parseModel(f);
    setModel(m);
    void storeModel(m);
    const sp = structuredClone(store.state.spec);
    sp.skin = { ...sp.skin, modelId: m.id, modelName: m.name, enabled: false, transform: fitTransform(m), bindPose: {} };
    store.update({ spec: sp, view: { ...store.state.view, tab: 'skin', ghost: { ...store.state.view.ghost, show: true } } }, true);
    setStatus(`Loaded ${m.name}`, 1);
    toast('Model loaded. Line it up, pose the figure to match, then bind.');
  } catch (e) {
    setStatus('Could not read that model', 1);
    toast(String((e as Error).message ?? e), 'error');
  }
}

function removeModel(): void {
  setModel(null);
  void storeModel(null);
  const sp = structuredClone(store.state.spec);
  sp.skin = { ...sp.skin, modelId: '', modelName: '', enabled: false };
  store.update({ spec: sp }, true);
}

function bindPose(): void {
  const sp = structuredClone(store.state.spec);
  sp.skin.bindPose = structuredClone(store.state.pose);
  sp.skin.enabled = true;
  store.update({ spec: sp, view: { ...store.state.view, ghost: { ...store.state.view.ghost, show: false } } }, true);
  toast('Bound. The armor now follows the model; posing moves it with the joints.');
}

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.json')) void loadSpec(f);
  else void loadModel(f);
});

function refitView(): void {
  viewer.setMode(store.state.view.mode);
}

// ---------- wiring ----------
buildPanel(panel, {
  store,
  rig: () => rig,
  stats,
  height: figureHeight,
  model: () => (model ? { name: model.name, tris: model.indices.length / 3 } : null),
  actions: {
    loadModel: (f) => void loadModel(f),
    removeModel,
    autoFit: () => {
      if (!model) return;
      const sp = structuredClone(store.state.spec);
      sp.skin.transform = fitTransform(model, true);
      store.update({ spec: sp }, true);
    },
    bindPose,
    exportGroup: (g) => void exportGroup(g),
    exportStl: () => void exportStl(),
    exportAll: () => void exportAll(),
    exportCalibration: () => void exportCalibration(),
    saveSpec,
    loadSpec: (f) => void loadSpec(f),
  },
});

let lastMode = store.state.view.mode;
store.subscribe((s, changed) => {
  if (changed.has('spec')) {
    applySpec(s.spec);
    const clamped = clampPose(rig, s.pose);
    if (JSON.stringify(clamped) !== JSON.stringify(s.pose)) { store.update({ pose: clamped }); return; }
    viewer.setPose(s.pose);
  }
  if (changed.has('pose')) viewer.setPose(s.pose);
  if (changed.has('colors')) viewer.setColors(s.colors);
  if (changed.has('view')) {
    viewer.setDisplay(s.view.display);
    viewer.setSelected(s.view.selected);
    if (s.view.mode !== lastMode) {
      lastMode = s.view.mode;
      viewer.setMode(s.view.mode);
      refreshPlates();
    }
  }
  if (changed.has('print')) refreshPlates();
  if (changed.has('spec') || changed.has('view')) syncGhost(s);
  syncChrome(s);
});

function syncChrome(s: AppState): void {
  undoBtn.disabled = !store.canUndo();
  redoBtn.disabled = !store.canRedo();
  document.body.classList.toggle('panel-closed', !s.view.panelOpen);
  document.body.classList.toggle('mode-plates', s.view.mode === 'plates');
  for (const b of modeBtns) b.classList.toggle('on', b.dataset.v === s.view.mode);
  for (const b of figureTools.querySelectorAll<HTMLButtonElement>('.pill[data-k]')) {
    b.classList.toggle('on', !!s.view.display[b.dataset.k as 'armor']);
  }
  if (document.activeElement !== explode) { explode.value = String(s.view.display.explode); explodeFill(); }
  document.title = `${s.spec.name} · dummo`;
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const v = store.state.view;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f') refitView();
  else if (k === 'a') store.update({ view: { ...v, display: { ...v.display, armor: !v.display.armor } } });
  else if (k === 'e') store.update({ view: { ...v, display: { ...v.display, explode: v.display.explode > 0 ? 0 : 0.6 } } });
  else if (k === 'p') store.update({ view: { ...v, mode: v.mode === 'plates' ? 'figure' : 'plates' } });
  else if (k === 'escape') store.update({ view: { ...v, selected: null } });
});

// first paint
void restoreModel().then((m) => {
  restoring = false;
  if (m && m.id === store.state.spec.skin.modelId) {
    setModel(m);
    if (skinActive(store.state.spec)) { builtSpec = ''; applySpec(store.state.spec); }
  } else if (skinActive(store.state.spec)) {
    toast('The skin model is not stored in this browser. Load it again in the Skin tab.', 'error');
  }
});
viewer.setColors(store.state.colors);
viewer.setDisplay(store.state.view.display);
applySpec(store.state.spec);
viewer.setPose(store.state.pose);
syncChrome(store.state);
if (window.matchMedia('(max-width: 820px)').matches) store.update({ view: { ...store.state.view, panelOpen: false } });
if (location.hash.includes('d=')) history.replaceState(null, '', location.pathname + location.search);

function logo(): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="11" y="2" width="10" height="9" rx="4.5" fill="var(--accent)"/>
    <rect x="9" y="12.5" width="14" height="9" rx="2" fill="var(--accent)"/>
    <circle cx="6" cy="14" r="2.6" fill="var(--ink)"/><circle cx="26" cy="14" r="2.6" fill="var(--ink)"/>
    <rect x="10" y="23" width="4.6" height="7" rx="1.4" fill="var(--ink)"/><rect x="17.4" y="23" width="4.6" height="7" rx="1.4" fill="var(--ink)"/>
  </svg>`;
  return wrap.firstChild as SVGSVGElement;
}
