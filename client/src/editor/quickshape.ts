// QuickShape: a stroke held still at its end snaps to the shape it was meant
// to be, when it is close enough: a straight line, an ellipse or circle, or a
// straight arrow (a line ending in a hook or a V). Otherwise it stays freehand.
// Coordinates are image px; times are kept, spread along the new path, so the
// drawing video and SAM see the snapped stroke as if it had been drawn so.

export type Point = { x: number; y: number; t: number };
export type Shape = 'line' | 'circle' | 'ellipse' | 'arrow';
type XY = { x: number; y: number };

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const pathLength = (pts: XY[]) => pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1], p) : 0), 0);

// n points evenly spaced along the path.
function resample(pts: XY[], n: number): XY[] {
  const total = pathLength(pts);
  if (!total) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const out: XY[] = [{ ...pts[0] }];
  let i = 1, walked = 0;
  for (let k = 1; k < n - 1; k++) {
    const target = (total * k) / (n - 1);
    while (i < pts.length - 1 && walked + dist(pts[i - 1], pts[i]) < target) walked += dist(pts[i - 1], pts[i++]);
    const seg = dist(pts[i - 1], pts[i]) || 1;
    const u = (target - walked) / seg;
    out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u });
  }
  out.push({ ...pts.at(-1)! });
  return out;
}

// The new path, timed from the stroke's first to last time by distance along it.
function timed(path: XY[], t0: number, t1: number): Point[] {
  const total = pathLength(path) || 1;
  let walked = 0;
  return path.map((p, i) => {
    if (i) walked += dist(path[i - 1], p);
    return { x: Math.round(p.x), y: Math.round(p.y), t: Math.round(t0 + ((t1 - t0) * walked) / total) };
  });
}

// Distance from p to the line through a and b.
function offLine(p: XY, a: XY, b: XY) {
  const len = dist(a, b) || 1;
  return ((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len; // signed
}

function fitLine(pts: XY[]): XY[] | null {
  const [a, b] = [pts[0], pts.at(-1)!];
  const chord = dist(a, b);
  if (pathLength(pts) / chord > 1.08) return null;
  if (Math.max(...pts.map((p) => Math.abs(offLine(p, a, b)))) > 0.035 * chord) return null;
  return resample([a, b], 24);
}

// A loop (it goes most of the way around its centre): fit an ellipse from the
// spread of its points, then check every point lies close to it.
function fitEllipse(pts: XY[]): { path: XY[]; circle: boolean } | null {
  const even = resample(pts, 64);
  const cx = even.reduce((s, p) => s + p.x, 0) / even.length;
  const cy = even.reduce((s, p) => s + p.y, 0) / even.length;
  let sweep = 0;
  for (let i = 1; i < even.length; i++) {
    let d = Math.atan2(even[i].y - cy, even[i].x - cx) - Math.atan2(even[i - 1].y - cy, even[i - 1].x - cx);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    sweep += d;
  }
  if (Math.abs(sweep) < 2 * Math.PI * 0.85) return null;
  // Only the first full turn: an overshoot past the start would skew the fit.
  let turn = 0, end = even.length;
  for (let i = 1; i < even.length; i++) {
    let d = Math.atan2(even[i].y - cy, even[i].x - cx) - Math.atan2(even[i - 1].y - cy, even[i - 1].x - cx);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    turn += d;
    if (Math.abs(turn) >= 2 * Math.PI) { end = i + 1; break; }
  }
  const ring = resample(even.slice(0, end), 64);
  const mx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
  const my = ring.reduce((s, p) => s + p.y, 0) / ring.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of ring) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  [sxx, syy, sxy] = [sxx / ring.length, syy / ring.length, sxy / ring.length];
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const mid = (sxx + syy) / 2, diff = Math.hypot((sxx - syy) / 2, sxy);
  let a = Math.sqrt(2 * (mid + diff)), b = Math.sqrt(2 * Math.max(1e-6, mid - diff));
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const local = (p: XY) => ({ u: (p.x - mx) * cos + (p.y - my) * sin, v: -(p.x - mx) * sin + (p.y - my) * cos });
  const radial = ring.map((p) => {
    const { u, v } = local(p);
    return Math.hypot(u / a, v / b);
  });
  const mean = radial.reduce((s, r) => s + r, 0) / radial.length;
  a *= mean;
  b *= mean;
  const errs = radial.map((r) => Math.abs(r / mean - 1));
  if (errs.reduce((s, e) => s + e, 0) / errs.length > 0.08 || Math.max(...errs) > 0.22) return null;
  const circle = b / a >= 0.88;
  if (circle) a = b = (a + b) / 2;
  // Start where the stroke started and go round the same way.
  const s0 = local(pts[0]);
  const phi0 = Math.atan2(s0.v / b, s0.u / a);
  const dir = Math.sign(sweep);
  const path = Array.from({ length: 57 }, (_, i) => {
    const phi = phi0 + (dir * 2 * Math.PI * i) / 56;
    const [u, v] = [a * Math.cos(phi), b * Math.sin(phi)];
    return { x: mx + u * cos - v * sin, y: my + u * sin + v * cos };
  });
  return { path, circle };
}

// A straight shaft to the farthest point (the tip), then a short tail back
// from it: a hook (one barb) or a V (both). Snaps to a shaft with a clean,
// symmetric two-barb head.
function fitArrow(pts: XY[]): XY[] | null {
  const start = pts[0];
  // The tip: where the pen first gets (nearly) farthest from the start; a V
  // comes back to it after the first barb.
  const far = Math.max(...pts.map((p) => dist(start, p)));
  const k = pts.findIndex((p) => dist(start, p) >= 0.97 * far);
  const tip = pts[k];
  const shaft = pts.slice(0, k + 1), tail = pts.slice(k);
  const S = dist(start, tip);
  if (tail.length < 3 || shaft.length < 3) return null;
  if (pathLength(shaft) / S > 1.12 || Math.max(...shaft.map((p) => Math.abs(offLine(p, start, tip)))) > 0.06 * S) return null;
  const tailLen = pathLength(tail);
  if (tailLen < 0.08 * S || tailLen > 0.7 * S) return null;
  // The tail goes back from the tip and stays near the shaft's end.
  const [ux, uy] = [(tip.x - start.x) / S, (tip.y - start.y) / S];
  const back = tail.map((p) => (tip.x - p.x) * ux + (tip.y - p.y) * uy);
  const side = tail.map((p) => offLine(p, start, tip));
  if (Math.max(...back) < 0.06 * S || Math.min(...back) < -0.03 * S || Math.max(...side.map(Math.abs)) > 0.4 * S) return null;
  const head = Math.min(0.3 * S, Math.max(0.12 * S, Math.max(...back)));
  const barb = (sign: number) => {
    const a = Math.PI / 6;
    const [bx, by] = [-ux * Math.cos(a) + sign * -uy * Math.sin(a), -uy * Math.cos(a) + sign * ux * Math.sin(a)];
    return { x: tip.x + bx * head, y: tip.y + by * head };
  };
  return [...resample([start, tip], 24), barb(1), tip, barb(-1)];
}

// The snapped stroke, or null to leave it freehand. `minSize`: the smallest
// stroke worth snapping, in image px (about 24 screen px).
export function quickShape(points: Point[], minSize: number): { shape: Shape; points: Point[] } | null {
  if (points.length < 6) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < minSize) return null;
  const [t0, t1] = [points[0].t, points.at(-1)!.t];
  const ellipse = fitEllipse(points);
  if (ellipse) return { shape: ellipse.circle ? 'circle' : 'ellipse', points: timed(ellipse.path, t0, t1) };
  const line = fitLine(points);
  if (line) return { shape: 'line', points: timed(line, t0, t1) };
  const arrow = fitArrow(points);
  if (arrow) return { shape: 'arrow', points: timed(arrow, t0, t1) };
  return null;
}
