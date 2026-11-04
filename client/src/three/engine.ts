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
import { runtime } from '../runtime';
import { SurfaceBaker } from '../surface/bake';

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
  // An opened model as a part Spark edits around (kept as is, never rebuilt): set by loadModel.
  private importedPart: Part | null = null;
  // Surface edits on the opened model: the 2D pipeline on the view, baked into its textures.
  private baker: SurfaceBaker | null = null;
  private surfaceEdits = 0;
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
    this.set({ hasModel: this.builder.parts.length > 0 || !!this.imported, hasStrokes: this.sketch.strokes.length > 0, canUndo: this.sketch.strokes.length > 0 || this.builds.length > 0, canRedo: this.redos.length > 0 });
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
      Object.assign(window, { THREE, stage, sketch: this.sketch, builder: this.builder, demoChair: () => this.demoChair(), demoHouse: () => this.demoHouse(), replayChair: (say?: string) => this.replayChair(say), loadModel: (url: string, name?: string, height?: number) => this.loadModel(url, name, height), drawGuides: (view: ViewName | null, strokes: number[][][], caption?: string) => this.drawGuides(view, strokes, caption), make: (text?: string) => this.make(text), quickShapeDemo: () => this.quickShapeDemo() });
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

  // A high-quality model to edit (the Sample model): sized to stand about half a
  // metre tall on the ground, then edits are drawn on and around it; Spark sees
  // it as one part it keeps as it is.
  // `height`: how tall it stands (m); a model lying along x or z (a sword) is stood upright.
  async loadModel(url: string, name = 'imported model', height = 0.5) {
    if (!this.stage) return;
    try {
      this.clear();
      const gltf = await new GLTFLoader().loadAsync(url);
      const turn = new THREE.Group();
      turn.add(gltf.scene);
      const s0 = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
      if (s0.z > s0.y && s0.z >= s0.x) turn.rotation.x = -Math.PI / 2;
      else if (s0.x > s0.y) turn.rotation.z = Math.PI / 2;
      turn.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(turn);
      const size = box.getSize(new THREE.Vector3());
      const k = height / Math.max(size.y, 0.001);
      turn.scale.setScalar(k);
      turn.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k + 0.02, -((box.min.z + box.max.z) / 2) * k);
      const group = new THREE.Group();
      group.add(turn);
      this.imported = group;
      this.stage.model.add(group);
      group.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(group);
      const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      this.importedPart = { name, primitive: 'mesh', center: c.toArray().map(r3), size: sz.toArray().map(r3), rotation: [0, 0, 0], color: '#808080', material: 'metal', strokes: [], profile: -1, path: [], radii: [], outline: [] };
      this.stage.fit();
      this.status(`${name} · draw on it and say the change`);
      this.sync();
    } catch (e) {
      this.onError(`That model didn’t open: ${String(e).slice(0, 120)}`);
    }
  }

  // New parts on an opened model: a horn or wing rooted on its surface (a ray
  // from just outside its root toward the model's middle, the root moved to
  // the hit), and each part in the model's own look there: the color under the
  // hit (vertex color, texel or material color) a little lighter or darker for
  // an accent, and its roughness and metalness. Spark's color stays when the
  // words ask for one (or for flames).
  private onSurface(parts: Part[], before: Part[], transcript = ''): Part[] {
    const model = this.imported;
    if (!model) return parts;
    const meshes: THREE.Object3D[] = [];
    model.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o));
    const box = new THREE.Box3().setFromObject(model);
    const mid = box.getCenter(new THREE.Vector3());
    const old = new Set(before.map((p) => p.name));
    const ray = new THREE.Raycaster();
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const named = /\b(red|orange|yellow|green|blue|purple|pink|black|white|gold|golden|silver|bronze|flames?|fire|glow\w*)\b/i.test(transcript);
    return parts.map((p) => {
      if (old.has(p.name) || p.primitive === 'mesh') return p;
      const root = new THREE.Vector3().fromArray(p.center);
      const dir = mid.clone().sub(root).normalize();
      ray.set(root.clone().addScaledVector(dir, -0.3), dir);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) return p;
      let q = p;
      // A tube that already runs through the model (a guard across a blade) stays as drawn.
      const through = p.primitive === 'tube' && p.path?.some((v) => box.containsPoint(root.clone().add(new THREE.Vector3().fromArray(v))));
      if ((p.primitive === 'tube' || p.primitive === 'membrane') && !through) {
        const inset = p.primitive === 'tube' ? Math.abs(p.radii?.[0] ?? 0.02) * 0.6 : 0.005;
        const to = hit.point.clone().addScaledVector(dir, inset);
        const shift = root.clone().sub(to);
        // A tube keeps its drawn curve (only its base moves); a membrane moves whole.
        const path = p.primitive === 'tube' && p.path ? p.path.map((v, i) => (i === 0 ? v : v.map((x, a) => r3(x + shift.getComponent(a))))) : p.path;
        q = { ...p, center: to.toArray().map(r3), ...(path ? { path } : {}) };
      }
      const look = surfaceLook(hit);
      if (!look) return q;
      const accent = look.color.clone();
      const hsl = accent.getHSL({ h: 0, s: 0, l: 0 });
      accent.setHSL(hsl.h, Math.min(1, hsl.s * 1.15), hsl.l > 0.55 ? hsl.l - 0.14 : hsl.l + 0.14);
      return { ...q, ...(named ? {} : { color: `#${accent.getHexString()}` }), roughness: look.roughness, metalness: look.metalness };
    });
  }

  // Marks drawn ON the opened model with a request to change its look
  // (engrave, recolor, a pattern, "this shape") edit its texture; strokes off
  // it, or "add … here", make parts that follow them.
  private surfaceRoute(strokes: Stroke[], transcript: string) {
    if (!this.imported || !strokes.length || !strokes.every((s) => s.plane === 'surface')) return false;
    return !/^\s*(add|attach|put|give|grow|stick|place)\b/i.test(transcript) && !/\b(horns?|wings?|tail|spikes?|handle|guard)\b/i.test(transcript);
  }

  // The current view through the 2D pipeline (render, marks, words → Spark,
  // SAM, Muse Image, pasted back only inside the marks), then baked into the
  // model's base-color (and emissive) texture (surface/bake.ts).
  private async surfaceEdit(strokes: Stroke[], transcript: string) {
    const stage = this.stage!, canvas = stage.renderer.domElement;
    let mesh: THREE.Mesh | null = null;
    this.imported!.traverse((o) => !mesh && (o as THREE.Mesh).isMesh && (mesh = o as THREE.Mesh));
    if (!mesh) return this.onNotice('This model has no surface to paint.');
    if (!transcript) return this.onNotice('Say or type what to change there.');
    if (!this.baker || (this.baker as any).mesh !== mesh) this.baker = new SurfaceBaker(stage.renderer, mesh);
    this.busy = true;
    this.set({ thinking: true, caption: `“${transcript}”` });
    this.status('Looking at the surface', true);
    const t0 = performance.now();
    try {
      stage.controls.autoRotate = false;
      stage.controls.update();
      // The view as it is, without the strokes (they go as marks), and once more without glow (the bake's lighting reference).
      const scene = stage.scene;
      const hidden = [stage.sketch, stage.helpers].map((o) => [o, o.visible] as const);
      for (const [o] of hidden) o.visible = false;
      stage.renderer.render(scene, stage.camera);
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'));
      const material = (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
      const glow = material.emissiveIntensity;
      material.emissiveIntensity = 0;
      stage.renderer.render(scene, stage.camera);
      const plain = await createImageBitmap(canvas);
      material.emissiveIntensity = glow;
      for (const [o, v] of hidden) o.visible = v;
      const cam = stage.camera.clone();
      const marks = strokes.map((s, k) => ({
        mark: k + 1,
        points: s.points.map((p, i) => {
          const v = p.clone().project(cam);
          return { x: ((v.x + 1) / 2) * canvas.width, y: ((1 - v.y) / 2) * canvas.height, t: k * 1500 + i * 20 };
        }),
      }));
      const { imageId } = await runtime.uploadImage(blob);
      const { id } = runtime.startJob({ imageId, strokes: marks, pcm: null, asr: null, text: transcript });
      let job = runtime.job(id)!;
      while (job.stage !== 'done' && job.stage !== 'error') {
        this.status(`Editing the surface · ${((performance.now() - t0) / 1000).toFixed(0)} s`, true);
        await new Promise((r) => setTimeout(r, 250));
        job = runtime.job(id)!;
      }
      if (job.stage === 'error') throw new Error(job.error);
      const rendered = runtime.bitmap(imageId), edited = runtime.bitmap(job.resultImageId!);
      if (!rendered || !edited) throw new Error('the edited view is missing');
      this.baker.bake(cam, rendered, plain, edited);
      this.surfaceEdits++;
      while (this.sketch.current().length) this.sketch.undo();
      const ms = performance.now() - t0;
      const said = job.edits?.map((e) => e.instruction).join('; ') || transcript;
      this.set({ result: { say: said, parts: [], ms } });
      this.status(`On the surface · ${(ms / 1000).toFixed(1)} s · turn it around · Undo restores it`);
      (window as any).lastSurface = { ms, edits: job.edits };
    } catch (e) {
      this.status(IDLE);
      this.onError(`That surface edit didn’t come through: ${String(e).slice(0, 160)}`);
    } finally {
      this.busy = false;
      this.set({ thinking: false });
      this.sync();
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
    this.importedPart = null;
    this.baker = null;
    this.surfaceEdits = 0;
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
    } else if (this.surfaceEdits && this.baker?.undo()) this.surfaceEdits--;
    else this.undoBuild();
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
    // The whole stroke, 48 points evenly along it: drawn shapes are built from it (fit-parts.ts); Spark sees `points`.
    const trace = resample(s.points, 48).map((p) => p.toArray().map((v) => Math.round(v * 1000) / 1000));
    return { id: s.id, color: strokeColor(s.id), drawnFrom: s.viewDir.toArray(), plane: s.plane, bbox: { min: box.min.toArray(), max: box.max.toArray() }, points, trace, closed: s.closed, ...(s.pen ? { pen: s.pen } : {}) };
  }

  async perceive(transcript: string) {
    if (this.busy || !this.stage) return;
    const stage = this.stage, sketch = this.sketch, builder = this.builder;
    const editing = builder.parts.length > 0 || !!this.importedPart;
    if (this.surfaceRoute(editing ? sketch.current() : sketch.strokes, transcript)) return this.surfaceEdit(sketch.current(), transcript);
    // The opened model goes in as a part Spark keeps (the builder never draws it).
    const current = this.importedPart && !builder.parts.some((p) => p.primitive === 'mesh') ? [this.importedPart, ...builder.parts] : builder.parts;
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
      const r = await perceive({ views, transcript, strokes: strokes.map((s) => this.strokeInfo(s)), parts: current }, (ev) => {
        if (ev.type === 'say') said = ev.say;
        if (ev.type === 'part') {
          got.push(ev.part as Part);
          builder.apply(this.onSurface(got, current, transcript), sketch.strokes, true);
          this.status(`Building · ${got.length} ${got.length === 1 ? 'part' : 'parts'}`, true);
        }
      });
      const a = r.answer;
      this.subject = a.subject;
      this.builds.push({ parts: before, transcript });
      a.parts = this.onSurface(a.parts as Part[], current, transcript);
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

  // 3D polylines drawn with pen events from a named view, the caption showing
  // what is said (a stroke that starts on the model is drawn on its surface).
  // With make(), the replay harness for any sketch and edit.
  // `view` null: from where the camera is.
  async drawGuides(view: ViewName | null, strokes: number[][][], caption = '') {
    const stage = this.stage!;
    stage.controls.autoRotate = false;
    if (view) {
      const f0 = stage.frames;
      await new Promise((r) => setTimeout(r, 100));
      stage.goTo(view, stage.frames - f0 < 4);
      await new Promise((r) => setTimeout(r, 650));
    }
    if (caption) this.set({ caption });
    for (const pts of strokes) await penStroke(stage, pts.map(([x, y, z]) => screenOf(stage, x, y, z)), 300 + 60 * pts.length);
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

// The look of a model's surface at a ray hit: its color (vertex color, else the
// base-color texel, times the material color) and its roughness and metalness.
const texels = new Map<string, { data: Uint8ClampedArray; w: number; h: number }>();
function surfaceLook(hit: THREE.Intersection) {
  const mesh = hit.object as THREE.Mesh;
  const mat = (Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material) as THREE.MeshStandardMaterial;
  if (!mat) return null;
  const color = mat.color ? mat.color.clone().convertLinearToSRGB() : new THREE.Color('#808080');
  const vc = mesh.geometry.getAttribute('color');
  if (vc && hit.face) {
    const c = [hit.face.a, hit.face.b, hit.face.c].map((i) => new THREE.Color(vc.getX(i), vc.getY(i), vc.getZ(i)));
    color.multiply(new THREE.Color((c[0].r + c[1].r + c[2].r) / 3, (c[0].g + c[1].g + c[2].g) / 3, (c[0].b + c[1].b + c[2].b) / 3).convertLinearToSRGB());
  } else if (mat.map?.image && hit.uv) {
    const img = mat.map.image as CanvasImageSource & { width: number; height: number };
    let t = texels.get(mat.map.uuid);
    if (!t) {
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      t = { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
      texels.set(mat.map.uuid, t);
    }
    const x = Math.min(t.w - 1, Math.max(0, Math.floor((((hit.uv.x % 1) + 1) % 1) * t.w)));
    const yv = (((hit.uv.y % 1) + 1) % 1) * t.h;
    const y = Math.min(t.h - 1, Math.max(0, Math.floor(mat.map.flipY ? t.h - yv : yv)));
    const i = (y * t.w + x) * 4;
    color.multiply(new THREE.Color(t.data[i] / 255, t.data[i + 1] / 255, t.data[i + 2] / 255));
  }
  return { color, roughness: mat.roughness ?? 0.6, metalness: mat.metalness ?? 0 };
}

// n points evenly spaced along a polyline (by length).
function resample(pts: THREE.Vector3[], n: number) {
  if (pts.length < 2) return pts.slice();
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = acc.at(-1)! || 1;
  const out: THREE.Vector3[] = [];
  for (let k = 0, j = 1; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < pts.length - 1 && acc[j] < d) j++;
    const u = (d - acc[j - 1]) / Math.max(1e-9, acc[j] - acc[j - 1]);
    out.push(pts[j - 1].clone().lerp(pts[j], Math.min(1, Math.max(0, u))));
  }
  return out;
}

export const engine3d = new Engine3D();
