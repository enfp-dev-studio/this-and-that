// Instant edits and paste-back in a Web Worker (pixels.worker.ts), with the
// main thread as the fallback where a worker can't draw (no OffscreenCanvas).
// Inputs are copied, so the caller keeps its pixels; results come back moved.

import { applyLocal } from './local';
import type { Mask } from './meta';
import { pasteMarked, type Seg } from './paste';
import type { Edit } from './pipeline';
import type { Stroke } from './render';

export type Request =
  | { op: 'local'; image: ImageData; edits: Edit[]; masks: [number, Mask][]; skip: number[] }
  | { op: 'paste'; image: ImageData; edited: ImageBitmap; strokes: Stroke[]; seg: { masks: [number, Mask][]; width: number; height: number }; edits: Edit[] };
type Result = { out: ImageData; done: number[] };

let worker: Worker | null | undefined;
const waiting = new Map<number, { resolve: (r: Result) => void; reject: (e: Error) => void }>();
let seq = 0;

function pixelsWorker() {
  if (worker !== undefined) return worker;
  try {
    worker = typeof OffscreenCanvas === 'undefined' ? null : new Worker(new URL('./pixels.worker.ts', import.meta.url), { type: 'module' });
    worker?.addEventListener('message', (e: MessageEvent<{ id: number; out?: Result; error?: string }>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.out) w?.resolve(e.data.out);
      else w?.reject(new Error(e.data.error ?? 'pixels worker failed'));
    });
    worker?.addEventListener('error', () => {
      // A worker that can't start: everything from now on runs here.
      worker = null;
      for (const w of waiting.values()) w.reject(new Error('pixels worker failed'));
      waiting.clear();
    });
  } catch {
    worker = null;
  }
  return worker;
}

function run(req: Request, transfer: Transferable[] = []) {
  const w = pixelsWorker();
  if (!w) return Promise.reject(new Error('no pixels worker'));
  const id = ++seq;
  return new Promise<Result>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, req }, transfer);
  });
}

export async function applyLocalOff(image: ImageData, edits: Edit[], masks: Map<number, Mask>, skip = new Set<number>()) {
  try {
    const r = await run({ op: 'local', image, edits, masks: [...masks], skip: [...skip] });
    return { out: r.out, done: new Set(r.done) };
  } catch {
    return applyLocal(image, edits, masks, skip);
  }
}

// `edited` is handed over (and closed) either way.
export async function pasteMarkedOff(image: ImageData, edited: ImageBitmap, strokes: Stroke[], seg: Seg, edits: Edit[]) {
  try {
    const fallback = await createImageBitmap(edited); // in case the worker fails after taking `edited`
    try {
      const r = await run({ op: 'paste', image, edited, strokes, seg: { ...seg, masks: [...seg.masks] }, edits }, [edited]);
      return { out: r.out };
    } catch {
      return { out: pasteMarked(image, fallback, strokes, seg, edits).out };
    } finally {
      fallback.close();
    }
  } catch {
    return { out: pasteMarked(image, edited, strokes, seg, edits).out };
  }
}
