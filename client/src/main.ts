import * as THREE from 'three';
import { Builder, type Part } from './build';
import { Stage } from './scene';
import { Sketch, type Stroke } from './sketch';
import { renderViews, strokeColor, type View } from './views';
import { Voice } from './voice';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = new Stage($('stage'));
const sketch = new Sketch(stage);
const builder = new Builder(stage);
const caption = $('caption');
const statusEl = $('status');
const typed = $<HTMLInputElement>('typed');
const talk = $('talk');
let busy = false;

const status = (text: string, working = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('busy', working);
};

// ── toolbar ────────────────────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.addEventListener('click', () => stage.goTo(b.dataset.view as any)));
document.querySelectorAll<HTMLButtonElement>('#planes button').forEach((b) =>
  b.addEventListener('click', () => {
    sketch.mode = b.dataset.plane as any;
    document.querySelectorAll('#planes button').forEach((x) => x.classList.toggle('on', x === b));
  }),
);
$('undo').addEventListener('click', () => sketch.undo());
$('clear').addEventListener('click', () => {
  sketch.clear();
  builder.clear();
  sketch.round = 1;
  $('result').hidden = true;
  $('strip').innerHTML = '';
  caption.textContent = '';
  status('펜/왼쪽 버튼으로 그리고, 마이크를 누른 채 말하세요');
});
let sketchVisible = true;
$('toggle-sketch').addEventListener('click', () => sketch.setVisible((sketchVisible = !sketchVisible)));

// ── talk: hold (or tap to toggle), or hold Space ──────────────────────────
const voice = new Voice((text) => (caption.textContent = text));
let pressedAt = 0;
let toggled = false;

async function startTalk() {
  if (voice.recording || busy) return;
  talk.classList.add('rec');
  caption.textContent = '';
  status('듣는 중… 그리면서 말하세요');
  try {
    await voice.start();
  } catch (e) {
    talk.classList.remove('rec');
    status(`마이크를 열 수 없어요: ${e}`);
  }
}

async function stopTalk() {
  if (!voice.recording) return;
  talk.classList.remove('rec');
  status('받아쓰는 중…', true);
  const r = await voice.stop().catch(() => ({ text: '', via: 'error', ms: 0 }));
  const text = [r.text, typed.value].filter(Boolean).join(' ');
  caption.textContent = text ? `“${text}”` : '';
  typed.value = '';
  await perceive(text);
}

talk.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (toggled) {
    toggled = false;
    stopTalk();
    return;
  }
  pressedAt = performance.now();
  startTalk();
});
const release = () => {
  if (!voice.recording || toggled) return;
  if (performance.now() - pressedAt < 300) toggled = true; // a tap: keep listening until the next tap
  else stopTalk();
};
talk.addEventListener('pointerup', release);
talk.addEventListener('pointercancel', release);

addEventListener('keydown', (e) => {
  if (e.target === typed) {
    if (e.key === 'Enter') make();
    return;
  }
  if (e.code === 'Space' && !e.repeat) (e.preventDefault(), startTalk());
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') sketch.undo();
  if (e.key === 'Enter') make();
});
addEventListener('keyup', (e) => e.code === 'Space' && e.target !== typed && stopTalk());
$('make').addEventListener('click', () => make());

function make() {
  const text = typed.value.trim();
  typed.value = '';
  if (text) caption.textContent = `“${text}”`;
  perceive(text);
}

// ── perceive → build ───────────────────────────────────────────────────────
function strokeInfo(s: Stroke) {
  const box = new THREE.Box3().setFromPoints(s.points);
  const n = Math.min(8, s.points.length);
  const points = Array.from({ length: n }, (_, i) => s.points[Math.round((i * (s.points.length - 1)) / Math.max(1, n - 1))].toArray());
  return { id: s.id, color: strokeColor(s.id), drawnFrom: s.viewDir.toArray(), plane: s.plane, bbox: { min: box.min.toArray(), max: box.max.toArray() }, points, closed: s.closed };
}

function showStrip(views: View[], thinking: boolean) {
  const strip = $('strip');
  strip.innerHTML = views.map((v, i) => `<figure style="animation-delay:${i * 60}ms"><img src="${v.image}"><figcaption>${v.name}</figcaption></figure>`).join('');
  strip.classList.toggle('thinking', thinking);
}

function showResult(subject: string, say: string, parts: Part[], ms: number) {
  $('result').hidden = false;
  $('say').textContent = say || subject;
  $('chips').innerHTML = parts.map((p) => `<span><i style="background:${p.color}"></i>${p.name}</span>`).join('') + `<span>Muse Spark ${(ms / 1000).toFixed(1)} s</span>`;
}

async function perceive(transcript: string) {
  if (busy) return;
  const editing = builder.parts.length > 0;
  const strokes = editing ? sketch.current() : sketch.strokes;
  if (!strokes.length && !(editing && transcript)) {
    status('먼저 그려 주세요');
    return;
  }
  busy = true;
  status('Muse Spark가 여러 방향에서 스케치를 보는 중…', true);
  const views = renderViews(stage, strokes, { withModel: editing });
  showStrip(views, true);
  try {
    const res = await fetch('/api/perceive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views, transcript, strokes: strokes.map(strokeInfo), parts: builder.parts }),
    });
    if (!res.ok || !res.body) throw new Error(await res.text());
    // NDJSON: parts arrive one by one while Spark writes them.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const got: Part[] = [];
    let buf = '';
    let said = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (ev.type === 'say') said = ev.say;
        if (ev.type === 'part') {
          got.push(ev.part);
          builder.apply(got, sketch.strokes, true);
          status(`만드는 중… ${got.map((p) => p.name).join(', ')}`, true);
        }
        if (ev.type === 'error') throw new Error(ev.error);
        if (ev.type === 'done') {
          const a = ev.answer;
          builder.apply(a.parts, sketch.strokes);
          sketch.settle();
          showResult(a.subject, a.say || said, a.parts, ev.ms);
          status(`${a.subject} · ${a.parts.length}개 부품 · 첫 부품 ${(ev.firstMs / 1000).toFixed(1)} s · 그리고 말해서 고칠 수 있어요`);
          (window as any).last = ev;
        }
      }
    }
  } catch (e) {
    status(`실패: ${String(e).slice(0, 160)}`);
  } finally {
    busy = false;
    $('strip').classList.remove('thinking');
  }
}

// ── scripted sketches for testing without a pen ────────────────────────────
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function path(pts: THREE.Vector3[], jitter = 0.006) {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const steps = Math.max(4, Math.round(pts[i].distanceTo(pts[i + 1]) / 0.03));
    for (let k = 0; k < steps; k++) out.push(pts[i].clone().lerp(pts[i + 1], k / steps).add(V((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter, 0)));
  }
  out.push(pts[pts.length - 1].clone());
  return out;
}
const FRONT = V(0, 0, -1), SIDE = V(-1, 0, 0);
function demoChair() {
  const f = (pts: THREE.Vector3[]) => sketch.addStroke(path(pts), { viewDir: FRONT });
  const s = (pts: THREE.Vector3[]) => sketch.addStroke(path(pts), { viewDir: SIDE });
  f([V(-0.25, 0.45, 0), V(0.25, 0.45, 0)]);
  f([V(-0.23, 0.45, 0), V(-0.23, 0, 0)]);
  f([V(0.23, 0.45, 0), V(0.23, 0, 0)]);
  f([V(-0.23, 0.5, 0), V(-0.23, 0.95, 0), V(0.23, 0.95, 0), V(0.23, 0.5, 0)]);
  s([V(0, 0.45, 0.22), V(0, 0.45, -0.22)]);
  s([V(0, 0.45, 0.2), V(0, 0, 0.2)]);
  s([V(0, 0, -0.2), V(0, 0.45, -0.2), V(0, 0.95, -0.27)]);
}
function demoHouse() {
  const f = (pts: THREE.Vector3[], closed = false) => sketch.addStroke(path(pts), { viewDir: FRONT, closed });
  const s = (pts: THREE.Vector3[]) => sketch.addStroke(path(pts), { viewDir: SIDE });
  f([V(-0.4, 0, 0), V(-0.4, 0.5, 0), V(0, 0.85, 0), V(0.4, 0.5, 0), V(0.4, 0, 0), V(-0.4, 0, 0)], true);
  f([V(-0.08, 0, 0), V(-0.08, 0.28, 0), V(0.08, 0.28, 0), V(0.08, 0, 0)]);
  f([V(0.18, 0.75, 0), V(0.18, 0.95, 0), V(0.28, 0.95, 0), V(0.28, 0.66, 0)]);
  s([V(0, 0.5, 0.4), V(0, 0.5, -0.4), V(0, 0, -0.4)]);
  s([V(0, 0.85, 0.45), V(0, 0.85, -0.45)]);
}

Object.assign(window, { THREE, stage, sketch, builder, perceive, demoChair, demoHouse });
