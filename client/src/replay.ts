// Draws with synthetic pen events along hand-wobbly screen paths, through the
// same Pointer Events code a stylus uses. For testing without a tablet and
// for a backup screen recording: `replayChair()` in the console.

import type { Stage } from './scene';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Screen point (CSS px) of a 3D point in the current view.
export function screenOf(stage: Stage, x: number, y: number, z: number) {
  const v = new (stage.camera.position.constructor as any)(x, y, z).project(stage.camera);
  const r = stage.renderer.domElement.getBoundingClientRect();
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height] as [number, number];
}

export async function penStroke(stage: Stage, pts: [number, number][], ms = 500, id = 7) {
  const el = stage.renderer.domElement;
  // Resample the polyline and add a little hand wobble.
  const path: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const n = Math.max(6, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
    for (let k = 0; k < n; k++) path.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  path.push(pts[pts.length - 1]);
  const phase = Math.random() * 6;
  const fire = (type: string, [x, y]: [number, number], i: number, buttons: number) => {
    const w = Math.sin(i * 0.35 + phase) * 1.6;
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', isPrimary: true, clientX: x + w, clientY: y - w, button: type === 'pointermove' ? -1 : 0, buttons, pressure: buttons ? 0.6 : 0, bubbles: true, cancelable: true }));
  };
  fire('pointerdown', path[0], 0, 1);
  for (let i = 1; i < path.length; i++) {
    fire('pointermove', path[i], i, 1);
    await wait(ms / path.length);
  }
  fire('pointerup', path[path.length - 1], path.length, 0);
  await wait(120);
}
