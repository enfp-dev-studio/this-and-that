// This & That client: draw numbered marks on the image while talking. Each
// mark goes to the server when its stroke ends, so SAM outlines it while you
// are still talking; on release the voice follows and the edit runs.

type Point = { x: number; y: number; t: number };
type Stroke = {
  mark: number;
  points: Point[];
  markId?: string; // SAM request for this mark, sent when the stroke ends
  mask?: HTMLImageElement; // SAM's outline of what the mark points at
  samDone?: boolean;
  settled?: boolean; // no sheen: an arrow, "no change", or already edited locally
};
type Edit = { mark: number; kind?: string; target: string; instruction: string };
type Job = {
  stage: string;
  transcript?: string;
  edits?: Edit[];
  error?: string;
  resultImageId?: string;
  previewImageId?: string; // instant (local) edits, before Muse Image is done
  localMarks?: number[];
  elapsedMs: number;
};
type Version = { url: string; imageId: Promise<string> };

const COLORS = ['#ff3b30', '#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#ff2d95', '#64d2ff', '#ffd60a'];
const colorOf = (mark: number) => COLORS[(mark - 1) % COLORS.length];
const IDLE_LABEL = 'Hold or tap, then draw and talk';

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
let preview: HTMLImageElement | null = null; // shown instead of `image` while the rest is edited
let current: Version | null = null;
const versions: Version[] = []; // earlier images, for Undo
let strokes: Stroke[] = [];
let drawing: Stroke | null = null;
let penSeen = false;

// Recording session: starts with the talk button or the first stroke.
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let t0 = 0;
let state: 'idle' | 'recording' | 'processing' | 'review' = 'idle';
let micStream: MediaStream | null = null;

const postJson = async (path: string, body: unknown) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
};

// ---------- image ----------

// Show an image and make it the one to edit. A new image is uploaded once;
// results already live on the server and come with their id.
async function setImage(url: string, imageId?: Promise<string>, keepHistory = true) {
  const img = new Image();
  img.src = url;
  await img.decode();
  if (keepHistory && current) versions.push(current);
  image = img;
  preview = null;
  current = { url, imageId: imageId ?? upload(url) };
  current.imageId.catch((e) => showError(`upload failed: ${e.message}`));
  strokes = [];
  $('empty').hidden = true;
  draw();
}

async function upload(url: string) {
  const dataUrl = url.startsWith('data:') ? url : await blobToDataUrl(await (await fetch(url)).blob());
  return (await postJson('/api/images', { image: dataUrl })).imageId as string;
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
  if (state === 'processing') return;
  if (state === 'recording') cancelRecording();
  strokes = [];
  draw();
});
$('undo').addEventListener('click', async () => {
  if (state === 'processing' || state === 'recording') return;
  if (state === 'review') closeReview();
  const prev = versions.pop();
  if (prev) await setImage(prev.url, prev.imageId, false);
  resetPanel();
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

// Offscreen canvas for the "working on it" sheen, clipped to the masks.
const sheen = document.createElement('canvas');
const sheenCtx = sheen.getContext('2d')!;

function draw() {
  const dpr = devicePixelRatio || 1;
  const cw = Math.round(stage.clientWidth * dpr);
  const ch = Math.round(stage.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) [canvas.width, canvas.height] = [cw, ch];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return;
  const r = fitRect();
  ctx.drawImage(preview ?? image, r.x, r.y, r.w, r.h);

  // SAM masks: a tint in the mark's colour, plus a moving sheen while the edit runs.
  const masks = strokes.filter((s) => s.mask && !s.settled);
  if (masks.length) {
    ctx.globalAlpha = state === 'processing' ? 0.28 : 0.38;
    for (const s of masks) ctx.drawImage(s.mask!, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
    if (state === 'processing') drawSheen(masks, r);
  }

  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.scale(r.k, r.k);
  const unit = Math.max(image.naturalWidth, image.naturalHeight) / 160;
  for (const s of strokes) drawStroke(s, unit, state === 'processing' ? 0.55 : 1);
  ctx.restore();
}

function drawSheen(masks: Stroke[], r: ReturnType<typeof fitRect>) {
  sheen.width = Math.max(1, Math.round(r.w));
  sheen.height = Math.max(1, Math.round(r.h));
  for (const s of masks) sheenCtx.drawImage(s.mask!, 0, 0, sheen.width, sheen.height);
  sheenCtx.globalCompositeOperation = 'source-in';
  const span = sheen.width + sheen.height;
  const at = ((performance.now() / 1400) % 1) * span * 1.6 - span * 0.3;
  const g = sheenCtx.createLinearGradient(at - 160, at * 0.4 - 80, at + 160, at * 0.4 + 80);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  sheenCtx.fillStyle = g;
  sheenCtx.fillRect(0, 0, sheen.width, sheen.height);
  sheenCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(sheen, r.x, r.y, r.w, r.h);
}

function animate() {
  if (state !== 'processing') return;
  draw();
  requestAnimationFrame(animate);
}

// Same look as the server's render (white halo, colour line, numbered badge).
function drawStroke(s: Stroke, unit: number, alpha: number) {
  if (!s.points.length) return;
  ctx.globalAlpha = alpha;
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
  ctx.globalAlpha = 1;
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
  if (drawing) segment(drawing);
  drawing = null;
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// Ask SAM for this mark right away; show its outline when it comes back.
async function segment(s: Stroke) {
  s.markId = crypto.randomUUID().slice(0, 8);
  try {
    const imageId = await current!.imageId;
    const r = await postJson('/api/marks', { imageId, markId: s.markId, stroke: { mark: s.mark, points: s.points } });
    if (r.found) {
      const mask = new Image();
      mask.src = r.overlay;
      await mask.decode();
      s.mask = mask;
    }
  } catch (err) {
    console.warn('SAM for mark', s.mark, 'failed:', err);
  }
  s.samDone = true;
  if (strokes.includes(s)) {
    draw();
    updateSamStage();
  }
}

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
    t0 = performance.now();
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
  talkLabel.textContent = IDLE_LABEL;
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
  stagesEl.hidden = false;
  updateSamStage();
  animate();
  try {
    const { id } = await postJson('/api/jobs', {
      imageId: await current!.imageId,
      strokes: strokes.map(({ mark, points, markId }) => ({ mark, points, markId })),
      audio: audio ? await blobToDataUrl(audio) : null,
    });
    await follow(id);
  } catch (err) {
    showError((err as Error).message);
  }
}

// ---------- progress ----------

const SERVER_STAGES = ['understand', 'edit', 'paste', 'done'];

function setStage(name: string, cls: string) {
  const li = stagesEl.querySelector<HTMLElement>(`[data-stage="${name}"]`);
  if (li) li.className = cls;
}

function updateSamStage() {
  if (stagesEl.hidden) return;
  setStage('sam', strokes.every((s) => s.samDone) ? 'done' : 'active');
}

function resetPanel() {
  stagesEl.hidden = true;
  for (const li of stagesEl.querySelectorAll('li')) li.className = '';
  caption.textContent = '';
  caption.classList.remove('error');
  editsEl.innerHTML = '';
  review.hidden = true;
}

async function follow(id: string) {
  for (;;) {
    const job: Job = await (await fetch(`/api/jobs/${id}`)).json();
    if (job.error) throw new Error(job.error);
    const at = SERVER_STAGES.indexOf(job.stage);
    SERVER_STAGES.forEach((name, i) => setStage(name, i < at ? 'done' : i === at ? 'active' : ''));
    if (job.transcript) caption.textContent = `“${job.transcript}”`;
    if (job.edits && !editsEl.childElementCount) showEdits(job.edits, job.localMarks ?? []);
    if (job.previewImageId && !preview) await showPreview(job.previewImageId, job.localMarks ?? []);
    talkLabel.textContent = `Working… ${Math.round(job.elapsedMs / 1000)} s`;
    if (job.stage === 'done') return showResult(job.resultImageId!);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function showEdits(edits: Edit[], localMarks: number[]) {
  for (const e of edits) {
    const li = document.createElement('li');
    li.dataset.mark = String(e.mark);
    li.innerHTML = `<b style="background:${colorOf(e.mark)}">${e.mark}</b>`;
    li.append(`${e.target} → ${e.instruction}`);
    if (localMarks.includes(e.mark)) li.insertAdjacentHTML('beforeend', ' <i class="instant">⚡ instant</i>');
    editsEl.append(li);
    // An arrow's SAM mask is whatever it crossed: stop highlighting it.
    const s = strokes.find((s) => s.mark === e.mark);
    if (s) s.settled = e.kind === 'pointer' || /^no change/i.test(e.instruction);
  }
}

// Local edits are done: show them now, keep the sheen on what Muse is still editing.
async function showPreview(id: string, localMarks: number[]) {
  const img = new Image();
  img.src = `/api/images/${id}.jpg`;
  await img.decode();
  preview = img;
  for (const s of strokes) if (localMarks.includes(s.mark)) s.settled = true;
  draw();
}

function showError(msg: string) {
  state = 'idle';
  talk.disabled = false;
  talkLabel.textContent = IDLE_LABEL;
  caption.textContent = `Something went wrong: ${msg}`;
  caption.classList.add('error');
  draw();
}

// ---------- before / after ----------

let result: Version | null = null;
async function showResult(resultImageId: string) {
  result = { url: `/api/images/${resultImageId}.jpg`, imageId: Promise.resolve(resultImageId) };
  $<HTMLImageElement>('before').src = current!.url;
  const after = $<HTMLImageElement>('after');
  after.src = result.url;
  await after.decode();
  state = 'review';
  talk.disabled = false;
  talkLabel.textContent = 'Talk again to keep going';
  review.hidden = false;
  compare.hidden = false;
  placeCompare();
  setSplit(0.5);
  draw();
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
  talkLabel.textContent = IDLE_LABEL;
}

// Keep: the result becomes the image to keep refining. Talking again from
// review also keeps it.
async function keepResult() {
  closeReview();
  if (result) await setImage(result.url, result.imageId);
  resetPanel();
}
$('keep').addEventListener('click', keepResult);
$('discard').addEventListener('click', () => {
  closeReview();
  strokes = [];
  draw();
  resetPanel();
});
