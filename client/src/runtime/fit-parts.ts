// Spark's part list, held to the sketch. Every part that explains strokes is
// moved (and, when it is not tilted, sized) onto those strokes; Spark's numbers
// stay only where the strokes say nothing: the depth of a stroke drawn facing
// the camera, a part's thickness, or an offset Spark chose on purpose (an
// armrest above the seat line drawn for it, a hidden leg mirrored to the far
// side). And an edit adds at most one part per cluster of new strokes (a
// mirrored pair for "both" / "each"), unless the words count more ("three shelves").
// Plain math, no three.js: used by server/3d/perceive.ts (the local server)
// and client/src/runtime/perceive.ts (the web app).

type Vec = number[];
export type FitStroke = { id: number; drawnFrom: Vec; plane: 'view' | 'ground' | 'surface'; bbox: { min: Vec; max: Vec }; points: Vec[] };
export type FitPart = { name: string; primitive: string; center: Vec; size: Vec; rotation: Vec; strokes: number[] };

const LONG = 0.05; // a stroke extent at least this long (and ≥ 40% of the part) sets the part's extent on that axis
const SNAP = 0.12; // on a thin axis the part moves onto its strokes when it is at most this far off

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

// The local axis along each world axis, for a part turned by multiples of 90° (else null: tilted).
function axisMap(rotation: Vec): number[] | null {
  const m = matrix(rotation);
  const map = m.map((row) => row.findIndex((v) => Math.abs(v) > 0.999));
  return map.every((j) => j >= 0) && new Set(map).size === 3 ? map : null;
}

// The part on its strokes, and along which world axes the strokes placed it.
export function fitPart<P extends FitPart>(part: P, strokes: Map<number, FitStroke>): { part: P; placed: boolean[] } {
  const placed = [false, false, false];
  if (part.primitive === 'extrude') return { part, placed }; // already its stroke's outline
  const own = part.strokes.map((id) => strokes.get(id)).filter((s): s is FitStroke => !!s);
  if (!own.length) return { part, placed };
  const map = axisMap(part.rotation);
  const m = matrix(part.rotation);
  // What each stroke really fixes: one drawn on a plane facing the camera says
  // nothing about depth along the view direction; one drawn on the model's
  // surface marks a place on it, so the part may stand off it vertically.
  const pts: { p: Vec; extent: boolean[]; place: boolean[] }[] = [];
  for (const s of own) {
    const d = s.drawnFrom.map(Math.abs);
    const depth = s.plane === 'view' ? d.indexOf(Math.max(...d)) : -1;
    const extent = [0, 1, 2].map((a) => a !== depth);
    const place = extent.map((t, a) => t && !(s.plane === 'surface' && a === 1));
    for (const p of s.points) pts.push({ p, extent, place });
  }
  const center = [...part.center], size = [...part.size];
  let moved = false;
  for (let pass = 0; pass < 2; pass++) {
    // The part's extent along each world axis, as placed so far.
    const span = [0, 1, 2].map((a) => [0, 1, 2].reduce((sum, j) => sum + Math.abs(m[a][j]) * Math.abs(size[j]), 0));
    const long = span.map((v) => v >= LONG);
    // A stroke shared with other parts (a side profile that is a leg and the back at once) counts only near this part.
    const near = (p: Vec, a: number) => Math.abs(p[a] - center[a]) <= span[a] / 2 + (long[a] ? 0.06 : SNAP);
    const kept = pts.filter(({ p, extent }) => [0, 1, 2].every((a) => !extent[a] || near(p, a)));
    for (let a = 0; a < 3; a++) {
      const ext = kept.filter((k) => k.extent[a]).map(({ p }) => p[a]);
      if (ext.length < 2) continue;
      const lo = Math.min(...ext), hi = Math.max(...ext), e = hi - lo;
      if (long[a] && e >= LONG && e >= 0.4 * span[a]) {
        center[a] = (lo + hi) / 2;
        if (map) size[map[a]] = Math.sign(size[map[a]] || 1) * Math.min(2 * Math.abs(part.size[map[a]]), Math.max(0.5 * Math.abs(part.size[map[a]]), e));
        moved = placed[a] = true;
        continue;
      }
      const at = kept.filter((k) => k.place[a]).map(({ p }) => p[a]);
      if (at.length < 2) continue;
      const mid = (Math.min(...at) + Math.max(...at)) / 2;
      if (Math.abs(mid - center[a]) <= SNAP) (center[a] = mid), (moved = placed[a] = true);
    }
  }
  return { part: moved ? { ...part, center: center.map((v) => Math.round(v * 1000) / 1000), size: size.map((v) => Math.round(v * 1000) / 1000) } : part, placed };
}

// Strokes that touch or nearly touch (bounding boxes within 6 cm) are one cluster.
function clusters(strokes: FitStroke[]) {
  const parent = strokes.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const gap = (a: FitStroke, b: FitStroke) => Math.max(...[0, 1, 2].map((k) => Math.max(0, a.bbox.min[k] - b.bbox.max[k], b.bbox.min[k] - a.bbox.max[k])));
  for (let i = 0; i < strokes.length; i++) for (let j = i + 1; j < strokes.length; j++) if (gap(strokes[i], strokes[j]) <= 0.06) parent[root(i)] = root(j);
  return new Map(strokes.map((s, i) => [s.id, root(i)]));
}

const COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6 };

// Holds a part list (streamed or whole) to the sketch: `next` per part as it
// arrives (null: dropped), `all` for a whole list. `prev`: the model being
// edited (empty for a first build); `strokes`: this round's strokes.
export function partHolder<P extends FitPart>(prev: FitPart[], strokes: FitStroke[], transcript: string, log: (s: string) => void = () => {}) {
  const byId = new Map(strokes.map((s) => [s.id, s]));
  const cluster = clusters(strokes);
  const editing = prev.length > 0;
  const t = transcript.toLowerCase();
  const both = /\b(both|each|pair|either)\b|양쪽|양옆|둘 다|각각/.test(t);
  const counted = Math.max(0, ...[...t.matchAll(/\b(two|three|four|five|six|[2-6])\b|(두|세|네|다섯|여섯) ?(개|쪽|짝)/g)].map((m) => COUNTS[m[1] ?? m[2]] ?? Number(m[1])));
  const nClusters = new Set(cluster.values()).size;
  // "Both" is a mirrored pair: two parts in all, both on one stroke when only one side was drawn.
  const perCluster = both && nClusters === 1 ? 2 : 1;
  const limit = Math.max(nClusters, both ? 2 : 0, counted);
  const used = new Map<number, number>(); // cluster → new parts on it
  let added = 0;
  // Parts Spark put at the same coordinate (both front legs at z = 0.15) move
  // together: one whose strokes don't fix that axis (drawn facing it) takes
  // the shift of the ones whose strokes do.
  const placedSoFar: { spark: Vec; shift: Vec; placed: boolean[] }[] = [];
  const follow = (part: P, fitted: P, placed: boolean[]): P => {
    const center = [...fitted.center];
    for (let a = 0; a < 3; a++) {
      if (placed[a]) continue;
      const peers = placedSoFar.filter((q) => q.placed[a] && Math.abs(q.spark[a] - part.center[a]) < 0.005);
      if (peers.length) center[a] = Math.round((part.center[a] + peers.reduce((s, q) => s + q.shift[a], 0) / peers.length) * 1000) / 1000;
    }
    return center.some((v, a) => v !== fitted.center[a]) ? { ...fitted, center } : fitted;
  };
  // Keep or drop one part, and fit it onto its strokes.
  const fitOne = (part: P): { part: P; own: P; placed: boolean[] } | null => {
    // In an edit, a new part is one that explains this round's strokes.
    const mine = editing ? [...new Set(part.strokes.filter((id) => byId.has(id)).map((id) => cluster.get(id)!))] : [];
    if (mine.length && !counted) {
      // One part per cluster (a pair with "both"); a part spanning two clusters, or one more than the strokes show, is a duplicate.
      if (mine.length > 1 && nClusters > 1) return log(`[fit] dropped ${part.name}: spans ${mine.length} stroke clusters`), null;
      const n = used.get(mine[0]) ?? 0;
      if (n >= perCluster || added >= limit) return log(`[fit] dropped ${part.name}: ${n} part(s) already on its strokes`), null;
      used.set(mine[0], n + 1);
      added++;
    } else if (mine.length && added++ >= limit) return log(`[fit] dropped ${part.name}: more parts than asked for`), null;
    const { part: own, placed } = fitPart(part, byId);
    if (part.strokes.some((id) => byId.has(id))) placedSoFar.push({ spark: part.center, shift: own.center.map((v, a) => v - part.center[a]), placed });
    return { part, own, placed };
  };
  const finish = ({ part, own, placed }: { part: P; own: P; placed: boolean[] }) => {
    const fitted = follow(part, own, placed);
    if (fitted !== part) log(`[fit] ${part.name}: center ${part.center} → ${fitted.center}, size ${part.size} → ${fitted.size}`);
    return fitted;
  };
  // Streamed: each part as it arrives (following the parts before it).
  const next = (part: P): P | null => {
    const r = fitOne(part);
    return r && finish(r);
  };
  // A whole list: every part fitted first, so each can follow all its peers.
  const all = (parts: P[]) => parts.map(fitOne).filter((r): r is NonNullable<typeof r> => !!r).map(finish);
  return { next, all };
}
