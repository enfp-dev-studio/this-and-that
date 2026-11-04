// Muse Image paints the model: render it from the user's camera, have Muse
// Image repaint that picture as a finished asset, and project the painting
// back onto the parts from the same camera. Faces turned away from that
// camera keep their plain color, so the paint fades out around the sides.

import * as THREE from 'three';
import type { Stage } from './scene';

const SIZE = 1024;
let offscreen: THREE.WebGLRenderer | null = null;

// The model alone from the current viewpoint (square), plus that camera.
export function renderModel(stage: Stage) {
  offscreen ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  offscreen.setPixelRatio(1);
  offscreen.setSize(SIZE, SIZE);
  const cam = stage.camera.clone();
  cam.aspect = 1;
  cam.updateProjectionMatrix();
  // Frame the model the way the user sees it, but square.
  const scene = stage.scene;
  const bg = scene.background;
  scene.background = new THREE.Color('#ffffff');
  const hidden = [stage.sketch, stage.helpers, scene.getObjectByName('grid')!, scene.getObjectByName('shadow')!].map((o) => [o, o.visible] as const);
  for (const [o] of hidden) o.visible = false;
  offscreen.render(scene, cam);
  const image = offscreen.domElement.toDataURL('image/jpeg', 0.9);
  // The same view as a flat black mask: where the model really is (white walls
  // would vanish into the white background of the shaded render).
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  offscreen.render(scene, cam);
  const mask = offscreen.domElement.toDataURL('image/png');
  scene.overrideMaterial = null;
  for (const [o, v] of hidden) o.visible = v;
  scene.background = bg;
  return { image, mask, cam };
}

// Bounding box of the non-white pixels, in UV space (v up).
async function silhouette(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = 256, h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] > 232 && d[i + 1] > 232 && d[i + 2] > 232) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  if (x1 <= x0 || y1 <= y0) return null;
  return { u0: x0 / w, u1: (x1 + 1) / w, v0: 1 - (y1 + 1) / h, v1: 1 - y0 / h };
}

// Project `image` (a repaint of the render whose silhouette is `mask`, seen
// from `cam`) onto every mesh of the model. Muse Image may redraw the object a
// little smaller or shifted, so the painting's silhouette box is mapped onto
// the render's.
export async function applyPaint(stage: Stage, image: string, cam: THREE.Camera, mask: string) {
  const [a, b] = await Promise.all([silhouette(mask), silhouette(image)]);
  const remap = new THREE.Vector4(1, 1, 0, 0);
  if (a && b) {
    const su = (b.u1 - b.u0) / (a.u1 - a.u0), sv = (b.v1 - b.v0) / (a.v1 - a.v0);
    remap.set(su, sv, b.u0 - a.u0 * su, b.v0 - a.v0 * sv);
  }
  const tex = await new THREE.TextureLoader().loadAsync(image);
  tex.colorSpace = THREE.SRGBColorSpace;
  cam.updateMatrixWorld();
  const projMat = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  stage.model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    // Painted before: three.js reuses the compiled program, so just update the
    // uniforms it already holds.
    const u = mat.userData.paint;
    if (u) {
      u.uPaint.value = tex;
      u.uProjMat.value = projMat;
      u.uProjPos.value = camPos;
      u.uRemap.value = remap;
      u.uMix.value = 0;
      mat.userData.paintMix = u.uMix;
      return;
    }
    const uniforms = { uPaint: { value: tex }, uProjMat: { value: projMat }, uProjPos: { value: camPos }, uMix: { value: 0 }, uRemap: { value: remap } };
    mat.userData.paint = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uProjMat;\nvarying vec4 vProj;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 pw = modelMatrix * vec4(transformed, 1.0);\nvProj = uProjMat * pw;\nvWPos = pw.xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uPaint;\nuniform vec4 uRemap;\nuniform vec3 uProjPos;\nuniform float uMix;\nvarying vec4 vProj;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nfloat paintMask;\nvec3 paintColor;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec2 puv = (vProj.xy / vProj.w * 0.5 + 0.5) * uRemap.xy + uRemap.zw;
          float inside = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0) * step(0.0, vProj.w);
          float facing = smoothstep(0.08, 0.4, dot(normalize(vWNormal), normalize(uProjPos - vWPos)));
          paintColor = texture2D(uPaint, puv).rgb;
          paintMask = uMix * inside * facing;
          diffuseColor.rgb = mix(diffuseColor.rgb, paintColor, paintMask);`,
        )
        // The painting carries its own light; let some of it through as is.
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += paintColor * paintMask * 0.35;');
    };
    mat.customProgramCacheKey = () => 'painted';
    mat.needsUpdate = true;
    mat.userData.paintMix = uniforms.uMix;
  });
  const mixes: { value: number }[] = [];
  stage.model.traverse((o) => (o as THREE.Mesh).isMesh && mixes.push(((o as THREE.Mesh).material as THREE.Material).userData.paintMix));
  // Fade the paint in.
  const t0 = performance.now();
  const fade = () => {
    const k = Math.min(1, (performance.now() - t0) / 900);
    for (const m of mixes) if (m) m.value = k;
    if (k < 1) requestAnimationFrame(fade);
  };
  fade();
}
