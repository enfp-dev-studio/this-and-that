// This & That on the surface of a 3D model: orbit to a view, draw on the
// model and say what to change. The view is rendered and goes through the
// same 2D pipeline as a picture (Spark maps words to marks, SAM finds each
// marked region, Muse Image edits, only the marked pixels are pasted back),
// then the edit is baked into the model's base-color texture (bake.ts), so it
// stays on the surface from every angle. Undo restores the texture.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { runtime } from '../runtime';
import { colorOf } from '../runtime/render';
import { LiveAsr } from '../editor/live-asr';
import { bakeDebug, SurfaceBaker } from './bake';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const caption = $('caption');
const typed = $<HTMLInputElement>('typed');
const status = (text: string, busy = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('busy', busy);
};

// ── stage ──────────────────────────────────────────────────────────────────
// preserveDrawingBuffer: the view sent to the pipeline is read off this canvas.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
$('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2b2d32');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
camera.position.set(0, 0.15, 3.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.minDistance = 1.2;
controls.maxDistance = 8;
const strokesGroup = new THREE.Group();
scene.add(strokesGroup);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

let mesh: THREE.Mesh | null = null;
let baker: SurfaceBaker | null = null;
new GLTFLoader().loadAsync('/3d/DamagedHelmet.glb').then((gltf) => {
  scene.add(gltf.scene);
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh;
  });
  baker = new SurfaceBaker(renderer, mesh!);
  status('모델 위에 그리고, 마이크를 누른 채 말하세요');
}, (e) => status(`모델을 못 불러왔어요: ${e}`));

// ── strokes on the surface ────────────────────────────────────────────────
type SurfaceStroke = { mark: number; points: THREE.Vector3[]; at: number[]; line: Line2 | null };
const strokes: SurfaceStroke[] = [];
let drawing: (SurfaceStroke & { pointerId: number; plane: THREE.Plane }) | null = null;
const ray = new THREE.Raycaster();
const _size = new THREE.Vector2();

function lineOf(points: THREE.Vector3[], color: string) {
  const geo = new LineGeometry();
  geo.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  const mat = new LineMaterial({ color, linewidth: 4, transparent: true, depthTest: false });
  const line = new Line2(geo, mat);
  line.onBeforeRender = (r) => mat.resolution.copy(r.getSize(_size));
  line.renderOrder = 5;
  line.frustumCulled = false;
  return line;
}

// The surface point under the pen (lifted a hair off it), else a point on a
// camera-facing plane through the last surface point.
function surfacePoint(e: PointerEvent, plane: THREE.Plane | null) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = mesh ? ray.intersectObject(mesh, false)[0] : undefined;
  if (hit?.face) {
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { p: hit.point.clone().addScaledVector(n, 0.004), hit: true };
  }
  const p = plane ? ray.ray.intersectPlane(plane, new THREE.Vector3()) : null;
  return p ? { p, hit: false } : null;
}

const el = renderer.domElement;
let penAt = -1e9;
el.addEventListener('pointermove', (e) => e.pointerType === 'pen' && (penAt = performance.now()), { capture: true });
el.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') penAt = performance.now();
  // Palm rejection: no orbiting from a touch while the pen is around.
  if (e.pointerType === 'touch' && (drawing || performance.now() - penAt < 800)) e.stopImmediatePropagation();
}, { capture: true });
el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' || e.button !== 0 || drawing || busy || !mesh) return;
  if (strokes.length >= 6) return status('한 번에 표시는 6개까지예요');
  const centre = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), new THREE.Vector3());
  const first = surfacePoint(e, centre);
  if (!first) return;
  try { el.setPointerCapture(e.pointerId); } catch {}
  controls.enabled = false;
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), first.p);
  drawing = { mark: strokes.length + 1, points: [first.p], at: [performance.now()], line: null, pointerId: e.pointerId, plane };
});
el.addEventListener('pointermove', (e) => {
  if (!drawing || e.pointerId !== drawing.pointerId) return;
  for (const ev of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) {
    const q = surfacePoint(ev, drawing.plane);
    if (!q || q.p.distanceTo(drawing.points[drawing.points.length - 1]) < 0.004) continue;
    if (q.hit) drawing.plane.setFromNormalAndCoplanarPoint(drawing.plane.normal, q.p);
    drawing.points.push(q.p);
    drawing.at.push(performance.now());
  }
  if (drawing.points.length < 2) return;
  if (drawing.line) strokesGroup.remove(drawing.line);
  drawing.line = lineOf(drawing.points, colorOf(drawing.mark));
  strokesGroup.add(drawing.line);
});
const endStroke = (e: PointerEvent) => {
  if (!drawing || e.pointerId !== drawing.pointerId) return;
  controls.enabled = true;
  const s = drawing;
  drawing = null;
  if (s.points.length < 3) return void (s.line && strokesGroup.remove(s.line));
  strokes.push({ mark: s.mark, points: s.points, at: s.at, line: s.line });
  status(`표시 ${strokes.length}개 · 말하거나 입력해서 고치세요`);
};
el.addEventListener('pointerup', endStroke);
el.addEventListener('pointercancel', endStroke);

function clearStrokes() {
  for (const s of strokes) s.line && strokesGroup.remove(s.line);
  strokes.length = 0;
}

// ── talk ───────────────────────────────────────────────────────────────────
let busy = false;
let live: LiveAsr | null = null;
let recordedAt = 0;
let stream: MediaStream | null = null;
async function startTalk() {
  if (live || busy) return;
  $('talk').classList.add('rec');
  caption.textContent = '';
  status('듣는 중… 그리면서 말하세요');
  try {
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    recordedAt = performance.now();
    live = new LiveAsr(stream, (text) => (caption.textContent = text), Promise.resolve([]), recordedAt);
  } catch (e) {
    $('talk').classList.remove('rec');
    status(`마이크를 열 수 없어요: ${e}`);
  }
}
async function stopTalk() {
  if (!live) return;
  $('talk').classList.remove('rec');
  const l = live;
  live = null;
  const voice = await l.stop();
  await submit({ ...voice, text: typed.value.trim() || undefined });
}
$('talk').addEventListener('pointerdown', (e) => (e.preventDefault(), startTalk()));
$('talk').addEventListener('pointerup', () => stopTalk());
$('talk').addEventListener('pointercancel', () => stopTalk());
addEventListener('keydown', (e) => {
  if (e.target === typed) return void (e.key === 'Enter' && submit({ text: typed.value.trim() }));
  if (e.code === 'Space' && !e.repeat) (e.preventDefault(), startTalk());
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') undo();
});
addEventListener('keyup', (e) => e.code === 'Space' && e.target !== typed && (e.preventDefault(), stopTalk()));
$('send').addEventListener('click', () => submit({ text: typed.value.trim() }));
document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.blur()));

// ── the take: view → 2D pipeline → texture ─────────────────────────────────
const STAGES: Record<string, string> = { understand: 'Muse Spark가 표시와 말을 맞추는 중…', edit: 'Muse Image가 그 부분만 고치는 중…', paste: '표시한 영역만 붙이는 중…' };

function toBlob(c: HTMLCanvasElement) {
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'));
}

async function submit(voice: { pcm?: Int16Array; asr?: any; text?: string }) {
  if (busy || !baker) return;
  if (!strokes.length) return status('먼저 모델 위에 고칠 곳을 그려 주세요');
  if (!voice.text && !voice.pcm?.length) return status('무엇을 바꿀지 말하거나 입력해 주세요');
  busy = true;
  typed.value = '';
  if (voice.text) caption.textContent = `“${voice.text}”`;
  try {
    // 1. The view as it is now, without the strokes (they go as marks).
    controls.update();
    strokesGroup.visible = false;
    renderer.render(scene, camera);
    const blob = await toBlob(renderer.domElement);
    // The same view without emission: the bake's lighting reference.
    const material = mesh!.material as THREE.MeshStandardMaterial;
    const glow = material.emissiveIntensity;
    material.emissiveIntensity = 0;
    renderer.render(scene, camera);
    const plain = await createImageBitmap(renderer.domElement);
    material.emissiveIntensity = glow;
    strokesGroup.visible = true;
    const cam = camera.clone();
    const { width: W, height: H } = renderer.domElement;
    const t0 = Math.min(recordedAt || Infinity, ...strokes.map((s) => s.at[0]));
    const marks = strokes.map((s) => ({
      mark: s.mark,
      points: s.points.map((p, i) => {
        const v = p.clone().project(cam);
        return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, t: Math.max(0, Math.round(s.at[i] - t0)) };
      }),
    }));
    status('화면을 보내는 중…', true);
    const { imageId } = await runtime.uploadImage(blob);
    const { id } = runtime.startJob({ imageId, strokes: marks, pcm: voice.pcm ?? null, asr: voice.asr ?? null, ...(voice.text && !voice.pcm?.length ? { text: voice.text } : {}) });
    const t1 = performance.now();
    let job = runtime.job(id)!;
    while (job.stage !== 'done' && job.stage !== 'error') {
      status(`${STAGES[job.stage] ?? job.stage} ${((performance.now() - t1) / 1000).toFixed(0)} s`, true);
      if (job.transcript) caption.textContent = `“${job.transcript}”`;
      if (job.edits?.length) showEdits(job.edits);
      await new Promise((r) => setTimeout(r, 250));
      job = runtime.job(id)!;
    }
    if (job.stage === 'error') throw new Error(job.error);
    if (job.edits?.length) showEdits(job.edits);
    // 2. Into the texture.
    const rendered = runtime.bitmap(imageId), edited = runtime.bitmap(job.resultImageId!);
    if (!rendered || !edited) throw new Error('결과 이미지를 못 찾았어요');
    baker.bake(cam, rendered, plain, edited);
    (window as any).lastTake = { cam, rendered, plain, edited, imageId, resultId: job.resultImageId };
    clearStrokes();
    showStrip(runtime.imageUrl(imageId), runtime.imageUrl(job.resultImageId!));
    status(`표면에 입혔어요 · ${((performance.now() - t1) / 1000).toFixed(1)} s · 돌려 보세요 · 되돌리기로 원래대로`);
    (window as any).lastJob = job;
  } catch (e) {
    strokesGroup.visible = true;
    status(`실패: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  } finally {
    busy = false;
  }
}

function showEdits(edits: { mark: number; target: string; instruction: string }[]) {
  const box = $('edits');
  box.hidden = false;
  box.innerHTML = edits.map((e) => `<div><i style="background:${colorOf(e.mark)}"></i><b>${e.target}</b>: ${e.instruction}</div>`).join('');
}

function showStrip(sent: string, result: string) {
  $('strip').innerHTML = `<figure><img src="${sent}"><figcaption>보낸 화면</figcaption></figure><figure><img src="${result}"><figcaption>2D 결과 (표시한 곳만)</figcaption></figure>`;
}

// ── undo, before/after ─────────────────────────────────────────────────────
function undo() {
  if (busy) return;
  if (strokes.length) {
    const s = strokes.pop()!;
    s.line && strokesGroup.remove(s.line);
    return;
  }
  if (baker?.undo()) status('텍스처를 되돌렸어요');
}
$('undo').addEventListener('click', undo);
$('clear').addEventListener('click', clearStrokes);
const before = $('before');
before.addEventListener('pointerdown', () => baker?.peek(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) before.addEventListener(ev, () => baker?.peek(false));

Object.assign(window, { THREE, scene, camera, controls, renderer, strokes, submit, runtime, bakeDebug });
Object.defineProperties(window, { baker: { get: () => baker }, mesh: { get: () => mesh } });
