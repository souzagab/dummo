import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PartDef } from '../core/catalog.ts';
import type { Rig } from '../core/skeleton.ts';
import { restToPosed } from '../core/pose.ts';
import type { Colors, MeshData, Pose } from '../core/types.ts';

export type Display = {
  armor: boolean;
  frame: boolean;
  outlines: boolean;
  explode: number;
  stand: boolean;
};

export type PlateView = {
  label: string;
  bedX: number;
  bedY: number;
  items: { positions: Float32Array; indices: Uint32Array; matrix: THREE.Matrix4; group: 'frame' | 'armor' | 'accessory' }[];
};

type Entry = { raw: MeshData; geo: THREE.BufferGeometry; edges: THREE.BufferGeometry | null };

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
  readonly controls: OrbitControls;
  private figure = new THREE.Group();
  private stand = new THREE.Group();
  private platesGroup = new THREE.Group();
  private ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  private entries = new Map<string, Entry>();
  private meshes = new Map<string, THREE.Mesh>();
  private parts: PartDef[] = [];
  private rig: Rig | null = null;
  private pose: Pose = {};
  private scale = 1;
  private restGround = 0;
  private mode: 'figure' | 'plates' = 'figure';
  private needsRender = true;
  private selected: string | null = null;
  private framedOnce = false;
  display: Display = { armor: true, frame: true, outlines: true, explode: 0, stand: false };
  onSelect: (node: string | null) => void = () => {};

  private mats = {
    frame: new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 0.62, metalness: 0.08 }),
    armor: new THREE.MeshStandardMaterial({ color: 0xe8642c, roughness: 0.5, metalness: 0.04 }),
    accessory: new THREE.MeshStandardMaterial({ color: 0x9a9286, roughness: 0.7, metalness: 0 }),
    frameSel: new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 0.62, metalness: 0.08, emissive: 0x2a6df4, emissiveIntensity: 0.55 }),
    armorSel: new THREE.MeshStandardMaterial({ color: 0xe8642c, roughness: 0.5, metalness: 0.04, emissive: 0x2a6df4, emissiveIntensity: 0.45 }),
    edge: new THREE.LineBasicMaterial({ color: 0x1b1d21, transparent: true, opacity: 0.55 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xd9d4cb, roughness: 0.9 }),
  };

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('viewport-canvas');

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8378, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(140, 260, 220);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -160; sc.right = 160; sc.top = 220; sc.bottom = -60; sc.near = 10; sc.far = 900;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.9);
    rim.position.set(-200, 140, -180);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.ShadowMaterial({ opacity: 0.16 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(400, 40, 0x000000, 0x000000);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.06;
    this.scene.add(this.grid);

    this.scene.add(this.figure, this.stand, this.platesGroup);
    this.platesGroup.rotation.x = -Math.PI / 2;
    this.platesGroup.visible = false;

    this.camera.position.set(170, 120, 330);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 70, 0);
    this.controls.addEventListener('change', () => this.requestRender());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.installPicking();
    const loop = () => {
      requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (moved || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  requestRender(): void {
    this.needsRender = true;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private installPicking(): void {
    const ray = new THREE.Raycaster();
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || this.mode !== 'figure') return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      this.scene.updateMatrixWorld();
      const hits = ray.intersectObjects([...this.meshes.values()].filter((m) => m.visible), false);
      const node = hits.length ? (hits[0].object.userData.node as string) : null;
      this.onSelect(node && node !== 'world' ? node : null);
    });
  }

  // ---------- content ----------

  setGeometry(key: string, mesh: MeshData | null): void {
    const old = this.entries.get(key);
    if (old) { old.geo.dispose(); old.edges?.dispose(); this.entries.delete(key); }
    if (mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      const geo = toCreasedNormals(g, Math.PI / 7);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const edges = new THREE.EdgesGeometry(g, 32);
      g.dispose();
      this.entries.set(key, { raw: mesh, geo, edges });
    }
    for (const p of this.parts) if (p.key === key) this.syncMesh(p);
    this.updateMatrices();
  }

  hasGeometry(key: string): boolean {
    return this.entries.has(key);
  }

  setParts(parts: PartDef[], rig: Rig, scale: number, restGround: number): void {
    this.parts = parts;
    this.rig = rig;
    this.scale = scale;
    this.restGround = restGround;
    const ids = new Set(parts.map((p) => p.id));
    for (const [id, m] of this.meshes) if (!ids.has(id)) { m.removeFromParent(); this.meshes.delete(id); }
    for (const p of parts) this.syncMesh(p);
    this.updateMatrices();
    if (!this.framedOnce && parts.length) { this.framedOnce = true; this.frameFigure(); }
  }

  private syncMesh(p: PartDef): void {
    const entry = this.entries.get(p.key);
    let mesh = this.meshes.get(p.id);
    if (!entry) {
      if (mesh) mesh.visible = false;
      return;
    }
    if (!mesh) {
      mesh = new THREE.Mesh(entry.geo, this.mats.frame);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (p.group === 'accessory' && p.node === 'world' ? this.stand : this.figure).add(mesh);
      this.meshes.set(p.id, mesh);
    }
    mesh.geometry = entry.geo;
    mesh.userData.node = p.node;
    mesh.userData.group = p.group;
    mesh.userData.key = p.key;
    let line = mesh.children[0] as THREE.LineSegments | undefined;
    if (!line) {
      line = new THREE.LineSegments(entry.edges ?? undefined, this.mats.edge);
      line.matrixAutoUpdate = false;
      line.raycast = () => {};
      mesh.add(line);
    }
    if (entry.edges) line.geometry = entry.edges;
    this.applyMaterial(mesh);
  }

  private applyMaterial(mesh: THREE.Mesh): void {
    const g = mesh.userData.group as string, sel = this.selected && mesh.userData.node === this.selected;
    mesh.material = g === 'accessory' ? this.mats.accessory : g === 'armor' ? (sel ? this.mats.armorSel : this.mats.armor) : sel ? this.mats.frameSel : this.mats.frame;
    const visible = this.entries.has(mesh.userData.key as string);
    const isWeapon = mesh.userData.key === 'weapon';
    const show = isWeapon ? this.display.frame : g === 'accessory' ? this.display.stand : g === 'armor' ? this.display.armor : this.display.frame;
    mesh.visible = visible && show;
    const line = mesh.children[0] as THREE.LineSegments | undefined;
    if (line) line.visible = this.display.outlines;
  }

  setPose(pose: Pose): void {
    this.pose = pose;
    this.updateMatrices();
  }

  setDisplay(d: Partial<Display>): void {
    this.display = { ...this.display, ...d };
    for (const m of this.meshes.values()) this.applyMaterial(m);
    this.updateMatrices();
  }

  setSelected(node: string | null): void {
    this.selected = node;
    for (const m of this.meshes.values()) this.applyMaterial(m);
    this.requestRender();
  }

  setColors(c: Colors): void {
    this.mats.frame.color.set(c.frame);
    this.mats.frameSel.color.set(c.frame);
    this.mats.armor.color.set(c.armor);
    this.mats.armorSel.color.set(c.armor);
    this.renderer.setClearColor(c.background);
    const lum = new THREE.Color(c.background).getHSL({ h: 0, s: 0, l: 0 }).l;
    this.mats.edge.color.set(lum < 0.35 ? 0x000000 : 0x1b1d21);
    this.requestRender();
  }

  private updateMatrices(): void {
    if (!this.rig) return;
    const k = this.display.explode;
    const rig = k > 0 ? explodedRig(this.rig, k) : this.rig;
    const posed = restToPosed(rig, this.pose);
    const shift = new THREE.Matrix4();
    const off = new THREE.Vector3();
    let minY = Infinity;
    const v = new THREE.Vector3();
    for (const p of this.parts) {
      const mesh = this.meshes.get(p.id);
      if (!mesh) continue;
      const nodeRest = this.rig.byId[p.node]?.pivot;
      const nodeExp = rig.byId[p.node]?.pivot;
      off.set(0, 0, 0);
      if (nodeRest && nodeExp) off.set(nodeExp[0] - nodeRest[0], nodeExp[1] - nodeRest[1], nodeExp[2] - nodeRest[2]);
      if (k > 0 && p.explode) off.addScaledVector(new THREE.Vector3(...p.explode), k * 9 * this.scale);
      shift.makeTranslation(off.x, off.y, off.z);
      const base = posed[p.node] ?? posed.world;
      mesh.matrix.copy(base).multiply(shift).multiply(p.mount);
      mesh.matrixWorldNeedsUpdate = true;
      if (p.node !== 'world' && p.key !== 'weapon' && mesh.visible) {
        const raw = this.entries.get(p.key)?.raw.positions;
        if (raw) {
          const step = raw.length > 30000 ? 9 : 3;
          for (let i = 0; i < raw.length; i += step) {
            v.set(raw[i], raw[i + 1], raw[i + 2]).applyMatrix4(mesh.matrix);
            if (v.y < minY) minY = v.y;
          }
        }
      }
    }
    if (Number.isFinite(minY)) this.figure.position.y = -minY;
    this.stand.position.y = this.restGround;
    this.requestRender();
  }

  // ---------- camera ----------

  frameFigure(): void {
    const box = new THREE.Box3().setFromObject(this.figure);
    if (box.isEmpty()) {
      const h = 140 * this.scale;
      box.set(new THREE.Vector3(-40, 0, -20), new THREE.Vector3(40, h, 20));
    }
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const aspect = this.camera.aspect || 1;
    const r = Math.max(size.y, (size.x * 1.1) / Math.min(aspect, 1)) * 0.5;
    const dist = (r / Math.tan((this.camera.fov * Math.PI) / 360)) * (aspect < 1 ? 1.5 : 1.35);
    const dir = new THREE.Vector3(0.45, 0.22, 1).normalize();
    // leave room for the toolbar overlay at the top of the viewport
    c.y += size.y * 0.06;
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = dist / 50;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setMode(mode: 'figure' | 'plates'): void {
    this.mode = mode;
    this.figure.visible = mode === 'figure';
    this.stand.visible = mode === 'figure';
    this.platesGroup.visible = mode === 'plates';
    this.ground.visible = mode === 'figure';
    this.grid.visible = mode === 'figure';
    if (mode === 'plates') this.framePlates();
    else this.frameFigure();
  }

  showPlates(plates: PlateView[]): void {
    for (const c of [...this.platesGroup.children]) {
      c.removeFromParent();
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    let x = 0;
    for (const pl of plates) {
      const g = new THREE.Group();
      g.position.set(x, 0, 0);
      const bed = new THREE.Mesh(new THREE.BoxGeometry(pl.bedX, pl.bedY, 1.2), this.mats.plate);
      bed.position.set(pl.bedX / 2, pl.bedY / 2, -0.6);
      bed.receiveShadow = true;
      g.add(bed);
      const label = makeLabel(pl.label);
      label.position.set(pl.bedX / 2, -12, 0);
      label.scale.set(pl.bedX * 0.55, pl.bedX * 0.55 * 0.18, 1);
      g.add(label);
      for (const it of pl.items) {
        const geo0 = new THREE.BufferGeometry();
        geo0.setAttribute('position', new THREE.BufferAttribute(it.positions, 3));
        geo0.setIndex(new THREE.BufferAttribute(it.indices, 1));
        const geo = toCreasedNormals(geo0, Math.PI / 7);
        geo0.dispose();
        const mat = it.group === 'armor' ? this.mats.armor : it.group === 'accessory' ? this.mats.accessory : this.mats.frame;
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        m.applyMatrix4(it.matrix);
        g.add(m);
      }
      this.platesGroup.add(g);
      x += pl.bedX + 30;
    }
    if (this.mode === 'plates') this.framePlates();
    this.requestRender();
  }

  private framePlates(): void {
    this.platesGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.platesGroup);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z) * 0.55;
    const dist = r / Math.tan((this.camera.fov * Math.PI) / 360) * 1.1;
    this.controls.target.copy(c);
    this.camera.position.set(c.x, c.y + dist * 0.9, c.z + dist * 0.55);
    this.camera.near = dist / 50;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

function explodedRig(rig: Rig, k: number): Rig {
  const f = 1 + k * 0.45;
  const nodes = rig.nodes.map((n) => ({ ...n }));
  const byId: Rig['byId'] = {};
  for (const n of nodes) byId[n.id] = n;
  for (const n of nodes) {
    if (!n.parent) continue;
    const p = byId[n.parent], orig = rig.byId[n.id], origP = rig.byId[n.parent];
    n.pivot = [
      p.pivot[0] + (orig.pivot[0] - origP.pivot[0]) * f,
      p.pivot[1] + (orig.pivot[1] - origP.pivot[1]) * f,
      p.pivot[2] + (orig.pivot[2] - origP.pivot[2]) * f,
    ];
  }
  return { nodes, byId, points: rig.points };
}

function makeLabel(text: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 92;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#5b544b';
  g.font = '600 48px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 48);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  return sp;
}
