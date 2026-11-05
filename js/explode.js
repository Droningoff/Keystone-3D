// Взрыв-схема модуля для окна спецификации: детали (группы деталей) разлетаются от центра модуля.
// Группа — верхний уровень исходной модели (ящик, сборка) у модулей Самолета или отдельная панель у параметрических.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MATERIALS } from './catalog.js';
import { panelBox } from './model.js';

export class ExplodeView {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0xf4f6f9);
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(0.7, 1, 1.1);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 200000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.draw());
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.nodes = [];
    this.factor = 0.6;
    this.labels = false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth || 520, h = this.el.clientHeight || 420;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  /** item — элемент build.items; панели в локальных координатах модуля */
  setItem(it, { fronts = true } = {}) {
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      o.traverse((q) => { q.geometry?.dispose(); q.material?.dispose?.(); });
    }
    this.nodes = [];
    const panels = it.panels.filter((p) => fronts || p.role !== 'front');
    if (!panels.length) { this.draw(); return; }
    const all = new THREE.Box3();
    const groups = new Map();
    for (const p of panels) {
      const b = panelBox(p);
      const k = p.group != null ? 'g' + p.group : 'p' + p.key;
      if (!groups.has(k)) groups.set(k, { box: new THREE.Box3(), panels: [] });
      const g = groups.get(k);
      const bb = new THREE.Box3(new THREE.Vector3(b.x1, b.y1, b.z1), new THREE.Vector3(b.x2, b.y2, b.z2));
      g.box.union(bb);
      all.union(bb);
      g.panels.push({ p, b });
    }
    const center = all.getCenter(new THREE.Vector3());
    this.size = all.getSize(new THREE.Vector3());
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b2f36, transparent: true, opacity: 0.55 });
    for (const g of groups.values()) {
      const node = new THREE.Group();
      for (const { p, b } of g.panels) {
        const geo = new THREE.BoxGeometry(Math.max(0.5, b.x2 - b.x1), Math.max(0.5, b.y2 - b.y1), Math.max(0.5, b.z2 - b.z1));
        const md = p.color != null ? p : (MATERIALS[p.mat] || { color: 0xcccccc });
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: md.color, roughness: md.metal ? 0.35 : 0.7, metalness: md.metal ? 0.7 : 0,
          transparent: !!p.glass, opacity: p.glass ? 0.4 : 1,
        }));
        mesh.position.set((b.x1 + b.x2) / 2 - center.x, (b.y1 + b.y2) / 2 - center.y, (b.z1 + b.z2) / 2 - center.z);
        node.add(mesh);
        const ed = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
        ed.position.copy(mesh.position);
        node.add(ed);
      }
      // Направление разлёта: от центра модуля к центру группы; плоские детали у центра — по их нормали
      const gc = g.box.getCenter(new THREE.Vector3()).sub(center);
      const gs = g.box.getSize(new THREE.Vector3());
      const dir = gc.clone();
      const thin = Math.min(gs.x, gs.y, gs.z);
      if (dir.length() < 1) {
        if (thin === gs.z) dir.set(0, 0, 1); else if (thin === gs.x) dir.set(1, 0, 0); else dir.set(0, 1, 0);
        dir.multiplyScalar(Math.max(this.size.x, this.size.y, this.size.z) * 0.15);
      }
      node.userData.dir = dir;
      this.root.add(node);
      this.nodes.push(node);
    }
    this.applyFactor();
    this.fit();
  }

  setFactor(f) { this.factor = f; this.applyFactor(); }

  applyFactor() {
    for (const n of this.nodes) n.position.copy(n.userData.dir).multiplyScalar(this.factor);
    this.draw();
  }

  fit() {
    const s = this.size || new THREE.Vector3(600, 720, 560);
    const r = Math.max(s.x, s.y, s.z) * (1 + this.factor) * 0.75 + 50;
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.set(dist * 0.55, dist * 0.35, dist * 0.78);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.draw();
  }

  draw() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    this.ro.disconnect();
    this.controls.dispose();
    this.root.traverse((q) => { q.geometry?.dispose(); q.material?.dispose?.(); });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
