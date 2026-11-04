// Reshaping an opened model itself (a sword, stood upright): its vertices move,
// the geometry taken from the stroke. The model is split along its main (y)
// axis by its width: the guard is the widest band in the lower half, the blade
// above it, the grip and pommel below. Operations:
//   lengthen: the blade stretches so its tip lands at the stroke's far end
//   thin:     the blade narrows to the spacing of two lines, tapering to a point
//   curve:    the blade bends along a drawn arc (a katana's curve)
//   gem:      a faceted gem set where a small circle was drawn
// Every change keeps flat shading (normals recomputed per face) and can be undone.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ReshapeOp = 'lengthen' | 'thin' | 'curve' | 'gem';
export type Segment = 'blade' | 'guard' | 'grip' | 'pommel';
export type Layout = { cx: number; cz: number; base: number; tip: number; guardBottom: number; guardTop: number; guardY: number; bladeHalf: number };

// The operation the words ask for, when Spark gives none.
export function opFromWords(text: string): ReshapeOp | null {
  const t = text.toLowerCase();
  if (/\b(gem|jewel|stone|ruby|sapphire|emerald)\b/.test(t)) return 'gem';
  if (/\b(curve|curved|bend|katana|sabre|saber|scimitar)\b/.test(t)) return 'curve';
  if (/\b(thin|thinner|slim|narrow|rapier)\b/.test(t)) return 'thin';
  if (/\b(long|longer|lengthen|length|extend)\b/.test(t)) return 'lengthen';
  return null;
}

function meshesOf(model: THREE.Object3D) {
  const out: THREE.Mesh[] = [];
  model.updateMatrixWorld(true);
  model.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.reshapeGem && out.push(o as THREE.Mesh));
  return out;
}

// Where the blade, guard, grip and pommel are, from the width along the height.
export function layout(model: THREE.Object3D): Layout {
  const box = new THREE.Box3().setFromObject(model);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const [base, tip] = [box.min.y, box.max.y], N = 60;
  const width = new Array(N).fill(0);
  const v = new THREE.Vector3();
  for (const m of meshesOf(model)) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      const k = Math.min(N - 1, Math.max(0, Math.floor(((v.y - base) / (tip - base)) * N)));
      width[k] = Math.max(width[k], Math.abs(v.x - cx));
    }
  }
  const lower = width.slice(0, N / 2);
  const g = lower.indexOf(Math.max(...lower));
  let [a, b] = [g, g];
  while (a > 0 && width[a - 1] > 0.55 * width[g]) a--;
  while (b < N - 1 && width[b + 1] > 0.55 * width[g]) b++;
  const y = (k: number) => base + ((tip - base) * k) / N;
  const blade = width.slice(b + 1, N - 3);
  return { cx, cz, base, tip, guardBottom: y(a), guardTop: y(b + 1), guardY: (y(a) + y(b + 1)) / 2, bladeHalf: blade.length ? Math.max(...blade) : 0.03 };
}

// Every mesh's vertices moved in world space by `move` (only blade vertices are
// passed to it when `bladeOnly`); returns how to undo it.
function deform(model: THREE.Object3D, L: Layout, move: (p: THREE.Vector3) => void, bladeOnly = true) {
  const undo: (() => void)[] = [];
  const v = new THREE.Vector3();
  for (const m of meshesOf(model)) {
    const before = m.geometry;
    const g = (before.index ? before.toNonIndexed() : before.clone()) as THREE.BufferGeometry;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const inv = m.matrixWorld.clone().invert();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      if (bladeOnly && v.y <= L.guardTop + 0.002) continue;
      move(v);
      v.applyMatrix4(inv);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.deleteAttribute('normal');
    g.computeVertexNormals(); // non-indexed: one normal per face, flat as before
    g.computeBoundingBox();
    g.computeBoundingSphere();
    m.geometry = g;
    undo.push(() => ((m.geometry = before), g.dispose()));
  }
  return () => undo.forEach((u) => u());
}

const pts = (stroke: THREE.Vector3[]) => stroke.map((p) => p.clone());

// The blade stretches along its axis so its tip reaches the stroke's highest point.
export function lengthen(model: THREE.Object3D, stroke: THREE.Vector3[]) {
  const L = layout(model);
  const to = Math.max(...stroke.map((p) => p.y));
  if (to <= L.guardTop + 0.05) return null;
  const k = (to - L.guardTop) / (L.tip - L.guardTop);
  return deform(model, L, (p) => void (p.y = L.guardTop + (p.y - L.guardTop) * k));
}

// The blade narrows to half the spacing of two lines, tapering to a sharp point over its last fifth.
export function thin(model: THREE.Object3D, strokes: THREE.Vector3[][]) {
  const L = layout(model);
  const xs = strokes.map((s) => s.reduce((a, p) => a + p.x, 0) / s.length).sort((a, b) => a - b);
  const half = xs.length >= 2 ? (xs.at(-1)! - xs[0]) / 2 : L.bladeHalf * 0.5;
  const k = Math.min(1, Math.max(0.15, half / L.bladeHalf));
  return deform(model, L, (p) => {
    const t = (p.y - L.guardTop) / (L.tip - L.guardTop);
    const point = t > 0.8 ? 1 - (t - 0.8) / 0.2 * 0.85 : 1;
    p.x = L.cx + (p.x - L.cx) * k * point;
  });
}

// The blade bends along the drawn arc: each height moves sideways by the arc's
// offset there (from where the arc starts), past its end by the arc's last slope.
export function curve(model: THREE.Object3D, stroke: THREE.Vector3[]) {
  const L = layout(model);
  const arc = pts(stroke).sort((a, b) => a.y - b.y);
  if (arc.length < 3 || arc.at(-1)!.y - arc[0].y < 0.1) return null;
  const x0 = arc[0].x, y0 = Math.max(arc[0].y, L.guardTop);
  const at = (y: number) => {
    if (y <= arc[0].y) return 0;
    for (let i = 1; i < arc.length; i++) if (y <= arc[i].y) {
      const u = (y - arc[i - 1].y) / Math.max(1e-6, arc[i].y - arc[i - 1].y);
      return arc[i - 1].x + (arc[i].x - arc[i - 1].x) * u - x0;
    }
    const [a, b] = [arc.at(-2)!, arc.at(-1)!];
    return b.x - x0 + ((b.x - a.x) / Math.max(1e-6, b.y - a.y)) * (y - b.y);
  };
  return deform(model, L, (p) => void (p.x += p.y >= y0 ? at(p.y) : 0));
}

// A faceted gem (a brilliant: a table, a crown, a deep pavilion) where a small
// circle was drawn, sized to it, half sunk into the surface, facing out.
export function gem(model: THREE.Object3D, stroke: THREE.Vector3[], color = '#d0104c') {
  const c = stroke.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(stroke.length);
  const r = Math.max(0.012, stroke.reduce((a, p) => a + p.distanceTo(c), 0) / stroke.length);
  const crown = new THREE.CylinderGeometry(r * 0.62, r, r * 0.38, 8, 1).toNonIndexed();
  crown.translate(0, r * 0.19, 0);
  const pavilion = new THREE.ConeGeometry(r, r * 0.85, 8, 1).toNonIndexed();
  pavilion.rotateX(Math.PI);
  pavilion.translate(0, -r * 0.425, 0);
  for (const g of [crown, pavilion]) g.deleteAttribute('uv');
  const geo = mergeGeometries([crown, pavilion])!;
  geo.deleteAttribute('normal');
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.22, flatShading: true, metalness: 0.15, roughness: 0.18 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.reshapeGem = true;
  // Facing out of the model (toward where it was drawn from: +z for a front view).
  const L = layout(model);
  const out = new THREE.Vector3(0, 0, c.z >= L.cz ? 1 : -1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
  mesh.position.copy(c).addScaledVector(out, -r * 0.05);
  model.add(mesh);
  model.worldToLocal(mesh.position);
  mesh.quaternion.premultiply(model.getWorldQuaternion(new THREE.Quaternion()).invert());
  mesh.scale.divide(model.getWorldScale(new THREE.Vector3()));
  return () => (model.remove(mesh), geo.dispose(), mat.dispose());
}
