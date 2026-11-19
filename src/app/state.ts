import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { DEFAULT_COLORS, DEFAULT_PRINT, defaultSpec, sanitizeSpec } from '../core/defaults.ts';
import { POSES } from '../core/pose.ts';
import type { Colors, FigureSpec, Pose, PrintSettings } from '../core/types.ts';
import type { Display } from '../viewer/viewer.ts';

export type Tab = 'design' | 'pose' | 'print' | 'guide';
export type Quality = 'draft' | 'normal' | 'fine';

export type ViewState = {
  mode: 'figure' | 'plates';
  tab: Tab;
  selected: string | null;
  display: Display;
  quality: Quality;
  panelOpen: boolean;
};

export type AppState = {
  spec: FigureSpec;
  pose: Pose;
  print: PrintSettings;
  colors: Colors;
  view: ViewState;
};

type Snapshot = { spec: FigureSpec; pose: Pose };
type Listener = (s: AppState, changed: Set<keyof AppState>) => void;

const STORAGE_KEY = 'dummo:v1';

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private committed: Snapshot;
  private saveTimer = 0;

  constructor() {
    this.state = loadInitial();
    this.committed = snap(this.state);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Update state. commit = record an undo step (use on slider release, button clicks). */
  update(patch: Partial<AppState>, commit = false): void {
    const changed = new Set(Object.keys(patch) as (keyof AppState)[]);
    if (patch.spec) patch = { ...patch, spec: sanitizeSpec(patch.spec) };
    this.state = { ...this.state, ...patch };
    if (commit) this.commit();
    this.emit(changed);
    this.scheduleSave();
  }

  commit(): void {
    const cur = snap(this.state);
    if (JSON.stringify(cur) === JSON.stringify(this.committed)) return;
    this.undoStack.push(this.committed);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.committed = cur;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(snap(this.state));
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(snap(this.state));
    this.restore(next);
  }

  private restore(s: Snapshot): void {
    this.committed = structuredClone(s);
    this.state = { ...this.state, spec: structuredClone(s.spec), pose: structuredClone(s.pose) };
    this.emit(new Set(['spec', 'pose']));
    this.scheduleSave();
  }

  private emit(changed: Set<keyof AppState>): void {
    for (const l of this.listeners) l(this.state, changed);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted(this.state)));
      } catch {
        /* storage unavailable */
      }
    }, 400);
  }

  shareUrl(): string {
    const data = encode(persisted(this.state));
    const u = new URL(window.location.href);
    u.hash = `d=${data}`;
    return u.toString();
  }
}

function snap(s: AppState): Snapshot {
  return { spec: structuredClone(s.spec), pose: structuredClone(s.pose) };
}

function persisted(s: AppState) {
  return { v: 1, spec: s.spec, pose: s.pose, print: s.print, colors: s.colors };
}

function encode(obj: unknown): string {
  const bytes = deflateSync(strToU8(JSON.stringify(obj)), { level: 9 });
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(s: string): unknown {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(strFromU8(inflateSync(bytes)));
}

function merge<T extends object>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object') return base;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = merge(cur as object, v);
    else if (typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

function fromData(data: unknown): Partial<AppState> {
  const d = (data ?? {}) as Record<string, unknown>;
  const pose: Pose = {};
  if (d.pose && typeof d.pose === 'object') {
    for (const [k, v] of Object.entries(d.pose as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) pose[k] = v as Pose[string];
    }
  }
  return {
    spec: sanitizeSpec(merge(defaultSpec(), d.spec)),
    pose,
    print: merge(DEFAULT_PRINT, d.print),
    colors: merge(DEFAULT_COLORS, d.colors),
  };
}

function loadInitial(): AppState {
  const view: ViewState = {
    mode: 'figure', tab: 'design', selected: null, quality: 'normal',
    display: { armor: true, frame: true, outlines: true, explode: 0, stand: false },
    panelOpen: true,
  };
  const base: AppState = {
    spec: defaultSpec(), pose: structuredClone(POSES.Rest), print: { ...DEFAULT_PRINT }, colors: { ...DEFAULT_COLORS }, view,
  };
  const hash = window.location.hash.match(/[#&]d=([^&]+)/);
  if (hash) {
    try {
      return { ...base, ...fromData(decode(hash[1])) };
    } catch {
      /* bad link: fall through */
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...base, ...fromData(JSON.parse(raw)) };
  } catch {
    /* storage unavailable */
  }
  return base;
}

export function specFromFile(text: string): Partial<AppState> {
  return fromData(JSON.parse(text));
}
