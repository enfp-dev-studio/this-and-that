// The 3D stage: renderer, camera, orbit controls (right mouse / fingers),
// ground grid, lights, and smooth moves to the named views.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#f3efe6');

    this.camera.position.set(0, 0.75, 3.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.55, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 12;
    this.controls.update();

    const grid = new THREE.GridHelper(4, 16, 0xcfc6b6, 0xe2dccf);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.9;
    grid.name = 'grid';
    this.scene.add(grid);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.14 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.0005;
    shadow.receiveShadow = true;
    shadow.name = 'shadow';
    this.scene.add(shadow);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cdb8, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2.5, 4, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.scene.add(this.model, this.sketch, this.helpers);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  onTick(f: (now: number) => void) {
    this.tickers.push(f);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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
