import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { MATERIALS } from './catalog.js?v=20261028m';
import { panelBox } from './model.js?v=20261110a';
import { buildFixtureMesh, FIXTURE_CATALOG, SINK_RIM } from './fixtures.js?v=20261028m';
import { WALL_BY_ID } from './walls.js?v=20261110a';
import {
  roomOutline, roomWallSegments, roomBounds, isAdvanced, ensureAdvancedFields,
  roomWallSegments3D, ceilingHeightAt, planAtHeight, edgeLetter, pointInPolygon,
} from './roomGeom.js?v=20261110a';
import { buildHardwareMesh } from './hardware.js?v=20261029j';

/**
 * handlers:
 *  onPick(moduleId|null, panelKey|null, fixtureId|null)
 *  onMove(moduleId, x, z)
 *  onPlace(x, z, wall?)
 *  onToggleFront(moduleId, panelKey)
 *  snap(moduleId, x, z) -> {x,z}
 *  dockSockets(excludeId|null) -> [{id,hostId,side,corner,x,y,z,label,pose?}]
 *  onDock(moduleId, socket) — пристыковка к маркеру
 *  onRoomPick(part) — { kind:'wall'|'ceiling', edgeIndex?, letter?, point, y }
 *  onRoomContext(part, clientX, clientY)
 *  onPickCtor(kind, id) — kind: 'obstacle'|'opening'
 *  onMoveObstacle(id, x, z)
 *  onMoveOpening(id, offset, sill?)
 *  onDraggingCtor(kind, id, fields) — live обновление полей в props
 */
export class Viewer {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.frontMode = 'show';
    this.lineMode = false; // eKitchen «в линиях» — Ч/Б каркас
    this.mode = 'select'; // select | place | placeFixture | placeCtor
    this.placeType = null;
    this.placeFixture = null;
    this.placeCtor = null; // { id, title, kind, ... } из CONSTRUCTION_CATALOG
    this.placeRot = 0;
    this.roomSel = null; // { kind, edgeIndex?, letter? }
    this.sel = { moduleId: null, panelKey: null, fixtureId: null, obstacleId: null, openingId: null };
    this.ctorObstacleMeshes = new Map();
    this.ctorOpeningMeshes = new Map();
    this.ghost = null;
    this.openAnim = new Map(); // `${mid}:${key}` -> current 0..1
    this.clock = new THREE.Clock();
    this.ctrlHeld = false;
    this.shiftHeld = false;
    this.dockMode = false; // Ctrl или кнопка «Стык»
    this._dockHotId = null;
    // Навигация как в eKitchen: walk (изнутри) | orbit (изометрия) | top | front
    this.navMode = 'orbit';
    this.showGrid = true;
    this.showDims = true;
    this.dimMode = 'basic'; // none | basic | all — как BPlanner
    this.layers = {
      ceiling: true, walls: true, floor: true,
      appliances: true, communications: true, furniture: true,
    };
    this.keysHeld = new Set();
    this.walkDrag = null; // {x0,y0, vx,vz} — скорость от смещения мыши
    this._lookPitch = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    el.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    el.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9ebee);
    this.camera = new THREE.PerspectiveCamera(40, 1, 10, 80000);
    this.camera.position.set(2500, 2200, 5500);

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this._down(e));
    dom.addEventListener('pointermove', (e) => this._move(e));
    dom.addEventListener('pointerup', (e) => this._up(e));
    // dblclick браузера часто срывается из?за пересборки сцены на клике — дублируем своей логикой в _up
    dom.addEventListener('dblclick', (e) => { e.preventDefault(); this._dbl(e); });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._key(e));
    window.addEventListener('keyup', (e) => this._keyup(e));
    window.addEventListener('blur', () => {
      this.ctrlHeld = false;
      this.shiftHeld = false;
      this.keysHeld.clear();
      this.walkDrag = null;
      this._rebuildDocks();
    });

    this.controls = new OrbitControls(this.camera, dom);
    this.controls.target.set(2000, 900, 1500);
    this.controls.enableDamping = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this._lastTap = null; // ручной double-tap по фасаду

    this.lightRoot = new THREE.Group();
    this.scene.add(this.lightRoot);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.55);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.35);
    this.ceilingGroup = new THREE.Group();
    this.accent = new THREE.PointLight(0xffe6c2, 0, 4000);
    this.lightRoot.add(this.hemi, this.sun, this.fill, this.ceilingGroup, this.accent);

    this.roomGroup = new THREE.Group();
    this.furnGroup = new THREE.Group();
    this.fixGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this.dockGroup = new THREE.Group();
    this.measureGroup = new THREE.Group(); // сетка + размеры
    this.wallHandleGroup = new THREE.Group(); // интерактивные точки пол/yRef/потолок
    this.wallHandleBaseGroup = new THREE.Group(); // пунктир базового состояния при drag
    this.scene.add(
      this.roomGroup, this.furnGroup, this.fixGroup, this.ghostGroup,
      this.dockGroup, this.measureGroup, this.wallHandleGroup, this.wallHandleBaseGroup,
    );
    this._wallHandleBaseline = null;

    this.floorMesh = null;
    this.wallMeshes = [];
    this.ray = new THREE.Raycaster();
    this.modGroups = new Map();
    this.doorPivots = new Map();

    new ResizeObserver(() => this._resize()).observe(el);
    this._resize();
    const loop = () => {
      const dt = this.clock.getDelta();
      this._animateDoors(dt);
      this._updateWallVisibility();
      this._updateNav(dt);
      // top тоже нужен update — иначе после «Сверху» камера «залипает»
      if (this.controls.enabled) this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  _resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setMode(mode, payload = null) {
    this.mode = mode;
    this.placeType = mode === 'place' ? payload : null;
    this.placeFixture = mode === 'placeFixture' ? payload : null;
    this.placeCtor = mode === 'placeCtor' ? payload : null;
    this.ghostGroup.clear();
    if (mode === 'place' || mode === 'placeFixture' || mode === 'placeCtor') {
      this.roomSel = null;
      this.setPropFocus(null);
      this._applyRoomHighlight();
    }
    this.el.style.cursor = mode.startsWith('place') ? 'crosshair' : '';
    this._applyViewControls(this.navMode || 'orbit');
  }

  setRoomSelection(sel) {
    this.roomSel = sel;
    this._applyRoomHighlight();
    this._applyPropFocusHighlight();
    this._rebuildWallHandles();
  }

  /** Пунктир исходных рёбер при перетаскивании 3D-ручки стены. */
  setWallHandleBaseline(base) {
    this._wallHandleBaseline = base || null;
    this._drawWallHandleBaseline();
  }

  _clearWallHandleGroup(g) {
    if (!g) return;
    g.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material.dispose?.();
      }
    });
    g.clear();
  }

  /** Ручки углов выбранной стены на трёх высотах: пол / yRef / потолок. */
  _rebuildWallHandles() {
    this._clearWallHandleGroup(this.wallHandleGroup);
    if (this._wallHandleDrag) return; // не сбрасывать во время drag
    const sel = this.roomSel;
    const room = this.room;
    if (!sel || sel.kind !== 'wall' || sel.edgeIndex == null || !room) return;
    ensureAdvancedFields(room);
    const segs = roomWallSegments3D(room);
    const s = segs[sel.edgeIndex];
    if (!s) return;
    const n = room.planFloor.length;
    const i0 = sel.edgeIndex;
    const i1 = (sel.edgeIndex + 1) % n;
    const yRef = +room.yRef || 900;
    const pts = [
      { p: s.a0, y: 40, vertIndex: i0, layer: 'floor' },
      { p: s.b0, y: 40, vertIndex: i1, layer: 'floor' },
      { p: s.aR, y: yRef, vertIndex: i0, layer: 'ref' },
      { p: s.bR, y: yRef, vertIndex: i1, layer: 'ref' },
      { p: s.a1, y: s.hA || (+room.height || 2700), vertIndex: i0, layer: 'ceil' },
      { p: s.b1, y: s.hB || (+room.height || 2700), vertIndex: i1, layer: 'ceil' },
    ];
    const col = { floor: 0x0969da, ref: 0x0d9488, ceil: 0x8b5cf6 };
    for (const h of pts) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(55, 14, 14),
        new THREE.MeshBasicMaterial({
          color: col[h.layer] || 0x0969da,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      mesh.position.set(h.p.x, h.y, h.p.z);
      mesh.renderOrder = 30;
      mesh.userData.wallHandle = {
        vertIndex: h.vertIndex,
        layer: h.layer,
        edgeIndex: sel.edgeIndex,
        y: h.y,
      };
      this.wallHandleGroup.add(mesh);
    }
  }

  _drawWallHandleBaseline() {
    this._clearWallHandleGroup(this.wallHandleBaseGroup);
    const base = this._wallHandleBaseline;
    const drag = this._wallHandleDrag;
    if (!base?.verts || drag?.vertIndex == null) return;
    const n = base.verts.length;
    const i = drag.vertIndex;
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const y = drag.y || 40;
    const dashMat = new THREE.LineDashedMaterial({
      color: 0x0969da, dashSize: 60, gapSize: 40,
      depthTest: false, transparent: true, opacity: 0.9,
    });
    const addSeg = (a, b) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([
        a.x, y, a.z, b.x, y, b.z,
      ], 3));
      const line = new THREE.Line(geo, dashMat.clone());
      line.computeLineDistances();
      line.renderOrder = 28;
      this.wallHandleBaseGroup.add(line);
    };
    addSeg(base.verts[prev], base.verts[i]);
    addSeg(base.verts[i], base.verts[next]);
    const mark = new THREE.Mesh(
      new THREE.SphereGeometry(40, 10, 10),
      new THREE.MeshBasicMaterial({
        color: 0x0969da, depthTest: false, transparent: true, opacity: 0.45, wireframe: true,
      }),
    );
    mark.position.set(base.verts[i].x, y, base.verts[i].z);
    mark.renderOrder = 29;
    this.wallHandleBaseGroup.add(mark);
  }

  _hitWallHandle(e) {
    if (!this.wallHandleGroup?.children?.length) return null;
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const hits = this.ray.intersectObjects(this.wallHandleGroup.children, false);
    return hits[0] || null;
  }

  /** Подсветка конкретного свойства: lengthFloor|lengthRef|lengthCeil|angleStart*|angleEnd* */
  setPropFocus(key) {
    this.propFocus = key || null;
    this._applyPropFocusHighlight();
  }

  _ensurePropFocusOverlay() {
    if (!this._propFocusOverlay) {
      this._propFocusOverlay = new THREE.Group();
      this._propFocusOverlay.name = 'propFocusOverlay';
      this.scene.add(this._propFocusOverlay);
    }
    return this._propFocusOverlay;
  }

  _clearPropFocusOverlay() {
    const g = this._propFocusOverlay;
    if (!g) return;
    g.traverse((o) => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
      o.geometry?.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material.dispose?.();
      }
    });
    g.clear();
  }

  _applyPropFocusHighlight() {
    this._clearPropFocusOverlay();
    const key = this.propFocus;
    const sel = this.roomSel;
    const room = this.room;
    if (!key || !sel || sel.kind !== 'wall' || sel.edgeIndex == null || !room) return;
    ensureAdvancedFields(room);
    const segs = roomWallSegments3D(room);
    const s = segs[sel.edgeIndex];
    if (!s) return;
    const g = this._ensurePropFocusOverlay();
    const yRef = +room.yRef || 900;
    const col = 0xff2d55; // акцент отличный от выделения стены (бирюза)

    const addLen = (ax, ay, az, bx, by, bz, label) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([ax, ay, az, bx, by, bz], 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: col, depthTest: false, transparent: true, opacity: 1,
      }));
      line.renderOrder = 20;
      g.add(line);
      // маркеры концов
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz]]) {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(35, 10, 10),
          new THREE.MeshBasicMaterial({ color: col, depthTest: false }),
        );
        m.position.set(x, y, z);
        m.renderOrder = 21;
        g.add(m);
      }
      const div = document.createElement('div');
      div.className = 'mlabel prop-focus';
      div.textContent = label;
      const lab = new CSS2DObject(div);
      lab.position.set((ax + bx) / 2, (ay + by) / 2 + 40, (az + bz) / 2);
      g.add(lab);
    };

    const addCorner = (p, y, label) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(55, 12, 12),
        new THREE.MeshBasicMaterial({ color: col, depthTest: false }),
      );
      m.position.set(p.x, y, p.z);
      m.renderOrder = 21;
      g.add(m);
      // крест осей угла
      const cross = new THREE.BufferGeometry();
      const r = 120;
      cross.setAttribute('position', new THREE.Float32BufferAttribute([
        p.x - r, y, p.z, p.x + r, y, p.z,
        p.x, y, p.z - r, p.x, y, p.z + r,
      ], 3));
      g.add(new THREE.LineSegments(cross, new THREE.LineBasicMaterial({
        color: col, depthTest: false,
      })));
      const div = document.createElement('div');
      div.className = 'mlabel prop-focus';
      div.textContent = label;
      const lab = new CSS2DObject(div);
      lab.position.set(p.x, y + 80, p.z);
      g.add(lab);
    };

    if (key === 'lengthFloor') {
      addLen(s.a0.x, 40, s.a0.z, s.b0.x, 40, s.b0.z, `пол ${Math.round(s.lenFloor)}`);
    } else if (key === 'lengthRef') {
      addLen(s.aR.x, yRef, s.aR.z, s.bR.x, yRef, s.bR.z, `yRef ${Math.round(s.lenRef)}`);
    } else if (key === 'lengthCeil') {
      addLen(s.a1.x, s.hA, s.a1.z, s.b1.x, s.hB, s.b1.z, `потолок ${Math.round(s.lenCeil)}`);
    } else if (key.startsWith('angleStart')) {
      const y = key.endsWith('Floor') ? 40 : key.endsWith('Ref') ? yRef : s.hA;
      const p = key.endsWith('Floor') ? s.a0 : key.endsWith('Ref') ? s.aR : s.a1;
      addCorner(p, y, `∠ нач.`);
    } else if (key.startsWith('angleEnd')) {
      const y = key.endsWith('Floor') ? 40 : key.endsWith('Ref') ? yRef : s.hB;
      const p = key.endsWith('Floor') ? s.b0 : key.endsWith('Ref') ? s.bR : s.b1;
      addCorner(p, y, `∠ кон.`);
    }
  }

  _clearRoomSelOverlay() {
    if (!this._roomSelOverlay) return;
    this._roomSelOverlay.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material.dispose?.();
      }
    });
    this._roomSelOverlay.clear();
  }

  /** Явное выделение: заливка + яркий контур выбранной стены/потолка. */
  _applyRoomHighlight() {
    const sel = this.roomSel;
    if (!this._roomSelOverlay) {
      this._roomSelOverlay = new THREE.Group();
      this._roomSelOverlay.name = 'roomSelOverlay';
      this.scene.add(this._roomSelOverlay);
    }
    this._clearRoomSelOverlay();

    for (const m of this.wallMeshes || []) {
      const mat = m.material;
      const on = sel?.kind === 'wall' && sel.edgeIndex != null && m.userData.edgeIndex === sel.edgeIndex;
      if (mat?.emissive) {
        mat.emissive = new THREE.Color(on ? 0x0d9488 : 0x000000);
        mat.emissiveIntensity = on ? 0.55 : 0;
      }
      if (m.userData._edgeHelper) m.userData._edgeHelper.visible = false;
      if (on) this._addSelOverlayForMesh(m);
    }

    const ceilOn = sel?.kind === 'ceiling' && this.ceilMesh;
    if (this.ceilMesh?.material?.emissive) {
      this.ceilMesh.material.emissive = new THREE.Color(ceilOn ? 0x0d9488 : 0x000000);
      this.ceilMesh.material.emissiveIntensity = ceilOn ? 0.4 : 0;
    }
    if (ceilOn) this._addSelOverlayForMesh(this.ceilMesh);
  }

  _addSelOverlayForMesh(src) {
    if (!src?.geometry || !this._roomSelOverlay) return;
    src.updateWorldMatrix(true, false);
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.32,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    const fill = new THREE.Mesh(src.geometry.clone(), fillMat);
    fill.applyMatrix4(src.matrixWorld);
    fill.renderOrder = 10;
    this._roomSelOverlay.add(fill);

    const edgeMat = new THREE.LineBasicMaterial({
      color: 0xfbbf24,
      depthTest: false,
      transparent: true,
      opacity: 1,
    });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(src.geometry, 20), edgeMat);
    edges.applyMatrix4(src.matrixWorld);
    edges.renderOrder = 11;
    this._roomSelOverlay.add(edges);

    // второй контур чуть крупнее — «обводка»
    const edgeMat2 = new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    const edges2 = new THREE.LineSegments(new THREE.EdgesGeometry(src.geometry, 20), edgeMat2);
    edges2.applyMatrix4(src.matrixWorld);
    edges2.scale.multiplyScalar(1.004);
    edges2.renderOrder = 12;
    this._roomSelOverlay.add(edges2);
  }

  _hitRoomPart(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const targets = [...(this.wallMeshes || [])];
    if (this.ceilMesh) targets.push(this.ceilMesh);
    const hits = this.ray.intersectObjects(targets, false);
    if (!hits.length) return null;
    const h = hits[0];
    const ud = h.object.userData || {};
    if (ud.roomPart === 'ceiling' || h.object === this.ceilMesh) {
      return {
        kind: 'ceiling',
        point: h.point.clone(),
        y: h.point.y,
        object: h.object,
      };
    }
    const edgeIndex = ud.edgeIndex != null ? ud.edgeIndex : null;
    return {
      kind: 'wall',
      edgeIndex,
      letter: edgeIndex != null ? edgeLetter(edgeIndex) : (ud.wall ? WALL_BY_ID[ud.wall]?.letter : '?'),
      wall: ud.wall,
      point: h.point.clone(),
      y: h.point.y,
      object: h.object,
    };
  }

  setFrontMode(mode) {
    this.frontMode = mode;
    if (this.build) this.render(this.build, this.sel, this.fixtures);
  }

  /**
   * eKitchen «Посмотреть в линиях» (butt_bw / EnableCortonaWiseWireFrame):
   * белый фон, чёрные рёбра (EdgesGeometry ≈ IndexedFaceSetWithEdges), без заливки/текстур.
   */
  setLineMode(on) {
    const next = !!on;
    this.lineMode = next;
    this.scene.background = new THREE.Color(next ? 0xffffff : 0xe9ebee);
    if (next) {
      // не перезаписывать сохранённый свет нулями при повторном включении
      if (!this._savedLight) {
        this._savedLight = {
          hemi: this.hemi.intensity, sun: this.sun.intensity,
          fill: this.fill.intensity, accent: this.accent.intensity,
        };
      }
      this.hemi.intensity = 0.05;
      this.sun.intensity = 0;
      this.fill.intensity = 0;
      this.accent.intensity = 0;
      // как eKitchen: прячем стены/потолок — остаются линии мебели на белом
      if (this.roomGroup) this.roomGroup.visible = false;
      if (this.ceilingGroup) this.ceilingGroup.visible = false;
    } else if (this._savedLight) {
      this.hemi.intensity = this._savedLight.hemi || 0.55;
      this.sun.intensity = this._savedLight.sun || 1.2;
      this.fill.intensity = this._savedLight.fill || 0.35;
      this.accent.intensity = this._savedLight.accent || 0;
      this._savedLight = null;
      if (this.ceilingGroup) this.ceilingGroup.visible = true;
      this._updateWallVisibility();
    }
    if (this.build) this.render(this.build, this.sel, this.fixtures || []);
  }

  /** Ч/Б: почти невидимая заливка (pick) — контур даёт EdgesGeometry / wireframe. */
  _lineFillMat() {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.01, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  _lineEdgeMat() {
    return new THREE.LineBasicMaterial({ color: 0x000000, depthTest: true, depthWrite: false });
  }

  _lineWireMat() {
    return new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, side: THREE.DoubleSide });
  }

  _toLineWire(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = this._lineWireMat();
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }

  applyLighting(L) {
    if (!L) return;
    if (this.lineMode) {
      // не возвращаем свет поверх режима линий (refresh иначе затирает setLineMode)
      this._savedLight = {
        hemi: L.ambient ?? 0.55, sun: L.sun ?? 1.2,
        fill: L.fill ?? 0.35, accent: L.accent ? 1.2 : 0,
      };
      this.hemi.intensity = 0.05;
      this.sun.intensity = 0;
      this.fill.intensity = 0;
      this.accent.intensity = 0;
      return;
    }
    this.hemi.intensity = L.ambient ?? 0.55;
    this.sun.intensity = L.sun ?? 1.2;
    this.fill.intensity = L.fill ?? 0.35;
    const az = ((L.sunAzimuth ?? 35) * Math.PI) / 180;
    const el = ((L.sunElevation ?? 55) * Math.PI) / 180;
    const r = 8000;
    this.sun.position.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
    this.fill.position.set(-3000, 1500, 2000);
    this.accent.intensity = L.accent ? 1.2 : 0;
    this.accent.color.set(L.accentColor || '#ffe6c2');
    this.ceilingGroup.clear();
    if (L.ceiling && this.room) {
      const n = L.ceilingCount || 4;
      const Lx = this.room.length, Dz = this.room.depth, Hy = this.room.height;
      for (let i = 0; i < n; i++) {
        const pl = new THREE.PointLight(0xfff5e6, L.ceilingIntensity ?? 0.6, Math.max(Lx, Dz) * 1.2);
        pl.position.set(((i % 2) + 0.5) * (Lx / 2), Hy - 50, (Math.floor(i / 2) + 0.5) * (Dz / 2));
        const lamp = new THREE.Mesh(
          new THREE.CylinderGeometry(60, 60, 20, 16),
          new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xfff0c8, emissiveIntensity: 0.8 }),
        );
        lamp.position.copy(pl.position);
        lamp.userData.lamp = true;
        this.ceilingGroup.add(pl, lamp);
      }
    }
  }

  setFixturesVisible(v) {
    this._fixturesWanted = !!v;
    if (!this.lineMode) this.fixGroup.visible = !!v;
  }

  // Стены: в режиме auto прячутся те, что стоят между камерой и центром комнаты
  _updateWallVisibility() {
    if (!this.room || !this.wallGroups) return;
    // «В линиях» — только каркас мебели на белом; комнату не показываем (иначе чёрные плоскости при погашенном свете)
    if (this.lineMode) {
      this.roomGroup.visible = false;
      if (this.ceilingGroup) this.ceilingGroup.visible = false;
      return;
    }
    const mode = this.room.show || 'auto';
    this.roomGroup.visible = mode !== 'hide';
    const cam = this.camera.position;
    const { length: L, depth: D } = this.room;
    for (const [name, grp] of Object.entries(this.wallGroups)) {
      let vis = mode === 'full' || mode === 'auto';
      if (mode === 'auto') {
        vis = !({ back: cam.z < 0, front: cam.z > D, left: cam.x < 0, right: cam.x > L }[name]);
      }
      grp.visible = vis;
    }
    if (this.ceilMesh) this.ceilMesh.visible = mode === 'full' && this.camera.position.y < this.room.height;
    const lampsVis = mode === 'full' || mode === 'auto';
    for (const o of this.ceilingGroup.children) if (o.userData.lamp) o.visible = lampsVis;
  }

  /** Контур Shape (x,z) → горизонтальная плоскость на высоте y (нормаль вверх). */
  _shapeToHorizontal(shape, y = 0) {
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getY(i);
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  setRoom(room) {
    this.room = room;
    ensureAdvancedFields(room);
    const g = this.roomGroup;
    // полное освобождение геометрии — иначе артефакты после смены контура
    g.traverse((o) => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
      o.geometry?.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else if (o.material !== undefined && o.parent === g || o.isMesh) {
          try { o.material.dispose?.(); } catch (_) { /* shared */ }
        }
      }
    });
    g.clear();
    this.wallMeshes = [];
    this.wallGroups = {};
    this.ctorObstacleMeshes = new Map();
    this.ctorOpeningMeshes = new Map();
    this.wallLetterGroup = new THREE.Group();
    g.add(this.wallLetterGroup);
    const L = room.length, D = room.depth, H = room.height;
    const floorMat = new THREE.MeshStandardMaterial({ color: room.floorColor || 0xcfc6b8, roughness: 0.9 });
    const wallMat = new THREE.MeshStandardMaterial({ color: room.wallColor || 0xf6f4f0, roughness: 0.95, side: THREE.DoubleSide });
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.15 });

    const outline = roomOutline(room);
    const bounds = roomBounds(room);
    // без дублирующей замыкающей точки в Shape
    const ring = [];
    for (const p of outline) {
      if (ring.length && Math.hypot(ring[0].x - p.x, ring[0].z - p.z) < 0.5) break;
      const prev = ring[ring.length - 1];
      if (prev && Math.hypot(prev.x - p.x, prev.z - p.z) < 0.5) continue;
      ring.push(p);
    }
    const shape = new THREE.Shape();
    if (ring.length >= 3) {
      shape.moveTo(ring[0].x, ring[0].z);
      for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i].x, ring[i].z);
      shape.closePath();
    } else {
      shape.moveTo(0, 0); shape.lineTo(L, 0); shape.lineTo(L, D); shape.lineTo(0, D); shape.closePath();
    }

    // ShapeGeometry в XY; rotateX(-π/2) зеркалит Z → «пол за комнатой». Кладём вершины в XZ вручную.
    const floor = new THREE.Mesh(this._shapeToHorizontal(shape, 0), floorMat);
    floor.receiveShadow = true;
    floor.userData = { plane: 'floor', pickPlane: true };
    g.add(floor);
    this.floorMesh = floor;

    let ceil;
    if (room.ceiling?.mode === 'samples' && room.planFloor?.length >= 3) {
      const verts = room.planFloor;
      const pos = [];
      const idx = [];
      for (let i = 0; i < verts.length; i++) {
        const h = ceilingHeightAt(room, verts[i].x, verts[i].z);
        const lean = planAtHeight(room, h)[i];
        pos.push(lean.x, h, lean.z);
      }
      for (let i = 1; i < verts.length - 1; i++) idx.push(0, i, i + 1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      ceil = new THREE.Mesh(geo, ceilMat);
    } else {
      ceil = new THREE.Mesh(this._shapeToHorizontal(shape, H), ceilMat);
    }
    g.add(ceil);
    this.ceilMesh = ceil;

    for (const name of ['back', 'front', 'left', 'right']) {
      const wg = new THREE.Group();
      wg.userData.wall = name;
      g.add(wg);
      this.wallGroups[name] = wg;
    }

    const segs3 = roomWallSegments3D(room);
    const yRef = +room.yRef || 900;
    for (const s of segs3) {
      const wg = this.wallGroups[s.wall] || g;
      const a0 = s.a0, b0 = s.b0, aR = s.aR || a0, bR = s.bR || b0, a1 = s.a1, b1 = s.b1;
      // пояса между соседними уровнями (пол → … → потолок) → сложный контур при разных длинах
      const belts = s.belts?.length >= 2 ? s.belts : [
        { a: a0, b: b0, yA: 0, yB: 0 }, { a: aR, b: bR, yA: yRef, yB: yRef }, { a: a1, b: b1, yA: s.hA, yB: s.hB },
      ];
      const pos = [], idx = [];
      for (let k = 0; k < belts.length - 1; k++) {
        const lo = belts[k], hi = belts[k + 1], o = pos.length / 3;
        pos.push(lo.a.x, lo.yA, lo.a.z, lo.b.x, lo.yB, lo.b.z, hi.b.x, hi.yB, hi.b.z, hi.a.x, hi.yA, hi.a.z);
        idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const wmat = wallMat.clone();
      if (!wmat.emissive) wmat.emissive = new THREE.Color(0x000000);
      const wc = room.wallColors?.[s.edgeIndex] ?? room.wallColors?.[s.wall];
      if (wc != null) wmat.color = new THREE.Color(wc);
      const mesh = new THREE.Mesh(geo, wmat);
      mesh.userData = {
        plane: 'wall', wall: s.wall, edgeIndex: s.edgeIndex, pickPlane: true,
        roomPart: 'wall', letter: edgeLetter(s.edgeIndex),
      };
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xf0c000 }));
      edges.visible = false;
      mesh.add(edges);
      mesh.userData._edgeHelper = edges;
      wg.add(mesh);
      this.wallMeshes.push(mesh);
    }
    for (const ob of room.obstacles || []) {
      if (!ob.id) continue;
      const oh = Math.max(10, +ob.y1 - +ob.y0);
      const col = ob.color != null ? +ob.color : 0xb0a090;
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
      mat.emissive = new THREE.Color(0x000000);
      mat.emissiveIntensity = 0;
      const box = new THREE.Mesh(new THREE.BoxGeometry(+ob.w, oh, +ob.d), mat);
      box.position.set(+ob.x + +ob.w / 2, +ob.y0 + oh / 2, +ob.z + +ob.d / 2);
      if (+ob.rot) box.rotation.y = (+ob.rot * Math.PI) / 180;
      box.castShadow = true;
      box.receiveShadow = true;
      box.userData = {
        pickCtor: true, ctorKind: 'obstacle', ctorId: ob.id,
        x: +ob.x, z: +ob.z, w: +ob.w, d: +ob.d, y0: +ob.y0, y1: +ob.y1, rot: +ob.rot || 0,
      };
      g.add(box);
      this.ctorObstacleMeshes.set(ob.id, box);
    }
    if (this.ceilMesh) {
      this.ceilMesh.userData = { ...(this.ceilMesh.userData || {}), roomPart: 'ceiling', pickPlane: true };
      if (this.ceilMesh.material && this.ceilMesh.material.emissive == null) {
        this.ceilMesh.material.emissive = new THREE.Color(0x000000);
        this.ceilMesh.material.emissiveIntensity = 0;
      }
    }
    this._applyRoomHighlight();
    this._applyLayers();

    // Буква на каждом ребре контура (A, B, C… включая новые после добавления вершин)
    const labelHBase = (isAdvanced(room) ? ceilingHeightAt(room, L / 2, D / 2) : H) - 80;
    for (const s of segs3) {
      const letter = edgeLetter(s.edgeIndex);
      const div = document.createElement('div');
      div.className = 'mlabel wall-letter';
      div.textContent = letter;
      div.title = `Стена ${letter}`;
      const lab = new CSS2DObject(div);
      // чуть внутрь комнаты от середины ребра на полу, высота — у потолка сегмента
      const hLab = Math.max(200, Math.min(s.hA || H, s.hB || H) - 80);
      const inset = 60;
      lab.position.set(
        s.midX - s.nx * inset,
        Number.isFinite(hLab) ? hLab : labelHBase,
        s.midZ - s.nz * inset,
      );
      this.wallLetterGroup.add(lab);
    }
    this.setWallLettersVisible(room.showWallLetters !== false);

    for (const op of room.openings || []) {
      this._addOpening(this.wallGroups[op.wall] || g, op, L, D, H);
    }
    if ((room.show || 'auto') === 'floor') for (const wg of Object.values(this.wallGroups)) wg.visible = false;

    this._rebuildMeasureOverlay(room);
    this._refreshHighlights();
    this._applyPropFocusHighlight();
    if (!this._wallHandleDrag) this._rebuildWallHandles();
  }

  /** Подсветка выбранной конструкции (колонна / проём). */
  _applyCtorHighlight() {
    if (!this._roomSelOverlay) {
      this._roomSelOverlay = new THREE.Group();
      this._roomSelOverlay.name = 'roomSelOverlay';
      this.scene.add(this._roomSelOverlay);
    }
    const oid = this.sel?.obstacleId || null;
    const opid = this.sel?.openingId || null;
    for (const [id, mesh] of this.ctorObstacleMeshes || []) {
      const on = id === oid;
      if (mesh.material?.emissive) {
        mesh.material.emissive.setHex(on ? 0x0d9488 : 0x000000);
        mesh.material.emissiveIntensity = on ? 0.5 : 0;
      }
      if (on) this._addSelOverlayForMesh(mesh);
    }
    for (const [id, pack] of this.ctorOpeningMeshes || []) {
      const on = id === opid;
      for (const mesh of [pack.mesh, pack.frame].filter(Boolean)) {
        if (mesh.material?.emissive) {
          mesh.material.emissive.setHex(on ? 0x0d9488 : 0x000000);
          mesh.material.emissiveIntensity = on ? 0.45 : 0;
        }
      }
      if (on && pack.mesh) this._addSelOverlayForMesh(pack.mesh);
    }
  }

  _refreshHighlights() {
    this._applyRoomHighlight();
    this._applyCtorHighlight();
  }

  _hitCtor(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const meshes = [];
    this.roomGroup?.traverse((o) => { if (o.isMesh && o.userData?.pickCtor) meshes.push(o); });
    if (!meshes.length) return null;
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const ud = hit.object.userData || {};
    return {
      ctorKind: ud.ctorKind,
      ctorId: ud.ctorId,
      point: hit.point.clone(),
      object: hit.object,
      ud,
    };
  }

  setGridVisible(v) {
    this.showGrid = !!v;
    if (this.room) this._rebuildMeasureOverlay(this.room);
  }

  setDimsVisible(v) {
    this.showDims = !!v;
    if (this.room) this._rebuildMeasureOverlay(this.room);
  }

  setDimMode(mode) {
    this.dimMode = mode === 'none' || mode === 'all' ? mode : 'basic';
    this.showDims = this.dimMode !== 'none';
    if (this.room) this._rebuildMeasureOverlay(this.room);
  }

  setLayers(layers) {
    this.layers = { ...this.layers, ...(layers || {}) };
    this._applyLayers();
  }

  _applyLayers() {
    const L = this.layers || {};
    if (this.floorMesh) this.floorMesh.visible = L.floor !== false;
    if (this.ceilMesh) this.ceilMesh.visible = L.ceiling !== false && (this.room?.show || 'auto') !== 'floor';
    for (const wg of Object.values(this.wallGroups || {})) {
      if (wg) wg.visible = L.walls !== false && (this.room?.show || 'auto') !== 'floor' && (this.room?.show || 'auto') !== 'hide';
    }
    if (this.furnGroup) this.furnGroup.visible = L.furniture !== false;
    if (this.fixGroup) {
      const wantFix = this._fixturesWanted !== false;
      this.fixGroup.visible = wantFix && (L.appliances !== false || L.communications !== false);
      this.fixGroup.traverse((o) => {
        const kind = o.userData?.fixtureKind;
        if (!kind) return;
        if (kind === 'socket' || kind === 'pipe') o.visible = L.communications !== false;
        else o.visible = L.appliances !== false;
      });
    }
  }

  /** Сетка пола (шаг 100/500) + внешние размеры комнаты в 3D — как план/сцена eKitchen. */
  _rebuildMeasureOverlay(room) {
    const g = this.measureGroup;
    g.traverse((o) => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
    });
    g.clear();
    if (!room) return;
    const L = +room.length || 4000;
    const D = +room.depth || 3500;
    const H = +room.height || 2700;
    const y = 1.5;

    if (this.showGrid) {
      ensureAdvancedFields(room);
      const poly = room.planFloor || [];
      const minor = [], major = [];
      const step = 100, majorEvery = 500;
      const inside = (x, z) => poly.length < 3 || pointInPolygon(x, z, poly);
      for (let x = 0; x <= L + 0.1; x += step) {
        for (let z = 0; z < D; z += step) {
          const z2 = Math.min(D, z + step);
          if (!inside(x, (z + z2) / 2)) continue;
          const pts = [x, y, z, x, y, z2];
          if (Math.round(x) % majorEvery === 0) major.push(...pts);
          else minor.push(...pts);
        }
      }
      for (let z = 0; z <= D + 0.1; z += step) {
        for (let x = 0; x < L; x += step) {
          const x2 = Math.min(L, x + step);
          if (!inside((x + x2) / 2, z)) continue;
          const pts = [x, y, z, x2, y, z];
          if (Math.round(z) % majorEvery === 0) major.push(...pts);
          else minor.push(...pts);
        }
      }
      const mk = (arr, color, op) => {
        if (!arr.length) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
          color, transparent: true, opacity: op, depthWrite: false,
        }));
        line.renderOrder = -1;
        g.add(line);
      };
      mk(minor, 0xc8c2b6, 0.45);
      mk(major, 0x9e9588, 0.75);
      // контур плана (не AABB)
      try {
        const segs = roomWallSegments(room);
        const edgePts = [];
        for (const s of segs) edgePts.push(s.x1, y + 0.5, s.z1, s.x2, y + 0.5, s.z2);
        if (edgePts.length) {
          const edge = new THREE.BufferGeometry();
          edge.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3));
          g.add(new THREE.LineSegments(edge, new THREE.LineBasicMaterial({ color: 0x5c6570 })));
        }
      } catch (_) { /* */ }
    }

    const dimMode = this.dimMode || (this.showDims ? 'basic' : 'none');
    if (dimMode !== 'none') {
      const off = 180;
      const dy = 25;
      this._dimLine(g, 0, dy, -off, L, dy, -off, `${Math.round(L)}`, true);
      this._dimLine(g, -off, dy, 0, -off, dy, D, `${Math.round(D)}`, false);
      this._dimLine(g, -off * 0.55, 0, -off * 0.55, -off * 0.55, H, -off * 0.55, `${Math.round(H)}`, false);
      // три длины на каждой стене: пол / yRef / потолок — отрезки с засечками
      try {
        const segs3 = roomWallSegments3D(room);
        const yRef = +room.yRef || 900;
        for (const s of segs3) {
          const letter = edgeLetter(s.edgeIndex ?? 0);
          // наружу от стены, чтобы не лежало на плоскости
          const ox = s.nx * 80, oz = s.nz * 80;
          this._dimSeg(
            g,
            s.a0.x + ox, 50, s.a0.z + oz,
            s.b0.x + ox, 50, s.b0.z + oz,
            `${letter} ${Math.round(s.lenFloor)}`,
          );
          this._dimSeg(
            g,
            s.aR.x + ox, yRef, s.aR.z + oz,
            s.bR.x + ox, yRef, s.bR.z + oz,
            `${Math.round(s.lenRef)}`,
          );
          const yC = ((s.hA || H) + (s.hB || H)) / 2;
          this._dimSeg(
            g,
            s.a1.x + ox, yC, s.a1.z + oz,
            s.b1.x + ox, yC, s.b1.z + oz,
            `${Math.round(s.lenCeil)}`,
          );
        }
      } catch (_) { /* */ }
      if (dimMode === 'all') {
        for (let x = 500; x < L; x += 500) this._dimTickLabel(g, String(x), x, dy + 8, -off * 0.55);
        for (let z = 500; z < D; z += 500) this._dimTickLabel(g, String(z), -off * 0.55, dy + 8, z);
        for (const op of room.openings || []) {
          const w = +op.width || 0;
          const yMid = (+op.sill || 0) + (+op.height || 0) / 2;
          let x1, z1, x2, z2;
          if (op.wall === 'back') {
            x1 = +op.offset; z1 = -60; x2 = x1 + w; z2 = -60;
          } else if (op.wall === 'front') {
            x1 = L - (+op.offset) - w; z1 = D + 60; x2 = x1 + w; z2 = D + 60;
          } else if (op.wall === 'left') {
            x1 = -60; z1 = +op.offset; x2 = -60; z2 = z1 + w;
          } else {
            x1 = L + 60; z1 = D - (+op.offset) - w; x2 = L + 60; z2 = z1 + w;
          }
          this._dimSeg(g, x1, yMid, z1, x2, yMid, z2, `${op.type === 'door' ? 'Д' : 'О'} ${w}`);
        }
      }
    }
    g.visible = this.showGrid || dimMode !== 'none';
  }

  /** Размерный отрезок: линия + засечки на концах + подпись в середине. */
  _dimSeg(g, x1, y1, z1, x2, y2, z2, text) {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz) || 1;
    // единичный перпендикуляр для засечек (в плоскости, ближайшей к экрану)
    let px, py, pz;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > Math.abs(dz)) {
      // почти вертикаль — засечка в XZ
      px = 1; py = 0; pz = 0;
    } else {
      // горизонталь в XZ — перпендикуляр в плане + чуть вверх
      const hx = -dz / len, hz = dx / len;
      px = hx; py = 0.35; pz = hz;
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl; py /= pl; pz /= pl;
    }
    const tick = 45;
    const positions = [
      x1, y1, z1, x2, y2, z2,
      x1 - px * tick, y1 - py * tick, z1 - pz * tick,
      x1 + px * tick, y1 + py * tick, z1 + pz * tick,
      x2 - px * tick, y2 - py * tick, z2 - pz * tick,
      x2 + px * tick, y2 + py * tick, z2 + pz * tick,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0x1f6feb, depthTest: true, transparent: true, opacity: 0.95,
    })));
    this._dimLabel(g, text, (x1 + x2) / 2, (y1 + y2) / 2 + 25, (z1 + z2) / 2);
  }

  _dimLine(g, x1, y1, z1, x2, y2, z2, text, alongX) {
    void alongX;
    this._dimSeg(g, x1, y1, z1, x2, y2, z2, text);
  }

  _dimTickLabel(g, text, x, y, z) {
    const div = document.createElement('div');
    div.className = 'mlabel dim-tick';
    div.textContent = text;
    const lab = new CSS2DObject(div);
    lab.position.set(x, y, z);
    g.add(lab);
  }

  setWallLettersVisible(v) {
    if (this.room) this.room.showWallLetters = !!v;
    if (!this.wallLetterGroup) return;
    this.wallLetterGroup.visible = !!v;
    // CSS2DRenderer не учитывает visible родителя — прячем DOM-узлы явно
    this.wallLetterGroup.traverse((o) => {
      if (!o.isCSS2DObject) return;
      o.visible = !!v;
      if (o.element) o.element.style.display = v ? '' : 'none';
    });
  }

  _dimLabel(g, text, x, y, z) {
    const div = document.createElement('div');
    div.className = 'mlabel dim';
    div.textContent = text + ' мм';
    const lab = new CSS2DObject(div);
    lab.position.set(x, y, z);
    g.add(lab);
  }

  _addOpening(g, op, L, D, H) {
    if (!op.id) return;
    const fillCol = op.color != null ? +op.color : (op.type === 'door' ? 0x6b4f2a : 0x9ec9e8);
    const frameCol = op.frameColor != null ? +op.frameColor : 0x8b7355;
    const frameMat = new THREE.MeshStandardMaterial({ color: frameCol, roughness: 0.7 });
    frameMat.emissive = new THREE.Color(0x000000);
    frameMat.emissiveIntensity = 0;
    const glassMat = new THREE.MeshStandardMaterial({
      color: fillCol,
      transparent: op.type === 'window',
      opacity: op.type === 'window' ? 0.45 : 1,
      roughness: 0.2,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    glassMat.emissive = new THREE.Color(0x000000);
    glassMat.emissiveIntensity = 0;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(op.width, op.height), glassMat);
    const off = (+op.offset || 0) + (+op.width || 0) / 2;
    const y = (+op.sill || 0) + (+op.height || 0) / 2;
    let placed = false;
    let edgeIndex = op.edgeIndex != null ? +op.edgeIndex : null;
    if (edgeIndex != null && this.room) {
      try {
        const segs = roomWallSegments(this.room);
        const s = segs[edgeIndex];
        if (s && s.len > 1) {
          const tx = (s.x2 - s.x1) / s.len, tz = (s.z2 - s.z1) / s.len;
          mesh.position.set(s.x1 + tx * off, y, s.z1 + tz * off);
          mesh.rotation.y = Math.atan2(-s.nx, -s.nz);
          placed = true;
        }
      } catch { /* fallback ниже */ }
    }
    if (!placed) {
      if (op.wall === 'back') mesh.position.set(off, y, 2);
      else if (op.wall === 'front') { mesh.position.set(L - off, y, D - 2); mesh.rotation.y = Math.PI; }
      else if (op.wall === 'left') { mesh.position.set(2, y, off); mesh.rotation.y = Math.PI / 2; }
      else { mesh.position.set(L - 2, y, D - off); mesh.rotation.y = -Math.PI / 2; }
    }
    const ctorUd = {
      pickCtor: true, ctorKind: 'opening', ctorId: op.id,
      edgeIndex, wall: op.wall, offset: +op.offset || 0, width: +op.width || 0,
      sill: +op.sill || 0, height: +op.height || 0,
    };
    mesh.userData = { ...ctorUd };
    g.add(mesh);
    const fw = 40;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(op.width + fw, op.height + fw, 30), frameMat);
    frame.position.copy(mesh.position);
    frame.rotation.copy(mesh.rotation);
    frame.translateZ(-8);
    frame.userData = { ...ctorUd };
    g.add(frame);
    this.ctorOpeningMeshes.set(op.id, { mesh, frame });
  }

  render(build, sel, fixtures = []) {
    this.build = build;
    this.sel = sel || this.sel;
    this.fixtures = fixtures;
    for (const grp of this.modGroups.values()) grp.traverse((o) => { if (o.element) o.element.remove(); });
    this.furnGroup.clear();
    this.fixGroup.clear();
    this.modGroups.clear();
    this.doorPivots.clear();
    const issueMods = new Set((build.issues || []).filter((i) => i.level === 'error').map((i) => i.moduleId));

    for (const it of build.items) {
      const m = it.module;
      if (!m) continue;
      const root = new THREE.Group();
      root.position.set(+m.x, 0, +m.z);
      root.rotation.y = ((+m.rot || 0) * Math.PI) / 180;
      root.userData.moduleId = m.id;

      const mid = m.id;
      const modSel = sel.moduleId === mid;
      const body = new THREE.Group();
      root.add(body);
      const followers = [];

      const lines = this.lineMode;
      for (const p of it.panels) {
        if (p.role === 'front' && this.frontMode === 'hide' && !lines) continue;
        const box = panelBox(p);
        const md = p.color != null ? p : (MATERIALS[p.mat] || { color: 0xcccccc });
        const ghost = !lines && ((p.role === 'front' && this.frontMode === 'ghost') || !!p.glass);
        const panelSel = modSel && sel.panelKey === p.key;
        const mat = lines
          ? this._lineFillMat()
          : new THREE.MeshStandardMaterial({
            color: md.color, roughness: md.metal ? 0.35 : md.gloss ? 0.25 : 0.75, metalness: md.metal ? 0.7 : 0,
            transparent: ghost, opacity: ghost ? (p.glass ? 0.4 : 0.25) : 1, depthWrite: !ghost,
          });
        if (!lines) {
          if (panelSel) { mat.emissive = new THREE.Color(0x2a7fff); mat.emissiveIntensity = 0.55; }
          else if (modSel) { mat.emissive = new THREE.Color(0x1d5fbf); mat.emissiveIntensity = 0.18; }
          else if (issueMods.has(mid)) { mat.emissive = new THREE.Color(0xff2a2a); mat.emissiveIntensity = 0.3; }
        }

        if (p.role === 'top' && !lines) {
          const cut = this._countertopWithHoles(p, box, m, fixtures, mat);
          if (cut) { body.add(cut); continue; }
        }

        // Фурнитура (петли Sensys, ножки, навесы) — процедурная модель внутри gab .b3d.
        let drawBox = box;
        const isMetal = (p.role === 'metal' || p.metal) && !p.openable;
        const pn = (p.name || '').toLowerCase();
        if (isMetal && /ножк|цокол/.test(pn) && !/креплен|заглуш/.test(pn)) {
          const floor = +m.p.elev || 0;
          if (drawBox.y2 > floor) drawBox = { ...drawBox, y2: floor };
          if (drawBox.y2 - drawBox.y1 < 40) drawBox = { ...drawBox, y1: floor - 100, y2: floor };
        }
        if (isMetal) {
          const hwMat = lines ? this._lineWireMat() : mat;
          const hw = buildHardwareMesh({ ...p, moduleId: mid }, drawBox, hwMat, {
            width: +m.p.width,
            carcassBottom: +m.p.elev || 0,
          });
          if (hw) {
            if (lines) this._toLineWire(hw);
            body.add(hw);
            if (p.follow) followers.push({ objs: [hw], follow: p.follow });
            continue;
          }
        }

        const geo = new THREE.BoxGeometry(drawBox.x2 - drawBox.x1, drawBox.y2 - drawBox.y1, drawBox.z2 - drawBox.z1);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = !lines;
        const cx = (drawBox.x1 + drawBox.x2) / 2, cy = (drawBox.y1 + drawBox.y2) / 2, cz = (drawBox.z1 + drawBox.z2) / 2;
        mesh.userData = { moduleId: mid, panelKey: p.key, pick: true, openable: p.openable, hinge: p.hinge };
        const edgeMat = lines
          ? this._lineEdgeMat()
          : new THREE.LineBasicMaterial({ color: 0x2b2f36, transparent: true, opacity: 0.4 });

        if (p.openable === 'door') {
          const pivot = new THREE.Group();
          pivot.userData = { moduleId: mid, panelKey: p.key, openable: 'door' };
          const hx = p.hinge === 'right' ? drawBox.x2 : drawBox.x1;
          pivot.position.set(hx, cy, cz);
          mesh.position.set(cx - hx, 0, 0);
          pivot.add(mesh);
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
          edges.position.copy(mesh.position);
          edges.userData = { moduleId: mid, panelKey: p.key, pick: true, openable: 'door' };
          pivot.add(edges);
          body.add(pivot);
          const animKey = `${mid}:${p.key}`;
          const target = p.openAmt || 0;
          if (!this.openAnim.has(animKey)) this.openAnim.set(animKey, target);
          this.doorPivots.set(animKey, { pivot, hinge: p.hinge, kind: 'door', target });
          this._applyDoorPose(animKey);
        } else if (p.openable === 'drawer') {
          const pivot = new THREE.Group();
          pivot.userData = { moduleId: mid, panelKey: p.key, openable: 'drawer' };
          pivot.position.set(0, 0, 0);
          mesh.position.set(cx, cy, cz);
          pivot.add(mesh);
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
          edges.position.copy(mesh.position);
          pivot.add(edges);
          body.add(pivot);
          const animKey = `${mid}:${p.key}`;
          const target = p.openAmt || 0;
          if (!this.openAnim.has(animKey)) this.openAnim.set(animKey, target);
          this.doorPivots.set(animKey, { pivot, kind: 'drawer', travel: p.openTravel || 400, baseZ: 0, meshZ: cz, target });
          this._applyDoorPose(animKey);
        } else {
          mesh.position.set(cx, cy, cz);
          body.add(mesh);
          // Контур: в режиме линий — у всего (как IndexedFaceSetWithEdges); иначе не у мелкой фурнитуры
          const drawEdges = lines || (p.role !== 'metal' && !p.metal);
          let edges = null;
          if (drawEdges) {
            edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat.clone());
            if (!lines && panelSel) {
              edges.material.color.setHex(0x0a4fd6);
              edges.material.opacity = 1;
            }
            edges.position.copy(mesh.position);
            body.add(edges);
          }
          if (p.follow) followers.push({ objs: edges ? [mesh, edges] : [mesh], follow: p.follow });
        }
      }
      // Детали ящика/двери (короб, направляющие, ручки) переезжают в узел своего фасада
      for (const f of followers) {
        const dp = this.doorPivots.get(`${mid}:${f.follow}`);
        if (!dp) continue;
        for (const o of f.objs) {
          body.remove(o);
          if (o.userData) {
            o.userData.openable = dp.kind;
            o.userData.panelKey = f.follow;
            o.userData.moduleId = mid;
            o.userData.pick = !!o.isMesh;
          }
          if (dp.kind === 'door') o.position.sub(dp.pivot.position);
          dp.pivot.add(o);
        }
      }

      for (const e of it.extras) {
        if (e.type === 'handle' && this.frontMode !== 'show' && !lines) continue;
        const mat = lines
          ? this._lineFillMat()
          : new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.3 });
        const edgeMatEx = lines ? this._lineEdgeMat() : null;
        let mesh;
        if (e.type === 'handle') {
          const gw = e.vertical ? 12 : 140, gh = e.vertical ? 140 : 12, gd = 25;
          const geo = new THREE.BoxGeometry(gw, gh, gd);
          mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(e.x, e.y, e.z + 12);
          mesh.userData = { moduleId: mid, panelKey: e.panelKey, pick: true, openable: e.panelKey ? 'door' : undefined };
          const attach = (parent) => {
            parent.add(mesh);
            if (edgeMatEx) {
              const ed = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMatEx);
              ed.position.copy(mesh.position);
              parent.add(ed);
            }
          };
          if (e.panelKey) {
            const animKey = `${mid}:${e.panelKey}`;
            const dp = this.doorPivots.get(animKey);
            if (dp?.kind === 'door') {
              const p = it.panels.find((q) => q.key === e.panelKey);
              const box = panelBox(p);
              const hx = p.hinge === 'right' ? box.x2 : box.x1;
              const cy = (box.y1 + box.y2) / 2, cz = (box.z1 + box.z2) / 2;
              mesh.position.set(e.x - hx, e.y - cy, e.z + 12 - cz);
              attach(dp.pivot);
              continue;
            }
            if (dp?.kind === 'drawer') {
              mesh.position.set(e.x, e.y, e.z + 12);
              attach(dp.pivot);
              continue;
            }
          }
          if (edgeMatEx) {
            const ed = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMatEx);
            ed.position.copy(mesh.position);
            body.add(mesh, ed);
            continue;
          }
        } else if (e.type === 'rod') {
          mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(12, 12, e.x2 - e.x1, 16),
            lines ? this._lineWireMat() : mat,
          );
          mesh.rotation.z = Math.PI / 2;
          mesh.position.set((e.x1 + e.x2) / 2, e.y, e.z);
        }
        if (mesh) body.add(mesh);
      }

      if (!it.virtual && !lines) {
        const div = document.createElement('div');
        div.className = 'mlabel' + (modSel ? ' sel' : '') + (issueMods.has(mid) ? ' err' : '');
        div.textContent = `${it.index} · ${m.p.width}`;
        const lab = new CSS2DObject(div);
        lab.position.set(m.p.width / 2, (+m.p.elev || 0) + +m.p.height + 60, +m.p.depth);
        root.add(lab);
      }

      this.furnGroup.add(root);
      this.modGroups.set(mid, root);
    }

    this.fixGroup.visible = this.lineMode ? true : (this._fixturesWanted !== false);
    for (const f of fixtures) {
      const mesh = buildFixtureMesh(THREE, f);
      if (!mesh) continue;
      const fk = FIXTURE_CATALOG[f.type]?.kind || 'appliance';
      mesh.userData = { ...(mesh.userData || {}), fixtureKind: fk, fixtureId: f.id };
      mesh.traverse((o) => { if (o.isMesh) o.userData = { ...o.userData, fixtureKind: fk, fixtureId: f.id }; });
      if (this.lineMode) {
        this._toLineWire(mesh);
      } else if (sel.fixtureId === f.id) {
        mesh.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material = o.material.clone();
            o.material.emissive = new THREE.Color(0x2a7fff);
            o.material.emissiveIntensity = 0.4;
          }
        });
      }
      this.fixGroup.add(mesh);
    }
    this._applyLayers();
    this._rebuildDocks();
  }

  // Столешница с вырезами под мойки, лежащие на ней. Столешница всегда без поворота (rot = 0).
  _countertopWithHoles(p, box, root, fixtures, mat) {
    const holes = [];
    for (const f of fixtures) {
      const def = FIXTURE_CATALOG[f.type];
      if (def?.kind !== 'sink') continue;
      if (Math.abs(+f.elev - box.y2) > 5) continue;
      const lx = +f.x - +root.x, lz = +f.z - +root.z;
      const rot = ((+f.rot || 0) % 180 + 180) % 180;
      const [w, d] = rot === 90 ? [def.d, def.w] : [def.w, def.d];
      const hw = w / 2 - SINK_RIM, hd = d / 2 - SINK_RIM;
      if (lx - hw < box.x1 || lx + hw > box.x2 || lz - hd < box.z1 || lz + hd > box.z2) continue;
      holes.push([lx - hw, lz - hd, lx + hw, lz + hd]);
    }
    if (!holes.length) return null;
    const shape = new THREE.Shape();
    shape.moveTo(box.x1, box.z1); shape.lineTo(box.x2, box.z1); shape.lineTo(box.x2, box.z2); shape.lineTo(box.x1, box.z2); shape.closePath();
    for (const [x1, z1, x2, z2] of holes) {
      const h = new THREE.Path();
      h.moveTo(x1, z1); h.lineTo(x1, z2); h.lineTo(x2, z2); h.lineTo(x2, z1); h.closePath();
      shape.holes.push(h);
    }
    const t = box.y2 - box.y1;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, mat);
    // Поворот на +90° вокруг X кладёт контур (x, z) в плоскость XZ, выдавливание уходит вниз
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = box.y2;
    mesh.castShadow = true;
    mesh.userData = { moduleId: root.id, panelKey: p.key, pick: true };
    return mesh;
  }

  _applyDoorPose(key) {
    const info = this.doorPivots.get(key);
    if (!info) return;
    const cur = this.openAnim.get(key) ?? info.target ?? 0;
    if (info.kind === 'door') {
      // Поворот вокруг +Y уводит +X в ?Z (внутрь корпуса), поэтому левой петле нужен отрицательный угол
      info.pivot.rotation.y = (info.hinge === 'right' ? 1 : -1) * cur * (Math.PI / 2) * 0.95;
    } else if (info.kind === 'drawer') {
      info.pivot.position.z = cur * (info.travel || 400);
    }
  }

  _animateDoors(dt) {
    // Экспоненциальное сглаживание ~0.45 с до почти полного открытия
    const k = 1 - Math.exp(-dt * 5.5);
    for (const [key, info] of this.doorPivots) {
      let cur = this.openAnim.get(key) ?? 0;
      const tgt = info.target ?? 0;
      cur += (tgt - cur) * k;
      if (Math.abs(cur - tgt) < 0.0008) cur = tgt;
      this.openAnim.set(key, cur);
      this._applyDoorPose(key);
    }
  }

  /**
   * Режимы камеры eKitchen:
   * walk — изнутри (игровой стиль), top — сверху, 3d/orbit — изометрия, front — спереди.
   */
  _applyViewControls(navKind) {
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    if (navKind === 'walk') {
      this.controls.enabled = false;
      return;
    }
    this.controls.enabled = true;
    if (navKind === 'top') {
      this.controls.enableRotate = false;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    } else {
      this.controls.enableRotate = true;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    }
  }

  setView(kind) {
    const L = this.room?.length || 4000, D = this.room?.depth || 3500, H = this.room?.height || 2700;
    const t = new THREE.Vector3(L / 2, H / 2.5, D / 2);
    const d = Math.max(L, D, H) * 1.6;
    this.walkDrag = null;
    this._lookPitch = 0;

    // проекции на стены A–D как в BPlanner
    if (/^wall[A-Da-d]$/.test(kind) || /^wall:[A-Da-d]$/.test(kind)) {
      const letter = kind.replace(/^wall:?/i, '').toUpperCase();
      this.navMode = 'orbit';
      this._applyViewControls('orbit');
      const dist = Math.max(L, D) * 0.85;
      const eyeY = H * 0.55;
      if (letter === 'A') {
        this.camera.position.set(L / 2, eyeY, dist);
        this.controls.target.set(L / 2, eyeY * 0.7, 0);
      } else if (letter === 'C') {
        this.camera.position.set(L / 2, eyeY, D - dist);
        this.controls.target.set(L / 2, eyeY * 0.7, D);
      } else if (letter === 'D') {
        this.camera.position.set(dist, eyeY, D / 2);
        this.controls.target.set(0, eyeY * 0.7, D / 2);
      } else {
        this.camera.position.set(L - dist, eyeY, D / 2);
        this.controls.target.set(L, eyeY * 0.7, D / 2);
      }
      this.controls.update();
      this.h.onNavMode?.(`wall${letter}`);
      return;
    }
    const map = { walk: 'walk', inside: 'walk', orbit: 'orbit', '3d': 'orbit', top: 'top', front: 'front' };
    this.navMode = map[kind] || 'orbit';
    this._applyViewControls(this.navMode);

    if (this.navMode === 'walk') {
      this.camera.position.set(L / 2, 1600, D - 200);
      this.camera.lookAt(L / 2, 1400, 0);
      this.controls.target.set(L / 2, 1400, D / 2);
      const eul = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this._lookPitch = eul.x;
    } else if (this.navMode === 'top') {
      this.camera.up.set(0, 1, 0);
      // чуть смещаем по Z, чтобы не Gimbal Lock при взгляде строго вниз
      this.camera.position.set(L / 2, d * 1.15, D / 2 + 0.01);
      this.controls.target.set(L / 2, 0, D / 2);
      this.controls.update();
    } else if (this.navMode === 'front') {
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(L / 2, H / 2.4, D + d * 0.7);
      this.controls.target.copy(t);
      this.controls.update();
    } else {
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(L / 2 + d * 0.4, H * 0.95, D / 2 + d * 0.7);
      this.controls.target.copy(t);
      this.controls.update();
    }
    this.h.onNavMode?.(this.navMode === 'orbit' ? '3d' : this.navMode);
  }

  /** Зум камеры относительно target (factor > 1 — отдалить). */
  zoomCamera(factor = 1.15) {
    if (this.navMode === 'walk') {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.camera.position.addScaledVector(dir, factor > 1 ? -200 : 200);
      return;
    }
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    offset.multiplyScalar(factor);
    // не уходить в target
    if (offset.length() < 400) offset.setLength(400);
    if (offset.length() > 60000) offset.setLength(60000);
    this.camera.position.copy(t).add(offset);
    this.controls.update();
  }

  /** Поворот / наклон камеры вокруг target (градусы). */
  orbitCamera(yawDeg = 0, pitchDeg = 0) {
    if (this.navMode === 'walk') {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-yawDeg * Math.PI) / 180);
      this.camera.quaternion.premultiply(q);
      this._lookPitch = THREE.MathUtils.clamp((this._lookPitch || 0) + (pitchDeg * Math.PI) / 180, -1.2, 1.2);
      const eu = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      eu.x = this._lookPitch;
      this.camera.quaternion.setFromEuler(eu);
      return;
    }
    if (this.navMode === 'top') {
      // сверху — панорамирование target
      const pan = 200;
      this.controls.target.x += (yawDeg > 0 ? -pan : yawDeg < 0 ? pan : 0);
      this.controls.target.z += (pitchDeg > 0 ? -pan : pitchDeg < 0 ? pan : 0);
      this.camera.position.x += (yawDeg > 0 ? -pan : yawDeg < 0 ? pan : 0);
      this.camera.position.z += (pitchDeg > 0 ? -pan : pitchDeg < 0 ? pan : 0);
      this.controls.update();
      return;
    }
    const t = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(t);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= (yawDeg * Math.PI) / 180;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi - (pitchDeg * Math.PI) / 180, 0.12, Math.PI - 0.12);
    offset.setFromSpherical(spherical);
    this.camera.position.copy(t).add(offset);
    this.controls.update();
  }

  _navSpeed() {
    // eKitchen: Shift / Ctrl / Ctrl+Shift ускоряют
    let s = 1;
    if (this.shiftHeld && this.ctrlHeld) s = 4;
    else if (this.ctrlHeld) s = 2.5;
    else if (this.shiftHeld) s = 2;
    return s;
  }

  _updateNav(dt) {
    if (this.mode === 'place' || this.mode === 'placeFixture') return;
    if (this.press?.drag || this.press?.dockClick) return;

    const speed = 1800 * this._navSpeed(); // мм/с
    const turn = 1.4 * this._navSpeed();

    if (this.navMode === 'walk') {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      let mx = 0, mz = 0, yaw = 0, pitch = 0;
      if (this.keysHeld.has('ArrowUp') || this.keysHeld.has('KeyW')) { mx += forward.x; mz += forward.z; }
      if (this.keysHeld.has('ArrowDown') || this.keysHeld.has('KeyS')) { mx -= forward.x; mz -= forward.z; }
      if (this.keysHeld.has('KeyA')) { mx -= right.x; mz -= right.z; }
      if (this.keysHeld.has('KeyD')) { mx += right.x; mz += right.z; }
      if (this.keysHeld.has('ArrowLeft')) yaw += 1;
      if (this.keysHeld.has('ArrowRight')) yaw -= 1;
      if (this.keysHeld.has('Digit3') || this.keysHeld.has('Numpad3') || this.keysHeld.has('PageUp')) pitch += 1;
      if (this.keysHeld.has('Digit4') || this.keysHeld.has('Numpad4') || this.keysHeld.has('PageDown')) pitch -= 1;

      // мышь: смещение от точки нажатия задаёт скорость (как eKitchen)
      if (this.walkDrag) {
        mx += forward.x * this.walkDrag.vz + right.x * this.walkDrag.vx;
        mz += forward.z * this.walkDrag.vz + right.z * this.walkDrag.vx;
      }

      if (mx || mz) {
        const len = Math.hypot(mx, mz) || 1;
        this.camera.position.x += (mx / len) * speed * dt;
        this.camera.position.z += (mz / len) * speed * dt;
      }
      if (yaw) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * turn * dt);
        this.camera.quaternion.premultiply(q);
      }
      if (pitch) {
        this._lookPitch = THREE.MathUtils.clamp(this._lookPitch + pitch * turn * dt, -1.2, 1.2);
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        e.x = this._lookPitch;
        this.camera.quaternion.setFromEuler(e);
      }
      // держим глаза на уровне
      this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, 1200, 1800);
      const L = this.room?.length || 4000, D = this.room?.depth || 3500;
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, 80, L - 80);
      this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, 80, D - 80);
      return;
    }

    if (this.navMode === 'top') {
      // панорама стрелками / WASD
      let dx = 0, dz = 0;
      if (this.keysHeld.has('ArrowLeft') || this.keysHeld.has('KeyA')) dx -= 1;
      if (this.keysHeld.has('ArrowRight') || this.keysHeld.has('KeyD')) dx += 1;
      if (this.keysHeld.has('ArrowUp') || this.keysHeld.has('KeyW')) dz -= 1;
      if (this.keysHeld.has('ArrowDown') || this.keysHeld.has('KeyS')) dz += 1;
      if (this.walkDrag) { dx += this.walkDrag.vx; dz += this.walkDrag.vz; }
      if (dx || dz) {
        const sp = speed * dt;
        this.camera.position.x += dx * sp;
        this.camera.position.z += dz * sp;
        this.controls.target.x += dx * sp;
        this.controls.target.z += dz * sp;
      }
      return;
    }

    // Изометрия / спереди: стрелки крутят камеру вокруг кухни (разные ракурсы)
    if (this.navMode === 'orbit' || this.navMode === 'front') {
      let yaw = 0, pitch = 0, dolly = 0;
      if (this.keysHeld.has('ArrowLeft') || this.keysHeld.has('KeyA')) yaw += 1;
      if (this.keysHeld.has('ArrowRight') || this.keysHeld.has('KeyD')) yaw -= 1;
      if (this.keysHeld.has('ArrowUp') || this.keysHeld.has('KeyW')) pitch += 1;
      if (this.keysHeld.has('ArrowDown') || this.keysHeld.has('KeyS')) pitch -= 1;
      if (this.keysHeld.has('PageUp')) dolly -= 1;
      if (this.keysHeld.has('PageDown')) dolly += 1;
      if (!yaw && !pitch && !dolly) return;
      const tgt = this.controls.target;
      const offset = this.camera.position.clone().sub(tgt);
      const sph = new THREE.Spherical().setFromVector3(offset);
      sph.theta += yaw * turn * dt;
      sph.phi = THREE.MathUtils.clamp(sph.phi - pitch * turn * dt, 0.15, Math.PI - 0.15);
      if (dolly) sph.radius = Math.max(800, sph.radius * (1 + dolly * 0.6 * dt * this._navSpeed()));
      offset.setFromSpherical(sph);
      this.camera.position.copy(tgt).add(offset);
      this.camera.lookAt(tgt);
    }
  }

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _hitFurniture(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const meshes = [];
    this.furnGroup.traverse((o) => { if (o.userData?.pick && o.isMesh) meshes.push(o); });
    this.fixGroup.traverse((o) => { if (o.userData?.pick || o.parent?.userData?.fixtureId) meshes.push(o); });
    return this.ray.intersectObjects(meshes, true)[0] || null;
  }

  // Скрытые стены не должны перехватывать клик: проверяем видимость всей цепочки родителей
  _visible(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

  _hitPlane(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const walls = this.wallMeshes.filter((w) => this._visible(w));
    const planes = [this.floorMesh, ...walls].filter(Boolean);
    const hit = this.ray.intersectObjects(planes, false)[0];
    if (hit) return hit;
    // Помещение скрыто — ставим на плоскость пола
    const pt = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt)) return { point: pt, object: { userData: { plane: 'floor' } } };
    return null;
  }

  // Для объектов: сначала мебель (столешница, корпус), потом пол/стены
  _hitForFixture(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const meshes = [];
    this.furnGroup.traverse((o) => { if (o.userData?.pick && o.isMesh) meshes.push(o); });
    const f = this.ray.intersectObjects(meshes, false)[0];
    if (f && f.object.userData?.moduleId) return { point: f.point, moduleId: f.object.userData.moduleId, wall: null };
    const p = this._hitPlane(e);
    if (!p) return null;
    return { point: p.point, moduleId: null, wall: p.object.userData?.wall || null };
  }

  _fixtureRoot(obj) {
    let o = obj;
    while (o) {
      if (o.userData?.fixtureId) return o;
      o = o.parent;
    }
    return null;
  }

  _dockActive() {
    return this.dockMode || this.ctrlHeld;
  }

  _hitDock(e) {
    if (!this._dockActive() || !this.dockGroup.children.length) return null;
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const meshes = [];
    this.dockGroup.traverse((o) => { if (o.userData?.dock && o.isMesh) meshes.push(o); });
    const hit = this.ray.intersectObjects(meshes, false)[0];
    return hit?.object?.userData?.dock || null;
  }

  setDockMode(on) {
    this.dockMode = !!on;
    this._rebuildDocks();
    this.h.onDockMode?.(this._dockActive());
  }

  _rebuildDocks() {
    while (this.dockGroup.children.length) {
      const o = this.dockGroup.children.pop();
      o.traverse((c) => {
        c.geometry?.dispose?.();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
          else c.material.dispose?.();
        }
        if (c.element) c.element.remove();
      });
    }
    this._dockHotId = null;
    if (!this._dockActive() || this.mode !== 'select') return;
    const moverId = this.sel.moduleId || this.press?.moduleId || null;
    const socks = this.h.dockSockets?.(moverId) || [];
    for (const s of socks) {
      const g = new THREE.Group();
      g.position.set(s.x, s.y, s.z);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1f6feb, emissive: 0x1f6feb, emissiveIntensity: 0.65,
        transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
      });
      // крупная зона попадания + видимый октаэдр
      const hit = new THREE.Mesh(new THREE.SphereGeometry(70, 12, 10), mat.clone());
      hit.material.opacity = 0.18;
      hit.userData.dock = s;
      hit.renderOrder = 19;
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(42, 0), mat);
      mesh.userData.dock = s;
      mesh.renderOrder = 20;
      g.add(hit);
      g.add(mesh);
      const el = document.createElement('div');
      el.className = 'dock-mark';
      el.textContent = s.label || (s.side === 'left' ? '◀' : '▶');
      el.title = `Привязать сюда (${s.side === 'left' ? 'слева' : 'справа'})`;
      const lab = new CSS2DObject(el);
      lab.position.set(0, 50, 0);
      lab.userData.dock = s;
      g.add(lab);
      g.userData.dock = s;
      this.dockGroup.add(g);
    }
  }

  _setDockHot(id) {
    if (this._dockHotId === id) return;
    this._dockHotId = id;
    this.dockGroup.traverse((o) => {
      if (!o.isMesh || !o.userData?.dock) return;
      const on = o.userData.dock.id === id;
      o.material.color.setHex(on ? 0x067647 : 0x1f6feb);
      o.material.emissive.setHex(on ? 0x067647 : 0x1f6feb);
      if (o.geometry?.type !== 'SphereGeometry') o.scale.setScalar(on ? 1.25 : 1);
    });
    this.dockGroup.traverse((o) => {
      if (o.element?.classList) o.element.classList.toggle('hot', o.userData?.dock?.id === id);
    });
  }

  _down(e) {
    if (e.button !== 0 && e.button !== 2) return;
    this.ctrlHeld = e.ctrlKey || e.metaKey;
    this.shiftHeld = e.shiftKey;
    if (this.mode === 'place' || this.mode === 'placeFixture' || this.mode === 'placeCtor') {
      if (e.button !== 0) return;
      this.press = { x: e.clientX, y: e.clientY, placing: true };
      return;
    }

    // ПКМ в режиме «изнутри» — смотреть (yaw/pitch) как мышью в eKitchen
    if (e.button === 2 && this.navMode === 'walk') {
      this.walkLook = { x: e.clientX, y: e.clientY };
      this.controls.enabled = false;
      return;
    }
    if (e.button !== 0) return;

    // Ручки углов стены (пол / yRef / потолок) — до мебели и орбиты
    const wh = this._hitWallHandle(e);
    if (wh?.object?.userData?.wallHandle) {
      const info = { ...wh.object.userData.wallHandle };
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this._wallHandleDrag = info;
      this.press = {
        x: e.clientX, y: e.clientY,
        wallHandle: info,
        drag: true,
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -info.y),
      };
      this.h.onWallHandleDown?.(info);
      this._drawWallHandleBaseline();
      e.preventDefault();
      return;
    }

    // Режим привязки (Ctrl / «Стык»): маркер или клик по хосту — как CTRL в eKitchen
    if (this._dockActive()) {
      const dockHit = this._hitDock(e);
      if (dockHit) {
        const moverId = this.sel.moduleId;
        if (moverId && moverId !== dockHit.hostId && !String(moverId).startsWith('__top')) {
          this.press = { x: e.clientX, y: e.clientY, dock: dockHit, dockClick: true };
          this.controls.enabled = false;
          e.preventDefault();
          return;
        }
      }
      const hitHost = this._hitFurniture(e);
      const hostMid = hitHost?.object?.userData?.moduleId
        || hitHost?.object?.parent?.userData?.moduleId;
      if (
        hostMid && this.sel.moduleId && hostMid !== this.sel.moduleId
        && !String(hostMid).startsWith('__top')
      ) {
        this.press = {
          x: e.clientX, y: e.clientY,
          dockHost: hostMid,
          dockClick: true,
          dockPoint: hitHost.point?.clone?.() || null,
        };
        this.controls.enabled = false;
        e.preventDefault();
        return;
      }
    }

    const hit = this._hitFurniture(e);
    const openHit = this._openableFromObject(hit?.object) || this._findOpenable(e);
    // По фасаду — выбор/открытие, без drag (кроме Shift+drag для сдвига)
    if (openHit && !e.shiftKey) {
      this.press = { x: e.clientX, y: e.clientY, hit, dragging: false, openHit, noDrag: true };
      return;
    }
    this.press = { x: e.clientX, y: e.clientY, hit, dragging: false };
    const ud = hit?.object.userData || {};
    const mid = ud.moduleId || hit?.object.parent?.userData?.moduleId;
    const fix = this._fixtureRoot(hit?.object);
    const ctorHit = (!mid && !fix) ? this._hitCtor(e) : null;

    // Перемещение: Shift+drag по любому модулю ИЛИ drag уже выбранного (как манипулятор eKitchen)
    const canDrag = mid && mid !== '__top' && !String(mid).startsWith('__top')
      && (e.shiftKey || mid === this.sel.moduleId);
    if (canDrag) {
      this.sel = { moduleId: mid, panelKey: null, fixtureId: null, obstacleId: null, openingId: null };
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this.press.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.press.start = hit.point.clone();
      this.press.drag = true;
      this.press.moduleId = mid;
      this.press.axisLock = !!e.shiftKey; // Shift = ортогональ вдоль ряда (ось стены)
      if (this._dockActive()) this._rebuildDocks();
      e.preventDefault();
    } else if (fix && fix.userData.fixtureId === this.sel.fixtureId) {
      this.controls.enabled = false;
      this.press.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.press.start = hit.point.clone();
      this.press.drag = true;
      this.press.fixtureId = fix.userData.fixtureId;
    } else if (ctorHit && (
      (ctorHit.ctorKind === 'obstacle' && (e.shiftKey || ctorHit.ctorId === this.sel.obstacleId))
      || (ctorHit.ctorKind === 'opening' && (e.shiftKey || ctorHit.ctorId === this.sel.openingId))
    )) {
      this.sel = {
        moduleId: null, panelKey: null, fixtureId: null,
        obstacleId: ctorHit.ctorKind === 'obstacle' ? ctorHit.ctorId : null,
        openingId: ctorHit.ctorKind === 'opening' ? ctorHit.ctorId : null,
      };
      this.setRoomSelection(null);
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this.press.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.press.start = ctorHit.point.clone();
      this.press.drag = true;
      this.press.ctorKind = ctorHit.ctorKind;
      this.press.ctorId = ctorHit.ctorId;
      this.press.ctorBase = { ...ctorHit.ud };
      e.preventDefault();
    } else if (this.navMode === 'walk' && !openHit) {
      // ЛКМ по пустому месту — движение камеры (скорость = смещение мыши), как eKitchen
      this.walkDrag = { x0: e.clientX, y0: e.clientY, vx: 0, vz: 0 };
      this.controls.enabled = false;
    }
  }

  _move(e) {
    if (this.mode === 'place' || this.mode === 'placeFixture' || this.mode === 'placeCtor') {
      this._updateGhost(e);
      return;
    }
    if (this.walkLook) {
      const dx = e.clientX - this.walkLook.x;
      const dy = e.clientY - this.walkLook.y;
      this.walkLook.x = e.clientX;
      this.walkLook.y = e.clientY;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.005);
      this.camera.quaternion.premultiply(q);
      this._lookPitch = THREE.MathUtils.clamp(this._lookPitch - dy * 0.005, -1.2, 1.2);
      const eu = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      eu.x = this._lookPitch;
      this.camera.quaternion.setFromEuler(eu);
      return;
    }
    if (this.walkDrag && !this.press?.drag) {
      // смещение от точки нажатия → постоянная скорость, пока кнопка зажата
      this.walkDrag.vx = (e.clientX - this.walkDrag.x0) / 140;
      this.walkDrag.vz = -(e.clientY - this.walkDrag.y0) / 140;
      return;
    }
    if (this._dockActive() && !this.press?.drag) {
      const d = this._hitDock(e);
      this._setDockHot(d?.id || null);
    }
    const pr = this.press;
    if (!pr || !pr.drag) return;
    if (!pr.dragging && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 4) return;
    pr.dragging = true;
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const pt = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(pr.plane, pt)) return;
    if (pr.wallHandle) {
      this.h.onWallHandleDrag?.(pr.wallHandle, pt.x, pt.z);
      // сдвинуть саму ручку визуально
      for (const o of this.wallHandleGroup.children) {
        const ud = o.userData?.wallHandle;
        if (ud && ud.vertIndex === pr.wallHandle.vertIndex && ud.layer === pr.wallHandle.layer) {
          o.position.x = pt.x;
          o.position.z = pt.z;
        }
      }
      return;
    }
    if (pr.moduleId) {
      const m = this.build.items.find((it) => it.module?.id === pr.moduleId)?.module;
      if (!m) return;
      let dx = pt.x - pr.start.x;
      let dz = pt.z - pr.start.z;
      // Shift: только вдоль стены ряда (local +X)
      if (pr.axisLock || e.shiftKey) {
        const a = ((+m.rot || 0) * Math.PI) / 180;
        const alongX = Math.cos(a), alongZ = -Math.sin(a);
        const t = dx * alongX + dz * alongZ;
        dx = t * alongX;
        dz = t * alongZ;
      }
      const nx = +m.x + dx;
      const nz = +m.z + dz;
      let sn = this.h.snap?.(pr.moduleId, nx, nz) || { x: nx, z: nz };
      if (this._dockActive()) {
        const socks = this.h.dockSockets?.(pr.moduleId) || [];
        let best = null, bestD = 120;
        for (const s of socks) {
          if (!s.pose) continue;
          const dd = Math.hypot(s.pose.x - nx, s.pose.z - nz);
          if (dd < bestD) { bestD = dd; best = s; }
        }
        if (best) {
          sn = { x: best.pose.x, z: best.pose.z, rot: best.pose.rot, dock: best };
          this._setDockHot(best.id);
        } else this._setDockHot(null);
      }
      pr.newPos = sn;
      const grp = this.modGroups.get(pr.moduleId);
      if (grp) {
        grp.position.set(sn.x, 0, sn.z);
        if (sn.rot != null) grp.rotation.y = (sn.rot * Math.PI) / 180;
      }
      this.h.onDragging?.(pr.moduleId, sn.x, sn.z);
    } else if (pr.ctorKind === 'obstacle' && pr.ctorId) {
      const base = pr.ctorBase || {};
      const nx = Math.round((+base.x + (pt.x - pr.start.x)) / 10) * 10;
      const nz = Math.round((+base.z + (pt.z - pr.start.z)) / 10) * 10;
      pr.newCtor = { x: nx, z: nz };
      const mesh = this.ctorObstacleMeshes.get(pr.ctorId);
      if (mesh) {
        const w = +base.w || 400, d = +base.d || 400;
        const y0 = +base.y0 || 0, y1 = +base.y1 || 2700;
        mesh.position.set(nx + w / 2, y0 + Math.max(10, y1 - y0) / 2, nz + d / 2);
      }
      this.h.onDraggingCtor?.('obstacle', pr.ctorId, pr.newCtor);
    } else if (pr.ctorKind === 'opening' && pr.ctorId) {
      const base = pr.ctorBase || {};
      let offset = +base.offset || 0;
      let sill = +base.sill || 0;
      try {
        const segs = roomWallSegments(this.room);
        const ei = base.edgeIndex != null ? +base.edgeIndex : 0;
        const s = segs[ei];
        if (s && s.len > 1) {
          const tx = (s.x2 - s.x1) / s.len, tz = (s.z2 - s.z1) / s.len;
          const along = (pt.x - s.x1) * tx + (pt.z - s.z1) * tz;
          const w = +base.width || 900;
          offset = Math.max(0, Math.round(along - w / 2));
          offset = Math.round(offset / 10) * 10;
        }
      } catch (_) { /* */ }
      // вертикаль: Shift — менять подоконник
      if (e.shiftKey) {
        sill = Math.max(0, Math.round((+base.sill + (pt.y - pr.start.y)) / 10) * 10);
      }
      pr.newCtor = { offset, sill };
      const pack = this.ctorOpeningMeshes.get(pr.ctorId);
      if (pack?.mesh) {
        const w = +base.width || 900, h = +base.height || 1400;
        const offC = offset + w / 2;
        const y = sill + h / 2;
        try {
          const segs = roomWallSegments(this.room);
          const s = segs[base.edgeIndex != null ? +base.edgeIndex : 0];
          if (s && s.len > 1) {
            const tx = (s.x2 - s.x1) / s.len, tz = (s.z2 - s.z1) / s.len;
            pack.mesh.position.set(s.x1 + tx * offC, y, s.z1 + tz * offC);
            if (pack.frame) {
              pack.frame.position.copy(pack.mesh.position);
              pack.frame.rotation.copy(pack.mesh.rotation);
              pack.frame.translateZ(-8);
            }
          }
        } catch (_) { /* */ }
      }
      this.h.onDraggingCtor?.('opening', pr.ctorId, pr.newCtor);
    }
  }

  _up(e) {
    this.walkDrag = null;
    this.walkLook = null;
    const pr = this.press;
    this.press = null;
    this.controls.enabled = this.navMode !== 'walk';
    try { this.renderer.domElement.releasePointerCapture?.(e.pointerId); } catch (_) { /* */ }
    if (!pr) return;

    if (pr.dockClick) {
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) <= 10) {
        const mid = this.sel.moduleId;
        if (mid && pr.dock) this.h.onDock?.(mid, pr.dock);
        else if (mid && pr.dockHost) {
          this.h.onDockToHost?.(mid, pr.dockHost, pr.dockPoint?.x, pr.dockPoint?.z);
        }
      }
      this._lastTap = null;
      return;
    }

    if (pr.placing) {
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 6) return;
      if (this.mode === 'place') {
        const hit = this._hitPlane(e);
        if (!hit) return;
        this.h.onPlace?.(hit.point.x, hit.point.z, hit.object.userData.wall || null, hit.point.y, this.placeRot,
          hit.object.userData.edgeIndex ?? null);
      } else if (this.mode === 'placeCtor') {
        const ctor = this.placeCtor;
        if (!ctor) return;
        if (ctor.kind === 'opening') {
          const hit = this._hitRoomPart(e) || (() => {
            const p = this._hitPlane(e);
            if (!p || p.object?.userData?.plane !== 'wall') return null;
            return {
              kind: 'wall',
              edgeIndex: p.object.userData.edgeIndex ?? 0,
              letter: p.object.userData.letter,
              wall: p.object.userData.wall,
              point: p.point.clone(),
              y: p.point.y,
            };
          })();
          if (!hit || hit.kind !== 'wall') {
            this.h.onPlaceCtorHint?.('Кликните по стене, чтобы поставить проём');
            return;
          }
          this.h.onPlaceCtor?.(ctor, hit, this.placeRot);
        } else {
          const hit = this._hitPlane(e);
          if (!hit || hit.object?.userData?.plane !== 'floor') {
            this.h.onPlaceCtorHint?.('Кликните по полу, чтобы поставить конструкцию');
            return;
          }
          this.h.onPlaceCtor?.(ctor, { kind: 'floor', point: hit.point.clone() }, this.placeRot);
        }
      } else {
        const hit = this._hitForFixture(e);
        if (hit) this.h.onPlaceFixture?.(hit, this.placeRot);
      }
      return;
    }

    if (pr.dragging) {
      if (pr.wallHandle) {
        this._wallHandleDrag = null;
        this.h.onWallHandleUp?.(pr.wallHandle);
        this._lastTap = null;
        return;
      }
      if (pr.moduleId && pr.newPos) {
        if (pr.newPos.dock) this.h.onDock?.(pr.moduleId, pr.newPos.dock);
        else this.h.onMove?.(pr.moduleId, pr.newPos.x, pr.newPos.z);
      }
      if (pr.ctorKind === 'obstacle' && pr.ctorId && pr.newCtor) {
        this.h.onMoveObstacle?.(pr.ctorId, pr.newCtor.x, pr.newCtor.z);
      }
      if (pr.ctorKind === 'opening' && pr.ctorId && pr.newCtor) {
        this.h.onMoveOpening?.(pr.ctorId, pr.newCtor.offset, pr.newCtor.sill);
      }
      this._lastTap = null;
      return;
    }
    if (pr.wallHandle) {
      // клик без drag — просто отпустить
      this._wallHandleDrag = null;
      this.setWallHandleBaseline(null);
      this._rebuildWallHandles();
      return;
    }
    if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 4) return;

    const openHit = pr.openHit || this._findOpenable(e);
    const now = performance.now();
    const tap = this._lastTap;
    // Второй клик по тому же фасаду / модулю > открыть (окно 500 мс)
    if (openHit && tap && now - tap.t < 500 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 16
      && tap.moduleId === openHit.moduleId
      && (!tap.panelKey || !openHit.panelKey || tap.panelKey === openHit.panelKey)) {
      this._lastTap = null;
      this.h.onToggleFront?.(openHit.moduleId, openHit.panelKey);
      this.h.onPick?.(openHit.moduleId, openHit.panelKey, null);
      return;
    }
    if (openHit) this._lastTap = { t: now, x: e.clientX, y: e.clientY, ...openHit };
    else this._lastTap = { t: now, x: e.clientX, y: e.clientY, moduleId: null, panelKey: null };

    const fix = pr.hit ? this._fixtureRoot(pr.hit.object) : null;
    if (fix) {
      this.h.onPick?.(null, null, fix.userData.fixtureId);
      return;
    }
    const ud = pr.hit?.object.userData || {};
    const mid = ud.moduleId || openHit?.moduleId || null;
    if (!mid) {
      const ctorHit = this._hitCtor(e);
      if (ctorHit?.ctorId) {
        this.setRoomSelection(null);
        this.setPropFocus(null);
        this.h.onPickCtor?.(ctorHit.ctorKind, ctorHit.ctorId);
        return;
      }
      const roomHit = this._hitRoomPart(e);
      if (roomHit?.kind === 'wall') {
        this.setRoomSelection({ kind: 'wall', edgeIndex: roomHit.edgeIndex, letter: roomHit.letter });
        this.h.onWallSelect?.(roomHit);
        return;
      }
      this.setRoomSelection(null);
      this.setPropFocus(null);
    }
    this.h.onPick?.(mid, ud.panelKey || openHit?.panelKey || null, null);
  }

  _openableFromObject(obj) {
    let o = obj;
    while (o && o !== this.furnGroup) {
      const ud = o.userData || {};
      if (ud.openable && ud.moduleId && ud.panelKey) return { moduleId: ud.moduleId, panelKey: ud.panelKey };
      for (const [key, info] of this.doorPivots) {
        if (info.pivot && o === info.pivot) {
          const i = key.indexOf(':');
          return { moduleId: key.slice(0, i), panelKey: key.slice(i + 1) };
        }
      }
      o = o.parent;
    }
    return null;
  }

  _findOpenable(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const meshes = [];
    this.furnGroup.traverse((o) => { if (o.userData?.pick && o.isMesh) meshes.push(o); });
    const hits = this.ray.intersectObjects(meshes, true);
    for (const hit of hits) {
      const found = this._openableFromObject(hit.object);
      if (found) return found;
    }
    // fallback: любой фасад модуля под курсором
    for (const hit of hits) {
      let mid = hit.object.userData?.moduleId;
      let o = hit.object;
      while (!mid && o) { mid = o.userData?.moduleId; o = o.parent; }
      if (!mid) continue;
      for (const [key, info] of this.doorPivots) {
        if (key.startsWith(mid + ':')) {
          const i = key.indexOf(':');
          return { moduleId: key.slice(0, i), panelKey: key.slice(i + 1) };
        }
      }
    }
    return null;
  }

  _dbl(e) {
    e.preventDefault();
    e.stopPropagation();
    const hit = this._findOpenable(e);
    if (hit) {
      this._lastTap = null;
      this.h.onToggleFront?.(hit.moduleId, hit.panelKey);
    }
  }

  _key(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code) this.keysHeld.add(e.code);
    if (e.key === 'Control' || e.key === 'Meta') {
      this.ctrlHeld = true;
      // в walk Ctrl — ускорение; маркеры стыковки только без стрелок / WASD
      if (!this._navKeysDown()) {
        this._rebuildDocks();
        this.h.onDockMode?.(true);
      }
      return;
    }
    if (e.key === 'Shift') {
      this.shiftHeld = true;
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'PageUp', 'PageDown'].includes(e.code)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'g' || e.key === 'G') {
      this.setDockMode(!this.dockMode);
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      this.placeRot = (this.placeRot + 90) % 360;
      if (this.sel.obstacleId) this.h.onRotateObstacle?.(this.sel.obstacleId, 90);
      else if (this.sel.moduleId) this.h.onRotate?.(this.sel.moduleId, 90);
      if (this.sel.fixtureId) this.h.onRotateFixture?.(this.sel.fixtureId, 90);
    }
    if (e.key === 'o' || e.key === 'O') {
      const mid = this.sel.moduleId;
      if (!mid) return;
      let key = this.sel.panelKey;
      if (!key) {
        for (const k of this.doorPivots.keys()) {
          if (k.startsWith(mid + ':')) { key = k.slice(mid.length + 1); break; }
        }
      }
      if (key) this.h.onToggleFront?.(mid, key);
    }
    if (e.key === 'Escape') {
      this.setMode('select');
      this.h.onCancelPlace?.();
    }
  }

  _navKeysDown() {
    for (const c of this.keysHeld) {
      if (/^Arrow|Key[WASD]|PageUp|PageDown|Digit[34]|Numpad[34]/.test(c)) return true;
    }
    return false;
  }

  _keyup(e) {
    if (e.code) this.keysHeld.delete(e.code);
    if (e.key === 'Control' || e.key === 'Meta') {
      this.ctrlHeld = false;
      this._rebuildDocks();
      this.h.onDockMode?.(false);
    }
    if (e.key === 'Shift') this.shiftHeld = false;
  }

  _updateGhost(e) {
    this.ghostGroup.clear();
    if (this.mode === 'placeFixture') {
      const hit = this._hitForFixture(e);
      if (!hit) return;
      const f = this.h.previewFixture?.(this.placeFixture, hit, this.placeRot);
      if (!f) return;
      const mesh = buildFixtureMesh(THREE, f);
      if (!mesh) return;
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.55;
          o.material.emissive = new THREE.Color(f.moduleId ? 0x1f9d55 : 0x1f6feb);
          o.material.emissiveIntensity = 0.5;
          o.material.depthWrite = false;
        }
      });
      this.ghostGroup.add(mesh);
      return;
    }
    if (this.mode === 'placeCtor' && this.placeCtor) {
      const c = this.placeCtor;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0d9488, transparent: true, opacity: 0.45, depthWrite: false,
      });
      if (c.kind === 'opening') {
        const hit = this._hitRoomPart(e);
        if (!hit || hit.kind !== 'wall') return;
        const w = +c.width || 900, h = +c.height || 2100;
        const sill = +c.sill || 0;
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 80), mat);
        box.position.set(hit.point.x, sill + h / 2, hit.point.z);
        // ориентировать вдоль нормали стены
        const segs = (() => { try { return roomWallSegments(this.room); } catch { return []; } })();
        const seg = segs[hit.edgeIndex];
        if (seg) box.rotation.y = Math.atan2(-seg.nx, -seg.nz);
        this.ghostGroup.add(box);
      } else {
        const hit = this._hitPlane(e);
        if (!hit || hit.object?.userData?.plane !== 'floor') return;
        const w = +c.w || 400, d = +c.d || 400;
        const y0 = +c.y0 || 0, y1 = Math.min(+c.y1 || 2700, this.room?.height || 2700);
        const hh = Math.max(50, y1 - y0);
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
        box.position.set(hit.point.x, y0 + hh / 2, hit.point.z);
        box.rotation.y = (this.placeRot * Math.PI) / 180;
        this.ghostGroup.add(box);
      }
      return;
    }
    const hit = this._hitPlane(e);
    if (!hit) return;
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.35, depthWrite: false });
    let w = 600, d = 560, h = 870;
    if (this.mode === 'place' && this.placeType?.p) {
      w = +this.placeType.p.width; d = +this.placeType.p.depth; h = +this.placeType.p.height;
    } else if (this.mode === 'placeFixture' && this.placeFixture) {
      const def = FIXTURE_CATALOG[this.placeFixture];
      if (def) { w = def.w; d = def.d; h = def.h; }
    }
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    box.position.set(hit.point.x, hit.object.userData.plane === 'floor' ? h / 2 : hit.point.y, hit.point.z);
    box.rotation.y = (this.placeRot * Math.PI) / 180;
    this.ghostGroup.add(box);
  }

  syncOpenTargets(build) {
    for (const it of build.items) {
      if (!it.module) continue;
      for (const p of it.panels) {
        if (!p.openable) continue;
        const key = `${it.module.id}:${p.key}`;
        const info = this.doorPivots.get(key);
        if (info) info.target = p.openAmt || 0;
      }
    }
  }
}
