// 3D sketch mode (beta): draw strokes in 3D space, say what it is, get a
// low-poly model. The framework-free engine behind the React 3D view, like
// editor/engine.ts for the image mode: React reads its snapshot through
// useSyncExternalStore and calls its actions.

import * as THREE from 'three';
import { Builder, type Part } from './build';
import { Stage } from './scene';
import { Sketch, type Stroke } from './sketch';
import { renderViews, strokeColor, type View } from './views';
import { Voice } from './voice';
import { applyPaint, renderModel } from './paint';
import { penStroke, screenOf } from './replay';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { watchTheme } from '../editor/colors';
import { paintModel, perceive } from '../runtime/perceive';
import { countJob, limits, ProxyError } from '../runtime/meta';
import { put } from '../runtime/store';

export type ViewName = 'front' | 'side' | 'top' | 'three';
export type Snapshot3D = {
  status: string;
  working: boolean; // Spark or Muse Image is at work
  recording: boolean;
  caption: string;
  views: { name: string; image: string }[]; // what Spark looks at (and the painting)
  thinking: boolean;
  result: { say: string; parts: { name: string; color: string }[]; ms: number } | null;
  plane: 'view' | 'ground';
  pen: 'auto' | 'point' | 'shape'; // Point: marks an existing part; Shape: draws geometry; auto: Spark decides
  sketchVisible: boolean;
  gridVisible: boolean;
  wireframe: boolean;
  hasModel: boolean;
  hasStrokes: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

const IDLE = 'Draw with the pen, hold the mic and say what it is';
const SHAPES = { line: 'a line', circle: 'a circle', ellipse: 'an ellipse', arc: 'an arc', arrow: 'an arrow' };

class Engine3D {
  private snapshot: Snapshot3D = { status: IDLE, working: false, recording: false, caption: '', views: [], thinking: false, result: null, plane: 'view', pen: 'auto', sketchVisible: true, gridVisible: true, wireframe: false, hasModel: false, hasStrokes: false, canUndo: false, canRedo: false };
  private listeners = new Set<() => void>();
  // Failures and notices, shown the same way as in the image mode (toasts).
  onError: (message: string) => void = () => {};
  onNotice: (message: string) => void = () => {};
  private imported: THREE.Object3D | null = null; // a .glb opened as a reference to sketch over
  private stage: Stage | null = null;
  private sketch!: Sketch;
  private builder!: Builder;
  private voice = new Voice((text) => this.set({ caption: text }));
  private busy = false;
  private pressedAt = 0;
  private toggled = false;
  private builds: { parts: Part[]; transcript: string }[] = [];
  // What Undo took away, for Redo: a stroke, or a build (its parts and result).
  private redos: ({ kind: 'stroke'; stroke: Stroke } | { kind: 'build'; parts: Part[]; transcript: string; result: Snapshot3D['result'] })[] = [];
  private subject = '';

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;
  private set(patch: Partial<Snapshot3D>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
  private status(status: string, working = false) {
    this.set({ status, working });
  }
  private sync() {
    this.set({ hasModel: this.builder.parts.length > 0, hasStrokes: this.sketch.strokes.length > 0, canUndo: this.sketch.strokes.length > 0 || this.builds.length > 0, canRedo: this.redos.length > 0 });
  }

  // The scene is made once and moved into the view each time 3D mode mounts.
  attach(host: HTMLElement) {
    if (this.stage) this.stage.mount(host);
    else {
      const stage = (this.stage = new Stage(host));
      this.sketch = new Sketch(stage);
      this.builder = new Builder(stage);
      this.sketch.onChange = () => this.sync();
      this.sketch.onStroke = () => (this.redos = []); // a new stroke ends the redo history
      watchTheme(() => (stage.applyTheme(), this.sketch.applyTheme()));
      this.sketch.onSnap = (kind) => this.status(`QuickShape: snapped to ${SHAPES[kind]} · Undo brings back the stroke as drawn`);
      // After a build the model turns slowly until the user touches the scene.
      stage.renderer.domElement.addEventListener('pointerdown', () => (stage.controls.autoRotate = false));
      this.highlightOnHover(stage);
      Object.assign(window, { THREE, stage, sketch: this.sketch, builder: this.builder, demoChair: () => this.demoChair(), demoHouse: () => this.demoHouse(), replayChair: (say?: string) => this.replayChair(say), quickShapeDemo: () => this.quickShapeDemo() });
    }
    return () => {};
  }

  goTo(view: ViewName) {
    this.stage?.goTo(view);
  }

  fit() {
    this.stage?.fit();
  }

  // Selection highlight: the part under the pen or mouse (not while drawing)
  // glows softly.
  private highlightOnHover(stage: Stage) {
    const el = stage.renderer.domElement;
    const ray = new THREE.Raycaster();
    const glow = new THREE.Color('#2f6fde').multiplyScalar(0.3);
    let lit: THREE.Mesh | null = null;
    const light = (mesh: THREE.Mesh | null) => {
      if (mesh === lit) return;
      const emissive = (m: THREE.Mesh | null) => (m?.material as THREE.MeshStandardMaterial | undefined)?.emissive;
      emissive(lit)?.setHex(0);
      lit = mesh;
      emissive(lit)?.copy(glow);
    };
    el.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType === 'touch' || !stage.model.children.length) return light(null);
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), stage.camera);
      const hit = ray.intersectObjects(stage.model.children, true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.userData.part);
      light((hit?.object as THREE.Mesh | undefined) ?? null);
    });
    el.addEventListener('pointerleave', () => light(null));
    el.addEventListener('pointerdown', () => light(null));
  }

  setPlane(plane: 'view' | 'ground') {
    this.sketch.mode = plane;
    this.set({ plane });
  }

  setPen(pen: Snapshot3D['pen']) {
    this.sketch.pen = pen;
    this.set({ pen });
  }

  toggleGrid() {
    const gridVisible = !this.snapshot.gridVisible;
    const floor = this.stage?.helpers.getObjectByName('floor');
    if (floor) floor.visible = gridVisible;
    this.set({ gridVisible });
  }

  toggleWireframe() {
    const wireframe = !this.snapshot.wireframe;
    this.stage?.model.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && m && 'wireframe' in m) m.wireframe = wireframe;
    });
    this.set({ wireframe });
  }

  // Open a .glb/.gltf as a reference to sketch over and around (strokes can
  // land on its surface); it is not part of what Spark builds.
  async importModel(file: File) {
    if (!this.stage) return;
    try {
      const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
      if (this.imported) this.stage.model.remove(this.imported);
      this.imported = gltf.scene;
      this.stage.model.add(gltf.scene);
      this.stage.fit();
      this.sync();
    } catch (e) {
      this.onError(`That file didn’t open: ${String(e).slice(0, 120)}`);
    }
  }

  // The model as a binary glTF (.glb) download.
  async exportGlb() {
    if (!this.stage || !this.builder.parts.length) return;
    this.builder.finish();
    const glb = (await new GLTFExporter().parseAsync(this.stage.model, { binary: true })) as ArrayBuffer;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
    a.download = `${(this.subject || 'model').replace(/\W+/g, '-')}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  toggleSketch() {
    const sketchVisible = !this.snapshot.sketchVisible;
    this.sketch.setVisible(sketchVisible);
    this.set({ sketchVisible });
  }

  clear() {
    this.sketch.clear();
    this.builder.clear();
    if (this.imported) this.stage!.model.remove(this.imported);
    this.imported = null;
    this.builds.length = 0;
    this.redos = [];
    this.sketch.round = 1;
    this.set({ result: null, views: [], caption: '' });
    this.status(IDLE);
    this.sync();
  }

  // ---------- talk: hold (or tap to toggle), or hold Space ----------

  async talkDown() {
    if (this.toggled) {
      this.toggled = false;
      return this.stopTalk('');
    }
    this.pressedAt = performance.now();
    await this.startTalk();
  }

  talkUp(typed = '') {
    if (!this.voice.recording || this.toggled) return;
    if (performance.now() - this.pressedAt < 300) this.toggled = true; // a tap: keep listening until the next tap
    else this.stopTalk(typed);
  }

  private async startTalk() {
    if (this.voice.recording || this.busy) return;
    this.set({ recording: true, caption: '' });
    this.status('Listening · draw while you talk');
    // A take is at most maxRecordingSeconds long.
    clearTimeout(this.talkTimer);
    this.talkTimer = window.setTimeout(() => this.voice.recording && ((this.toggled = false), this.stopTalk('')), limits().maxRecordingSeconds * 1000);
    try {
      await this.voice.start();
    } catch (e) {
      this.set({ recording: false });
      this.status(IDLE);
      this.onNotice(`Microphone unavailable (${e}). Type instead with the keyboard button.`);
    }
  }

  private talkTimer: number | undefined;

  async stopTalk(typed: string) {
    clearTimeout(this.talkTimer);
    if (!this.voice.recording) return;
    this.set({ recording: false });
    this.status('Transcribing', true);
    const r = await this.voice.stop().catch(() => ({ text: '', via: 'error', ms: 0 }));
    const text = [r.text, typed].filter(Boolean).join(' ');
    this.set({ caption: text ? `“${text}”` : '' });
    await this.perceive(text);
  }

  // Build from the sketch and typed words, without the mic.
  make(text = '') {
    if (text) this.set({ caption: `“${text}”` });
    return this.perceive(text);
  }

  // ---------- undo: strokes of this round first, then whole builds ----------

  private undoBuild(forRedo = true) {
    const b = this.builds.pop();
    if (!b) return null;
    if (forRedo) this.redos.push({ kind: 'build', parts: this.builder.parts, transcript: b.transcript, result: this.snapshot.result });
    if (b.parts.length) this.builder.apply(b.parts, this.sketch.strokes);
    else this.builder.clear();
    this.sketch.unsettle();
    this.stage!.controls.autoRotate = false;
    this.set({ result: null });
    this.sync();
    return b;
  }

  undo() {
    if (this.busy) return;
    if (this.sketch.current().length) {
      // A snapped stroke first goes back to how it was drawn (not redoable).
      const last = this.sketch.strokes.at(-1)!;
      const snapped = !!last.raw;
      this.sketch.undo();
      if (!snapped) this.redos.push({ kind: 'stroke', stroke: last });
    } else this.undoBuild();
    this.sync();
  }

  redo() {
    const r = this.redos.pop();
    if (!r || this.busy) return;
    if (r.kind === 'stroke') this.sketch.restore(r.stroke);
    else {
      this.builds.push({ parts: this.builder.parts, transcript: r.transcript });
      this.builder.apply(r.parts, this.sketch.strokes);
      this.sketch.settle();
      this.set({ result: r.result });
    }
    this.sync();
  }

  // Same strokes and words, a fresh answer.
  reroll() {
    if (this.busy) return;
    const b = this.undoBuild(false);
    if (b) this.perceive(b.transcript);
  }

  // ---------- paint: Muse Image repaints the current view, projected back on ----------

  async paint(style = '') {
    if (this.busy || !this.builder.parts.length) return;
    const stage = this.stage!;
    this.busy = true;
    stage.controls.autoRotate = false;
    this.status('Muse Image is painting the model from this view', true);
    try {
      await countJob('paint').catch((e) => {
        if (e instanceof ProxyError) throw e;
      });
      this.builder.finish();
      const { image, mask, cam } = renderModel(stage);
      const r = await paintModel(image, this.subject, style);
      await applyPaint(stage, r.image, cam, mask);
      this.set({ views: [{ name: 'MUSE IMAGE', image: r.image }, ...this.snapshot.views] });
      this.status(`Muse Image ${(r.ms / 1000).toFixed(1)} s · best seen from the painted side`);
    } catch (e) {
      this.status(IDLE);
      this.onError(`Painting didn’t come through: ${String(e).slice(0, 160)}`);
    } finally {
      this.busy = false;
    }
  }

  // ---------- perceive → build ----------

  private strokeInfo(s: Stroke) {
    const box = new THREE.Box3().setFromPoints(s.points);
    const n = Math.min(8, s.points.length);
    const points = Array.from({ length: n }, (_, i) => s.points[Math.round((i * (s.points.length - 1)) / Math.max(1, n - 1))].toArray());
    return { id: s.id, color: strokeColor(s.id), drawnFrom: s.viewDir.toArray(), plane: s.plane, bbox: { min: box.min.toArray(), max: box.max.toArray() }, points, closed: s.closed, ...(s.pen ? { pen: s.pen } : {}) };
  }

  async perceive(transcript: string) {
    if (this.busy || !this.stage) return;
    const stage = this.stage, sketch = this.sketch, builder = this.builder;
    const editing = builder.parts.length > 0;
    const strokes = editing ? sketch.current() : sketch.strokes;
    if (!strokes.length && !(editing && transcript)) return this.onNotice('Draw something first, then talk or type.');
    this.busy = true;
    // Each build counts against the free daily jobs.
    try {
      await countJob('build');
    } catch (e) {
      if (e instanceof ProxyError) {
        this.busy = false;
        return this.status(e.message);
      }
    }
    const before = builder.parts;
    this.status('Looking at the sketch from six sides', true);
    builder.finish();
    const views: View[] = renderViews(stage, strokes, { withModel: editing });
    this.set({ views: views.map((v) => ({ name: v.name, image: v.image })), thinking: true });
    // The strokes Spark is looking at pulse until the answer is in.
    const pulse = (now: number) => {
      if (!this.busy || builder.parts !== before) return;
      for (const s of strokes) (s.line.material as any).opacity = 0.55 + 0.45 * Math.cos(now / 180);
    };
    stage.onTick(pulse);
    try {
      // Parts arrive one by one while Spark writes them.
      const got: Part[] = [];
      let said = '';
      const t0 = Date.now();
      const r = await perceive({ views, transcript, strokes: strokes.map((s) => this.strokeInfo(s)), parts: builder.parts }, (ev) => {
        if (ev.type === 'say') said = ev.say;
        if (ev.type === 'part') {
          got.push(ev.part as Part);
          builder.apply(got, sketch.strokes, true);
          this.status(`Building · ${got.length} ${got.length === 1 ? 'part' : 'parts'}`, true);
        }
      });
      const a = r.answer;
      this.subject = a.subject;
      this.builds.push({ parts: before, transcript });
      builder.apply(a.parts as Part[], sketch.strokes);
      if (this.snapshot.wireframe) this.set({ wireframe: false });
      sketch.settle();
      stage.controls.autoRotateSpeed = 1.6;
      stage.controls.autoRotate = true;
      this.set({ result: { say: a.say || said || a.subject, parts: a.parts.map((p) => ({ name: p.name, color: p.color })), ms: r.ms } });
      this.redos = [];
      this.status(`${a.subject} · ${a.parts.length} parts · ${(r.ms / 1000).toFixed(1)} s`);
      (window as any).last = { type: 'done', ...r };
      put('models', { id: crypto.randomUUID().slice(0, 8), at: t0, transcript, subject: a.subject, say: a.say, parts: a.parts, ms: r.ms, firstMs: r.firstMs, usage: r.usage });
    } catch (e) {
      this.status(IDLE);
      this.onError(`That build didn’t come through: ${String(e).slice(0, 160)}`);
    } finally {
      this.busy = false;
      stage.offTick(pulse);
      if (builder.parts === before) for (const s of strokes) (s.line.material as any).opacity = 1; // failed: strokes stay current
      this.set({ thinking: false, working: false });
      this.sync();
    }
  }

  // ---------- scripted sketches for testing without a pen ----------

  private path(pts: THREE.Vector3[], jitter = 0.006) {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const steps = Math.max(4, Math.round(pts[i].distanceTo(pts[i + 1]) / 0.03));
      for (let k = 0; k < steps; k++) out.push(pts[i].clone().lerp(pts[i + 1], k / steps).add(V((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter, 0)));
    }
    out.push(pts[pts.length - 1].clone());
    return out;
  }

  demoChair() {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const f = (pts: THREE.Vector3[]) => this.sketch.addStroke(this.path(pts), { viewDir: V(0, 0, -1) });
    const s = (pts: THREE.Vector3[]) => this.sketch.addStroke(this.path(pts), { viewDir: V(-1, 0, 0) });
    f([V(-0.25, 0.45, 0), V(0.25, 0.45, 0)]);
    f([V(-0.23, 0.45, 0), V(-0.23, 0, 0)]);
    f([V(0.23, 0.45, 0), V(0.23, 0, 0)]);
    f([V(-0.23, 0.5, 0), V(-0.23, 0.95, 0), V(0.23, 0.95, 0), V(0.23, 0.5, 0)]);
    s([V(0, 0.45, 0.22), V(0, 0.45, -0.22)]);
    s([V(0, 0.45, 0.2), V(0, 0, 0.2)]);
    s([V(0, 0, -0.2), V(0, 0.45, -0.2), V(0, 0.95, -0.27)]);
  }

  demoHouse() {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const f = (pts: THREE.Vector3[], closed = false) => this.sketch.addStroke(this.path(pts), { viewDir: V(0, 0, -1), closed });
    const s = (pts: THREE.Vector3[]) => this.sketch.addStroke(this.path(pts), { viewDir: V(-1, 0, 0) });
    f([V(-0.4, 0, 0), V(-0.4, 0.5, 0), V(0, 0.85, 0), V(0.4, 0.5, 0), V(0.4, 0, 0), V(-0.4, 0, 0)], true);
    f([V(-0.08, 0, 0), V(-0.08, 0.28, 0), V(0.08, 0.28, 0), V(0.08, 0, 0)]);
    f([V(0.18, 0.75, 0), V(0.18, 0.95, 0), V(0.28, 0.95, 0), V(0.28, 0.66, 0)]);
    s([V(0, 0.5, 0.4), V(0, 0.5, -0.4), V(0, 0, -0.4)]);
    s([V(0, 0.85, 0.45), V(0, 0.85, -0.45)]);
  }

  // The chair drawn with pen events from the front, then the side, while the
  // caption shows what would be said; then the usual build.
  async replayChair(say = '의자야, 등받이는 이렇게') {
    const stage = this.stage!;
    const at = (x: number, y: number, z: number) => screenOf(stage, x, y, z);
    const settle = async (view: ViewName) => {
      // Glide when frames are running; snap in a hidden or throttled tab.
      const f0 = stage.frames;
      await new Promise((r) => setTimeout(r, 100));
      stage.goTo(view, stage.frames - f0 < 4);
      await new Promise((r) => setTimeout(r, 650));
    };
    this.clear();
    await settle('front');
    this.set({ caption: say.split(',')[0] });
    await penStroke(stage, [at(-0.26, 0.45, 0), at(0.26, 0.46, 0)]);
    await penStroke(stage, [at(-0.23, 0.44, 0), at(-0.235, 0.0, 0)]);
    await penStroke(stage, [at(0.23, 0.44, 0), at(0.225, 0.0, 0)]);
    await penStroke(stage, [at(-0.22, 0.47, 0), at(-0.21, 0.95, 0), at(0.21, 0.96, 0), at(0.22, 0.47, 0)], 900);
    await settle('side');
    this.set({ caption: say });
    await penStroke(stage, [at(0, 0.45, 0.22), at(0, 0.45, -0.22)]);
    await penStroke(stage, [at(0, 0.44, 0.2), at(0, 0.0, 0.2)]);
    await penStroke(stage, [at(0, 0.0, -0.2), at(0, 0.45, -0.2), at(0, 0.95, -0.3)], 800);
    await settle('three');
    this.set({ caption: `“${say}”` });
    await this.perceive(say);
  }

  // QuickShape before/after: the same wobbly shapes drawn twice, lifted at once
  // (top row, stays as drawn) and held still before lifting (bottom row, snapped).
  async quickShapeDemo() {
    const stage = this.stage!;
    this.clear();
    stage.goTo('front', true);
    const r = stage.renderer.domElement.getBoundingClientRect();
    const sz = r.width * 0.06;
    const row = (y: number): [number, number][][] => {
      const cx = (k: number) => r.left + r.width * (0.2 + 0.15 * k);
      const ring = (x: number, rx: number, ry: number, a0: number, a1: number) => Array.from({ length: 40 }, (_, i) => [x + rx * Math.cos(a0 + ((a1 - a0) * i) / 39), y + ry * Math.sin(a0 + ((a1 - a0) * i) / 39)] as [number, number]);
      const x4 = cx(4);
      return [
        [[cx(0) - sz, y + sz * 0.6], [cx(0) + sz, y - sz * 0.6]],
        ring(cx(1), sz, sz, 0, 2.05 * Math.PI),
        ring(cx(2), sz * 1.15, sz * 0.6, 0.3, 0.3 + 2.03 * Math.PI),
        ring(cx(3), sz, sz, 0.9 * Math.PI, 2.1 * Math.PI),
        [[x4 - sz, y + sz * 0.4], [x4 + sz, y - sz * 0.4], [x4 + sz * 0.55, y - sz * 0.45], [x4 + sz, y - sz * 0.4], [x4 + sz * 0.75, y + sz * 0.02]],
      ];
    };
    const top = r.top + r.height * 0.3, bottom = r.top + r.height * 0.58;
    for (const pts of row(top)) await penStroke(stage, pts, 450, 7, { wobble: 3.5 });
    for (const pts of row(bottom)) await penStroke(stage, pts, 450, 7, { wobble: 3.5, holdMs: 550 });
    return this.sketch.strokes.map((s) => s.shape ?? 'as drawn');
  }
}

export const engine3d = new Engine3D();
