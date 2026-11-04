// Grease-Pencil-style drawing in 3D. A pen (or the left mouse button) draws;
// each stroke is projected onto a drawing plane chosen at pen-down:
//   1. on the built model → onto its surface under the pen;
//   2. near an existing stroke → a plane through that stroke point (so new
//      strokes connect to old ones in depth);
//   3. otherwise → through the orbit target.
// The plane faces the camera ("view") or lies flat ("ground"), and shows as a
// faint grid while drawing. Strokes are 3D polylines with ids and timestamps.

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Stage } from './scene';
import { fitShape, type Shape } from './quickshape';

export type PlaneMode = 'view' | 'ground';
export type Stroke = {
  id: number;
  points: THREE.Vector3[];
  times: number[]; // ms (Date.now) per point
  plane: 'view' | 'ground' | 'surface';
  normal: THREE.Vector3; // drawing plane normal
  viewDir: THREE.Vector3; // camera looking direction while drawing
  closed: boolean;
  round: number; // build round it belongs to
  line: Line2;
  shape?: Shape['kind']; // QuickShape snapped it to this
  raw?: { points: THREE.Vector3[]; times: number[] }; // the stroke as drawn, for undo
};

const INK = new THREE.Color('#25221f');
const SNAP_PX = 16;
const HOLD_MS = 400; // QuickShape: hold the pen still this long at the end of a stroke
const HOLD_PX = 5;
const _size = new THREE.Vector2();

export function makeLine(points: THREE.Vector3[], color: THREE.ColorRepresentation, width: number) {
  const geo = new LineGeometry();
  geo.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  const mat = new LineMaterial({ color, linewidth: width, transparent: true, depthWrite: true });
  const line = new Line2(geo, mat);
  // Fat lines need the target size in pixels; works for any renderer.
  line.onBeforeRender = (renderer) => {
    renderer.getSize(_size);
    mat.resolution.set(_size.x, _size.y);
  };
  line.frustumCulled = false;
  return line;
}

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  grad.addColorStop(0, 'rgba(47,111,222,0.16)');
  grad.addColorStop(0.7, 'rgba(47,111,222,0.06)');
  grad.addColorStop(1, 'rgba(47,111,222,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  g.globalCompositeOperation = 'source-atop';
  g.strokeStyle = 'rgba(47,111,222,0.55)';
  g.lineWidth = 1.5;
  for (let i = 0; i <= 512; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Sketch {
  strokes: Stroke[] = [];
  mode: PlaneMode = 'view';
  round = 1;
  onChange: () => void = () => {};
  onSnap: (kind: Shape['kind']) => void = () => {};
  private nextId = 1;
  private drawing: {
    pointerId: number;
    stroke: Omit<Stroke, 'line'> & { line: Line2 | null };
    plane: THREE.Plane;
    surface: boolean;
    screen: THREE.Vector2[];
    holdAt: THREE.Vector2; // where the pen last came to rest
    holdTimer: number;
  } | null = null;
  private ray = new THREE.Raycaster();
  private planeViz: THREE.Mesh;
  private dot: THREE.Mesh;
  private vizOpacity = 0;
  private vizTarget = 0;

  constructor(private stage: Stage) {
    this.planeViz = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.8),
      new THREE.MeshBasicMaterial({ map: gridTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }),
    );
    this.planeViz.renderOrder = -1;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: '#2f6fde', transparent: true, opacity: 0, depthTest: false }));
    this.dot.renderOrder = 10;
    stage.helpers.add(this.planeViz, this.dot);

    const el = stage.renderer.domElement;
    // Palm rejection: a touch that lands while the pen is drawing or hovering
    // (or just was) never reaches the orbit controls.
    let penAt = -1e9;
    const pen = (e: PointerEvent) => e.pointerType === 'pen' && (penAt = performance.now());
    el.addEventListener('pointermove', pen, { capture: true });
    el.addEventListener('pointerdown', (e) => {
      pen(e);
      if (e.pointerType === 'touch' && (this.drawing || performance.now() - penAt < 800)) e.stopImmediatePropagation();
    }, { capture: true });
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', () => (this.drawing ? null : (this.vizTarget = 0)));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.onTick(() => {
      this.vizOpacity += (this.vizTarget - this.vizOpacity) * 0.2;
      (this.planeViz.material as THREE.MeshBasicMaterial).opacity = this.vizOpacity;
      (this.dot.material as THREE.MeshBasicMaterial).opacity = Math.min(1, this.vizOpacity * 2);
      this.planeViz.visible = this.dot.visible = this.vizOpacity > 0.01;
    });
  }

  private isDrawPointer(e: PointerEvent) {
    if (e.pointerType === 'touch') return false; // fingers navigate
    return e.button === 0 && !e.ctrlKey && !e.metaKey;
  }

  private ndc(e: PointerEvent) {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  // Client px, like the pointer events (the canvas sits below the app's top bar).
  private toScreen(p: THREE.Vector3) {
    const v = p.clone().project(this.stage.camera);
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(r.left + (v.x + 1) * 0.5 * r.width, r.top + (1 - v.y) * 0.5 * r.height);
  }

  private modelMeshes() {
    const out: THREE.Object3D[] = [];
    this.stage.model.traverse((o) => (o as THREE.Mesh).isMesh && o.visible && out.push(o));
    return out;
  }

  // The drawing plane for a pen at this screen position.
  private pickPlane(e: PointerEvent): { plane: THREE.Plane; surface: boolean; anchor: THREE.Vector3 } {
    const cam = this.stage.camera;
    this.ray.setFromCamera(this.ndc(e), cam);
    const viewDir = cam.getWorldDirection(new THREE.Vector3());
    const hit = this.ray.intersectObjects(this.modelMeshes(), false)[0];
    if (hit?.face) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      return { plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point), surface: true, anchor: hit.point };
    }
    let anchor = this.stage.controls.target.clone();
    const screen = new THREE.Vector2(e.clientX, e.clientY);
    let best = SNAP_PX;
    for (const s of this.strokes) {
      if (!s.line.visible) continue;
      for (const p of s.points) {
        const d = this.toScreen(p).distanceTo(screen);
        if (d < best) (best = d), (anchor = p.clone());
      }
    }
    if (this.mode === 'ground') {
      const y = best < SNAP_PX ? anchor.y : 0;
      return { plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), surface: false, anchor: new THREE.Vector3(anchor.x, y, anchor.z) };
    }
    return { plane: new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir.clone().negate(), anchor), surface: false, anchor };
  }

  private project(e: PointerEvent, plane: THREE.Plane, surface: boolean): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc(e), this.stage.camera);
    if (surface) {
      const hit = this.ray.intersectObjects(this.modelMeshes(), false)[0];
      if (hit?.face) return hit.point.clone().add(hit.face.normal.clone().transformDirection(hit.object.matrixWorld).multiplyScalar(0.006));
    }
    return this.ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  private showPlane(plane: THREE.Plane, at: THREE.Vector3, opacity: number) {
    this.planeViz.position.copy(at);
    this.planeViz.lookAt(at.clone().add(plane.normal));
    this.dot.position.copy(at);
    this.vizTarget = opacity;
  }

  private down(e: PointerEvent) {
    if (!this.isDrawPointer(e) || this.drawing) return;
    const { plane, surface, anchor } = this.pickPlane(e);
    const p = this.project(e, plane, surface);
    if (!p) return;
    e.preventDefault();
    try {
      this.stage.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {} // synthetic events (replay) have no active pointer
    this.stage.controls.enabled = false; // palm on the screen must not orbit
    const viewDir = this.stage.camera.getWorldDirection(new THREE.Vector3());
    this.drawing = {
      pointerId: e.pointerId,
      plane,
      surface,
      screen: [new THREE.Vector2(e.clientX, e.clientY)],
      holdAt: new THREE.Vector2(e.clientX, e.clientY),
      holdTimer: 0,
      stroke: { id: this.nextId++, points: [p], times: [Date.now()], plane: surface ? 'surface' : this.mode, normal: plane.normal.clone(), viewDir, closed: false, round: this.round, line: null },
    };
    this.showPlane(plane, surface ? p : anchor, 0.7);
  }

  private move(e: PointerEvent) {
    const d = this.drawing;
    if (!d) {
      // Hover (pen or mouse): preview the plane the next stroke would use.
      if (e.pointerType !== 'touch' && e.buttons === 0) {
        const { plane, surface, anchor } = this.pickPlane(e);
        const p = this.project(e, plane, surface);
        this.showPlane(plane, surface && p ? p : anchor, 0.18);
        if (p) this.dot.position.copy(p);
      }
      return;
    }
    if (e.pointerId !== d.pointerId || d.stroke.shape) return; // snapped: the shape holds until the pen lifts
    // Each real movement restarts the QuickShape hold timer.
    const at = new THREE.Vector2(e.clientX, e.clientY);
    if (at.distanceTo(d.holdAt) > HOLD_PX) {
      d.holdAt = at;
      clearTimeout(d.holdTimer);
      d.holdTimer = window.setTimeout(() => this.quickShape(), HOLD_MS);
    }
    const events = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const s = new THREE.Vector2(ev.clientX, ev.clientY);
      if (s.distanceTo(d.screen[d.screen.length - 1]) < 2) continue;
      const p = this.project(ev, d.plane, d.surface);
      if (!p) continue;
      d.screen.push(s);
      d.stroke.points.push(p);
      d.stroke.times.push(Date.now());
    }
    this.dot.position.copy(d.stroke.points[d.stroke.points.length - 1]);
    this.redraw();
  }

  // The pen rests at the end of a stroke: snap it to a clean shape in its
  // drawing plane if one fits closely (line, circle, ellipse, arc, arrow).
  private quickShape() {
    const d = this.drawing;
    if (!d || d.stroke.shape || d.stroke.points.length < 6) return;
    let screenLen = 0;
    for (let i = 1; i < d.screen.length; i++) screenLen += d.screen[i].distanceTo(d.screen[i - 1]);
    if (screenLen < 30) return;
    const s = d.stroke;
    const n = d.plane.normal.clone().normalize();
    const u = new THREE.Vector3().crossVectors(Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const o = s.points[0].clone();
    const shape = fitShape(s.points.map((p) => ({ x: p.clone().sub(o).dot(u), y: p.clone().sub(o).dot(v) })));
    if (!shape) return;
    const t0 = s.times[0], t1 = s.times[s.times.length - 1];
    s.raw = { points: s.points, times: s.times };
    s.points = shape.points.map((q) => o.clone().addScaledVector(u, q.x).addScaledVector(v, q.y));
    s.times = s.points.map((_, i) => Math.round(t0 + ((t1 - t0) * i) / Math.max(1, s.points.length - 1)));
    s.closed = shape.closed;
    s.shape = shape.kind;
    this.redraw();
    // A short blue flash says "snapped".
    const line = s.line!;
    (line.material as LineMaterial).color.set('#2f6fde');
    setTimeout(() => (line.material as LineMaterial).color.copy(INK), 350);
    this.onSnap(shape.kind);
  }

  private redraw() {
    const d = this.drawing!;
    if (d.stroke.points.length < 2) return;
    if (d.stroke.line) {
      this.stage.sketch.remove(d.stroke.line);
      d.stroke.line.geometry.dispose();
    }
    d.stroke.line = makeLine(d.stroke.points, INK, 3);
    this.stage.sketch.add(d.stroke.line);
  }

  private up(e: PointerEvent) {
    const d = this.drawing;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drawing = null;
    clearTimeout(d.holdTimer);
    this.stage.controls.enabled = true;
    this.vizTarget = 0;
    const s = d.stroke;
    if (s.points.length < 3 || !s.line) {
      if (s.line) this.stage.sketch.remove(s.line);
      return;
    }
    if (s.shape) {
      this.strokes.push(s as Stroke);
      this.onChange();
      return;
    }
    // Light smoothing, then close loops that end near where they started.
    const pts = s.points.map((p, i, a) => (i === 0 || i === a.length - 1 ? p.clone() : a[i - 1].clone().add(p).add(a[i + 1]).multiplyScalar(1 / 3)));
    let screenLen = 0;
    for (let i = 1; i < d.screen.length; i++) screenLen += d.screen[i].distanceTo(d.screen[i - 1]);
    if (screenLen > 120 && d.screen[0].distanceTo(d.screen[d.screen.length - 1]) < 28) {
      s.closed = true;
      pts.push(pts[0].clone());
      s.times.push(s.times[s.times.length - 1]);
    }
    s.points = pts;
    this.stage.sketch.remove(s.line);
    s.line = makeLine(pts, INK, 3);
    this.stage.sketch.add(s.line);
    this.strokes.push(s as Stroke);
    this.onChange();
  }

  // Strokes not yet explained by a build.
  current() {
    return this.strokes.filter((s) => s.round === this.round);
  }

  // After a build: the strokes so far fade back and a new round starts.
  settle() {
    for (const s of this.strokes) {
      const m = s.line.material as LineMaterial;
      m.opacity = 0.22;
    }
    this.round++;
  }

  // Undo a build: its strokes become current (and fully visible) again.
  unsettle() {
    this.round = Math.max(1, this.round - 1);
    for (const s of this.strokes) if (s.round === this.round) (s.line.material as LineMaterial).opacity = 1;
  }

  undo() {
    // A snapped stroke first goes back to how it was drawn.
    const last = this.strokes[this.strokes.length - 1];
    if (last?.raw) {
      last.points = last.raw.points;
      last.times = last.raw.times;
      last.closed = false;
      delete last.raw;
      delete last.shape;
      const opacity = (last.line.material as LineMaterial).opacity;
      this.stage.sketch.remove(last.line);
      last.line.geometry.dispose();
      last.line = makeLine(last.points, INK, 3);
      (last.line.material as LineMaterial).opacity = opacity;
      this.stage.sketch.add(last.line);
      this.onChange();
      return true;
    }
    const s = this.strokes.pop();
    if (!s) return false;
    this.stage.sketch.remove(s.line);
    s.line.geometry.dispose();
    this.onChange();
    return true;
  }

  clear() {
    for (const s of this.strokes) this.stage.sketch.remove(s.line);
    this.strokes = [];
    this.onChange();
  }

  setVisible(v: boolean) {
    this.stage.sketch.visible = v;
  }

  // Add a stroke from code (tests and the scripted demo).
  addStroke(points: THREE.Vector3[], opts: { plane?: Stroke['plane']; viewDir?: THREE.Vector3; closed?: boolean } = {}) {
    const viewDir = opts.viewDir ?? this.stage.camera.getWorldDirection(new THREE.Vector3());
    const now = Date.now();
    const s: Stroke = {
      id: this.nextId++,
      points,
      times: points.map((_, i) => now + i * 8),
      plane: opts.plane ?? 'view',
      normal: viewDir.clone().negate(),
      viewDir,
      closed: !!opts.closed,
      round: this.round,
      line: makeLine(points, INK, 3),
    };
    this.stage.sketch.add(s.line);
    this.strokes.push(s);
    this.onChange();
    return s;
  }
}
