// The 3D stage: renderer, camera, orbit controls (right mouse / fingers),
// ground grid, lights, and smooth moves to the named views.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// A floor grid that fades out with distance (quarter-unit and unit lines).
function infiniteGrid() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: themeColor('--grid', '#b9b0a0') } },
      vertexShader: `varying vec3 vPos; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 uColor; varying vec3 vPos;
        float line(float size) { vec2 c = vPos.xz / size; vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - min(min(g.x, g.y), 1.0); }
        void main() {
          float fade = 1.0 - smoothstep(2.5, 9.0, distance(cameraPosition.xz, vPos.xz));
          float a = max(line(0.25) * 0.28, line(1.0) * 0.55) * fade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'floor';
  mesh.renderOrder = -2;
  return mesh;
}

// A colour from theme.css (any CSS colour) for three.js.
export function themeColor(name: string, fallback: string) {
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setStyle(`rgb(${r},${gr},${b})`);
}

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  controls: OrbitControls;
  // Everything the user made: strokes and the built model.
  sketch = new THREE.Group();
  model = new THREE.Group();
  helpers = new THREE.Group(); // hidden in the renders sent to Spark
  private tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t0: number; ms: number } | null = null;
  private tickers: ((now: number) => void)[] = [];

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.applyTheme();

    this.camera.position.set(0, 0.75, 3.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.55, 0);
    // Calm, eased orbit / pan / zoom; the wheel zooms toward the pointer.
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = 0.8;
    this.controls.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 12;
    this.controls.update();

    const grid = new THREE.GridHelper(4, 16, 0xcfc6b6, 0xe2dccf);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.9;
    grid.name = 'grid';
    // The small grid is what Spark's renders show as the ground (views.ts turns
    // it on there); the live view shows a subtle infinite floor instead.
    grid.visible = false;
    this.scene.add(grid);
    this.helpers.add(infiniteGrid());
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.14 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.0005;
    shadow.receiveShadow = true;
    shadow.name = 'shadow';
    this.scene.add(shadow);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cdb8, 1.6));
    // A soft cool rim from behind, so low-poly facets read against the dark background.
    const rim = new THREE.DirectionalLight(0xc8d8ff, 0.9);
    rim.position.set(-2.5, 3, -4);
    this.scene.add(rim);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2.5, 4, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.scene.add(this.model, this.sketch, this.helpers);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  // The scene follows the app's theme (light or dark), like the image mode's canvas.
  applyTheme() {
    this.scene.background = themeColor('--canvas', '#f3efe6');
    const floor = this.helpers.getObjectByName('floor') as THREE.Mesh | undefined;
    if (floor) ((floor.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).copy(themeColor('--grid', '#b9b0a0'));
  }

  onTick(f: (now: number) => void) {
    this.tickers.push(f);
  }

  offTick(f: (now: number) => void) {
    this.tickers = this.tickers.filter((x) => x !== f);
  }

  // Moved into a new host (the 3D mode remounted): keep the same renderer and scene.
  mount(host: HTMLElement) {
    if (host === this.host) return;
    this.host = host;
    host.appendChild(this.renderer.domElement);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  // The host's size: the app's 3D area, below the top bar.
  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Frame the sketch and the model (eased), keeping the viewing direction.
  fit() {
    const box = new THREE.Box3().expandByObject(this.sketch).expandByObject(this.model);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 1, 1));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.2, box.getSize(new THREE.Vector3()).length() / 2);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2)) * 1.05;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.tween = { from: this.camera.position.clone(), to: center.clone().addScaledVector(dir, dist), tFrom: this.controls.target.clone(), tTo: center, t0: performance.now(), ms: 500 };
  }

  // Fly to a named view around the current target.
  goTo(view: 'front' | 'side' | 'top' | 'three', instant = false) {
    const t = this.controls.target.clone();
    const d = this.camera.position.distanceTo(t);
    const dir = { front: [0, 0.08, 1], side: [1, 0.08, 0], top: [0, 1, 0.0001], three: [0.8, 0.55, 1] }[view];
    const to = t.clone().add(new THREE.Vector3(...dir).normalize().multiplyScalar(d));
    if (instant) {
      this.tween = null;
      this.camera.position.copy(to);
      this.camera.lookAt(t);
      this.camera.updateMatrixWorld();
      return;
    }
    this.tween = { from: this.camera.position.clone(), to, tFrom: t.clone(), tTo: t, t0: performance.now(), ms: 450 };
  }

  frames = 0;

  private frame(now: number) {
    this.frames++;
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.ms);
      const e = 1 - Math.pow(1 - k, 3);
      // Move along the sphere around the target so the distance stays put.
      const t = this.tween.tFrom.clone().lerp(this.tween.tTo, e);
      const a = this.tween.from.clone().sub(this.tween.tFrom);
      const b = this.tween.to.clone().sub(this.tween.tTo);
      const len = a.length() * (1 - e) + b.length() * e;
      const dir = a.normalize().lerp(b.normalize(), e).normalize();
      this.camera.position.copy(t).add(dir.multiplyScalar(len));
      this.controls.target.copy(t);
      if (k === 1) this.tween = null;
    }
    for (const f of this.tickers) f(now);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
