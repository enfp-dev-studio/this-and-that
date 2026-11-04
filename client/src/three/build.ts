// Turns Spark's part list into a low-poly model that grows in over the
// strokes. On an edit, unchanged parts stay put, changed ones morph to their
// new shape and removed ones shrink away.

import * as THREE from 'three';
import type { Stage } from './scene';
import type { Stroke } from './sketch';
import { fixRotation } from './fit';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Part = {
  name: string;
  primitive: 'box' | 'cylinder' | 'sphere' | 'cone' | 'capsule' | 'extrude' | 'tube' | 'membrane' | 'lathe' | 'mesh';
  center: number[];
  size: number[];
  rotation: number[];
  color: string;
  material: string;
  strokes: number[];
  profile: number;
  path?: number[][]; // tube: control points from its base (the center)
  radii?: number[]; // tube: [base, tip] radius
  outline?: number[][]; // membrane: [x, y] outline from its root (the center); lathe: [radius, y] half profile from its base
};

const FINISH: Record<string, { roughness: number; metalness: number }> = {
  wood: { roughness: 0.75, metalness: 0 },
  metal: { roughness: 0.35, metalness: 0.8 },
  plastic: { roughness: 0.45, metalness: 0 },
  fabric: { roughness: 0.95, metalness: 0 },
  stone: { roughness: 0.9, metalness: 0 },
  glass: { roughness: 0.1, metalness: 0.1 },
  ceramic: { roughness: 0.3, metalness: 0 },
  plant: { roughness: 0.8, metalness: 0 },
  paint: { roughness: 0.6, metalness: 0 },
};

const pos = (n: number) => Math.max(0.005, Math.abs(n) || 0.05);

function geometryOf(p: Part, strokes: Map<number, Stroke>): THREE.BufferGeometry {
  const [sx, sy, sz] = p.size.map(pos);
  switch (p.primitive) {
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 10, 1);
      g.scale(1, 1, sz / sx);
      return g;
    }
    case 'cone': {
      const g = new THREE.ConeGeometry(sx / 2, sy, 10, 1);
      g.scale(1, 1, sz / sx);
      return g;
    }
    case 'sphere': {
      const g = new THREE.SphereGeometry(0.5, 12, 8);
      g.scale(sx, sy, sz);
      return g;
    }
    case 'capsule': {
      const r = Math.min(sx, sz) / 2;
      const g = new THREE.CapsuleGeometry(r, Math.max(0.001, sy - 2 * r), 3, 10);
      g.scale(sx / (2 * r), 1, sz / (2 * r));
      return g;
    }
    case 'tube': {
      const path = (p.path ?? []).filter((q) => q.length === 3);
      if (path.length >= 2) return taperedTube(path, pos(p.radii?.[0] ?? sx / 2), pos(p.radii?.[1] ?? 0.004));
      return new THREE.ConeGeometry(sx / 2, sy, 10, 1);
    }
    case 'lathe': {
      // The half profile turned about the part's vertical axis.
      const profile = (p.outline ?? []).filter((q) => q.length === 2).map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
      if (profile.length >= 2) return new THREE.LatheGeometry(profile, 32);
      return new THREE.SphereGeometry(0.5, 12, 8).scale(sx, sy, sz);
    }
    case 'membrane': {
      const outline = (p.outline ?? []).filter((q) => q.length === 2);
      if (outline.length >= 3) return membrane(outline, sz);
      return new THREE.BoxGeometry(sx, sy, sz);
    }
    case 'extrude': {
      const s = strokes.get(p.profile);
      if (s && s.points.length >= 3) return extrudeFromStroke(s, sz);
      return new THREE.BoxGeometry(sx, sy, sz);
    }
    default:
      return new THREE.BoxGeometry(sx, sy, sz);
  }
}

// A horn or tail: a sweep along a smooth curve through the control points,
// narrowing from the base radius to the tip.
function taperedTube(path: number[][], base: number, tip: number) {
  const curve = new THREE.CatmullRomCurve3(path.map((q) => new THREE.Vector3(...q)), false, 'centripetal');
  const n = 40, radial = 12;
  const g = new THREE.TubeGeometry(curve, n, 1, radial, false);
  const at = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const c = curve.getPointAt(i / n);
    const r = base + (tip - base) * Math.pow(i / n, 0.9);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(at, k).sub(c).multiplyScalar(r).add(c);
      at.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

// A wing or fin: the outline as a thin sheet, cupped a little along its span,
// with ribs from the root to its 3 or 4 outermost tips.
function membrane(outline: number[][], thickness: number) {
  const sheet = membraneSheet(outline, thickness);
  const span = Math.max(0.05, ...outline.map(([x, y]) => Math.hypot(x, y)));
  const d = outline.map(([x, y]) => Math.hypot(x, y));
  // Tips: points farther from the root than both neighbours, the farthest first.
  const tips = outline.map((p, i) => ({ p, d: d[i], peak: d[i] >= d[(i + outline.length - 1) % outline.length] && d[i] >= d[(i + 1) % outline.length] })).filter((t) => t.peak && t.d > 0.35 * span).sort((a, b) => b.d - a.d).slice(0, 4);
  const ribs = tips.map(({ p: [x, y] }) => {
    const bend = (k: number) => [x * k, y * k + 0.06 * Math.hypot(x, y) * Math.sin(Math.PI * k), -0.12 * span * Math.pow((x * k) / span, 2)];
    return taperedTube([0, 0.33, 0.66, 1].map(bend), 0.035 * span, 0.008 * span).toNonIndexed();
  });
  return ribs.length ? mergeGeometries([sheet, ...ribs]) ?? sheet : sheet;
}

function membraneSheet(outline: number[][], thickness: number) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.004, thickness), bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -Math.max(0.004, thickness) / 2);
  const span = Math.max(0.05, ...outline.map(([x]) => Math.abs(x)));
  const at = g.getAttribute('position');
  for (let k = 0; k < at.count; k++) {
    const u = at.getX(k) / span;
    at.setZ(k, at.getZ(k) - 0.12 * span * u * u);
  }
  g.computeVertexNormals();
  return g;
}

// The stroke's outline, flattened onto its drawing plane and given thickness,
// centered on the origin (the part's center places it).
function extrudeFromStroke(s: Stroke, depth: number) {
  const n = s.normal.clone().normalize();
  const u = new THREE.Vector3().crossVectors(Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  const step = Math.max(1, Math.floor(s.points.length / 48));
  const flat = s.points.filter((_, i) => i % step === 0).map((p) => new THREE.Vector2(p.dot(u), p.dot(v)));
  const bb = new THREE.Box2().setFromPoints(flat);
  const c = bb.getCenter(new THREE.Vector2());
  const shape = new THREE.Shape(flat.map((q) => q.clone().sub(c)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -depth / 2);
  g.applyMatrix4(new THREE.Matrix4().makeBasis(u, v, n));
  g.computeVertexNormals();
  return g;
}

type Built = { part: Part; key: string; mesh: THREE.Mesh; anim: { t0: number; delay: number; from: THREE.Matrix4 | null; out?: boolean } };

export class Builder {
  parts: Part[] = [];
  private built = new Map<string, Built>();

  constructor(private stage: Stage) {
    stage.onTick((now) => this.tick(now));
  }

  // `partial`: parts still arriving from the stream; keep the ones not listed yet.
  apply(parts: Part[], strokes: Stroke[], partial = false) {
    const byId = new Map(strokes.map((s) => [s.id, s]));
    parts = parts.map((p) => fixRotation(p, byId));
    const now = performance.now();
    const next = new Map<string, Built>();
    // Bottom-up, so the model grows from the ground.
    const order = [...parts].sort((a, b) => a.center[1] - b.center[1]);
    order.forEach((part, i) => {
      if (part.primitive === 'mesh') return; // an opened model: shown as it is, not built
      const key = JSON.stringify(part);
      const old = this.built.get(part.name);
      if (old && old.key === key && !old.anim.out) {
        next.set(part.name, old);
        this.built.delete(part.name);
        return;
      }
      const f = FINISH[part.material] ?? FINISH.paint;
      const mat = new THREE.MeshStandardMaterial({ color: part.color, flatShading: true, transparent: true, opacity: 0, ...f });
      const mesh = new THREE.Mesh(geometryOf(part, byId), mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.fromArray(part.center);
      if (part.primitive !== 'extrude') mesh.rotation.set(...(part.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ');
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.userData.part = part.name;
      // Edge lines keep the low-poly look readable.
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), new THREE.LineBasicMaterial({ color: '#2a2622', transparent: true, opacity: 0 }));
      mesh.add(edges);
      this.stage.model.add(mesh);
      let from: THREE.Matrix4 | null = null;
      if (old) {
        from = old.mesh.matrix.clone();
        this.remove(old, now, 0);
        this.built.delete(part.name);
      }
      next.set(part.name, { part, key, mesh, anim: { t0: now, delay: old || partial ? 0 : 120 + i * 110, from } });
    });
    for (const [name, b] of this.built) partial ? next.set(name, b) : this.remove(b, now, 0);
    this.built = next;
    if (!partial) this.parts = parts;
  }

  private dying: Built[] = [];
  private remove(b: Built, now: number, delay: number) {
    b.anim = { t0: now, delay, from: null, out: true };
    this.dying.push(b);
  }

  clear() {
    const now = performance.now();
    for (const b of this.built.values()) this.remove(b, now, 0);
    this.built.clear();
    this.parts = [];
  }

  // Jump every animation to its end (before rendering the model for a model call).
  finish() {
    this.tick(performance.now() + 1e6);
  }

  private tick(now: number) {
    const ease = (k: number) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // back-out
    for (const b of this.built.values()) {
      const k = Math.min(1, Math.max(0, (now - b.anim.t0 - b.anim.delay) / 520));
      if (k === 1 && b.anim.t0 < 0) continue;
      const mat = b.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.min(1, k * 1.6);
      mat.transparent = mat.opacity < 1;
      (b.mesh.children[0] as THREE.LineSegments).material = Object.assign((b.mesh.children[0] as any).material, { opacity: 0.35 * Math.min(1, k * 1.6) });
      const target = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(b.part.center), b.part.primitive === 'extrude' ? new THREE.Quaternion() : new THREE.Quaternion().setFromEuler(new THREE.Euler(...(b.part.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ')), new THREE.Vector3(1, 1, 1));
      if (b.anim.from) {
        // Morph from the old transform (the geometry itself pops).
        const [p0, q0, s0] = decompose(b.anim.from);
        const [p1, q1] = decompose(target);
        const e = 1 - Math.pow(1 - k, 3);
        b.mesh.matrix.compose(p0.lerp(p1, e), q0.slerp(q1, e), s0.lerp(new THREE.Vector3(1, 1, 1), e));
      } else {
        const s = Math.max(0.001, ease(k));
        const [p1, q1] = decompose(target);
        // Grow up from the part's base.
        b.mesh.matrix.compose(p1, q1, new THREE.Vector3(Math.min(1, 0.6 + 0.4 * s), s, Math.min(1, 0.6 + 0.4 * s)));
      }
      if (k === 1) b.anim.t0 = -1;
    }
    this.dying = this.dying.filter((b) => {
      const k = Math.min(1, (now - b.anim.t0) / 300);
      (b.mesh.material as THREE.MeshStandardMaterial).opacity = 1 - k;
      (b.mesh.material as THREE.MeshStandardMaterial).transparent = true;
      b.mesh.matrix.multiply(new THREE.Matrix4().makeScale(0.97, 0.97, 0.97));
      if (k < 1) return true;
      this.stage.model.remove(b.mesh);
      b.mesh.geometry.dispose();
      return false;
    });
  }
}

function decompose(m: THREE.Matrix4): [THREE.Vector3, THREE.Quaternion, THREE.Vector3] {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return [p, q, s];
}
