// Spark sometimes gets a rotation's sign wrong (a roof slab tipped the wrong
// way, a chair back leaning forward). For each tilted part, try the sign
// flips and keep the one whose box sits closest to the part's own strokes.

import * as THREE from 'three';
import type { Part } from './build';
import type { Stroke } from './sketch';

const D2R = THREE.MathUtils.degToRad;

// Robust distance of points to an oriented box: mean of the nearest half.
function score(part: Part, rotation: number[], points: THREE.Vector3[]) {
  const inv = new THREE.Matrix4()
    .compose(new THREE.Vector3().fromArray(part.center), new THREE.Quaternion().setFromEuler(new THREE.Euler(D2R(rotation[0]), D2R(rotation[1]), D2R(rotation[2]), 'XYZ')), new THREE.Vector3(1, 1, 1))
    .invert();
  const half = part.size.map((n) => Math.abs(n) / 2);
  const q = new THREE.Vector3();
  const d = points.map((p) => {
    q.copy(p).applyMatrix4(inv);
    const dx = Math.max(0, Math.abs(q.x) - half[0]), dy = Math.max(0, Math.abs(q.y) - half[1]), dz = Math.max(0, Math.abs(q.z) - half[2]);
    return Math.hypot(dx, dy, dz);
  });
  d.sort((a, b) => a - b);
  const n = Math.max(1, Math.ceil(d.length / 2));
  return d.slice(0, n).reduce((a, b) => a + b, 0) / n;
}

export function fixRotation(part: Part, strokes: Map<number, Stroke>): Part {
  if (part.primitive === 'extrude' || part.primitive === 'sphere') return part;
  const tilted = [0, 1, 2].filter((i) => Math.abs(part.rotation[i]) >= 3 && Math.abs(Math.abs(part.rotation[i]) - 90) > 3 && Math.abs(Math.abs(part.rotation[i]) - 180) > 3);
  if (!tilted.length) return part;
  const points = part.strokes.flatMap((id) => strokes.get(id)?.points ?? []);
  if (points.length < 4) return part;
  let best = part.rotation, bestScore = score(part, part.rotation, points);
  const original = bestScore;
  for (let mask = 1; mask < 1 << tilted.length; mask++) {
    const r = [...part.rotation];
    tilted.forEach((axis, k) => mask & (1 << k) && (r[axis] = -r[axis]));
    const s = score(part, r, points);
    if (s < bestScore) (bestScore = s), (best = r);
  }
  // Only switch on a clear win.
  if (best === part.rotation || bestScore > original * 0.7) return part;
  console.info(`[fit] ${part.name}: rotation ${part.rotation} → ${best} (${original.toFixed(3)} → ${bestScore.toFixed(3)})`);
  return { ...part, rotation: best };
}
