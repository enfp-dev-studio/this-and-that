// This & That client: draw numbered marks on the image while talking, send the
// image + stroke log + voice to the server, show progress and a before/after.

type Point = { x: number; y: number; t: number };
type Stroke = { mark: number; points: Point[] };
type Edit = { mark: number; target: string; instruction: string };
type Job = { stage: string; transcript?: string; edits?: Edit[]; error?: string; elapsedMs: number };

const COLORS = ['#ff3b30', '#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#ff2d95', '#64d2ff', '#ffd60a'];
const colorOf = (mark: number) => COLORS[(mark - 1) % COLORS.length];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const stage = $('stage');
const talk = $<HTMLButtonElement>('talk');
const talkLabel = $('talkLabel');
const stagesEl = $('stages');
const caption = $('caption');
const editsEl = $('edits');
const review = $('review');
const compare = $('compare');

let image: HTMLImageElement | null = null;
let imageUrl = ''; // data URL of the current image
const versions: string[] = []; // earlier images, for Undo
let strokes: Stroke[] = [];
let drawing: Stroke | null = null;
let penSeen = false;

// Recording session: starts with the talk button or the first stroke.
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let t0 = 0;
let state: 'idle' | 'recording' | 'processing' | 'review' = 'idle';
let micStream: MediaStream | null = null;

// ---------- image ----------

async function setImage(url: string, keepHistory = true) {
  const img = new Image();
  img.src = url;
  await img.decode();
  if (keepHistory && imageUrl) versions.push(imageUrl);
  image = img;
  imageUrl = url.startsWith('data:') ? url : await toDataUrl(url);
  strokes = [];
  $('empty').hidden = true;
  draw();
}

async function toDataUrl(url: string) {
  const blob = await (await fetch(url)).blob();
  return blobToDataUrl(blob);
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });

$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await setImage(await blobToDataUrl(file));
});
$('sample').addEventListener('click', () => setImage('/api/sample'));
document.addEventListener('paste', async (e) => {
  const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
  if (file) await setImage(await blobToDataUrl(file));
});
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file?.type.startsWith('image/')) await setImage(await blobToDataUrl(file));
});
$('clear').addEventListener('click', () => {
  if (state === 'recording') cancelRecording();
  strokes = [];
  draw();
});
$('undo').addEventListener('click', async () => {
  const prev = versions.pop();
  if (prev && state !== 'processing') await setImage(prev, false);
});

// ---------- canvas ----------

// Where the image sits in the stage, in CSS pixels.
function fitRect() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!image) return { x: 0, y: 0, w, h, k: 1 };
  const k = Math.min(w / image.naturalWidth, h / image.naturalHeight);
  const iw = image.naturalWidth * k;
  const ih = image.naturalHeight * k;
  return { x: (w - iw) / 2, y: (h - ih) / 2, w: iw, h: ih, k };
}

function draw() {
  const dpr = devicePixelRatio || 1;
  canvas.width = stage.clientWidth * dpr;
  canvas.height = stage.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return;
  const r = fitRect();
  ctx.drawImage(image, r.x, r.y, r.w, r.h);
  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.scale(r.k, r.k);
  const unit = Math.max(image.naturalWidth, image.naturalHeight) / 160;
  for (const s of strokes) drawStroke(s, unit);
  ctx.restore();
}

// Same look as the server's render (white halo, colour line, numbered badge).
function drawStroke(s: Stroke, unit: number) {
  if (!s.points.length) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [color, width] of [['rgba(255,255,255,0.8)', unit * 1.6], [colorOf(s.mark), unit]] as const) {
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  const r = unit * 2.6;
  const p0 = s.points[0];
  const bx = Math.min(Math.max(p0.x, r), image!.naturalWidth - r);
  const by = Math.min(Math.max(p0.y - r * 1.3, r), image!.naturalHeight - r);
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fillStyle = colorOf(s.mark);
  ctx.fill();
  ctx.lineWidth = unit * 0.5;
  ctx.strokeStyle = 'white';
  ctx.stroke();
  ctx.fillStyle = 'white';
  ctx.font = `bold ${r * 1.15}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(s.mark), bx, by + r * 0.05);
}

new ResizeObserver(() => {
  draw();
  if (!compare.hidden) placeCompare();
}).observe(stage);

function toImage(e: PointerEvent): Point {
  const box = canvas.getBoundingClientRect();
  const r = fitRect();
  const x = (e.clientX - box.left - r.x) / r.k;
  const y = (e.clientY - box.top - r.y) / r.k;
  return {
    x: Math.round(Math.max(0, Math.min(image!.naturalWidth - 1, x))),
    y: Math.round(Math.max(0, Math.min(image!.naturalHeight - 1, y))),
    t: Math.round(performance.now() - t0),
  };
}

canvas.addEventListener('pointerdown', async (e) => {
  if (!image || state === 'processing' || state === 'review') return;
  if (e.pointerType === 'pen') penSeen = true;
  if (e.pointerType === 'touch' && penSeen) return; // palm rejection once a stylus is in use
  canvas.setPointerCapture(e.pointerId);
  if (state === 'idle') await startRecording();
  drawing = { mark: strokes.length + 1, points: [toImage(e)] };
  strokes.push(drawing);
  draw();
});
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const coalesced = e.getCoalescedEvents?.() ?? [];
  for (const ev of coalesced.length ? coalesced : [e]) drawing.points.push(toImage(ev));
  draw();
});
const endStroke = () => {
  drawing = null;
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ---------- talk button: hold to talk, or tap to start and tap to send ----------

let pressedAt = 0;
let startedByThisPress = false;
talk.addEventListener('pointerdown', async (e) => {
  if (!image || state === 'processing') return;
  talk.setPointerCapture(e.pointerId);
  pressedAt = performance.now();
  startedByThisPress = state === 'idle' || state === 'review';
  if (state === 'review') await keepResult();
  if (startedByThisPress) await startRecording();
});
talk.addEventListener('pointerup', () => {
  if (state !== 'recording') return;
  const held = performance.now() - pressedAt > 400;
  // A quick tap that started recording keeps it going; a hold, or a tap
  // while recording, sends.
  if (held || !startedByThisPress) stopAndSend();
});

async function startRecording() {
  if (state === 'recording') return;
  if (state === 'review') closeReview();
  strokes = [];
  chunks = [];
  state = 'recording';
  talk.classList.add('recording');
  talkLabel.textContent = 'Listening… tap (or release) to send';
  resetPanel();
  t0 = performance.now();
  try {
    micStream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    recorder = new MediaRecorder(micStream);
    recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    recorder.start(250);
    // The clock starts when audio does, so stroke times line up with the voice.
    const shift = performance.now() - t0;
    t0 += shift;
    for (const s of strokes) for (const p of s.points) p.t = Math.max(0, p.t - shift);
  } catch (err) {
    recorder = null;
    caption.textContent = `Microphone unavailable (${(err as Error).message}). Marks only.`;
  }
}

function cancelRecording() {
  recorder?.stop();
  recorder = null;
  state = 'idle';
  talk.classList.remove('recording');
  talkLabel.textContent = 'Hold or tap, then draw and talk';
}

async function stopAndSend() {
  const rec = recorder;
  const audio = rec
    ? await new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }));
        rec.stop();
      })
    : null;
  recorder = null;
  talk.classList.remove('recording');
  if (!strokes.length) {
    state = 'idle';
    talkLabel.textContent = 'Draw a mark while you talk';
    return;
  }
  state = 'processing';
  talk.disabled = true;
  talkLabel.textContent = 'Working…';
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageUrl, strokes, audio: audio ? await blobToDataUrl(audio) : null }),
    });
    const { id, error } = await res.json();
    if (error) throw new Error(error);
    await follow(id);
  } catch (err) {
    showError((err as Error).message);
  }
}

// ---------- progress ----------

const STAGES = ['video', 'understand', 'edit', 'paste', 'done'];

function resetPanel() {
  stagesEl.hidden = true;
  caption.textContent = '';
  caption.classList.remove('error');
  editsEl.innerHTML = '';
  review.hidden = true;
}

async function follow(id: string) {
  stagesEl.hidden = false;
  for (;;) {
    const job: Job = await (await fetch(`/api/jobs/${id}`)).json();
    if (job.error) throw new Error(job.error);
    const at = STAGES.indexOf(job.stage);
    for (const li of stagesEl.querySelectorAll('li')) {
      const i = STAGES.indexOf(li.dataset.stage!);
      li.className = i < at ? 'done' : i === at ? 'active' : '';
    }
    if (job.transcript) caption.textContent = `“${job.transcript}”`;
    if (job.edits && !editsEl.childElementCount) {
      for (const e of job.edits) {
        const li = document.createElement('li');
        li.innerHTML = `<b style="background:${colorOf(e.mark)}">${e.mark}</b>`;
        li.append(`${e.target} → ${e.instruction}`);
        editsEl.append(li);
      }
    }
    talkLabel.textContent = `Working… ${Math.round(job.elapsedMs / 1000)} s`;
    if (job.stage === 'done') return showResult(`/api/jobs/${id}/result.png`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

function showError(msg: string) {
  state = 'idle';
  talk.disabled = false;
  talkLabel.textContent = 'Hold or tap, then draw and talk';
  caption.textContent = `Something went wrong: ${msg}`;
  caption.classList.add('error');
}

// ---------- before / after ----------

let resultUrl = '';
async function showResult(url: string) {
  resultUrl = url;
  $<HTMLImageElement>('before').src = imageUrl;
  const after = $<HTMLImageElement>('after');
  after.src = url;
  await after.decode();
  state = 'review';
  talk.disabled = false;
  talkLabel.textContent = 'Talk again to keep going';
  review.hidden = false;
  compare.hidden = false;
  placeCompare();
  setSplit(0.5);
}

function placeCompare() {
  const r = fitRect();
  Object.assign(compare.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

function setSplit(f: number) {
  f = Math.max(0, Math.min(1, f));
  $('beforeClip').style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
  $('handle').style.left = `${f * 100}%`;
}

compare.addEventListener('pointerdown', (e) => {
  compare.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const box = compare.getBoundingClientRect();
    setSplit((ev.clientX - box.left) / box.width);
  };
  move(e);
  compare.addEventListener('pointermove', move);
  compare.addEventListener('pointerup', () => compare.removeEventListener('pointermove', move), { once: true });
});

function closeReview() {
  compare.hidden = true;
  review.hidden = true;
  state = 'idle';
  talkLabel.textContent = 'Hold or tap, then draw and talk';
}

// Keep: the result becomes the image to keep refining. Talking again from
// review also keeps it.
async function keepResult() {
  closeReview();
  await setImage(resultUrl);
  resetPanel();
}
$('keep').addEventListener('click', keepResult);
$('discard').addEventListener('click', () => {
  closeReview();
  strokes = [];
  draw();
  resetPanel();
});
