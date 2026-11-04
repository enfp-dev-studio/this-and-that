// Spark's part list, held to the sketch. In 3D the strokes are guides, not
// geometry to trace: they say WHERE the model or a new part goes and roughly
// what form it has; the parts stay the clean primitives Spark designed.
// - A first build: the whole model is moved (and evenly scaled, a little) so it
//   sits where the sketch is; each part keeps Spark's shape and proportions.
// - An edit: each new part goes to the region its strokes mark (keeping Spark's
//   size and height), then is attached to the nearest part of the model. The
//   count comes from the intent: one part per role, a mirrored pair for
//   left/right roles or plural words ("armrests"), the missing twin added
//   when only one side came back; more only when the words count them.
// Plain math, no three.js: used by server/3d/perceive.ts (the local server)
// and client/src/runtime/perceive.ts (the web app).

type Vec = number[];
export type FitStroke = { id: number; drawnFrom: Vec; plane: 'view' | 'ground' | 'surface'; bbox: { min: Vec; max: Vec }; points: Vec[] };
export type FitPart = { name: string; primitive: string; center: Vec; size: Vec; rotation: Vec; strokes: number[]; path?: Vec[]; radii?: number[]; outline?: Vec[] };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

// Rotation matrix (rows = world axes, columns = the part's local axes), Euler XYZ in degrees as three.js.
function matrix([rx, ry, rz]: Vec) {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [
    [cb * cc, -cb * sc, sb],
    [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
    [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
  ];
}

// The points a tube or membrane is made of, in its own frame (null: a solid primitive).
function shapePoints(p: FitPart): Vec[] | null {
  if (p.primitive === 'tube' && (p.path?.length ?? 0) >= 2) return p.path!;
  if (p.primitive === 'membrane' && (p.outline?.length ?? 0) >= 3) return p.outline!.map(([x, y]) => [x, y, 0]);
  return null;
}

// Euler XYZ (degrees, as three.js) of the frame whose local x, y, z are u, v, n.
function euler(u: Vec, v: Vec, n: Vec) {
  const m11 = u[0], m12 = v[0], m13 = n[0], m22 = v[1], m23 = n[1], m32 = v[2], m33 = n[2];
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  const [rx, rz] = Math.abs(m13) < 0.9999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
  return [rx, ry, rz].map((r) => r3((r * 180) / Math.PI));
}
const sub = (a: Vec, b: Vec) => a.map((x, i) => x - b[i]);
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec) => a.map((x) => x / (Math.hypot(...a) || 1));

// A part's world-axis box.
function box(p: FitPart) {
  const m = matrix(p.rotation);
  const local = shapePoints(p);
  if (local) {
    const pad = p.primitive === 'tube' ? Math.abs(p.radii?.[0] ?? 0.02) : Math.abs(p.size[2] ?? 0.01) / 2;
    const world = local.map((q) => [0, 1, 2].map((a) => p.center[a] + m[a][0] * q[0] + m[a][1] * q[1] + m[a][2] * q[2]));
    return { min: [0, 1, 2].map((a) => Math.min(...world.map((w) => w[a])) - pad), max: [0, 1, 2].map((a) => Math.max(...world.map((w) => w[a])) + pad) };
  }
  const half = [0, 1, 2].map((a) => [0, 1, 2].reduce((s, j) => s + Math.abs(m[a][j]) * Math.abs(p.size[j]), 0) / 2);
  return { min: p.center.map((c, a) => c - half[a]), max: p.center.map((c, a) => c + half[a]) };
}

// What a stroke fixes along each axis: one drawn on a plane facing the camera
// says nothing about depth along the view direction; one drawn on the model's
// surface marks a place on it, not a height.
function fixes(s: FitStroke) {
  const d = s.drawnFrom.map(Math.abs);
  const depth = s.plane === 'view' ? d.indexOf(Math.max(...d)) : -1;
  return [0, 1, 2].map((a) => a !== depth && !(s.plane === 'surface' && a === 1));
}

// The range the strokes cover along each axis they fix (null: none fixes it).
function range(strokes: FitStroke[]) {
  return [0, 1, 2].map((a) => {
    const vals = strokes.filter((s) => fixes(s)[a]).flatMap((s) => [s.bbox.min[a], s.bbox.max[a]]);
    return vals.length ? { lo: Math.min(...vals), hi: Math.max(...vals) } : null;
  });
}

// Strokes that touch or nearly touch (bounding boxes within 6 cm) are one cluster.
function clusters(strokes: FitStroke[]) {
  const parent = strokes.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const gap = (a: FitStroke, b: FitStroke) => Math.max(...[0, 1, 2].map((k) => Math.max(0, a.bbox.min[k] - b.bbox.max[k], b.bbox.min[k] - a.bbox.max[k])));
  for (let i = 0; i < strokes.length; i++) for (let j = i + 1; j < strokes.length; j++) if (gap(strokes[i], strokes[j]) <= 0.06) parent[root(i)] = root(j);
  const out = new Map<number, FitStroke[]>();
  strokes.forEach((s, i) => out.set(root(i), [...(out.get(root(i)) ?? []), s]));
  return [...out.values()];
}

// A part's role: its name without sides and copies ("armrest_left", "armrest_mirror_2" → "armrest").
const SIDES = /\b(left|right|l|r|side|sides|both|pair|mirror|mirrored|other|copy|second|extra|new|a|b|[0-9]+)\b/g;
const role = (name: string) => name.toLowerCase().replace(/[_\-.]+/g, ' ').replace(SIDES, ' ').replace(/\s+/g, ' ').trim().replace(/s$/, '');
const mirrorName = (name: string) => (/left/i.test(name) ? name.replace(/left/i, (m) => (m[0] === 'L' ? 'Right' : 'right')) : /right/i.test(name) ? name.replace(/right/i, (m) => (m[0] === 'R' ? 'Left' : 'left')) : `${name}_2`);

const COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6 };

// A first build: the model moved onto the sketch, scaled evenly by at most ±20%.
function alignModel<P extends FitPart>(parts: P[], strokes: FitStroke[], log: (s: string) => void): P[] {
  if (!parts.length || !strokes.length) return parts;
  const want = range(strokes);
  const boxes = parts.map(box);
  const have = [0, 1, 2].map((a) => ({ lo: Math.min(...boxes.map((b) => b.min[a])), hi: Math.max(...boxes.map((b) => b.max[a])) }));
  const ratios = [0, 1, 2].flatMap((a) => (want[a] && want[a]!.hi - want[a]!.lo >= 0.1 && have[a].hi - have[a].lo >= 0.1 ? [(want[a]!.hi - want[a]!.lo) / (have[a].hi - have[a].lo)] : []));
  const k = ratios.length ? Math.min(1.2, Math.max(0.8, ratios.sort((x, y) => x - y)[Math.floor(ratios.length / 2)])) : 1;
  const from = have.map((h) => (h.lo + h.hi) / 2);
  const to = [0, 1, 2].map((a) => (want[a] ? (want[a]!.lo + want[a]!.hi) / 2 : from[a]));
  // Keep it standing on the ground when it stood there.
  if (Math.abs(have[1].lo) <= 0.02) to[1] = from[1] * k;
  if (Math.abs(k - 1) < 0.02 && to.every((v, a) => Math.abs(v - from[a]) < 0.005)) return parts;
  log(`[fit] model: moved ${to.map((v, a) => r3(v - from[a]))}, scaled ×${r3(k)}`);
  const scaled = (q?: Vec[]) => q?.map((v) => v.map((x) => r3(x * k)));
  return parts.map((p) => ({ ...p, center: p.center.map((c, a) => r3(to[a] + k * (c - from[a]))), size: p.primitive === 'extrude' ? p.size : p.size.map((v) => r3(v * k)), ...(p.path ? { path: scaled(p.path) } : {}), ...(p.radii ? { radii: p.radii.map((v) => r3(v * k)) } : {}), ...(p.outline ? { outline: scaled(p.outline) } : {}) }));
}

// Holds a part list (streamed or whole) to the sketch: `next` per part as it
// arrives (null: dropped), `all` for a whole list. `prev`: the model being
// edited (empty for a first build); `strokes`: this round's strokes. A first
// build streams Spark's parts as they are and is aligned as a whole in `all`.
export function partHolder<P extends FitPart>(prev: FitPart[], strokes: FitStroke[], transcript: string, log: (s: string) => void = () => {}) {
  const editing = prev.length > 0;
  const byId = new Map(strokes.map((s) => [s.id, s]));
  const groups = clusters(strokes);
  const old = prev.map(box);
  const oldNames = new Set(prev.map((p) => p.name));
  const oldRoles = new Set(prev.map((p) => role(p.name)));
  const t = transcript.toLowerCase();
  const both = /\b(both|each|pair|either)\b|양쪽|양옆|둘 다|각각/.test(t);
  const counted = Math.max(0, ...[...t.matchAll(/\b(two|three|four|five|six|[2-6])\b|(두|세|네|다섯|여섯) ?(개|쪽|짝)/g)].map((m) => COUNTS[m[1] ?? m[2]] ?? Number(m[1])));
  const plural = (r: string) => both || new RegExp(`\\b${r.split(' ').at(-1)}(s|es)\\b`).test(t);
  const perRole = new Map<string, number>();

  // A new part: to the region its strokes mark, then touching the nearest part of the model.
  const place = (p: P): P => {
    const own = p.strokes.map((id) => byId.get(id)).filter((s): s is FitStroke => !!s);
    const mid = (g: FitStroke[]) => range(g).map((r, a) => (r ? (r.lo + r.hi) / 2 : p.center[a]));
    const guide = own.length ? own : groups.map((g) => ({ g, d: Math.hypot(...mid(g).map((v, a) => v - p.center[a])) })).sort((x, y) => x.d - y.d)[0]?.g ?? [];
    const want = range(guide);
    // Into the region (parts Spark already put there, like an armrest's two posts, keep their layout).
    let q: P = { ...p, center: p.center.map((c, a) => (want[a] ? Math.min(want[a]!.hi, Math.max(want[a]!.lo, c)) : c)) };
    // A horn or wing grows from its base: that goes where its strokes meet the model.
    if (shapePoints(p) && guide.length && old.length) {
      const dist = (v: Vec) => Math.min(...old.map((o) => Math.hypot(...[0, 1, 2].map((a) => Math.max(0, o.min[a] - v[a], v[a] - o.max[a])))));
      const ends = guide.flatMap((s) => [s.points[0], s.points.at(-1)!].map((v) => ({ v, s })));
      const { v, s } = ends.sort((x, y) => dist(x.v) - dist(y.v))[0];
      const f = s.plane === 'view' ? fixes(s) : [true, true, true];
      q = { ...p, center: p.center.map((c, a) => (f[a] ? v[a] : c)) };
      // A wing lies in its stroke's plane and reaches as far as the stroke, in
      // Spark's clean outline: its span from the root to the stroke's far point.
      if (p.primitive === 'membrane' && own.length) {
        const pts = own.flatMap((g) => g.points);
        const far = pts.reduce((b, x) => (Math.hypot(...sub(x, q.center)) > Math.hypot(...sub(b, q.center)) ? x : b));
        const reach = Math.hypot(...sub(far, q.center));
        const u = unit(sub(far, q.center));
        const off = pts.map((x) => { const d = sub(x, q.center); const t = dot(d, u); return d.map((c, i) => c - t * u[i]); }).reduce((b, w) => (Math.hypot(...w) > Math.hypot(...b) ? w : b));
        if (reach > 0.05 && Math.hypot(...off) > 0.01) {
          const n = unit(cross(u, off)), v = cross(n, u);
          const o = p.outline!;
          const sign = Math.max(...o.map(([x]) => x)) >= -Math.min(...o.map(([x]) => x)) ? 1 : -1;
          const span = Math.max(...o.map(([x]) => sign * x)) || 1;
          const k = Math.min(3, Math.max(0.3, reach / span));
          const outline = o.map(([x, y]) => [r3(sign * x * k), r3(y * k)]);
          q = { ...q, rotation: euler(u, v, n), outline, size: [r3(Math.abs(p.size[0]) * k), r3(Math.abs(p.size[1]) * k), p.size[2]] };
        }
      }
    }
    // Attached: moved by its gap to the nearest part of the model (within 30 cm).
    const b = box(q);
    const gaps = old.map((o) => [0, 1, 2].map((a) => (b.min[a] > o.max[a] ? o.max[a] - b.min[a] : b.max[a] < o.min[a] ? o.min[a] - b.max[a] : 0)));
    const gap = gaps.sort((x, y) => Math.hypot(...x) - Math.hypot(...y))[0];
    if (gap && Math.hypot(...gap) > 0.003 && Math.hypot(...gap) <= 0.3) q = { ...q, center: q.center.map((c, a) => c + gap[a]) };
    q = { ...q, center: q.center.map(r3) };
    log(`[fit] ${p.name}: placed ${p.center} → ${q.center}`);
    return q;
  };

  const next = (p: P): P | null => {
    if (!editing) return p;
    // Parts the model had (by name, or a role it had and no new stroke) stay as Spark kept them.
    const fresh = p.strokes.some((id) => byId.has(id));
    if (oldNames.has(p.name) || (!fresh && oldRoles.has(role(p.name)))) return p;
    // A new part: as many per role as the intent implies.
    const r = role(p.name);
    const max = counted || (/left|right/i.test(p.name) || plural(r) ? 2 : 1);
    const n = perRole.get(r) ?? 0;
    if (n >= max) return log(`[fit] dropped ${p.name}: already ${n} ${r}`), null;
    perRole.set(r, n + 1);
    // The side not drawn of a pair: as Spark had it for now; `all` mirrors the drawn one onto it.
    if (!fresh && /left|right/i.test(p.name) && strokes.length) return p;
    return place(p);
  };

  const all = (parts: P[]): P[] => {
    if (!editing) return alignModel(parts, strokes, log);
    let out = parts.map(next).filter((p): p is P => !!p);
    const flip = (q?: Vec[]) => q?.map(([x, ...rest]) => [-x, ...rest]);
    const mid0 = (Math.min(...old.map((b) => b.min[0])) + Math.max(...old.map((b) => b.max[0]))) / 2;
    const mirror = (one: P, name: string): P => ({ ...one, name, center: [r3(2 * mid0 - one.center[0]), one.center[1], one.center[2]], rotation: [one.rotation[0], -one.rotation[1], -one.rotation[2]], ...(one.path ? { path: flip(one.path) } : {}), ...(one.outline ? { outline: flip(one.outline) } : {}) });
    // A pair with one side drawn: the other side is the drawn one, mirrored.
    out = out.map((p) => {
      if (oldNames.has(p.name) || !/left|right/i.test(p.name) || p.strokes.some((id) => byId.has(id))) return p;
      const drawn = out.find((o) => o !== p && !oldNames.has(o.name) && role(o.name) === role(p.name) && o.strokes.some((id) => byId.has(id)));
      return drawn ? (log(`[fit] ${p.name}: mirror of ${drawn.name}`), mirror(drawn, p.name)) : p;
    });
    // "Armrests" with one side back: the twin, mirrored across the model's middle.
    for (const [r, n] of perRole) {
      if (n !== 1 || counted || !plural(r)) continue;
      const one = out.find((p) => !oldNames.has(p.name) && role(p.name) === r);
      if (!one) continue;
      const twin = mirror(one, mirrorName(one.name));
      log(`[fit] added ${twin.name}: mirror of ${one.name}`);
      out.push(twin);
    }
    return out;
  };
  return { next, all };
}
