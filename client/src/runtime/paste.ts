// Pasting an edit back only where it was asked for, and the regions that
// decide that: each mark's SAM mask (or its stroke), what the edit visibly
// changed near it, grown and feathered. Pure pixel work, so it also runs in
// the pixels worker (no API calls here).

import type { Mask } from './meta';
import type { Edit } from './pipeline';
import { fromPixels, pasteAlpha, pasteBack, pixels, strokeBox, type Source, type Stroke } from './render';

// The mark itself as a filled region (its bounding box as an ellipse), for
// marks SAM returned nothing for, and for arrows whose path matters too.
export function strokeMask(s: Stroke, width: number, height: number, scale: number, minRadius = 12): Mask {
  const b = strokeBox(s);
  const pad = 0.15;
  const cx = ((b.left + b.right) / 2) * scale;
  const cy = ((b.top + b.bottom) / 2) * scale;
  const rx = Math.max(minRadius, ((b.right - b.left) / 2) * scale * (1 + pad));
  const ry = Math.max(minRadius, ((b.bottom - b.top) / 2) * scale * (1 + pad));
  const data = new Uint8Array(width * height);
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(height, cy + ry); y++)
    for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(width, cx + rx); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) data[y * width + x] = 1;
  return { width, height, data };
}

// A sketch's region: inside its path (closed from last point to first) plus a
// band along the line, so a new outline larger than the old part is covered.
export function strokeHull(s: Stroke, width: number, height: number, scale: number): Mask {
  const pts = s.points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const b = strokeBox(s);
  const band = Math.max(4, Math.max(width, height) * 0.015);
  const data = new Uint8Array(width * height);
  const [x0, x1] = [Math.max(0, Math.floor(b.left * scale - band)), Math.min(width, Math.ceil(b.right * scale + band))];
  const [y0, y1] = [Math.max(0, Math.floor(b.top * scale - band)), Math.min(height, Math.ceil(b.bottom * scale + band))];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      let inside = false, near = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], c = pts[j];
        if (a.y > y !== c.y > y && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) inside = !inside;
        if (!near && i > 0) {
          // Distance to the segment from point i-1 to i (the drawn line, not the closing edge).
          const p = pts[i - 1], dx = a.x - p.x, dy = a.y - p.y;
          const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / Math.max(1e-6, dx * dx + dy * dy)));
          near = Math.hypot(x - p.x - t * dx, y - p.y - t * dy) <= band;
        }
      }
      if (inside || near) data[y * width + x] = 1;
    }
  return { width, height, data };
}

// Where the edit clearly changed the picture near a mark (steam above a
// removed cup, a lamp at the arrow's end), at SAM's size. Muse redraws the
// whole image with small drift, so only strong differences count.
function changedNear(image: Source, edited: Source, areas: number[][], w: number, h: number): Mask {
  const a = pixels(image, w, h).data;
  const b = pixels(edited, w, h).data;
  const data = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of areas)
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
        const i = (y * w + x) * 4;
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 48) data[y * w + x] = 1;
      }
  // Drop specks: keep pixels whose 5×5 neighbourhood is mostly changed.
  const out = new Uint8Array(w * h);
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) n += data[(y + dy) * w + x + dx];
      if (n >= 13) out[y * w + x] = 1;
    }
  return { width: w, height: h, data: out };
}

export type Seg = { masks: Map<number, Mask>; width: number; height: number };

// Where generative edits may change the picture, at SAM's size: each mark's
// SAM mask (or the stroke, for an arrow), and the area around it that the
// paste also takes changes from (the mark's box grown by half; a quarter of
// the image around an arrow).
export function editAreas(strokes: Stroke[], edits: Edit[], seg: Seg, scale: number) {
  const side = Math.max(seg.width, seg.height);
  const regions: Mask[] = [];
  const near: number[][] = [];
  for (const s of strokes) {
    const e = edits.find((e) => e.mark === s.mark);
    if (!e || /^no change/i.test(e.instruction)) continue;
    const b = strokeBox(s);
    const [x0, y0, x1, y1] = [b.left * scale, b.top * scale, b.right * scale, b.bottom * scale];
    if (e.kind === 'pointer') {
      // Where an arrow points, something may arrive: look a quarter of the image around it.
      regions.push(strokeMask(s, seg.width, seg.height, scale));
      near.push([x0 - side / 4, y0 - side / 4, x1 + side / 4, y1 + side / 4]);
    } else if (e.kind === 'sketch') {
      // The old part (SAM) and the new shape (the stroke's hull), so neither is clipped.
      const mask = seg.masks.get(s.mark);
      if (mask) regions.push(mask);
      regions.push(strokeHull(s, seg.width, seg.height, scale));
      const gx = (x1 - x0) * 0.5, gy = (y1 - y0) * 0.5;
      near.push([x0 - gx, y0 - gy, x1 + gx, y1 + gy]);
    } else {
      regions.push(seg.masks.get(s.mark) ?? strokeMask(s, seg.width, seg.height, scale));
      const gx = (x1 - x0) * 0.5, gy = (y1 - y0) * 0.5;
      near.push([x0 - gx, y0 - gy, x1 + gx, y1 + gy]);
    }
  }
  return { regions, near };
}

// Does a mask touch any of those areas?
export function touchesAreas(mask: Mask, areas: { regions: Mask[]; near: number[][] }) {
  const { width: w, data } = mask;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (areas.near.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return true;
    if (areas.regions.some((r) => r.data[i])) return true;
  }
  return false;
}

// Paste only the marked regions of `edited` onto `image`: each mark's SAM
// mask, plus whatever the edit visibly changed close to the mark.
// `image`: the picture's pixels; `edited`: Muse Image's result at any size.
export function pasteMarked(image: ImageData, edited: Source, strokes: Stroke[], seg: Seg, edits: Edit[]) {
  const { width, height } = image;
  const { regions, near } = editAreas(strokes, edits, seg, seg.width / width);
  if (!regions.length) return { out: image, alpha: new Uint8Array(width * height) };
  regions.push(changedNear(fromPixels(image), edited, near, seg.width, seg.height));
  const full = Math.max(width, height);
  const alpha = pasteAlpha(regions, width, height, full * 0.03, full * 0.012);
  return { out: pasteBack(image, edited, alpha), alpha };
}
