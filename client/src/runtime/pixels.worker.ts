// The pixels worker: instant edits and paste-back at full size, off the main
// thread so the sheen and the pen keep moving while a result is put together.

import { applyLocal } from './local';
import { pasteMarked } from './paste';
import type { Request } from './pixels';

self.onmessage = (e: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = e.data;
  try {
    const out =
      req.op === 'local'
        ? (() => {
            const r = applyLocal(req.image, req.edits, new Map(req.masks), new Set(req.skip));
            return { out: r.out, done: [...r.done] };
          })()
        : (() => {
            const r = pasteMarked(req.image, req.edited, req.strokes, { ...req.seg, masks: new Map(req.seg.masks) }, req.edits);
            req.edited.close();
            return { out: r.out, done: [] };
          })();
    (self as unknown as Worker).postMessage({ id, out }, [out.out.data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
