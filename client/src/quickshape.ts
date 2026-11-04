// QuickShape: fit a hand-drawn stroke (2D, in its drawing plane) to a clean
// shape: a straight line, a circle or ellipse, an arrow, or an arc. Returns
// null when nothing fits well enough, so a loose stroke stays as drawn.
// Errors are relative to the stroke's size, so the plane's units don't matter.

export type P2 = { x: number; y: number };
export type Shape = { kind: 'line' | 'circle' | 'ellipse' | 'arc' | 'arrow'; points: P2[]; closed: boolean };

const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: P2, b: P2, t: number): P2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const segment = (a: P2, b: P2, n: number) => Array.from({ length: n + 1 }, (_, i) => lerp(a, b, i / n));

function pathLength(p: P2[]) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(p[i], p[i - 1]);
  return s;
}

// Distance from p to the segment ab.
function toSegment(p: P2, a: P2, b: P2) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function lineFit(p: P2[]) {
  const a = p[0], b = p[p.length - 1];
  const len = dist(a, b);
  if (len < 1e-9) return null;
  let max = 0, sq = 0;
  for (const q of p) {
    const d = toSegment(q, a, b);
    max = Math.max(max, d);
    sq += d * d;
  }
  return { len, max: max / len, rms: Math.sqrt(sq / p.length) / len };
}

// Algebraic (Kåsa) circle fit: x² + y² + Dx + Ey + F = 0.
function circleFit(p: P2[]) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  const n = p.length;
  for (const { x, y } of p) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
  }
  // Normal equations for [D, E, F].
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const r = [-sxz, -syz, -sz];
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d0 = det(m);
  if (Math.abs(d0) < 1e-18) return null;
  const col = (k: number) => m.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
  const [D, E, F] = [0, 1, 2].map((k) => det(col(k)) / d0);
  const c = { x: -D / 2, y: -E / 2 };
  const rad2 = c.x * c.x + c.y * c.y - F;
  if (!(rad2 > 0)) return null;
  const rad = Math.sqrt(rad2);
  let sq = 0;
  for (const q of p) sq += (dist(q, c) - rad) ** 2;
  return { c, r: rad, rms: Math.sqrt(sq / n) / rad };
}

// Ellipse from the principal axes of the points, sized by their extents.
function ellipseFit(p: P2[]) {
  const n = p.length;
  const mx = p.reduce((s, q) => s + q.x, 0) / n, my = p.reduce((s, q) => s + q.y, 0) / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const q of p) {
    cxx += (q.x - mx) ** 2; cyy += (q.y - my) ** 2; cxy += (q.x - mx) * (q.y - my);
  }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const [ux, uy, vx, vy] = [Math.cos(theta), Math.sin(theta), -Math.sin(theta), Math.cos(theta)];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const q of p) {
    const u = (q.x - mx) * ux + (q.y - my) * uy, v = (q.x - mx) * vx + (q.y - my) * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  if (a < 1e-9 || b < 1e-9) return null;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const c = { x: mx + cu * ux + cv * vx, y: my + cu * uy + cv * vy };
  let sq = 0;
  for (const q of p) {
    const u = (q.x - c.x) * ux + (q.y - c.y) * uy, v = (q.x - c.x) * vx + (q.y - c.y) * vy;
    sq += (Math.hypot(u / a, v / b) - 1) ** 2;
  }
  return { c, a, b, theta, rms: Math.sqrt(sq / n) };
}

// Unwrapped angles of the points around c, in drawing order.
function sweep(p: P2[], c: P2) {
  let prev = Math.atan2(p[0].y - c.y, p[0].x - c.x);
  const start = prev;
  let total = 0;
  for (let i = 1; i < p.length; i++) {
    const a = Math.atan2(p[i].y - c.y, p[i].x - c.x);
    let d = a - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = a;
  }
  return { start, total };
}

// A straight shaft with a small head at its end, drawn in one stroke.
function arrowFit(p: P2[]): Shape | null {
  const n = p.length;
  const extent = Math.max(...p.map((q) => dist(q, p[0])));
  // The longest straight run from the start is the shaft.
  let k = -1;
  for (let i = n - 3; i >= Math.floor(n * 0.35); i--) {
    const f = lineFit(p.slice(0, i + 1));
    if (f && f.max < 0.06 && f.len > 0.6 * extent) {
      k = i;
      break;
    }
  }
  if (k < 0) return null;
  const a = p[0], b = p[k];
  const len = dist(a, b);
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const head = p.slice(k);
  const headSize = Math.max(...head.map((q) => dist(q, b)));
  // The head is small, really there, and points back along the shaft.
  if (head.length < 4 || headSize < 0.12 * len || headSize > 0.5 * len) return null;
  const back = head.reduce((s, q) => s + ((q.x - b.x) * dir.x + (q.y - b.y) * dir.y), 0) / head.length;
  if (back > -0.04 * len) return null;
  const barb = Math.min(0.3 * len, Math.max(0.14 * len, headSize));
  const ang = (28 * Math.PI) / 180;
  const rot = (s: number) => ({ x: b.x + barb * (-dir.x * Math.cos(ang) - s * -dir.y * Math.sin(ang)), y: b.y + barb * (-dir.y * Math.cos(ang) + s * -dir.x * Math.sin(ang)) });
  const c1 = rot(1), c2 = rot(-1);
  return { kind: 'arrow', points: [...segment(a, b, 16), ...segment(b, c1, 4).slice(1), ...segment(c1, b, 4).slice(1), ...segment(b, c2, 4).slice(1)], closed: false };
}

export function fitShape(p: P2[]): Shape | null {
  if (p.length < 6) return null;
  const length = pathLength(p);
  if (length < 1e-9) return null;

  const line = lineFit(p);
  if (line && line.max < 0.08 && line.rms < 0.035) return { kind: 'line', points: segment(p[0], p[p.length - 1], 16), closed: false };

  // Closed loop: ends meet, or it goes (almost) all the way around.
  const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const circle = circleFit(p);
  const turned = circle ? Math.abs(sweep(p, circle.c).total) : 0;
  const closed = dist(p[0], p[p.length - 1]) < 0.22 * diag || turned > (300 * Math.PI) / 180;
  if (closed) {
    const ring = (c: P2, a: number, b: number, th: number) =>
      Array.from({ length: 49 }, (_, i) => {
        const t = (i / 48) * 2 * Math.PI;
        const u = a * Math.cos(t), v = b * Math.sin(t);
        return { x: c.x + u * Math.cos(th) - v * Math.sin(th), y: c.y + u * Math.sin(th) + v * Math.cos(th) };
      });
    if (circle && circle.rms < 0.07) return { kind: 'circle', points: ring(circle.c, circle.r, circle.r, 0), closed: true };
    const e = ellipseFit(p);
    if (e && e.rms < 0.09) return { kind: 'ellipse', points: ring(e.c, e.a, e.b, e.theta), closed: true };
    return null;
  }

  const arrow = arrowFit(p);
  if (arrow) return arrow;

  if (circle && circle.rms < 0.05 && turned > (25 * Math.PI) / 180) {
    const { start, total } = sweep(p, circle.c);
    const n = Math.max(12, Math.round((Math.abs(total) / (2 * Math.PI)) * 48));
    return { kind: 'arc', points: Array.from({ length: n + 1 }, (_, i) => ({ x: circle.c.x + circle.r * Math.cos(start + (total * i) / n), y: circle.c.y + circle.r * Math.sin(start + (total * i) / n) })), closed: false };
  }
  return null;
}
