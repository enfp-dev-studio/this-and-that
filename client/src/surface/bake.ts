// Bakes a 2D edit of one rendered view back into the model's base-color
// texture. The mesh is rendered unwrapped (in UV space) into a new texture:
// each texel finds its surface point, projects it into the view that was
// edited, and takes the edit there — only if that point was visible in the
// view (depth test) and faced the camera (oblique areas would smear).
//
// The edit is transferred as a ratio, new = old × edited / rendered, so
// lighting isn't baked in, and every pixel the 2D pipeline left untouched
// (it pastes back only inside the SAM masks) gives ratio 1: no change.

import * as THREE from 'three';

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// 1 / view-space depth of the visible surface, per pixel of the edited view
// (0 where nothing was rendered).
const depthMat = new THREE.ShaderMaterial({
  vertexShader: `varying float vDepth; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying float vDepth; void main() { gl_FragColor = vec4(1.0 / vDepth, 0.0, 0.0, 1.0); }`,
  side: THREE.DoubleSide,
});

const bakeMat = new THREE.ShaderMaterial({
  uniforms: {
    uOld: { value: null },
    uRender: { value: null },
    uPlain: { value: null },
    uMode: { value: 0 },
    uEdited: { value: null },
    uDepth: { value: null },
    uViewProj: { value: new THREE.Matrix4() },
    uView: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uDebug: { value: 0 },
    uTile: { value: new THREE.Vector2() },
  },
  // uTile: the UV tile the mesh lives in (some models' UVs run 1..2 and
  // relies on repeat wrapping), so the texel lands in the 0..1 target.
  vertexShader: `
    uniform vec2 uTile;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying vec3 vNormal;
    void main() {
      vUv = uv;
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = vec4((uv - uTile) * 2.0 - 1.0, 0.0, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D uOld, uRender, uPlain, uEdited, uDepth;
    uniform int uMode;
    uniform mat4 uViewProj, uView;
    uniform vec3 uCamPos;
    uniform int uDebug;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying vec3 vNormal;
    void main() {
      vec4 old = texture2D(uOld, vUv);
      vec4 clip = uViewProj * vec4(vWorld, 1.0);
      vec2 s = clip.xy / clip.w * 0.5 + 0.5;
      float inView = step(0.0, clip.w) * step(0.0, s.x) * step(s.x, 1.0) * step(0.0, s.y) * step(s.y, 1.0);
      float depth = -(uView * vec4(vWorld, 1.0)).z;
      // Not behind what the camera saw there (a little slack for the raster).
      float visible = step(texture2D(uDepth, s).r, 1.006 / depth);
      float facing = smoothstep(0.18, 0.5, dot(normalize(vNormal), normalize(uCamPos - vWorld)));
      // r: the view as sent; e: the 2D result (identical wherever the
      // pipeline didn't paste); p: the view without emission, for the ratio.
      vec3 r = texture2D(uRender, s).rgb, e = texture2D(uEdited, s).rgb, p = texture2D(uPlain, s).rgb;
      vec3 d = abs(e - r);
      float edited = smoothstep(0.03, 0.1, max(d.r, max(d.g, d.b)));
      vec3 next = clamp(old.rgb * clamp((e + 0.025) / (p + 0.025), 0.0, 8.0), 0.0, 1.0);
      // Where the edit painted, the original glow goes out (mode 1: emissive map).
      if (uMode == 1) next = vec3(0.0);
      float w = inView * visible * facing * edited;
      // Debug: red where the texel is in view / also visible / also facing / also edited.
      if (uDebug > 0) next = vec3(1, 0, 0);
      if (uDebug == 1) w = inView;
      if (uDebug == 2) w = inView * visible;
      if (uDebug == 3) w = inView * visible * facing;
      // Accumulated (additive blending): where the UVs are mirrored, two surface
      // points share a texel, and the one the camera saw outweighs the hidden one.
      gl_FragColor = vec4(next * w, w);
    }`,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
});

// The new texture: the old one, with the accumulated edit where it has weight.
const composeMat = new THREE.ShaderMaterial({
  uniforms: { uOld: { value: null }, uAcc: { value: null } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D uOld, uAcc;
    varying vec2 vUv;
    void main() {
      vec4 old = texture2D(uOld, vUv), acc = texture2D(uAcc, vUv);
      gl_FragColor = vec4(mix(old.rgb, acc.rgb / max(acc.a, 1e-4), clamp(acc.a, 0.0, 1.0)), old.a);
    }`,
  depthTest: false,
  depthWrite: false,
});

const canvasTexture = (img: ImageBitmap) => {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

type Maps = { map: THREE.Texture | null; emissiveMap: THREE.Texture | null };

export const bakeDebug = bakeMat.uniforms.uDebug;

export class SurfaceBaker {
  private history: Maps[] = [];
  private proxy: THREE.Mesh;

  constructor(private renderer: THREE.WebGLRenderer, private mesh: THREE.Mesh) {
    this.proxy = new THREE.Mesh(mesh.geometry, depthMat);
    this.proxy.matrixAutoUpdate = false;
    this.proxy.frustumCulled = false; // drawn in UV space for the bake
    const uv = mesh.geometry.attributes.uv;
    let u = Infinity, v = Infinity;
    for (let i = 0; i < uv.count; i++) (u = Math.min(u, uv.getX(i))), (v = Math.min(v, uv.getY(i)));
    bakeMat.uniforms.uTile.value.set(Math.floor(u + 1e-3), Math.floor(v + 1e-3));
  }

  get material() {
    return this.mesh.material as THREE.MeshStandardMaterial;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  private draw(target: THREE.WebGLRenderTarget | null, scene: THREE.Object3D, cam: THREE.Camera, clear: boolean) {
    const r = this.renderer;
    const prev = { target: r.getRenderTarget(), autoClear: r.autoClear, tone: r.toneMapping };
    r.setRenderTarget(target);
    r.autoClear = clear;
    r.toneMapping = THREE.NoToneMapping;
    r.render(scene, cam);
    r.setRenderTarget(prev.target);
    r.autoClear = prev.autoClear;
    r.toneMapping = prev.tone;
  }

  // `rendered`: the view as sent to the 2D pipeline; `plain`: the same view
  // with emission off; `edited`: the pipeline's result, same size; `cam`: the
  // camera they were rendered from.
  bake(cam: THREE.PerspectiveCamera, rendered: ImageBitmap, plain: ImageBitmap, edited: ImageBitmap) {
    const { width: w, height: h } = rendered;
    this.mesh.updateWorldMatrix(true, false);
    this.proxy.matrix.copy(this.mesh.matrixWorld);
    cam.updateMatrixWorld();
    const clear = { color: this.renderer.getClearColor(new THREE.Color()), alpha: this.renderer.getClearAlpha() };

    // 1. What the camera saw: the depth of the nearest surface per pixel.
    const depth = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.proxy.material = depthMat;
    this.renderer.setClearColor(0x000000, 1);
    const holder = new THREE.Scene().add(this.proxy);
    this.draw(depth, holder, cam, true);

    // 2. Per texture: the edit accumulated per texel in UV space, then laid over the old one.
    const tR = canvasTexture(rendered), tP = canvasTexture(plain), tE = canvasTexture(edited);
    bakeMat.uniforms.uRender.value = tR;
    bakeMat.uniforms.uPlain.value = tP;
    bakeMat.uniforms.uEdited.value = tE;
    bakeMat.uniforms.uDepth.value = depth.texture;
    bakeMat.uniforms.uViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    bakeMat.uniforms.uView.value.copy(cam.matrixWorldInverse);
    bakeMat.uniforms.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    const bakeOne = (old: THREE.Texture, mode: number) => {
      const img = old.image as { width: number; height: number } | undefined;
      const size = img ? { w: img.width, h: img.height } : { w: 2048, h: 2048 };
      const out = new THREE.WebGLRenderTarget(size.w, size.h, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: old.wrapS, wrapT: old.wrapT, depthBuffer: false });
      const acc = new THREE.WebGLRenderTarget(size.w, size.h, { type: THREE.HalfFloatType, depthBuffer: false });
      bakeMat.uniforms.uOld.value = old;
      bakeMat.uniforms.uMode.value = mode;
      this.proxy.material = bakeMat;
      this.renderer.setClearColor(0x000000, 0);
      this.draw(acc, holder, ortho, true);
      composeMat.uniforms.uOld.value = old;
      composeMat.uniforms.uAcc.value = acc.texture;
      quad.material = composeMat;
      this.draw(out, quad, ortho, true);
      acc.dispose();
      // Linear colors in the target; glTF's textures were sRGB-encoded.
      out.texture.colorSpace = THREE.LinearSRGBColorSpace;
      out.texture.flipY = false;
      return out.texture;
    };
    const before = { map: this.material.map, emissiveMap: this.material.emissiveMap };
    const map = bakeOne(before.map!, 0);
    const emissiveMap = before.emissiveMap ? bakeOne(before.emissiveMap, 1) : null;
    this.renderer.setClearColor(clear.color, clear.alpha);
    tR.dispose();
    tP.dispose();
    tE.dispose();
    depth.dispose();
    this.history.push(before);
    this.show({ map, emissiveMap });
  }

  private show(t: Maps) {
    this.material.map = t.map;
    this.material.emissiveMap = t.emissiveMap;
    this.material.needsUpdate = true;
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.show(prev);
    return true;
  }

  // Hold to see the original textures; release for the latest.
  private latest: Maps | null = null;
  peek(original: boolean) {
    if (!this.history.length) return;
    if (original && !this.latest) {
      this.latest = { map: this.material.map, emissiveMap: this.material.emissiveMap };
      this.show(this.history[0]);
    } else if (!original && this.latest) {
      this.show(this.latest);
      this.latest = null;
    }
  }
}
