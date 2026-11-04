// Renders the sketch (and the model, if any) from several viewpoints for
// Muse Spark: front, side, top, two 3/4 views and the user's current view.
// Each stroke gets its own color and its id number at its middle.

import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Stage } from './scene';
import type { Stroke } from './sketch';

export const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5a5', '#f032e6', '#9a6324', '#808000', '#000075', '#e6a700', '#800000'];
export const strokeColor = (id: number) => PALETTE[(id - 1) % PALETTE.length];

export type View = { name: string; note: string; image: string };

const SIZE = 512;
let offscreen: THREE.WebGLRenderer | null = null;

export function renderViews(stage: Stage, strokes: Stroke[], opts: { withModel: boolean }): View[] {
  offscreen ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  offscreen.setPixelRatio(1);
  offscreen.setSize(SIZE, SIZE);
  offscreen.shadowMap.enabled = true;
  const r = offscreen;

  // What the views frame: the strokes sent plus the model.
  const box = new THREE.Box3();
  for (const s of strokes) for (const p of s.points) box.expandByPoint(p);
  if (opts.withModel) box.expandByObject(stage.model);
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 1, 1));
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.25, box.getSize(new THREE.Vector3()).length() / 2);

  // Scene state for the renders: white paper, colored strokes, no helpers.
  const scene = stage.scene;
  const bg = scene.background;
  scene.background = new THREE.Color('#ffffff');
  const restore: (() => void)[] = [];
  stage.helpers.visible = false;
  // The renders keep the small ground grid Spark was tuned with (hidden live).
  const grid = scene.getObjectByName('grid');
  if (grid) {
    grid.visible = true;
    restore.push(() => (grid.visible = false));
  }
  const sketchVisible = stage.sketch.visible;
  stage.sketch.visible = true;
  const modelVisible = stage.model.visible;
  stage.model.visible = opts.withModel;
  for (const child of stage.sketch.children) {
    const s = strokes.find((x) => x.line === child);
    if (!s) {
      const was = child.visible;
      child.visible = false;
      restore.push(() => (child.visible = was));
      continue;
    }
    const m = s.line.material as LineMaterial;
    const [c, w, o, v] = [m.color.clone(), m.linewidth, m.opacity, child.visible];
    m.color.set(strokeColor(s.id));
    m.linewidth = 4;
    m.opacity = 1;
    child.visible = true;
    restore.push(() => (m.color.copy(c), (m.linewidth = w), (m.opacity = o), (child.visible = v)));
  }

  const ortho = (dir: THREE.Vector3, up: THREE.Vector3) => {
    const cam = new THREE.OrthographicCamera(-radius * 1.15, radius * 1.15, radius * 1.15, -radius * 1.15, 0.01, 100);
    cam.up.copy(up);
    cam.position.copy(center).addScaledVector(dir, radius * 4);
    cam.lookAt(center);
    return cam;
  };
  const persp = (dir: THREE.Vector3) => {
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    cam.position.copy(center).addScaledVector(dir.clone().normalize(), radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.05);
    cam.lookAt(center);
    return cam;
  };
  const current = stage.camera.clone();
  current.aspect = 1;
  current.updateProjectionMatrix();
  const Y = new THREE.Vector3(0, 1, 0);
  const shots: { name: string; note: string; cam: THREE.Camera }[] = [
    { name: 'FRONT', note: 'orthographic, looking along -Z (from +Z). +X right, +Y up', cam: ortho(new THREE.Vector3(0, 0, 1), Y) },
    { name: 'SIDE', note: 'orthographic, looking along -X (from +X, the right side). -Z (back) is to the right, +Y up', cam: ortho(new THREE.Vector3(1, 0, 0), Y) },
    { name: 'TOP', note: 'orthographic, looking down -Y. +X right, +Z (front) at the bottom', cam: ortho(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)) },
    { name: 'FRONT-RIGHT 3/4', note: 'perspective, from front-right above', cam: persp(new THREE.Vector3(0.9, 0.6, 1)) },
    { name: 'BACK-LEFT 3/4', note: 'perspective, from back-left above', cam: persp(new THREE.Vector3(-0.9, 0.6, -1)) },
    { name: 'USER VIEW', note: 'perspective, the view the user is looking from right now', cam: current },
  ];

  const views: View[] = [];
  for (const shot of shots) {
    r.render(scene, shot.cam);
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const g = c.getContext('2d')!;
    g.drawImage(r.domElement, 0, 0);
    // Stroke ids at their middles.
    g.font = 'bold 20px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const s of strokes) {
      const mid = s.points[Math.floor(s.points.length / 2)].clone().project(shot.cam);
      const x = (mid.x + 1) * 0.5 * SIZE, y = (1 - mid.y) * 0.5 * SIZE;
      g.lineWidth = 4;
      g.strokeStyle = '#fff';
      g.strokeText(String(s.id), x + 10, y - 10);
      g.fillStyle = strokeColor(s.id);
      g.fillText(String(s.id), x + 10, y - 10);
    }
    g.font = 'bold 15px sans-serif';
    g.textAlign = 'left';
    g.fillStyle = '#555';
    g.fillText(shot.name, 10, 16);
    views.push({ name: shot.name, note: shot.note, image: c.toDataURL('image/jpeg', 0.85) });
  }

  for (const f of restore) f();
  scene.background = bg;
  stage.helpers.visible = true;
  stage.sketch.visible = sketchVisible;
  stage.model.visible = modelVisible;
  return views;
}
