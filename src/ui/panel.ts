import { applyPreset, MATERIAL_DENSITY, MATERIALS, PRESETS, PROPORTION_LABELS, PROPORTION_LIMITS } from '../core/defaults.ts';
import { POSES } from '../core/pose.ts';
import { mirrorPose, type Rig, type RigNode } from '../core/skeleton.ts';
import type { Emblem, FigureSpec, HandPose, HeadShape, Proportions, SkinSettings, Tolerances, Vec3, Weapon } from '../core/types.ts';
import { MODEL_ACCEPT } from '../app/models.ts';
import type { AppState, Quality, Store, Tab } from '../app/state.ts';
import { colorPick, details, h, icon, section, segmented, select, slider, toggle, type Control } from './dom.ts';

export type PartStat = { key: string; label: string; group: string; qty: number; w: number; h: number; d: number; volume: number };

export type ModelInfo = { name: string; tris: number } | null;

export type PanelCtx = {
  store: Store;
  rig: () => Rig;
  stats: () => PartStat[];
  height: () => number;
  model: () => ModelInfo;
  actions: {
    loadModel: (f: File) => void;
    removeModel: () => void;
    autoFit: () => void;
    bindPose: () => void;
    exportGroup: (g: 'frame' | 'armor' | 'accessory') => void;
    exportStl: () => void;
    exportAll: () => void;
    exportCalibration: () => void;
    saveSpec: () => void;
    loadSpec: (f: File) => void;
  };
};

type Synced = { el: HTMLElement; sync: (s: AppState, changed: Set<keyof AppState>) => void };

const TABS: { id: Tab; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'skin', label: 'Skin' },
  { id: 'pose', label: 'Pose' },
  { id: 'print', label: 'Print' },
  { id: 'guide', label: 'Guide' },
];

export function buildPanel(host: HTMLElement, ctx: PanelCtx): void {
  const { store } = ctx;
  const tabs: Record<Tab, Synced> = {
    design: designTab(ctx),
    skin: skinTab(ctx),
    pose: poseTab(ctx),
    print: printTab(ctx),
    guide: guideTab(),
  };
  const tabButtons = TABS.map((t) => h('button', {
    type: 'button', class: 'tab', role: 'tab', 'data-tab': t.id,
    onclick: () => store.update({ view: { ...store.state.view, tab: t.id } }),
  }, t.label));
  const body = h('div', { class: 'panel-body' });
  host.append(h('nav', { class: 'tabs', role: 'tablist' }, ...tabButtons), body);
  for (const t of Object.values(tabs)) body.append(t.el);

  const sync = (s: AppState, changed: Set<keyof AppState>) => {
    for (const b of tabButtons) {
      const on = b.dataset.tab === s.view.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const [id, t] of Object.entries(tabs)) {
      const on = id === s.view.tab;
      t.el.hidden = !on;
      if (on) t.sync(s, changed);
    }
  };
  store.subscribe(sync);
  sync(store.state, new Set(['spec', 'pose', 'print', 'colors', 'view']));
}

// ---------------- Design ----------------

function designTab(ctx: PanelCtx): Synced {
  const { store } = ctx;
  const syncs: ((s: AppState) => void)[] = [];
  const setSpec = (fn: (sp: FigureSpec) => void, commit = false) => {
    const sp = structuredClone(store.state.spec);
    fn(sp);
    store.update({ spec: sp }, commit);
  };
  const commit = () => store.commit();

  const name = h('input', { type: 'text', class: 'name-input', maxlength: 40, 'aria-label': 'Figure name' });
  name.addEventListener('input', () => setSpec((sp) => { sp.name = name.value || 'Dummo'; }));
  name.addEventListener('change', commit);
  syncs.push((s) => { if (document.activeElement !== name) name.value = s.spec.name; });

  const presetRow = h('div', { class: 'chips' }, ...Object.keys(PRESETS).map((p) =>
    h('button', { type: 'button', class: 'chip', onclick: () => store.update({ spec: applyPreset(store.state.spec, p) }, true) }, p)));

  const heightOut = h('span', { class: 'readout' });
  syncs.push(() => { const v = ctx.height(); heightOut.textContent = v > 0 ? `≈ ${v.toFixed(0)} mm tall` : ''; });

  const scale = slider({
    label: 'Scale', min: 60, max: 250, step: 5, value: store.state.spec.scale * 100, unit: '%',
    hint: 'Joint fits stay the same at every scale.',
    onInput: (v) => setSpec((sp) => { sp.scale = v / 100; }), onCommit: commit,
  });
  syncs.push((s) => scale.set(s.spec.scale * 100));

  const propSlider = (k: keyof Proportions) => {
    const [lo, hi] = PROPORTION_LIMITS[k];
    const c = slider({
      label: PROPORTION_LABELS[k], min: lo, max: hi, step: 0.5, value: store.state.spec.proportions[k], unit: 'mm', digits: 1,
      onInput: (v) => setSpec((sp) => { sp.proportions[k] = v; }), onCommit: commit,
    });
    syncs.push((s) => c.set(s.spec.proportions[k]));
    return c.el;
  };

  const styleSlider = (label: string, key: 'headSize' | 'chestWidth' | 'bulk' | 'facet' | 'handSize' | 'footSize', min: number, max: number) => {
    const c = slider({
      label, min: min * 100, max: max * 100, step: 1, value: store.state.spec.style[key] * 100, unit: '%',
      onInput: (v) => setSpec((sp) => { sp.style[key] = v / 100; }), onCommit: commit,
    });
    syncs.push((s) => c.set(s.spec.style[key] * 100));
    return c.el;
  };

  const head = segmented<HeadShape>({
    label: 'Head shape',
    options: [{ value: 'egg', label: 'Egg' }, { value: 'round', label: 'Round' }, { value: 'block', label: 'Block' }, { value: 'visor', label: 'Visor' }],
    value: store.state.spec.style.headShape,
    onChange: (v) => setSpec((sp) => { sp.style.headShape = v; }, true),
  });
  syncs.push((s) => head.set(s.spec.style.headShape));

  const emblem = segmented<Emblem>({
    label: 'Chest emblem',
    options: [{ value: 'none', label: 'None' }, { value: 'chevron', label: 'Chevron' }, { value: 'circle', label: 'Ring' }, { value: 'bar', label: 'Bar' }],
    value: store.state.spec.style.emblem,
    onChange: (v) => setSpec((sp) => { sp.style.emblem = v; }, true),
  });
  syncs.push((s) => emblem.set(s.spec.style.emblem));

  const hands = segmented<HandPose>({
    label: 'Hands',
    options: [{ value: 'fist', label: 'Fists' }, { value: 'open', label: 'Open' }, { value: 'grip', label: 'Grip' }],
    value: store.state.spec.style.handPose,
    onChange: (v) => setSpec((sp) => { sp.style.handPose = v; }, true),
  });
  syncs.push((s) => hands.set(s.spec.style.handPose));

  const weapon = segmented<Weapon>({
    label: 'Right hand holds',
    options: [{ value: 'none', label: 'Nothing' }, { value: 'sword', label: 'Sword' }, { value: 'staff', label: 'Staff' }],
    value: store.state.spec.style.weapon,
    onChange: (v) => setSpec((sp) => { sp.style.weapon = v; if (v !== 'none') sp.style.handPose = 'grip'; }, true),
  });
  const weaponNote = h('p', { class: 'muted small' }, 'Weapons need Grip hands: the handle slides through the fist.');
  syncs.push((s) => { weapon.set(s.spec.style.weapon); weaponNote.hidden = s.spec.style.handPose === 'grip'; });

  const port = toggle({
    label: 'Back port (stand / accessories)', value: store.state.spec.style.backPort,
    onChange: (v) => setSpec((sp) => { sp.style.backPort = v; }, true),
  });
  syncs.push((s) => port.set(s.spec.style.backPort));

  const tilt = slider({
    label: 'Ankle tilt', min: 0, max: 15, step: 1, value: store.state.spec.style.ankleTilt, unit: '°',
    hint: 'Rotates the ankle socket opening so the feet rest slightly splayed.',
    onInput: (v) => setSpec((sp) => { sp.style.ankleTilt = v; }), onCommit: commit,
  });
  syncs.push((s) => tilt.set(s.spec.style.ankleTilt));

  const armorKeys: [keyof FigureSpec['style']['armor'], string][] = [
    ['head', 'Head'], ['chest', 'Chest'], ['abdomen', 'Abdomen'], ['pelvis', 'Pelvis'], ['arms', 'Arms'], ['legs', 'Legs'], ['feet', 'Feet'],
  ];
  const armorToggles = armorKeys.map(([k, label]) => {
    const t = toggle({ label, value: store.state.spec.style.armor[k], onChange: (v) => setSpec((sp) => { sp.style.armor[k] = v; }, true) });
    syncs.push((s) => t.set(s.spec.style.armor[k]));
    return t.el;
  });

  const swFrame = ['#3b3f46', '#1f2226', '#6b7079', '#d8d4cc', '#2f4858'];
  const swArmor = ['#e8642c', '#2a6df4', '#2bb673', '#f2c230', '#d7263d', '#8e5cd9', '#f4f1ea', '#22252a'];
  const swBg = ['#f3efe8', '#ffffff', '#dfe7ef', '#2a2d33', '#141518'];
  const colorCtl = (label: string, key: 'frame' | 'armor' | 'background', sw: string[]) => {
    const c = colorPick({ label, value: store.state.colors[key], swatches: sw, onChange: (v) => store.update({ colors: { ...store.state.colors, [key]: v } }) });
    syncs.push((s) => c.set(s.colors[key]));
    return c.el;
  };

  const el = h('div', { class: 'tab-page' },
    section('Figure', h('div', { class: 'row' }, name, heightOut), presetRow, scale.el),
    details('Torso', true, propSlider('chestLen'), propSlider('shoulderY'), propSlider('shoulderHalf'), propSlider('abdomenLen'), propSlider('waistLen'), propSlider('hipHalf'), propSlider('neckLen')),
    details('Limbs', true, propSlider('upperArmLen'), propSlider('forearmLen'), propSlider('thighLen'), propSlider('shinLen')),
    details('Armor style', true, head.el, styleSlider('Head size', 'headSize', 0.7, 1.6), styleSlider('Chest width', 'chestWidth', 0.8, 1.35),
      styleSlider('Limb bulk', 'bulk', 0.85, 1.35), styleSlider('Facets', 'facet', 0, 1), emblem.el, port.el),
    details('Armor pieces', false, h('div', { class: 'grid2' }, ...armorToggles)),
    details('Hands & feet', false, hands.el, weapon.el, weaponNote, styleSlider('Hand size', 'handSize', 0.8, 1.3), styleSlider('Foot size', 'footSize', 0.8, 1.3), tilt.el),
    details('Colors', false, colorCtl('Frame', 'frame', swFrame), colorCtl('Armor', 'armor', swArmor), colorCtl('Background', 'background', swBg)),
  );
  return { el, sync: (s) => syncs.forEach((f) => f(s)) };
}

// ---------------- Skin ----------------

function skinTab(ctx: PanelCtx): Synced {
  const { store, actions } = ctx;
  const syncs: ((s: AppState) => void)[] = [];
  const setSkin = (fn: (sk: SkinSettings) => void, commit = false) => {
    const sp = structuredClone(store.state.spec);
    fn(sp.skin);
    store.update({ spec: sp }, commit);
  };

  const fileIn = h('input', { type: 'file', accept: MODEL_ACCEPT, hidden: true });
  fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) actions.loadModel(f); fileIn.value = ''; });
  const drop = h('button', { type: 'button', class: 'dropzone', onclick: () => fileIn.click() },
    icon('upload', 22), h('strong', {}, 'Load a character model'), h('span', { class: 'muted small' }, 'STL, OBJ, GLB/glTF, 3MF or PLY. Drop it anywhere on the page.'));
  const info = h('div', { class: 'model-info' });

  const deg = h('div', { class: 'row wrap' }, ...(['X', 'Y', 'Z'] as const).map((ax, i) => h('button', {
    type: 'button', class: 'btn ghost small', onclick: () => setSkin((sk) => { sk.transform.rot[i] = ((sk.transform.rot[i] + 90 + 180) % 360) - 180; }, true),
  }, icon('reset', 14), `Turn ${ax}`)));

  const scale = slider({
    label: 'Size', min: -3, max: 3, step: 0.002, value: Math.log10(store.state.spec.skin.transform.scale),
    hint: 'Model scale. Auto-fit sets this from the figure height and refits the skeleton.',
    format: (v) => { const x = 10 ** v; return `×${x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(3) : x.toPrecision(3)}`; },
    onInput: (v) => setSkin((sk) => { sk.transform.scale = 10 ** v; }), onCommit: () => store.commit(),
  });
  syncs.push((s) => scale.set(Math.log10(s.spec.skin.transform.scale)));
  const offs = (['Left / right', 'Up / down', 'Back / front'] as const).map((label, i) => {
    const c = slider({
      label, min: -150, max: 150, step: 0.5, value: store.state.spec.skin.transform.offset[i], unit: 'mm', digits: 1,
      onInput: (v) => setSkin((sk) => { sk.transform.offset[i] = v; }), onCommit: () => store.commit(),
    });
    syncs.push((s) => c.set(s.spec.skin.transform.offset[i]));
    return c.el;
  });
  const ghost = toggle({ label: 'Show model', value: store.state.view.ghost.show, onChange: (v) => store.update({ view: { ...store.state.view, ghost: { ...store.state.view.ghost, show: v } } }) });
  syncs.push((s) => ghost.set(s.view.ghost.show));
  const opacity = slider({
    label: 'Model opacity', min: 5, max: 100, step: 1, value: store.state.view.ghost.opacity * 100, unit: '%',
    onInput: (v) => store.update({ view: { ...store.state.view, ghost: { ...store.state.view.ghost, opacity: v / 100 } } }),
  });
  syncs.push((s) => opacity.set(s.view.ghost.opacity * 100));

  const enabled = toggle({
    label: 'Use the model as armor', value: store.state.spec.skin.enabled,
    onChange: (v) => setSkin((sk) => { sk.enabled = v; }, true),
  });
  syncs.push((s) => enabled.set(s.spec.skin.enabled));
  const bindInfo = h('p', { class: 'muted small' });
  syncs.push((s) => {
    const n = Object.values(s.spec.skin.bindPose).filter((v) => v[0] || v[1] || v[2]).length;
    bindInfo.textContent = n ? `Bound to a pose with ${n} bent joint${n > 1 ? 's' : ''}.` : 'Bound to the straight rest pose.';
  });
  const detail = segmented<string>({
    label: 'Detail',
    options: [{ value: '0.8', label: 'Coarse' }, { value: '0.45', label: 'Normal' }, { value: '0.3', label: 'Fine' }],
    value: String(store.state.spec.skin.detail),
    onChange: (v) => setSkin((sk) => { sk.detail = Number(v); }, true),
  });
  syncs.push((s) => detail.set(String(s.spec.skin.detail)));
  const close = slider({
    label: 'Seal openings', min: 0, max: 6, step: 0.25, value: store.state.spec.skin.close, unit: 'mm', digits: 2,
    hint: 'Holes and gaps narrower than about twice this are filled, so open shells become solid.',
    onInput: (v) => setSkin((sk) => { sk.close = v; }), onCommit: () => store.commit(),
  });
  syncs.push((s) => close.set(s.spec.skin.close));
  const gap = slider({
    label: 'Gap between pieces', min: 0.2, max: 2, step: 0.05, value: store.state.spec.skin.gap, unit: 'mm', digits: 2,
    onInput: (v) => setSkin((sk) => { sk.gap = v; }), onCommit: () => store.commit(),
  });
  syncs.push((s) => gap.set(s.spec.skin.gap));
  const motion = toggle({
    label: 'Carve for movement', value: store.state.spec.skin.motion,
    hint: 'Hollow the chest and pelvis where the arms and legs swing, so the joints reach their full range. Off keeps more of the model\'s shape.',
    onChange: (v) => { setSkin((sk) => { sk.motion = v; }); store.commit(); },
  });
  syncs.push((s) => motion.set(s.spec.skin.motion));
  const coverT = toggle({
    label: 'Cover thin spots', value: store.state.spec.skin.cover,
    hint: 'Where the model is thinner than the frame (slim arms, narrow waists), fill in with standard armor so no joint is left bare.',
    onChange: (v) => { setSkin((sk) => { sk.cover = v; }); store.commit(); },
  });
  syncs.push((s) => coverT.set(s.spec.skin.cover));

  const loadedOnly = h('div', { class: 'tab-page' },
    section('Line it up', h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn secondary', onclick: () => actions.autoFit() }, icon('focus', 15), 'Auto-fit'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => actions.removeModel() }, icon('close', 15), 'Remove')),
    deg, scale.el, ...offs, ghost.el, opacity.el),
    section('Skin',
      h('p', { class: 'muted small' }, 'Loading a model fits the skeleton and binds it. To correct a joint: show the model, fix it in ', h('b', {}, 'Design'), ' or ', h('b', {}, 'Pose'), ', then bind again.'),
      h('button', { type: 'button', class: 'btn wide', onclick: () => actions.bindPose() }, icon('figure', 16), 'Bind to current pose'),
      bindInfo, enabled.el, detail.el, close.el, gap.el, motion.el, coverT.el,
      h('p', { class: 'muted small' }, 'Skin pieces split around the frame like the regular armor. Halves are joined with small printed dowels. Organic shapes usually need supports.')),
  );
  syncs.push(() => {
    const m = ctx.model();
    loadedOnly.hidden = !m;
    info.replaceChildren(...(m ? [h('strong', {}, m.name), h('span', { class: 'muted small' }, `${m.tris.toLocaleString()} triangles`)] : []));
    info.hidden = !m;
  });
  const el = h('div', { class: 'tab-page' }, section('Character model', drop, info, fileIn), loadedOnly);
  return { el, sync: (s) => syncs.forEach((f) => f(s)) };
}

// ---------------- Pose ----------------

const AXIS_LABELS: Record<RigNode['joint'], string[]> = {
  root: ['Pitch', 'Turn', 'Roll'],
  ball: ['Bend', 'Twist', 'Side'],
  hinge: ['Bend', '', ''],
  swivel: ['', 'Twist', ''],
};

function poseTab(ctx: PanelCtx): Synced {
  const { store } = ctx;
  const setPose = (pose: AppState['pose'], commit = false) => store.update({ pose }, commit);

  const presets = h('div', { class: 'chips' }, ...Object.keys(POSES).map((p) =>
    h('button', { type: 'button', class: 'chip', onclick: () => setPose(structuredClone(POSES[p]), true) }, p)));

  const tool = (label: string, ic: Parameters<typeof icon>[0], fn: () => void) =>
    h('button', { type: 'button', class: 'btn ghost small', onclick: fn }, icon(ic, 15), label);
  const tools = h('div', { class: 'row wrap' },
    tool('Left → right', 'mirror', () => setPose(mirrorPose(store.state.pose, 'L'), true)),
    tool('Right → left', 'mirror', () => setPose(mirrorPose(store.state.pose, 'R'), true)),
    tool('Flip', 'mirror', () => setPose(mirrorPose(store.state.pose, 'swap'), true)),
    tool('Random', 'dice', () => setPose(randomPose(ctx.rig()), true)),
    tool('Reset', 'reset', () => setPose({}, true)),
  );

  const card = h('div', { class: 'joint-card' });
  const list = h('div', { class: 'joint-list' });
  let cardNode: string | null | undefined;
  let cardSliders: { i: number; c: Control<number> }[] = [];

  const buildCard = (s: AppState) => {
    card.replaceChildren();
    cardSliders = [];
    cardNode = s.view.selected;
    const rig = ctx.rig();
    const n = s.view.selected ? rig.byId[s.view.selected] : null;
    if (!n) {
      card.append(h('p', { class: 'muted' }, 'Pick a joint below, or click any part of the figure.'));
      return;
    }
    card.append(h('div', { class: 'row space' }, h('strong', {}, `${n.group === 'Body' || n.group === 'Spine' || n.group === 'Head' ? '' : n.group + ' · '}${n.label}`),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => {
        const p = { ...store.state.pose };
        delete p[n.id];
        setPose(p, true);
      } }, icon('reset', 14), 'Zero')));
    const labels = AXIS_LABELS[n.joint];
    for (let i = 0; i < 3; i++) {
      const [lo, hi] = n.limits[i];
      if (lo === hi || !labels[i]) continue;
      const c = slider({
        label: labels[i], min: lo, max: hi, step: 1, value: s.pose[n.id]?.[i] ?? 0, unit: '°',
        onInput: (v) => {
          const p = { ...store.state.pose };
          const cur: Vec3 = p[n.id] ? [...p[n.id]] as Vec3 : [0, 0, 0];
          cur[i] = v;
          p[n.id] = cur;
          setPose(p);
        },
        onCommit: () => store.commit(),
      });
      cardSliders.push({ i, c });
      card.append(c.el);
    }
  };

  const buildList = (s: AppState) => {
    list.replaceChildren();
    const rig = ctx.rig();
    const groups = new Map<string, RigNode[]>();
    for (const n of rig.nodes) groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
    for (const [g, nodes] of groups) {
      list.append(h('div', { class: 'joint-group' }, h('span', { class: 'group-label' }, g),
        h('div', { class: 'chips' }, ...nodes.map((n) => {
          const v = s.pose[n.id];
          const moved = v && (v[0] || v[1] || v[2]);
          return h('button', {
            type: 'button', class: `chip${s.view.selected === n.id ? ' on' : ''}${moved ? ' moved' : ''}`,
            onclick: () => store.update({ view: { ...store.state.view, selected: n.id } }),
          }, n.label);
        }))));
    }
  };

  const el = h('div', { class: 'tab-page' },
    section('Poses', presets, tools),
    section('Joint', card),
    section('All joints', list),
    h('p', { class: 'muted small' }, 'Posing is limited to what the joints can do; armor may restrict extreme angles on the real print.'),
  );
  return {
    el,
    sync: (s, changed) => {
      if (cardNode !== s.view.selected || changed.has('spec')) buildCard(s);
      else for (const { i, c } of cardSliders) c.set(s.pose[s.view.selected!]?.[i] ?? 0);
      buildList(s);
    },
  };
}

function randomPose(rig: Rig): AppState['pose'] {
  const pose: AppState['pose'] = {};
  const rnd = (lo: number, hi: number, k: number) => {
    const mid = (lo + hi) / 2 * (lo < 0 && hi > 0 ? 0 : 1);
    const span = (hi - lo) / 2;
    return Math.round(mid + (Math.random() * 2 - 1) * span * k);
  };
  for (const n of rig.nodes) {
    if (n.joint === 'root') continue;
    const k = n.joint === 'ball' ? 0.45 : 0.6;
    pose[n.id] = n.limits.map(([lo, hi]) => (lo === hi ? 0 : Math.min(hi, Math.max(lo, rnd(lo, hi, k))))) as Vec3;
  }
  return pose;
}

// ---------------- Print ----------------

const BEDS: { label: string; x: number; y: number }[] = [
  { label: '180 × 180 (A1 mini, MINI)', x: 180, y: 180 },
  { label: '220 × 220 (Ender 3 class)', x: 220, y: 220 },
  { label: '250 × 210 (MK3 / MK4)', x: 250, y: 210 },
  { label: '256 × 256 (X1 / P1 / A1)', x: 256, y: 256 },
  { label: '300 × 300', x: 300, y: 300 },
];

function printTab(ctx: PanelCtx): Synced {
  const { store, actions } = ctx;
  const syncs: ((s: AppState) => void)[] = [];
  const setPrint = (patch: Partial<AppState['print']>) => store.update({ print: { ...store.state.print, ...patch } });

  const materialNames = [...Object.keys(MATERIALS), 'Custom'];
  const material = select({
    label: 'Frame material', options: materialNames.map((m) => ({ value: m, label: m })), value: store.state.spec.material,
    onChange: (v) => {
      const sp = structuredClone(store.state.spec);
      sp.material = v;
      if (MATERIALS[v]) sp.tolerances = { ...MATERIALS[v] };
      store.update({ spec: sp }, true);
    },
  });
  syncs.push((s) => material.set(s.spec.material));

  const tolDefs: [keyof Tolerances, string, string][] = [
    ['socketSpine', 'Spine ball grip', 'Ball diameter minus socket diameter for the torso joints.'],
    ['socketLimb', 'Limb ball grip', 'Ball diameter minus socket diameter for shoulders, hips, neck, wrists and ankles.'],
    ['hinge', 'Hinge grip', 'How far the clip ridge presses into the pin groove (radial).'],
    ['swivel', 'Swivel spring', 'Preload of the printed leaf spring on the swivel disc.'],
    ['armor', 'Armor clearance', 'Gap between armor and frame.'],
    ['peg', 'Armor peg press-fit', 'Interference of the pegs that hold armor halves together.'],
    ['slide', 'Slide clearance', 'Gap for sliding fits: swivel chamber, ankle tongue, stand peg.'],
  ];
  const tolSliders = tolDefs.map(([k, label, hint]) => {
    const c = slider({
      label, min: 0, max: 0.5, step: 0.01, value: store.state.spec.tolerances[k], unit: 'mm', digits: 2, hint,
      onInput: (v) => {
        const sp = structuredClone(store.state.spec);
        sp.tolerances[k] = v;
        sp.material = 'Custom';
        store.update({ spec: sp });
      },
      onCommit: () => store.commit(),
    });
    syncs.push((s) => c.set(s.spec.tolerances[k]));
    return c.el;
  });

  const bedOptions = [...BEDS.map((b) => ({ value: `${b.x}x${b.y}`, label: b.label })), { value: 'custom', label: 'Custom…' }];
  const bedKey = (s: AppState) => {
    const k = `${s.print.bedX}x${s.print.bedY}`;
    return BEDS.some((b) => `${b.x}x${b.y}` === k) ? k : 'custom';
  };
  const bedX = h('input', { type: 'number', min: 80, max: 500, class: 'num wide', 'aria-label': 'Bed width' });
  const bedY = h('input', { type: 'number', min: 80, max: 500, class: 'num wide', 'aria-label': 'Bed depth' });
  const customBed = h('div', { class: 'row' }, h('span', { class: 'control-label' }, 'Bed (mm)'), bedX, h('span', {}, '×'), bedY);
  bedX.addEventListener('change', () => setPrint({ bedX: Math.max(80, Math.min(500, Number(bedX.value) || 220)) }));
  bedY.addEventListener('change', () => setPrint({ bedY: Math.max(80, Math.min(500, Number(bedY.value) || 220)) }));
  const bed = select({
    label: 'Print bed', options: bedOptions, value: bedKey(store.state),
    onChange: (v) => {
      if (v === 'custom') { customBed.hidden = false; return; }
      const [x, y] = v.split('x').map(Number);
      setPrint({ bedX: x, bedY: y });
    },
  });
  syncs.push((s) => {
    const k = bedKey(s);
    bed.set(k);
    if (k === 'custom') customBed.hidden = false;
    else if (document.activeElement !== bedX && document.activeElement !== bedY) customBed.hidden = true;
    bedX.value = String(s.print.bedX);
    bedY.value = String(s.print.bedY);
  });

  const spacing = slider({ label: 'Part spacing', min: 2, max: 12, step: 1, value: store.state.print.spacing, unit: 'mm', onInput: (v) => setPrint({ spacing: v }) });
  syncs.push((s) => spacing.set(s.print.spacing));
  const stand = toggle({ label: 'Include display stand', value: store.state.print.stand, onChange: (v) => setPrint({ stand: v }) });
  syncs.push((s) => stand.set(s.print.stand));
  const quality = segmented<Quality>({
    label: 'Export detail', options: [{ value: 'draft', label: 'Draft' }, { value: 'normal', label: 'Normal' }, { value: 'fine', label: 'Fine' }],
    value: store.state.view.quality, onChange: (v) => store.update({ view: { ...store.state.view, quality: v } }),
  });
  syncs.push((s) => quality.set(s.view.quality));

  const btn = (label: string, fn: () => void, cls = 'btn') => h('button', { type: 'button', class: cls, onclick: fn }, icon('download', 16), label);
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) actions.loadSpec(f); fileIn.value = ''; });

  const table = h('div', { class: 'parts-table' });
  syncs.push((s) => {
    const stats = ctx.stats();
    const dens = MATERIAL_DENSITY[s.spec.material] ?? 1.2;
    const rows = stats.filter((r) => r.group !== 'accessory' || s.print.stand);
    const fill = 0.75; // perimeters dominate on parts this small
    let total = 0, count = 0;
    const tr = rows.map((r) => {
      const g = (r.volume / 1000) * dens * fill * r.qty;
      total += g;
      count += r.qty;
      return h('tr', {}, h('td', {}, h('span', { class: `dot ${r.group}` }), r.label), h('td', { class: 'n' }, `×${r.qty}`),
        h('td', { class: 'n' }, `${r.w.toFixed(0)}×${r.h.toFixed(0)}×${r.d.toFixed(0)}`), h('td', { class: 'n' }, `${g.toFixed(1)} g`));
    });
    table.replaceChildren(
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Qty'), h('th', {}, 'Size mm'), h('th', {}, 'Est.'))), h('tbody', {}, ...tr)),
      h('p', { class: 'muted small' }, `${count} pieces · about ${total.toFixed(0)} g of filament`),
    );
  });

  const el = h('div', { class: 'tab-page' },
    section('Export',
      h('div', { class: 'export-grid' },
        btn('Frame 3MF', () => actions.exportGroup('frame')),
        btn('Armor 3MF', () => actions.exportGroup('armor')),
        btn('Extras 3MF', () => actions.exportGroup('accessory'), 'btn secondary'),
        btn('STL zip', () => actions.exportStl(), 'btn secondary'),
      ),
      btn('Everything (zip)', () => actions.exportAll(), 'btn wide'),
      quality.el,
      h('p', { class: 'muted small' }, 'Parts come out already oriented for printing: no supports needed. Frame parts: PETG, ABS or ASA. Armor: any material.'),
    ),
    section('Print bed', bed.el, customBed, spacing.el, stand.el),
    section('Frame material', material.el,
      h('p', { class: 'muted small' }, 'Fit values are absolute (they don\'t scale). Print the test coupon to tune them for your printer.'),
      btn('Fit test coupon (3MF)', () => actions.exportCalibration(), 'btn secondary wide')),
    details('Fit tuning (advanced)', false, ...tolSliders),
    section('Parts', table),
    section('Design file',
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn secondary', onclick: () => actions.saveSpec() }, icon('download', 16), 'Save .json'),
        h('button', { type: 'button', class: 'btn secondary', onclick: () => fileIn.click() }, icon('upload', 16), 'Open .json'), fileIn)),
  );
  return { el, sync: (s) => syncs.forEach((f) => f(s)) };
}

// ---------------- Guide ----------------

function guideTab(): Synced {
  const el = h('div', { class: 'tab-page guide', html: GUIDE_HTML });
  return { el, sync: () => {} };
}

const GUIDE_HTML = `
<section class="card"><h3>How it works</h3>
<p>Every figure has two layers. The <b>frame</b> holds all the joints and is printed in a tough, slightly flexible plastic. The <b>armor</b> gives the figure its look; it slides or clamps over the frame and can be any material or color.</p>
<p>Joints hold their pose by friction. Each one is printed a little oversized against a part that can flex: ball sockets are split rings, knee and elbow links have a V-ridge that drops into a grooved pin, and the hip and shoulder twists have a printed leaf spring.</p>
</section>
<section class="card"><h3>Printing</h3>
<ul>
<li>Frame: PETG, ABS or ASA. PLA works with the PLA preset but wears loose faster.</li>
<li>0.4 mm nozzle, 0.15–0.2 mm layers, 2–3 walls, 15–20% infill.</li>
<li>No supports. Every part is exported in the right orientation.</li>
<li>Use elephant-foot compensation (about 0.15 mm) and a brim if small parts lift.</li>
<li>Not sure about the fit? Print the <b>fit test coupon</b> from the Print tab first and set the values that feel right.</li>
</ul></section>
<section class="card"><h3>Assembly</h3>
<ol>
<li><b>Legs.</b> Drop the hip swivel's disc into the top slot of the thigh, then slide the thigh armor up from the knee end until it stops. Snap a knee link onto the thigh's pin, slide the shin armor down over the shin's pin end, and snap the shin onto the other side of the link.</li>
<li><b>Feet.</b> Press each ankle's tongue into its foot, then snap the ankle socket onto the shin ball.</li>
<li><b>Arms.</b> Same as the legs: shoulder swivel into the upper arm, upper arm armor, elbow link, forearm armor and forearm, then snap on a hand.</li>
<li><b>Spine.</b> Snap the pelvis's centre ball into the waist socket so the rod passes through the side openings. Then waist ball into abdomen, abdomen ball into the chest's lower socket, neck into the chest's top socket, and the head core onto the neck.</li>
<li><b>Torso and head armor.</b> Lay each frame piece into the back half so the pegs pass through its holes, then press the front half on. The pelvis halves close from the sides.</li>
<li>Snap the hip swivels onto the pelvis side balls and the shoulder swivels onto the chest's shoulder balls.</li>
<li><b>Stand.</b> Press the post into the base and plug its peg into the back port.</li>
</ol></section>
<section class="card"><h3>Character skins</h3>
<p>Any humanoid model can become the armor: a sculpt, a game model, a statue. Load it in the <b>Skin</b> tab (STL, OBJ, GLB/glTF, 3MF or PLY), standing upright and facing front.</p>
<ol>
<li>dummo stands the model on the ground, finds its head, hands and feet, and fits the skeleton: proportions, arm and leg angles (T-pose, A-pose or arms down) and position. Then it binds.</li>
<li>Binding solidifies the model (hollow shells and holes narrower than about twice <i>Seal openings</i> are filled) and gives each bone the nearest part of the body.</li>
<li>If a joint is off, show the model, fix it in <b>Design</b> or <b>Pose</b> and press <b>Bind to current pose</b>. If the model lies down or faces the wrong way, use the turn buttons, then <b>Auto-fit</b>.</li>
</ol>
<p>Torso and head pieces split around the frame and are joined by printed dowels. Arms and legs become slide-on sleeves: shoulder and hip pieces wrap the joint, and knees and elbows get side plates. Organic shapes usually need supports.</p>
</section>
<section class="card"><h3>Tuning the fit</h3>
<ul>
<li>A joint is floppy: raise its grip value by 0.05 mm and reprint that part.</li>
<li>A joint is too stiff or cracks when snapping: lower it by 0.05 mm.</li>
<li>Armor too tight: raise armor clearance. Halves pop apart: raise the peg press-fit.</li>
</ul></section>
<section class="card"><h3>Shortcuts</h3>
<ul class="keys">
<li><kbd>Ctrl</kbd> <kbd>Z</kbd> undo · <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Z</kbd> redo</li>
<li><kbd>F</kbd> frame the view · <kbd>A</kbd> armor on/off · <kbd>E</kbd> exploded view</li>
<li><kbd>P</kbd> print plates · <kbd>Esc</kbd> clear the selection</li>
</ul></section>`;
