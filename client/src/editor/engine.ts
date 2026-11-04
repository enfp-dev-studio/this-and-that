// The editor without the UI: the canvas (image, marks, SAM outlines, sheen),
// recording (marks + voice + realtime transcription), jobs and version
// history. React reads its state through subscribe/getSnapshot; pointer
// drawing goes straight to the canvas.

import { postJson } from './api';
import { LiveAsr } from './live-asr';
import { markColor, themeColor, watchTheme } from './colors';

export type Point = { x: number; y: number; t: number };
export type Stroke = {
  mark: number;
  points: Point[];
  markId?: string; // SAM request for this mark, sent when the stroke ends
  mask?: HTMLImageElement; // SAM's outline of what the mark points at
  tinted?: { color: string; canvas: HTMLCanvasElement };
  samDone?: boolean;
  settled?: boolean; // no tint or sheen: an arrow, "no change", or already edited locally
};
export type Edit = { mark: number; kind?: string; op?: string; target: string; instruction: string };
export type Version = { url: string; imageId: Promise<string> };
export type StepState = 'pending' | 'active' | 'done';
export type Mode = 'empty' | 'idle' | 'recording' | 'processing' | 'review';
export type Fit = { x: number; y: number; w: number; h: number };

export type Snapshot = {
  mode: Mode;
  caption: string;
  edits: Edit[];
  localMarks: number[];
  steps: { sam: StepState; understand: StepState; edit: StepState; paste: StepState };
  elapsedMs: number;
  marks: number; // marks drawn in this recording
  penOnly: boolean; // once a stylus is used, fingers don't draw
  versions: Version[];
  index: number; // current version
  result: Version | null; // the edit waiting for Keep or Discard
  compare: boolean; // before/after overlay
  fit: Fit; // where the image sits in the stage, CSS px
};

type Job = {
  stage: string;
  transcript?: string;
  edits?: Edit[];
  error?: string;
  resultImageId?: string;
  previewImageId?: string;
  localMarks?: number[];
  elapsedMs: number;
};

const NO_STEPS = { sam: 'pending', understand: 'pending', edit: 'pending', paste: 'pending' } as const;
const SERVER_STEPS = ['understand', 'edit', 'paste', 'done'] as const;
// Room around the image for the floating toolbar and breathing space.
const PAD = { top: 32, side: 32, bottom: 128 };


export const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });

async function upload(url: string) {
  const dataUrl = url.startsWith('data:') ? url : await blobToDataUrl(await (await fetch(url)).blob());
  return (await postJson('/api/images', { image: dataUrl })).imageId as string;
}

class Editor {
  private snapshot: Snapshot = {
    mode: 'empty',
    caption: '',
    edits: [],
    localMarks: [],
    steps: { ...NO_STEPS },
    elapsedMs: 0,
    marks: 0,
    penOnly: false,
    versions: [],
    index: -1,
    result: null,
    compare: false,
    fit: { x: 0, y: 0, w: 0, h: 0 },
  };
  private listeners = new Set<() => void>();
  onError: (message: string) => void = () => {};
  onNotice: (message: string) => void = () => {};

  private stage?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private image: HTMLImageElement | null = null;
  private preview: HTMLImageElement | null = null; // instant edits, shown while the rest is edited
  private strokes: Stroke[] = [];
  private drawing: Stroke | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;
  private micStream: MediaStream | null = null;
  private live: LiveAsr | null = null;
  private pressedAt = 0;
  private startedByThisPress = false;

  // ---------- store ----------

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;
  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  // ---------- canvas ----------

  attach(stage: HTMLElement, canvas: HTMLCanvasElement) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const ro = new ResizeObserver(() => this.draw());
    ro.observe(stage);
    const unwatch = watchTheme(() => this.draw());
    const listeners = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(type: K, f: (e: HTMLElementEventMap[K]) => void) => canvas.addEventListener(type, f, { signal: listeners.signal });
    on('pointerdown', (e) => this.pointerDown(e));
    on('pointermove', (e) => this.pointerMove(e));
    on('pointerup', () => this.endStroke());
    on('pointercancel', () => this.endStroke());
    this.draw();
    return () => {
      ro.disconnect();
      unwatch();
      listeners.abort();
    };
  }

  private fitRect(): Fit & { k: number } {
    const w = this.stage?.clientWidth ?? 0;
    const h = this.stage?.clientHeight ?? 0;
    if (!this.image) return { x: 0, y: 0, w, h, k: 1 };
    const aw = Math.max(1, w - PAD.side * 2), ah = Math.max(1, h - PAD.top - PAD.bottom);
    const k = Math.min(aw / this.image.naturalWidth, ah / this.image.naturalHeight);
    const iw = this.image.naturalWidth * k, ih = this.image.naturalHeight * k;
    return { x: (w - iw) / 2, y: PAD.top + (ah - ih) / 2, w: iw, h: ih, k };
  }

  draw() {
    const { canvas, ctx, stage } = this;
    if (!canvas || !ctx || !stage) return;
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(stage.clientWidth * dpr), ch = Math.round(stage.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) [canvas.width, canvas.height] = [cw, ch];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const r = this.fitRect();
    const f = this.snapshot.fit;
    if (f.x !== r.x || f.y !== r.y || f.w !== r.w || f.h !== r.h) queueMicrotask(() => this.set({ fit: { x: r.x, y: r.y, w: r.w, h: r.h } }));
    if (!this.image) return;
    ctx.drawImage(this.preview ?? this.image, r.x, r.y, r.w, r.h);

    // SAM outlines: a tint in the mark's colour, plus a sheen while the edit runs.
    const masks = this.strokes.filter((s) => s.mask && !s.settled);
    const working = this.snapshot.mode === 'processing';
    if (masks.length) {
      ctx.globalAlpha = working ? 0.28 : 0.38;
      for (const s of masks) ctx.drawImage(this.tint(s), r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      if (working) this.drawSheen(masks, r);
    }

    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.scale(r.k, r.k);
    const unit = Math.max(this.image.naturalWidth, this.image.naturalHeight) / 160;
    for (const s of this.strokes) this.drawStroke(s, unit, working ? 0.55 : 1);
    ctx.restore();
  }

  // The server's mask in this theme's colour for the mark.
  private tint(s: Stroke) {
    const color = markColor(s.mark);
    if (s.tinted?.color === color) return s.tinted.canvas;
    const c = document.createElement('canvas');
    c.width = s.mask!.naturalWidth;
    c.height = s.mask!.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(s.mask!, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    s.tinted = { color, canvas: c };
    return c;
  }

  private sheenCanvas = document.createElement('canvas');
  private drawSheen(masks: Stroke[], r: Fit) {
    const c = this.sheenCanvas;
    const g = c.getContext('2d')!;
    c.width = Math.max(1, Math.round(r.w));
    c.height = Math.max(1, Math.round(r.h));
    for (const s of masks) g.drawImage(this.tint(s), 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-in';
    const span = c.width + c.height;
    const at = ((performance.now() / 1400) % 1) * span * 1.6 - span * 0.3;
    const grad = g.createLinearGradient(at - 160, at * 0.4 - 80, at + 160, at * 0.4 + 80);
    const sheen = themeColor('--sheen');
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.5, sheen);
    grad.addColorStop(1, 'transparent');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    this.ctx!.drawImage(c, r.x, r.y, r.w, r.h);
  }

  private animate = () => {
    if (this.snapshot.mode !== 'processing') return;
    this.draw();
    requestAnimationFrame(this.animate);
  };

  // Same look as the server's render: halo, colour line, numbered badge.
  private drawStroke(s: Stroke, unit: number, alpha: number) {
    const ctx = this.ctx!;
    if (!s.points.length) return;
    const color = markColor(s.mark);
    const halo = themeColor('--mark-halo');
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [stroke, width] of [[halo, unit * 1.6], [color, unit]] as const) {
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    const r = unit * 2.6;
    const p0 = s.points[0];
    const bx = Math.min(Math.max(p0.x, r), this.image!.naturalWidth - r);
    const by = Math.min(Math.max(p0.y - r * 1.3, r), this.image!.naturalHeight - r);
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = unit * 0.5;
    ctx.strokeStyle = halo;
    ctx.stroke();
    ctx.fillStyle = themeColor('--mark-text');
    ctx.font = `600 ${r * 1.15}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s.mark), bx, by + r * 0.05);
    ctx.globalAlpha = 1;
  }

  private toImage(e: PointerEvent): Point {
    const box = this.canvas!.getBoundingClientRect();
    const r = this.fitRect();
    const x = (e.clientX - box.left - r.x) / r.k;
    const y = (e.clientY - box.top - r.y) / r.k;
    return {
      x: Math.round(Math.max(0, Math.min(this.image!.naturalWidth - 1, x))),
      y: Math.round(Math.max(0, Math.min(this.image!.naturalHeight - 1, y))),
      t: Math.round(performance.now() - this.t0),
    };
  }

  private async pointerDown(e: PointerEvent) {
    const { mode } = this.snapshot;
    if (!this.image || mode === 'processing' || mode === 'review') return;
    if (e.pointerType === 'pen' && !this.snapshot.penOnly) this.set({ penOnly: true });
    if (e.pointerType === 'touch' && this.snapshot.penOnly) return; // palm rejection once a stylus is in use
    this.canvas!.setPointerCapture(e.pointerId);
    if (mode === 'idle') await this.startRecording();
    this.drawing = { mark: this.strokes.length + 1, points: [this.toImage(e)] };
    this.strokes.push(this.drawing);
    this.set({ marks: this.strokes.length });
    this.draw();
  }

  private pointerMove(e: PointerEvent) {
    if (!this.drawing) return;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length ? coalesced : [e]) this.drawing.points.push(this.toImage(ev));
    this.draw();
  }

  private endStroke() {
    if (this.drawing) this.segment(this.drawing);
    this.drawing = null;
  }

  // Ask SAM for this mark right away; show its outline when it comes back.
  private async segment(s: Stroke) {
    s.markId = crypto.randomUUID().slice(0, 8);
    try {
      const imageId = await this.current()!.imageId;
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
    if (this.strokes.includes(s)) {
      this.draw();
      this.updateSamStep();
    }
  }

  setPenOnly(on: boolean) {
    this.set({ penOnly: on });
  }

  clearMarks() {
    if (this.snapshot.mode === 'processing') return;
    if (this.snapshot.mode === 'recording') this.cancelRecording();
    this.strokes = [];
    this.set({ marks: 0 });
    this.draw();
  }

  // ---------- images and history ----------

  private current() {
    return this.snapshot.versions[this.snapshot.index] as Version | undefined;
  }

  private async show(url: string) {
    const img = new Image();
    img.src = url;
    await img.decode();
    this.image = img;
    this.preview = null;
    this.strokes = [];
  }

  // A new picture starts a new history.
  async open(url: string) {
    if (this.snapshot.mode === 'processing' || this.snapshot.mode === 'recording') return;
    await this.show(url);
    const v: Version = { url, imageId: upload(url) };
    v.imageId.catch((e) => this.onError(`Upload failed: ${e.message}`));
    this.set({ mode: 'idle', versions: [v], index: 0, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }

  async openFile(file: Blob) {
    await this.open(await blobToDataUrl(file));
  }

  async goTo(index: number) {
    const { mode, versions } = this.snapshot;
    if (mode === 'processing' || mode === 'recording' || index < 0 || index >= versions.length) return;
    await this.show(versions[index].url);
    this.set({ mode: 'idle', index, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }
  undo = () => this.goTo(this.snapshot.index - 1);
  redo = () => this.goTo(this.snapshot.index + 1);

  // Keep: the result becomes the next version (dropping any redo).
  async keep() {
    const { result, versions, index } = this.snapshot;
    if (!result) return;
    await this.show(result.url);
    this.set({ mode: 'idle', versions: [...versions.slice(0, index + 1), result], index: index + 1, result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }

  discard() {
    this.strokes = [];
    this.preview = null;
    this.set({ mode: 'idle', result: null, compare: false, marks: 0, ...this.emptyPanel() });
    this.draw();
  }

  setCompare(on: boolean) {
    this.set({ compare: on });
  }

  // What the before/after overlay shows: the pending result against the
  // current version, or the current version against the one before it.
  comparePair(): { before: string; after: string } | null {
    const { result, versions, index } = this.snapshot;
    if (result) return { before: versions[index].url, after: result.url };
    if (index > 0) return { before: versions[index - 1].url, after: versions[index].url };
    return null;
  }

  // ---------- talk: hold to talk, or tap to start and tap to send ----------

  async talkDown() {
    const { mode } = this.snapshot;
    if (!this.image || mode === 'processing') return;
    this.pressedAt = performance.now();
    this.startedByThisPress = mode === 'idle' || mode === 'review';
    if (mode === 'review') await this.keep();
    if (this.startedByThisPress) await this.startRecording();
  }

  talkUp() {
    if (this.snapshot.mode !== 'recording') return;
    const held = performance.now() - this.pressedAt > 400;
    // A quick tap that started recording keeps it going; a hold, or a tap
    // while recording, sends.
    if (held || !this.startedByThisPress) this.stopAndSend();
  }

  private async startRecording() {
    if (this.snapshot.mode === 'recording') return;
    this.strokes = [];
    this.chunks = [];
    this.set({ mode: 'recording', marks: 0, compare: false, ...this.emptyPanel() });
    this.t0 = performance.now();
    try {
      this.micStream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.recorder = new MediaRecorder(this.micStream);
      this.recorder.ondataavailable = (ev) => ev.data.size && this.chunks.push(ev.data);
      this.recorder.start(250);
      // The clock starts when audio does, so stroke times line up with the voice.
      this.t0 = performance.now();
      try {
        this.live = new LiveAsr(this.micStream, (text) => this.snapshot.mode === 'recording' && text && this.set({ caption: text }));
      } catch {
        this.live = null; // batch transcription on the server still works
      }
    } catch (err) {
      this.recorder = null;
      this.onNotice(`Microphone unavailable (${(err as Error).message}). Marks only.`);
    }
  }

  private cancelRecording() {
    this.recorder?.stop();
    this.recorder = null;
    this.live?.stop();
    this.live = null;
    this.set({ mode: 'idle' });
  }

  private async stopAndSend() {
    const rec = this.recorder;
    const audio = rec
      ? await new Promise<Blob>((resolve) => {
          rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType }));
          rec.stop();
        })
      : null;
    this.recorder = null;
    const asrId = this.live ? this.live.stop() : Promise.resolve(null);
    this.live = null;
    if (!this.strokes.length) {
      this.set({ mode: 'idle' });
      this.onNotice('Draw a mark while you talk.');
      return;
    }
    this.set({ mode: 'processing', steps: { ...NO_STEPS, sam: 'active' }, elapsedMs: 0 });
    this.updateSamStep();
    this.animate();
    try {
      const { id } = await postJson('/api/jobs', {
        imageId: await this.current()!.imageId,
        strokes: this.strokes.map(({ mark, points, markId }) => ({ mark, points, markId })),
        audio: audio ? await blobToDataUrl(audio) : null,
        asrId: await asrId,
      });
      await this.follow(id);
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  // ---------- progress ----------

  private emptyPanel() {
    return { caption: '', edits: [], localMarks: [], steps: { ...NO_STEPS }, elapsedMs: 0 };
  }

  private updateSamStep() {
    if (this.snapshot.mode !== 'processing') return;
    this.set({ steps: { ...this.snapshot.steps, sam: this.strokes.every((s) => s.samDone) ? 'done' : 'active' } });
  }

  private async follow(id: string) {
    for (;;) {
      const job: Job = await (await fetch(`/api/jobs/${id}`)).json();
      if (job.error) throw new Error(job.error);
      const at = SERVER_STEPS.indexOf(job.stage as (typeof SERVER_STEPS)[number]);
      const steps = { ...this.snapshot.steps };
      for (const [i, name] of (['understand', 'edit', 'paste'] as const).entries()) steps[name] = i < at ? 'done' : i === at ? 'active' : 'pending';
      const patch: Partial<Snapshot> = { steps, elapsedMs: job.elapsedMs };
      if (job.transcript) patch.caption = job.transcript;
      if (job.edits && !this.snapshot.edits.length) {
        patch.edits = job.edits;
        // An arrow's SAM mask is whatever it crossed: stop highlighting it.
        for (const e of job.edits) {
          const s = this.strokes.find((s) => s.mark === e.mark);
          if (s) s.settled = e.kind === 'pointer' || /^no change/i.test(e.instruction);
        }
      }
      if (job.localMarks?.length) patch.localMarks = job.localMarks;
      this.set(patch);
      if (job.previewImageId && !this.preview) await this.showPreview(job.previewImageId, job.localMarks ?? []);
      if (job.stage === 'done') return this.showResult(job.resultImageId!);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Local edits are done: show them now, keep the sheen on what Muse is still editing.
  private async showPreview(id: string, localMarks: number[]) {
    const img = new Image();
    img.src = `/api/images/${id}.jpg`;
    await img.decode();
    this.preview = img;
    for (const s of this.strokes) if (localMarks.includes(s.mark)) s.settled = true;
    this.draw();
  }

  private async showResult(resultImageId: string) {
    const result: Version = { url: `/api/images/${resultImageId}.jpg`, imageId: Promise.resolve(resultImageId) };
    const img = new Image();
    img.src = result.url;
    await img.decode();
    this.set({ mode: 'review', result, compare: true, steps: { sam: 'done', understand: 'done', edit: 'done', paste: 'done' } });
    this.draw();
  }

  private fail(message: string) {
    this.set({ mode: 'idle', steps: { ...NO_STEPS } });
    this.onError(message);
    this.draw();
  }
}

export const editor = new Editor();
