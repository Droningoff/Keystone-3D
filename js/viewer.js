import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MATERIALS } from './catalog.js?v=20261028m';
import { panelBox, localToWorld } from './model.js?v=20261125m';
import { buildFixtureMesh, FIXTURE_CATALOG, SINK_RIM, fixtureDims, fixtureCenter } from './fixtures.js?v=20261124be';
import { WALL_BY_ID } from './walls.js?v=20261110a';
import {
  roomOutline, roomWallSegments, roomBounds, isAdvanced, ensureAdvancedFields,
  roomWallSegments3D, ceilingHeightAt, planAtHeight, edgeLetter, pointInPolygon,
  isOpenRoom, wallEdgeCount, wallCornerFillPts, levelsWithPlans,
} from './roomGeom.js?v=20261125q';
import { buildHardwareMesh } from './hardware.js?v=20261029j';

/**
 * handlers:
 *  onPick(moduleId|null, panelKey|null, fixtureId|null)
 *  onMove(moduleId, x, z)
 *  onPlace(x, z, wall?)
 *  onToggleFront(moduleId, panelKey)
 *  snap(moduleId, x, z) -> {x,z}
 *  dockSockets(excludeId|null) -> [{id,hostId,side,corner,x,y,z,strip*,pose?,ghost?}]
 *  onDock(moduleId, socket) — пристыковка к маркеру
 *  onRoomPick(part) — { kind:'wall'|'ceiling', edgeIndex?, letter?, point, y }
 *  onRoomContext(part, clientX, clientY)
 *  onPickCtor(kind, id) — kind: 'obstacle'|'opening'
 *  onMoveObstacle(id, x, z)
 *  onMoveOpening(id, offset, sill?)
 *  onDraggingCtor(kind, id, fields) — live обновление полей в props
 *  onMoveFixture(id, {x,z,elev?})
 *  onResizeFixture(id, {w?,d?,h?,elev?})
 *  onPatchModule(id, {x?,z?,rot?,elev?,w?,d?,h?}) — CAD-gizmo модуля
 *  onEditDim(edit, newValueMm) — двойной клик по размеру на сцене
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
    this.roomEdgeHelpers = [];
    this.roomEdgeMats = [];
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
    this.perspCamera = new THREE.PerspectiveCamera(40, 1, 10, 80000);
    this.perspCamera.position.set(2500, 2200, 5500);
    this.orthoCamera = new THREE.OrthographicCamera(-2000, 2000, 1500, -1500, 10, 80000);
    this.camera = this.perspCamera;
    this._wallElev = null; // { edgeIndex, wallW, wallH, midX, midY, midZ, nx, nz }

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
    this.roomEdgeGroup = new THREE.Group(); // окантовка отдельно — видна и в режиме «В линиях»
    this.furnGroup = new THREE.Group();
    this.fixGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this.dockGroup = new THREE.Group();
    this.measureGroup = new THREE.Group(); // сетка + размеры
    this.moduleDimGroup = new THREE.Group(); // размеры модулей W/D/H (как на эскизах)
    this.wallHandleGroup = new THREE.Group(); // интерактивные точки пол/yRef/потолок
    this.wallHandleBaseGroup = new THREE.Group(); // пунктир базового состояния при drag
    this.fixHandleGroup = new THREE.Group(); // ручки растягивания коммуникаций
    this.ctorLineGroup = new THREE.Group(); // конструкции/проёмы в режиме «Линии» (roomGroup скрыт)
    this.tapeGroup = new THREE.Group(); // рулетка: произвольные замеры
    this.tapeMode = false;
    this.tapePending = null; // THREE.Vector3 | null
    this.scene.add(
      this.roomGroup, this.roomEdgeGroup, this.furnGroup, this.fixGroup, this.ghostGroup,
      this.dockGroup, this.measureGroup, this.moduleDimGroup, this.wallHandleGroup, this.wallHandleBaseGroup,
      this.fixHandleGroup, this.ctorLineGroup, this.tapeGroup,
    );
    this._wallHandleBaseline = null;
    this._fixtureById = new Map();
    this.fixMeshes = new Map();

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
    if (this.camera?.isOrthographicCamera && this._wallElev) {
      this._fitWallElevFrustum();
    } else if (this.perspCamera) {
      this.perspCamera.aspect = w / Math.max(1, h);
      this.perspCamera.updateProjectionMatrix();
    }
    for (const m of this.roomEdgeMats || []) m.resolution?.set(w, h);
  }

  /** Активная камера (перспектива ↔ орто для развёртки стены). */
  _useCamera(cam) {
    if (!cam || this.camera === cam) return;
    const t = this.controls?.target?.clone?.() || new THREE.Vector3();
    this.camera = cam;
    if (this.controls) {
      this.controls.object = cam;
      this.controls.target.copy(t);
      this.controls.update();
    }
  }

  _usePerspectiveCamera() {
    this._wallElev = null;
    this._useCamera(this.perspCamera);
    if (this.perspCamera && this.el) {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      this.perspCamera.aspect = w / Math.max(1, h);
      this.perspCamera.updateProjectionMatrix();
    }
  }

  /** Ortho-frustum под габарит стены и аспект вьюпорта (без перспективных искажений). */
  _fitWallElevFrustum() {
    const cam = this.orthoCamera;
    const info = this._wallElev;
    if (!cam || !info) return;
    const w = this.el?.clientWidth || 800;
    const h = this.el?.clientHeight || 600;
    const aspect = w / Math.max(1, h);
    const margin = 1.14;
    const contentW = Math.max(400, (+info.wallW || 4000) * margin);
    const contentH = Math.max(400, (+info.wallH || 2700) * margin);
    let halfW = contentW / 2;
    let halfH = contentH / 2;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.near = 10;
    cam.far = 80000;
    cam.updateProjectionMatrix();
  }

  /**
   * 2D-развёртка стены: ортокамера смотрит перпендикулярно изнутри,
   * горизонталь = вдоль стены, вертикаль = высота.
   */
  _setWallElevationView(edgeIdx) {
    const room = this.room;
    const H = +room?.height || 2700;
    const L = +room?.length || 4000;
    const D = +room?.depth || 3500;
    const segs = room ? roomWallSegments3D(room) : [];
    const s = segs.find((x) => x.edgeIndex === edgeIdx) || segs[edgeIdx];

    let midX; let midZ; let nx; let nz; let wallW;
    if (s) {
      midX = s.midX ?? ((s.a0.x + s.b0.x) / 2);
      midZ = s.midZ ?? ((s.a0.z + s.b0.z) / 2);
      nx = s.nx || 0;
      nz = s.nz || 0;
      wallW = s.lenFloor || s.len || Math.hypot(s.b0.x - s.a0.x, s.b0.z - s.a0.z) || 1000;
    } else {
      const letter = edgeLetter(edgeIdx);
      wallW = (letter === 'A' || letter === 'C') ? L : D;
      nx = 0; nz = 0;
      if (letter === 'A') { midX = L / 2; midZ = 0; nz = -1; }
      else if (letter === 'C') { midX = L / 2; midZ = D; nz = 1; }
      else if (letter === 'D') { midX = 0; midZ = D / 2; nx = -1; }
      else { midX = L; midZ = D / 2; nx = 1; }
    }

    const midY = H / 2;
    this._wallElev = {
      edgeIndex: edgeIdx,
      wallW, wallH: H,
      midX, midY, midZ, nx, nz,
    };

    const cam = this.orthoCamera;
    cam.up.set(0, 1, 0);
    cam.zoom = 1;
    // изнутри комнаты, перпендикулярно стене; дистанция не влияет на масштаб ortho
    const dist = Math.max(800, Math.min(wallW, H) * 0.35 + 600);
    cam.position.set(midX - nx * dist, midY, midZ - nz * dist);
    cam.lookAt(midX, midY, midZ);
    this._fitWallElevFrustum();
    this._useCamera(cam);
    this.controls.target.set(midX, midY, midZ);
    this.controls.minZoom = 0.25;
    this.controls.maxZoom = 6;
    this.controls.screenSpacePanning = true;
    this.controls.update();
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
      if (this.tapeMode) this.setTapeMode(false);
    }
    this.el.style.cursor = mode.startsWith('place') ? 'crosshair' : (this.tapeMode ? 'crosshair' : '');
    this._applyViewControls(this.navMode || 'orbit');
  }

  /** Рулетка: два клика по сцене → расстояние в мм. */
  setTapeMode(on) {
    const next = !!on;
    this.tapeMode = next;
    if (!next) {
      this.tapePending = null;
      this._clearTapePreview();
    } else {
      this.setMode('select');
    }
    this.el.style.cursor = next ? 'crosshair' : '';
    this.h.onTapeMode?.(next);
  }

  clearTapeMeasures() {
    this.tapePending = null;
    this._clearTapePreview();
    this.tapeGroup.traverse((o) => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
    });
    this.tapeGroup.clear();
  }

  _clearTapePreview() {
    const prev = this.tapeGroup.getObjectByName('tapePreview');
    if (prev) {
      prev.traverse((o) => {
        if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
      });
      this.tapeGroup.remove(prev);
    }
  }

  _hitTapePoint(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const meshes = [];
    const push = (root) => {
      if (!root) return;
      root.traverse((o) => {
        if (o.isMesh && this._visible(o) && o.geometry) meshes.push(o);
      });
    };
    push(this.floorMesh);
    for (const w of this.wallMeshes || []) push(w);
    push(this.furnGroup);
    push(this.fixGroup);
    push(this.ctorLineGroup);
    for (const [, m] of this.ctorObstacleMeshes || []) push(m);
    const hit = this.ray.intersectObjects(meshes, true)[0];
    if (hit?.point) return hit.point.clone();
    const pt = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt)) return pt;
    return null;
  }

  _tapeMarker(p, color = 0xeab308) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(28, 12, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    m.position.copy(p);
    m.renderOrder = 999;
    return m;
  }

  _addTapeSegment(a, b) {
    const dist = a.distanceTo(b);
    const g = new THREE.Group();
    g.userData.tape = true;
    const pts = [a.clone(), b.clone()];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({
        color: 0xca8a04, dashSize: 40, gapSize: 24, depthTest: false,
      }),
    );
    line.computeLineDistances();
    line.renderOrder = 998;
    g.add(line, this._tapeMarker(a), this._tapeMarker(b));
    const div = document.createElement('div');
    div.className = 'mlabel tape-dim';
    div.textContent = `${Math.round(dist)} мм`;
    const lab = new CSS2DObject(div);
    lab.position.copy(a).add(b).multiplyScalar(0.5);
    lab.position.y += 40;
    g.add(lab);
    this.tapeGroup.add(g);
    this.h.onTapeMeasure?.(Math.round(dist), a, b);
  }

  _tapeClick(e) {
    const p = this._hitTapePoint(e);
    if (!p) {
      this.h.onTapeHint?.('Кликните по полу, стене или объекту');
      return;
    }
    if (!this.tapePending) {
      this.tapePending = p;
      this._clearTapePreview();
      const preview = new THREE.Group();
      preview.name = 'tapePreview';
      preview.add(this._tapeMarker(p, 0xf59e0b));
      this.tapeGroup.add(preview);
      this.h.onTapeHint?.('Вторая точка — конец отрезка');
      return;
    }
    const a = this.tapePending.clone();
    this.tapePending = null;
    this._clearTapePreview();
    this._addTapeSegment(a, p);
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

  /** Ручки углов выбранной стены — по одной паре на каждый уровень room.levels. */
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
    const H = +room.height || 2700;
    const belts = s.belts?.length ? s.belts : [
      { id: 'floor', a: s.a0, b: s.b0, yA: 0, yB: 0 },
      { id: 'ceil', a: s.a1, b: s.b1, yA: s.hA || H, yB: s.hB || H },
    ];
    const named = { floor: 0x0969da, ref: 0x0d9488, ceil: 0x8b5cf6 };
    const fallback = [0x0969da, 0x0d9488, 0xf59e0b, 0x8b5cf6, 0xec4899, 0x64748b];
    const pts = [];
    belts.forEach((belt, bi) => {
      if (!belt?.a || !belt?.b) return;
      const yA = belt.id === 'floor' ? 40 : (+belt.yA || 0);
      const yB = belt.id === 'floor' ? 40 : (+belt.yB || 0);
      const color = named[belt.id] ?? fallback[bi % fallback.length];
      pts.push({ p: belt.a, y: yA, vertIndex: i0, layer: belt.id, color });
      pts.push({ p: belt.b, y: yB, vertIndex: i1, layer: belt.id, color });
    });
    for (const h of pts) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(55, 14, 14),
        new THREE.MeshBasicMaterial({
          color: h.color,
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

  /** Выделение стены/потолка: мягкая заливка, без обводки внутренних блоков сетки. */
  _applyRoomHighlight() {
    const sel = this.roomSel;
    if (!this._roomSelOverlay) {
      this._roomSelOverlay = new THREE.Group();
      this._roomSelOverlay.name = 'roomSelOverlay';
      this.scene.add(this._roomSelOverlay);
    }
    this._clearRoomSelOverlay();

    for (const m of this.wallMeshes || []) {
      const on = sel?.kind === 'wall' && sel.edgeIndex != null && m.userData.edgeIndex === sel.edgeIndex;
      const apply = (obj) => {
        const mat = obj.material;
        if (mat?.emissive) {
          mat.emissive = new THREE.Color(on ? 0x0d9488 : 0x000000);
          mat.emissiveIntensity = on ? 0.45 : 0;
        }
        // только полупрозрачная заливка — EdgesGeometry показывал бы швы проёмов как «блоки»
        if (on && obj.isMesh && obj.geometry) this._addSelOverlayForMesh(obj, { edges: false });
      };
      if (m.isMesh) apply(m);
      else m.traverse((o) => { if (o.isMesh) apply(o); });
    }
    this.setRoomEdgesVisible(this.room?.showRoomEdges === true);

    const ceilOn = sel?.kind === 'ceiling' && this.ceilMesh;
    if (this.ceilMesh?.material?.emissive) {
      this.ceilMesh.material.emissive = new THREE.Color(ceilOn ? 0x0d9488 : 0x000000);
      this.ceilMesh.material.emissiveIntensity = ceilOn ? 0.4 : 0;
    }
    if (ceilOn) this._addSelOverlayForMesh(this.ceilMesh, { edges: false });
  }

  _addSelOverlayForMesh(src, opts = {}) {
    if (!src?.geometry || !this._roomSelOverlay) return;
    src.updateWorldMatrix(true, false);
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.28,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    const fill = new THREE.Mesh(src.geometry.clone(), fillMat);
    fill.applyMatrix4(src.matrixWorld);
    fill.renderOrder = 10;
    this._roomSelOverlay.add(fill);

    if (opts.edges === false) return;
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
  }

  _hitRoomPart(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const targets = [...(this.wallMeshes || [])];
    if (this.ceilMesh) targets.push(this.ceilMesh);
    const hits = this.ray.intersectObjects(targets, true);
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
      // окантовка комнаты — отдельная группа, оставляем если включена
      this.setRoomEdgesVisible(this.room?.showRoomEdges === true);
    } else if (this._savedLight) {
      this.hemi.intensity = this._savedLight.hemi || 0.55;
      this.sun.intensity = this._savedLight.sun || 1.2;
      this.fill.intensity = this._savedLight.fill || 0.35;
      this.accent.intensity = this._savedLight.accent || 0;
      this._savedLight = null;
      if (this.ceilingGroup) this.ceilingGroup.visible = true;
      this._updateWallVisibility();
      this.setRoomEdgesVisible(this.room?.showRoomEdges === true);
    }
    if (this.build) this.render(this.build, this.sel, this.fixtures || []);
    // setRoom вызывается из render/refresh не всегда до lineMode — обновить каркас конструкций
    if (this.room) {
      // openings/obstacles уже в maps после последнего setRoom
      this._rebuildCtorLineOverlay();
    }
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
      if (!o.isMesh || !o.geometry) return;
      o.material = this._lineFillMat();
      o.castShadow = false;
      o.receiveShadow = false;
      // чёрный контур поверх почти невидимой заливки (как у мебели)
      if (!o.userData._lineEdges) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 20), this._lineEdgeMat());
        edges.userData = { ...(o.userData || {}), lineEdge: true };
        o.add(edges);
        o.userData._lineEdges = true;
      }
    });
  }

  /**
   * В режиме «Линии» roomGroup скрыт — конструкции и проёмы рисуем отдельно чёрным каркасом.
   */
  _rebuildCtorLineOverlay() {
    const g = this.ctorLineGroup;
    if (!g) return;
    g.clear();
    if (!this.lineMode) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const addWorldEdges = (src) => {
      if (!src) return;
      src.updateWorldMatrix(true, true);
      src.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const fill = new THREE.Mesh(o.geometry, this._lineFillMat());
        o.matrixWorld.decompose(fill.position, fill.quaternion, fill.scale);
        fill.userData = { ...(o.userData || {}) };
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 20), this._lineEdgeMat());
        o.matrixWorld.decompose(edges.position, edges.quaternion, edges.scale);
        edges.userData = { ...(o.userData || {}) };
        g.add(fill, edges);
      });
    };
    for (const [, mesh] of this.ctorObstacleMeshes || []) addWorldEdges(mesh);
    for (const [, pack] of this.ctorOpeningMeshes || []) addWorldEdges(pack?.mesh || pack?.root || pack);
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
      // окантовка не в roomGroup — не гасим
      if (this.roomEdgeGroup) this.roomEdgeGroup.visible = this.room?.showRoomEdges === true;
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
    // окантовка вне roomGroup — чистим отдельно
    if (this.roomEdgeGroup) {
      this.roomEdgeGroup.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material.dispose?.();
        }
      });
      this.roomEdgeGroup.clear();
    }
    this.roomEdgeHelpers = [];
    this.roomEdgeMats = [];
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

    this.roomEdgeHelpers = [];
    this.roomEdgeMats = [];

    for (const name of ['back', 'front', 'left', 'right']) {
      const wg = new THREE.Group();
      wg.userData.wall = name;
      g.add(wg);
      this.wallGroups[name] = wg;
    }

    const segs3 = roomWallSegments3D(room);
    const WALL_THICK = Math.max(40, +room.wallThick || 140);
    const nWalls = wallEdgeCount(room);
    const closedWalls = !isOpenRoom(room);
    for (const s of segs3) {
      const wg = this.wallGroups[s.wall] || g;
      const wmat = wallMat.clone();
      if (!wmat.emissive) wmat.emissive = new THREE.Color(0x000000);
      const wc = room.wallColors?.[s.edgeIndex] ?? room.wallColors?.[s.wall];
      if (wc != null) wmat.color = new THREE.Color(wc);
      const edgeOps = (room.openings || []).filter((op) => {
        if (op.edgeIndex != null) return +op.edgeIndex === s.edgeIndex;
        if (op.wall !== s.wall) return false;
        // без edgeIndex — только первое ребро с этим wall, иначе дырки дублируются
        const first = segs3.find((seg) => seg.wall === op.wall);
        return first && first.edgeIndex === s.edgeIndex;
      });
      const wallUd = {
        plane: 'wall', wall: s.wall, edgeIndex: s.edgeIndex, pickPlane: true,
        roomPart: 'wall', letter: edgeLetter(s.edgeIndex),
        // нормаль наружу — нужна для розеток/решёток на косых стенах
        nx: s.nx, nz: s.nz,
      };
      const ei = s.edgeIndex;
      const nSeg = segs3.length;
      const next = segs3[(ei + 1) % nSeg];
      // торцы на стыках не строим; угол вшит в эту же стену (без отдельного «столбика» и без запила 45°)
      const noCapStart = closedWalls || ei > 0;
      const noCapEnd = closedWalls || ei < nWalls - 1;
      const mesh = this._wallWithOpenings(s, edgeOps, wmat, WALL_THICK, {
        noCapStart,
        noCapEnd,
        cornerEnd: noCapEnd ? next : null,
      });
      if (mesh) {
        mesh.userData = { ...mesh.userData, ...wallUd };
        mesh.traverse((o) => {
          if (o.isMesh) o.userData = { ...o.userData, ...wallUd, pickPlane: true };
        });
        wg.add(mesh);
        this.wallMeshes.push(mesh);
      }
    }

    // Окантовка в отдельной группе (видна и при «В линиях»)
    this._buildRoomEdgeOverlay(this.roomEdgeGroup || g, room, segs3, H);
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
    this.setRoomEdgesVisible(room.showRoomEdges === true);

    for (const op of room.openings || []) {
      this._addOpening(this.wallGroups[op.wall] || g, op, L, D, H);
    }
    if ((room.show || 'auto') === 'floor') for (const wg of Object.values(this.wallGroups)) wg.visible = false;

    this._rebuildMeasureOverlay(room);
    this._refreshHighlights();
    this._applyPropFocusHighlight();
    if (!this._wallHandleDrag) this._rebuildWallHandles();
    this._rebuildCtorLineOverlay();
    // после пересборки комнаты — сохранить 2D-развёртку, если она активна
    if (this.navMode === 'wallElev' && this._wallElev?.edgeIndex != null) {
      this._setWallElevationView(this._wallElev.edgeIndex);
    }
  }

  /** Подсветка выбранной конструкции (колонна / проём). */
  _applyCtorHighlight() {
    if (!this._roomSelOverlay) {
      this._roomSelOverlay = new THREE.Group();
      this._roomSelOverlay.name = 'roomSelOverlay';
      this.scene.add(this._roomSelOverlay);
    }
    // не копим Edges-оверлеи: если вызываем вне _applyRoomHighlight — сначала очистить
    if (!this._roomSelBuilding) this._clearRoomSelOverlay();
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
      const root = pack.root || pack.mesh;
      root?.traverse((o) => {
        if (!o.isMesh || !o.material?.emissive) return;
        o.material.emissive.setHex(on ? 0x0d9488 : 0x000000);
        o.material.emissiveIntensity = on ? 0.45 : 0;
      });
      if (on && root) {
        root.traverse((o) => {
          if (o.isMesh && o.geometry && !o.userData?.isSill) this._addSelOverlayForMesh(o);
        });
      }
    }
  }

  _refreshHighlights() {
    this._roomSelBuilding = true;
    try {
      this._applyRoomHighlight();
      this._applyCtorHighlight();
    } finally {
      this._roomSelBuilding = false;
    }
    if (!this._fixHandleDrag) this._rebuildFixtureHandles();
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
    if (this.moduleDimGroup) this.moduleDimGroup.visible = L.furniture !== false;
    if (this.fixGroup) {
      const wantFix = this._fixturesWanted !== false;
      this.fixGroup.visible = wantFix && (L.appliances !== false || L.communications !== false);
      this.fixGroup.traverse((o) => {
        const kind = o.userData?.fixtureKind;
        if (!kind) return;
        if (kind === 'socket' || kind === 'vent' || kind === 'pipe') o.visible = L.communications !== false;
        else o.visible = L.appliances !== false;
      });
    }
  }

  /** Сетка пола (шаг 100/500) + внешние размеры комнаты в 3D — как план/сцена eKitchen. */
  _rebuildMeasureOverlay(room) {
    if (this._dimEdit) return;
    const g = this.measureGroup;
    g.traverse((o) => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
    });
    g.clear();
    // сохранить packs модульных размеров (группа moduleDimGroup)
    const keepMod = new Map();
    if (this._dimPacks) {
      for (const [id, p] of this._dimPacks) {
        if (String(id).startsWith('m')) keepMod.set(id, p);
      }
    }
    this._dimPacks = keepMod;
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
    const dimsOn = room.showWallDims !== false;
    const lens = room.showWallLens || { floor: true, mid: true, ceil: true };
    if (dimMode !== 'none') {
      const off = 180;
      // габарит высоты — у угла реального контура (не в (0,0): иначе уезжает за сцену)
      if (room.showHeightDim !== false) {
        let hx = -off * 0.55, hz = -off * 0.55;
        try {
          const segsH = roomWallSegments3D(room);
          if (segsH.length) {
            const s0 = segsH[0];
            // чуть снаружи угла первой стены
            hx = s0.a0.x + (s0.nx || 0) * off * 0.7 - (s0.nz || 0) * off * 0.15;
            hz = s0.a0.z + (s0.nz || 0) * off * 0.7 + (s0.nx || 0) * off * 0.15;
          } else {
            const bb = roomBounds(room);
            hx = bb.x1 - off * 0.55;
            hz = bb.z1 - off * 0.55;
          }
        } catch (_) { /* */ }
        this._dimTickLabel(g, String(Math.round(H)), hx, H / 2, hz, { kind: 'roomHeight' });
        const hGeo = new THREE.BufferGeometry();
        hGeo.setAttribute('position', new THREE.Float32BufferAttribute([
          hx, 0, hz, hx, H, hz,
        ], 3));
        const hLine = new THREE.Line(hGeo, new THREE.LineDashedMaterial({
          color: 0x111111, dashSize: 40, gapSize: 24, transparent: true, opacity: 0.75,
        }));
        hLine.computeLineDistances();
        g.add(hLine);
      }

      // длины стен: ровно столько пунктиров, сколько уровней в заказе (levelsWithPlans)
      if (dimsOn) try {
        const segs3 = roomWallSegments3D(room);
        const lvls = levelsWithPlans(room);
        const levelIds = new Set(lvls.map((l) => l.id));
        const hasMid = lvls.some((l) => l.id !== 'floor' && l.id !== 'ceil');
        for (const s of segs3) {
          const belts = (s.belts || []).filter((b) => levelIds.has(b.id));
          for (const belt of belts) {
            const id = belt.id || 'mid';
            const isFloor = id === 'floor';
            const isCeil = id === 'ceil';
            const isMid = !isFloor && !isCeil;
            if (isFloor && lens.floor === false) continue;
            if (isCeil && lens.ceil === false) continue;
            if (isMid && (lens.mid === false || !hasMid)) continue;
            const a = belt.a, b = belt.b;
            if (!a || !b) continue;
            const len = Math.round(Math.hypot(b.x - a.x, b.z - a.z));
            if (len < 1) continue;
            // пол: чуть выше плоскости, иначе пунктир тонет в сетке/полу
            let yA = +belt.yA || 0, yB = +belt.yB || 0;
            if (isFloor) { yA += 35; yB += 35; }
            this._wallLenDash(g, a.x, yA, a.z, b.x, yB, b.z, s.nx, s.nz, String(len), {
              kind: 'wallLen', edgeIndex: s.edgeIndex, levelId: id,
            });
          }
        }
        // зазоры проёмов/колонн — только по реальным уровням (без фантомной «столешницы»)
        this._addCtorClearanceDims(g, room, segs3);
      } catch (_) { /* */ }
      if (dimMode === 'all') {
        const dy = 25;
        for (let x = 500; x < L; x += 500) this._dimTickLabel(g, String(x), x, dy + 8, -off * 0.55);
        for (let z = 500; z < D; z += 500) this._dimTickLabel(g, String(z), -off * 0.55, dy + 8, z);
      }
    }
    g.visible = this.showGrid || dimMode !== 'none';
  }

  /**
   * Жирная окантовка: углы — ломаная по поясам; свободные концы открытого контура тоже.
   * Периметр пола/потолка — по реальному контуру. Чуть внутрь — без z-fight.
   */
  _buildRoomEdgeOverlay(parent, room, segs3, H) {
    const pts = [];
    const inset = 12;
    const pushSeg = (ax, ay, az, bx, by, bz) => {
      pts.push(ax, ay, az, bx, by, bz);
    };
    const inward = (nx, nz) => {
      let x = -(nx || 0), z = -(nz || 0);
      const L = Math.hypot(x, z) || 1;
      return { x: (x / L) * inset, z: (z / L) * inset };
    };
    /** Ломаная угла по поясам: side 'a'|'b' */
    const pushCorner = (seg, side, ox, oz) => {
      const belts = seg.belts?.length >= 2 ? seg.belts : [
        { a: seg.a0, b: seg.b0, yA: 0, yB: 0 },
        { a: seg.a1, b: seg.b1, yA: seg.hA || H, yB: seg.hB || H },
      ];
      for (let k = 0; k < belts.length - 1; k++) {
        const lo = belts[k], hi = belts[k + 1];
        const p0 = side === 'b' ? lo?.b : lo?.a;
        const p1 = side === 'b' ? hi?.b : hi?.a;
        const y0 = side === 'b' ? (+lo?.yB || 0) : (+lo?.yA || 0);
        const y1 = side === 'b' ? (+hi?.yB || 0) : (+hi?.yA || 0);
        if (!p0 || !p1) continue;
        pushSeg(p0.x + ox, y0, p0.z + oz, p1.x + ox, y1, p1.z + oz);
      }
    };

    const segs = segs3 || [];
    const n = segs.length;
    const open = isOpenRoom(room);

    // Углы у начала каждой стены (+ стык с предыдущей)
    for (let i = 0; i < n; i++) {
      const cur = segs[i];
      const hasPrev = !open || i > 0;
      const prev = hasPrev ? segs[(i - 1 + n) % n] : null;
      const nrm = prev
        ? inward((cur.nx || 0) + (prev.nx || 0), (cur.nz || 0) + (prev.nz || 0))
        : inward(cur.nx, cur.nz);
      pushCorner(cur, 'a', nrm.x, nrm.z);
    }
    // Свободный конец открытого контура — конец последней стены
    if (open && n > 0) {
      const last = segs[n - 1];
      const nrm = inward(last.nx, last.nz);
      pushCorner(last, 'b', nrm.x, nrm.z);
    }

    // Периметр пола и потолка по поясам
    for (const s of segs) {
      const belts = s.belts?.length ? s.belts : null;
      const floorB = belts?.[0] || { a: s.a0, b: s.b0, yA: 0, yB: 0 };
      const ceilB = belts?.[belts.length - 1] || { a: s.a1, b: s.b1, yA: s.hA || H, yB: s.hB || H };
      const ix = -(s.nx || 0) * inset, iz = -(s.nz || 0) * inset;
      if (floorB.a && floorB.b) {
        pushSeg(floorB.a.x + ix, (+floorB.yA || 0) + 1, floorB.a.z + iz,
          floorB.b.x + ix, (+floorB.yB || 0) + 1, floorB.b.z + iz);
      }
      if (ceilB.a && ceilB.b) {
        pushSeg(ceilB.a.x + ix, (+ceilB.yA || H) - 1, ceilB.a.z + iz,
          ceilB.b.x + ix, (+ceilB.yB || H) - 1, ceilB.b.z + iz);
      }
    }

    if (!pts.length) return;

    const geo = new LineSegmentsGeometry();
    geo.setPositions(pts);
    const lw = Math.max(1, Math.min(16, +room.edgeWidth || 4.5));
    const mat = new LineMaterial({
      color: 0x0f172a,
      linewidth: lw,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      worldUnits: false,
    });
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 600;
    mat.resolution.set(w, h);
    const lines = new LineSegments2(geo, mat);
    lines.computeLineDistances();
    lines.renderOrder = 5;
    lines.visible = false;
    lines.name = 'roomEdgeOverlay';
    parent.add(lines);
    this.roomEdgeHelpers.push(lines);
    this.roomEdgeMats.push(mat);
  }

  /** Толщина окантовки (px) без полной пересборки комнаты */
  setRoomEdgeWidth(px) {
    const lw = Math.max(1, Math.min(16, +px || 4.5));
    if (this.room) this.room.edgeWidth = lw;
    for (const m of this.roomEdgeMats || []) {
      m.linewidth = lw;
      m.needsUpdate = true;
    }
  }

  /** Длина стены / зазор: тонкий пунктир + подпись. edit — мета для dblclick. */
  _wallLenDash(g, x1, y1, z1, x2, y2, z2, nx, nz, text, edit = null) {
    // внутрь комнаты + без depthTest — иначе линия тонет в толще стены (видна только в проёмах)
    const inset = 55;
    const ix = -(nx || 0) * inset, iz = -(nz || 0) * inset;
    const ax = x1 + ix, az = z1 + iz, bx = x2 + ix, bz = z2 + iz;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([ax, y1, az, bx, y2, bz], 3));
    const mat = new THREE.LineDashedMaterial({
      color: 0x111111,
      dashSize: 36,
      gapSize: 22,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 6;
    g.add(line);

    const dimId = `d${(this._dimSeq = (this._dimSeq || 0) + 1)}`;
    line.userData.dimId = dimId;

    const mx = (ax + bx) / 2 - (nx || 0) * 22;
    const my = (y1 + y2) / 2 + 28;
    const mz = (az + bz) / 2 - (nz || 0) * 22;
    const div = document.createElement('div');
    div.className = 'mlabel dim-wall' + (edit ? ' dim-edit' : '');
    div.textContent = String(text).replace(/\s*мм\s*$/i, '').trim();
    div.dataset.dimId = dimId;
    div.title = edit
      ? 'Клик — подсветить · двойной клик — изменить'
      : 'Клик — подсветить размер';
    div.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._selectDim(dimId);
    });
    if (edit) {
      div.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._beginDimEdit(dimId);
      });
    }
    const lab = new CSS2DObject(div);
    lab.position.set(mx, my, mz);
    lab.userData.dimId = dimId;
    g.add(lab);

    if (!this._dimPacks) this._dimPacks = new Map();
    this._dimPacks.set(dimId, { line, mat, lab, div, edit: edit || null });
    if (this._selectedDimId === dimId) this._applyDimHighlight(dimId, true);
  }

  _clearDimSelection() {
    if (this._dimPacks) {
      for (const id of this._dimPacks.keys()) this._applyDimHighlight(id, false);
    }
    this._selectedDimId = null;
  }

  _selectDim(dimId) {
    const prev = this._selectedDimId;
    if (prev && prev !== dimId) this._applyDimHighlight(prev, false);
    if (prev === dimId) {
      this._applyDimHighlight(dimId, false);
      this._selectedDimId = null;
      return;
    }
    this._selectedDimId = dimId;
    this._applyDimHighlight(dimId, true);
  }

  _applyDimHighlight(dimId, on) {
    const pack = this._dimPacks?.get(dimId);
    if (!pack) return;
    if (pack.mat) {
      pack.mat.color.setHex(on ? 0x0d9488 : 0x111111);
      pack.mat.opacity = on ? 1 : 0.85;
      pack.mat.dashSize = on ? 48 : 36;
      pack.mat.gapSize = on ? 16 : 22;
      pack.mat.needsUpdate = true;
    }
    pack.div?.classList.toggle('sel', !!on);
  }

  /** Inline-редактирование числа размера (двойной клик). */
  _beginDimEdit(dimId) {
    const pack = this._dimPacks?.get(dimId);
    if (!pack?.div || !pack.edit || !this.h.onEditDim) return;
    if (this._dimEdit?.dimId === dimId) return;
    this._cancelDimEdit(false);
    this._selectDim(dimId);

    const div = pack.div;
    const prev = (div.textContent || '').replace(/\D+/g, '') || '0';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'dim-inline-input';
    inp.value = prev;
    inp.min = '0';
    inp.step = '10';
    inp.setAttribute('aria-label', 'Размер, мм');
    div.textContent = '';
    div.classList.add('editing');
    div.appendChild(inp);
    this._dimEdit = { dimId, pack, inp, prev };

    const finish = (ok) => {
      if (!this._dimEdit || this._dimEdit.dimId !== dimId) return;
      const raw = inp.value;
      this._dimEdit = null;
      div.classList.remove('editing');
      inp.remove();
      if (!ok) {
        div.textContent = prev;
        return;
      }
      const n = Math.round(+raw);
      if (!Number.isFinite(n) || n < 0) {
        div.textContent = prev;
        return;
      }
      div.textContent = String(n);
      try { this.h.onEditDim(pack.edit, n); } catch (_) { div.textContent = prev; }
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('dblclick', (e) => e.stopPropagation());
    inp.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => {
      inp.focus();
      inp.select();
    });
  }

  _cancelDimEdit(restore = true) {
    const ed = this._dimEdit;
    if (!ed) return;
    this._dimEdit = null;
    const { pack, inp, prev } = ed;
    pack.div?.classList.remove('editing');
    try { inp?.remove(); } catch (_) { /* */ }
    if (restore && pack.div) pack.div.textContent = prev;
  }

  /**
   * Пунктир зазоров: проём/колонна → сосед / угол стены;
   * по вертикали — до уровней стены (пол, столешница, потолок…).
   */
  _addCtorClearanceDims(g, room, segs3) {
    const segs = segs3 || [];
    const openings = room.openings || [];
    const obstacles = room.obstacles || [];

    const pointOnSeg = (s, tAlong, y) => {
      const len = Math.max(1, s.lenFloor || s.len || 1);
      const t = Math.max(0, Math.min(len, tAlong)) / len;
      return {
        x: s.a0.x + (s.b0.x - s.a0.x) * t,
        y,
        z: s.a0.z + (s.b0.z - s.a0.z) * t,
      };
    };

    for (const s of segs) {
      const len = Math.max(1, s.lenFloor || s.len || 1);
      const opsOnWall = openings.filter((op) => {
        if (op.edgeIndex != null) return +op.edgeIndex === s.edgeIndex;
        if (op.wall !== s.wall) return false;
        const first = segs.find((x) => x.wall === op.wall);
        return first && first.edgeIndex === s.edgeIndex;
      });

      const intervals = opsOnWall.map((op) => {
        const t0 = Math.max(0, +op.offset || 0);
        const t1 = Math.min(len, t0 + (+op.width || 900));
        return {
          t0, t1,
          y0: Math.max(0, +op.sill || 0),
          y1: Math.max(0, (+op.sill || 0) + (+op.height || 1400)),
          kind: 'opening',
          id: op.id,
          width: +op.width || 900,
        };
      }).filter((iv) => iv.t1 - iv.t0 > 10);

      for (const ob of obstacles) {
        const cx = +ob.x + (+ob.w || 0) / 2;
        const cz = +ob.z + (+ob.d || 0) / 2;
        const dx = s.b0.x - s.a0.x, dz = s.b0.z - s.a0.z;
        const t = ((cx - s.a0.x) * dx + (cz - s.a0.z) * dz) / (len * len);
        const px = s.a0.x + t * dx, pz = s.a0.z + t * dz;
        const dout = (cx - px) * (s.nx || 0) + (cz - pz) * (s.nz || 0);
        // у стены изнутри комнаты (outward normal → внутрь = −n)
        if (dout > 80 || dout < -500) continue;
        if (t < -0.02 || t > 1.02) continue;
        const half = Math.max(+ob.w || 0, +ob.d || 0) * 0.5;
        intervals.push({
          t0: Math.max(0, t * len - half),
          t1: Math.min(len, t * len + half),
          y0: +ob.y0 || 0,
          y1: +ob.y1 || (+ob.y0 || 0) + 100,
          kind: 'obstacle',
          id: ob.id,
          width: half * 2,
        });
      }

      intervals.sort((a, b) => a.t0 - b.t0);

      // горизонтальные зазоры — только если на стене есть проём/колонна;
      // иначе [0..len] @ y=1100 выглядит как «средний уровень» при 2 уровнях
      if (intervals.length) {
        const cuts = [0, len];
        for (const iv of intervals) cuts.push(iv.t0, iv.t1);
        cuts.sort((a, b) => a - b);
        const uniq = [];
        for (const c of cuts) {
          if (!uniq.length || Math.abs(c - uniq[uniq.length - 1]) > 2) uniq.push(c);
        }

        for (let i = 0; i < uniq.length - 1; i++) {
          const a = uniq[i], b = uniq[i + 1];
          const gap = b - a;
          if (gap < 40) continue;
          const mid = (a + b) / 2;
          if (intervals.some((iv) => mid > iv.t0 + 2 && mid < iv.t1 - 2)) continue;
          let yDim = (intervals[0].y0 + intervals[0].y1) / 2;
          let best = Infinity;
          for (const iv of intervals) {
            const d = Math.min(Math.abs(iv.t0 - mid), Math.abs(iv.t1 - mid));
            if (d < best) {
              best = d;
              yDim = (iv.y0 + iv.y1) / 2;
            }
          }
          const left = intervals.find((iv) => Math.abs(iv.t1 - a) < 3);
          const right = intervals.find((iv) => Math.abs(iv.t0 - b) < 3);
          let edit = null;
          if (right?.id) {
            // двигаем правый объект: его начало = a + newGap
            edit = {
              kind: 'clearH', edgeIndex: s.edgeIndex, wallLen: len,
              move: { type: right.kind, id: right.id, edge: 'start' },
              anchorT: a,
            };
          } else if (left?.id) {
            // правый край — стена/конец: двигаем левый объект к b − newGap
            edit = {
              kind: 'clearH', edgeIndex: s.edgeIndex, wallLen: len,
              move: { type: left.kind, id: left.id, edge: 'end' },
              anchorT: b,
            };
          }
          const p0 = pointOnSeg(s, a, yDim);
          const p1 = pointOnSeg(s, b, yDim);
          this._wallLenDash(g, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, s.nx, s.nz, String(Math.round(gap)), edit);
        }
      }

      // вертикаль: только до реальных уровней заказа (без фантомного ref)
      const levelIds = new Set(levelsWithPlans(room).map((l) => l.id));
      const belts = (s.belts || [])
        .filter((b) => !levelIds.size || levelIds.has(b.id))
        .map((b) => ({
          id: b.id,
          y: ((+b.yA || 0) + (+b.yB || 0)) / 2,
        }))
        .sort((a, b) => a.y - b.y);

      for (const iv of intervals) {
        if (!iv.id) continue;
        const tMid = (iv.t0 + iv.t1) / 2;
        const belowSill = [...belts].reverse().find((b) => b.y < iv.y0 - 25);
        const aboveTop = belts.find((b) => b.y > iv.y1 + 25);
        if (belowSill) {
          const p0 = pointOnSeg(s, tMid, belowSill.y);
          const p1 = pointOnSeg(s, tMid, iv.y0);
          this._wallLenDash(g, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, s.nx, s.nz,
            String(Math.round(iv.y0 - belowSill.y)), {
              kind: 'clearV', type: iv.kind, id: iv.id,
              edge: 'sill', fixedY: belowSill.y,
            });
        }
        if (aboveTop) {
          const p0 = pointOnSeg(s, tMid, iv.y1);
          const p1 = pointOnSeg(s, tMid, aboveTop.y);
          this._wallLenDash(g, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, s.nx, s.nz,
            String(Math.round(aboveTop.y - iv.y1)), {
              kind: 'clearV', type: iv.kind, id: iv.id,
              edge: 'top', fixedY: aboveTop.y,
            });
        }
      }
    }
  }

  /** Перпендикуляр к размерной оси (для засечек / крыльев стрелок). */
  _dimPerp(dx, dy, dz, len) {
    let px, py, pz;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > Math.abs(dz)) {
      px = 1; py = 0; pz = 0;
    } else {
      const hx = -dz / len, hz = dx / len;
      px = hx; py = 0.35; pz = hz;
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl; py /= pl; pz /= pl;
    }
    return { px, py, pz };
  }

  /** Размерный отрезок: линия + засечки на концах + подпись в середине. */
  _dimSeg(g, x1, y1, z1, x2, y2, z2, text) {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz) || 1;
    const { px, py, pz } = this._dimPerp(dx, dy, dz, len);
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

  /**
   * Размер модуля как на эскизах eKitchen: линия со стрелками на концах,
   * число без рамки (только лёгкий ореол для читаемости).
   */
  _modDimSeg(g, x1, y1, z1, x2, y2, z2, text, edit = null) {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const { px, py, pz } = this._dimPerp(dx, dy, dz, len);
    const alen = Math.min(52, Math.max(18, len * 0.18));
    const aw = alen * 0.42;
    // основная линия + два «крыла» стрелки на каждом конце (остриё наружу)
    const positions = [
      x1, y1, z1, x2, y2, z2,
      x1, y1, z1, x1 + ux * alen + px * aw, y1 + uy * alen + py * aw, z1 + uz * alen + pz * aw,
      x1, y1, z1, x1 + ux * alen - px * aw, y1 + uy * alen - py * aw, z1 + uz * alen - pz * aw,
      x2, y2, z2, x2 - ux * alen + px * aw, y2 - uy * alen + py * aw, z2 - uz * alen + pz * aw,
      x2, y2, z2, x2 - ux * alen - px * aw, y2 - uy * alen - py * aw, z2 - uz * alen - pz * aw,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0x2563eb, depthTest: true, transparent: true, opacity: 0.95,
    })));
    this._modDimLabel(g, text, (x1 + x2) / 2, (y1 + y2) / 2 + 18, (z1 + z2) / 2, edit);
  }

  _modDimLabel(g, text, x, y, z, edit = null) {
    const div = document.createElement('div');
    div.className = 'mlabel dim-mod' + (edit ? ' dim-edit' : '');
    div.textContent = String(text).replace(/\s*мм\s*$/i, '').trim();
    const dimId = `m${(this._dimSeq = (this._dimSeq || 0) + 1)}`;
    div.dataset.dimId = dimId;
    if (edit) {
      div.title = 'Двойной клик — изменить размер';
      div.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      div.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._beginDimEdit(dimId);
      });
    }
    const lab = new CSS2DObject(div);
    lab.position.set(x, y, z);
    g.add(lab);
    if (!this._dimPacks) this._dimPacks = new Map();
    this._dimPacks.set(dimId, { line: null, mat: null, lab, div, edit: edit || null });
  }

  _dimLine(g, x1, y1, z1, x2, y2, z2, text, alongX) {
    void alongX;
    this._dimSeg(g, x1, y1, z1, x2, y2, z2, text);
  }

  _dimTickLabel(g, text, x, y, z, edit = null) {
    const div = document.createElement('div');
    div.className = 'mlabel dim-tick' + (edit ? ' dim-edit' : '');
    div.textContent = text;
    const dimId = `t${(this._dimSeq = (this._dimSeq || 0) + 1)}`;
    div.dataset.dimId = dimId;
    if (edit) {
      div.title = 'Двойной клик — изменить';
      div.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._selectDim(dimId);
      });
      div.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._beginDimEdit(dimId);
      });
    }
    const lab = new CSS2DObject(div);
    lab.position.set(x, y, z);
    g.add(lab);
    if (!this._dimPacks) this._dimPacks = new Map();
    this._dimPacks.set(dimId, { line: null, mat: null, lab, div, edit: edit || null });
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

  /** Окантовка рёбер стен/пола/потолка — чтобы углы не сливались */
  setRoomEdgesVisible(v) {
    const on = !!v;
    if (this.room) this.room.showRoomEdges = on;
    if (this.roomEdgeGroup) this.roomEdgeGroup.visible = on;
    for (const e of this.roomEdgeHelpers || []) {
      e.visible = on;
    }
  }

  /** Видимость длин стен по уровням: { floor, mid, ceil } */
  setWallLensVisible(partial) {
    if (!this.room) return;
    const cur = this.room.showWallLens || { floor: true, mid: true, ceil: true };
    this.room.showWallLens = {
      floor: partial.floor != null ? !!partial.floor : cur.floor !== false,
      mid: partial.mid != null ? !!partial.mid : cur.mid !== false,
      ceil: partial.ceil != null ? !!partial.ceil : cur.ceil !== false,
    };
    this._rebuildMeasureOverlay(this.room);
  }

  setWallDimsVisible(v) {
    if (this.room) this.room.showWallDims = !!v;
    if (this.room) this._rebuildMeasureOverlay(this.room);
  }

  /** Видимость размеров модулей: { w, d, h }. */
  setModuleDimsVisible(partial) {
    if (!this.room) return;
    const cur = this.room.showModuleDims || { w: true, d: true, h: true };
    this.room.showModuleDims = {
      w: partial.w != null ? !!partial.w : cur.w !== false,
      d: partial.d != null ? !!partial.d : cur.d !== false,
      h: partial.h != null ? !!partial.h : cur.h !== false,
    };
    this._rebuildModuleDims(this.build);
  }

  /** RAF: пересчёт пунктиров/размеров во время drag (онлайн). */
  _scheduleLiveDims() {
    if (this._liveDimRaf) return;
    this._liveDimRaf = requestAnimationFrame(() => {
      this._liveDimRaf = 0;
      if (!this.room) return;
      const roomLive = this._roomForLiveDims();
      this._rebuildLiveOpeningHole(roomLive);
      this._rebuildMeasureOverlay(roomLive);
      this._rebuildModuleDims(this._buildForLiveDims());
    });
  }

  /**
   * Во время drag двери/окна (ладошка или гизмо) двигается не только меш,
   * но и вырез в геометрии стены — иначе проём «остаётся на месте».
   */
  _rebuildLiveOpeningHole(roomLive) {
    const room = roomLive || this._roomForLiveDims();
    if (!room || !this.room) return;
    const pr = this.press;
    const fh = this._fixHandleDrag || pr?.fixHandle;
    let opId = null;
    if (pr?.ctorKind === 'opening' && pr.ctorId) opId = pr.ctorId;
    else if (fh?.kind === 'opening' && fh.id) opId = fh.id;
    if (!opId) return;

    const opLive = (room.openings || []).find((o) => o.id === opId);
    const pack = this.ctorOpeningMeshes.get(opId);
    const oldRoot = pack?.wallRoot;
    if (!opLive || !oldRoot) return;
    const edgeIndex = opLive.edgeIndex != null ? +opLive.edgeIndex : (pack.mesh?.userData?.edgeIndex);
    if (edgeIndex == null) return;

    try {
      const segs = roomWallSegments3D(room);
      const s = segs.find((seg) => seg.edgeIndex === edgeIndex);
      if (!s) return;
      const WALL_THICK = Math.max(40, +room.wallThick || 140);
      const nSeg = segs.length;
      const closedWalls = !isOpenRoom(room);
      const nWalls = wallEdgeCount(room);
      const next = segs[(edgeIndex + 1) % nSeg];
      const noCapStart = closedWalls || edgeIndex > 0;
      const noCapEnd = closedWalls || edgeIndex < nWalls - 1;
      const edgeOps = (room.openings || []).filter((o) => {
        if (o.edgeIndex != null) return +o.edgeIndex === edgeIndex;
        if (o.wall !== s.wall) return false;
        const first = segs.find((seg) => seg.wall === o.wall);
        return first && first.edgeIndex === edgeIndex;
      });

      // материал стены — до очистки детей
      let wallMat = null;
      oldRoot.traverse((o) => {
        if (!wallMat && o.isMesh && o.material && !o.userData?.pickCtor && !o.userData?.isExterior) {
          wallMat = o.material.clone ? o.material.clone() : o.material;
        }
      });
      if (!wallMat) {
        wallMat = new THREE.MeshStandardMaterial({
          color: this.room.wallColor || 0xf6f4f0, roughness: 0.95, side: THREE.DoubleSide,
        });
      }
      if (wallMat.emissive == null) wallMat.emissive = new THREE.Color(0x000000);

      // сохранить модели проёмов (дверь/окно/небо), убрать геометрию стены
      const keep = [];
      for (const ch of [...oldRoot.children]) {
        if (ch.userData?.pickCtor || ch.userData?.ctorKind === 'opening' || ch.userData?.isExterior) {
          keep.push(ch);
          oldRoot.remove(ch);
        }
      }
      while (oldRoot.children.length) {
        const ch = oldRoot.children.pop();
        ch.traverse((o) => {
          o.geometry?.dispose?.();
          // материалы стены клонировали — исходные можно dispose
          if (o.material && o.material !== wallMat) {
            if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
            else o.material.dispose?.();
          }
        });
      }

      const wallUd = {
        plane: 'wall', wall: s.wall, edgeIndex: s.edgeIndex, pickPlane: true,
        roomPart: 'wall', letter: edgeLetter(s.edgeIndex),
        nx: s.nx, nz: s.nz,
      };
      const fresh = this._wallWithOpenings(s, edgeOps, wallMat, WALL_THICK, {
        noCapStart,
        noCapEnd,
        cornerEnd: noCapEnd ? next : null,
      });
      if (!fresh) {
        for (const ch of keep) oldRoot.add(ch);
        return;
      }
      // перенести геометрию и placeOpening в старый root (ссылки pack.wallRoot остаются валидны)
      oldRoot.userData = { ...fresh.userData, ...wallUd };
      while (fresh.children.length) {
        const ch = fresh.children[0];
        fresh.remove(ch);
        if (ch.isMesh) ch.userData = { ...ch.userData, ...wallUd, pickPlane: true };
        oldRoot.add(ch);
      }

      // вернуть двери/окна и поставить по live offset/sill
      const place = oldRoot.userData.placeOpening;
      const thick = oldRoot.userData.wallThick || WALL_THICK;
      for (const ch of keep) oldRoot.add(ch);
      for (const ch of keep) {
        if (ch.userData?.isExterior) continue;
        const cid = ch.userData?.ctorId;
        const op2 = cid ? (room.openings || []).find((o) => o.id === cid) : null;
        if (!op2 || !place) continue;
        const offC = (+op2.offset || 0) + (+op2.width || 0) / 2;
        const y = (+op2.sill || 0) + (+op2.height || 0) / 2;
        place(ch, offC, y, thick / 2);
        const sky = ch.userData?.exterior;
        if (sky && place) place(sky, offC, y, thick + 40);
      }

      // оверлей выделения (жёлтые Edges) привязан к старым matrixWorld —
      // при live-пересборке каждый кадр иначе копится «сетка» на двери
      this._clearRoomSelOverlay?.();
      if (this.lineMode) this._rebuildCtorLineOverlay?.();
      if (this.press?.gizmoOrigin && pack.mesh) {
        pack.mesh.getWorldPosition(this.press.gizmoOrigin);
      }
    } catch (_) { /* */ }
  }

  /** Комната с live-позой проёма/колонны под курсором. */
  _roomForLiveDims() {
    const room = this.room;
    if (!room) return room;
    const pr = this.press;
    const live = this._fixGizmoLive;
    const fh = this._fixHandleDrag || pr?.fixHandle;
    let openings = room.openings;
    let obstacles = room.obstacles;
    let changed = false;

    if (pr?.ctorKind === 'opening' && pr.ctorId && pr.newCtor) {
      openings = (openings || []).map((op) => (op.id === pr.ctorId ? { ...op, ...pr.newCtor } : op));
      changed = true;
    } else if (fh?.kind === 'opening' && live && fh.id) {
      openings = (openings || []).map((op) => (op.id === fh.id ? {
        ...op,
        offset: live.offset ?? op.offset,
        sill: live.sill ?? op.sill,
        width: live.width ?? op.width,
        height: live.height ?? op.height,
      } : op));
      changed = true;
    }

    if (pr?.ctorKind === 'obstacle' && pr.ctorId && pr.newCtor) {
      obstacles = (obstacles || []).map((ob) => (ob.id === pr.ctorId ? { ...ob, ...pr.newCtor } : ob));
      changed = true;
    } else if (fh?.kind === 'obstacle' && live && fh.id) {
      obstacles = (obstacles || []).map((ob) => (ob.id === fh.id ? {
        ...ob,
        x: live.x ?? ob.x,
        z: live.z ?? ob.z,
        w: live.w ?? ob.w,
        d: live.d ?? ob.d,
        y0: live.y0 ?? ob.y0,
        y1: live.y1 ?? ob.y1,
        rot: live.rot ?? ob.rot,
      } : ob));
      changed = true;
    }

    if (!changed) return room;
    return { ...room, openings, obstacles };
  }

  /** Build с live-позой модуля под курсором (для размеров W/D/H). */
  _buildForLiveDims() {
    const build = this.build;
    if (!build?.items) return build;
    const pr = this.press;
    const live = this._fixGizmoLive;
    const fh = this._fixHandleDrag || pr?.fixHandle;
    let mid = null;
    let patch = null;
    if (pr?.moduleId && pr.newPos) {
      mid = pr.moduleId;
      patch = {
        x: pr.newPos.x, z: pr.newPos.z,
        rot: pr.newPos.rot, elev: pr.newPos.elev,
      };
    } else if (fh?.kind === 'module' && live) {
      mid = fh.id;
      patch = live;
    }
    if (!mid || !patch) return build;
    return {
      ...build,
      items: build.items.map((it) => {
        if (!it.module || it.module.id !== mid) return it;
        const m = {
          ...it.module,
          x: patch.x != null ? +patch.x : it.module.x,
          z: patch.z != null ? +patch.z : it.module.z,
          rot: patch.rot != null ? +patch.rot : it.module.rot,
          p: {
            ...it.module.p,
            elev: patch.elev != null ? +patch.elev : it.module.p.elev,
            width: patch.w != null ? +patch.w : it.module.p.width,
            depth: patch.d != null ? +patch.d : it.module.p.depth,
            height: patch.h != null ? +patch.h : it.module.p.height,
          },
        };
        return { ...it, module: m };
      }),
    };
  }

  /**
   * Размеры каждого модуля на сцене (как эскизы eKitchen в режиме линий):
   * ширина — вдоль фасада сверху, глубина — по боку сверху, высота — вертикаль сбоку.
   */
  _rebuildModuleDims(build) {
    if (this._dimEdit) return;
    const g = this.moduleDimGroup;
    if (!g) return;
    g.traverse((o) => {
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
    });
    g.clear();
    if (this._dimPacks) {
      for (const id of [...this._dimPacks.keys()]) {
        if (String(id).startsWith('m')) this._dimPacks.delete(id);
      }
    } else {
      this._dimPacks = new Map();
    }
    const flags = this.room?.showModuleDims || { w: true, d: true, h: true };
    const showW = flags.w !== false;
    const showD = flags.d !== false;
    const showH = flags.h !== false;
    if (!showW && !showD && !showH) {
      g.visible = false;
      return;
    }
    g.visible = (this.layers?.furniture !== false);
    const items = build?.items || [];
    const OFF = 90;
    for (const it of items) {
      if (it.virtual || !it.module) continue;
      const m = it.module;
      const W = Math.round(+m.p?.width || 0);
      const H = Math.round(+m.p?.height || 0);
      const D = Math.round(+m.p?.depth || 0);
      if (W < 1 || H < 1 || D < 1) continue;
      const elev = +m.p?.elev || 0;
      const top = elev + H;
      const pt = (lx, ly, lz) => localToWorld(m, lx, ly, lz);

      const mid = m.id;
      if (showW) {
        // ширина: над передним ребром (lz = D), чуть вперёд и выше
        const a = pt(0, top + OFF * 0.35, D + OFF);
        const b = pt(W, top + OFF * 0.35, D + OFF);
        this._modDimSeg(g, a.x, a.y, a.z, b.x, b.y, b.z, String(W), {
          kind: 'modDim', moduleId: mid, axis: 'w',
        });
      }
      if (showD) {
        // глубина: вдоль правого бока (lx = W), сверху
        const a = pt(W + OFF, top + OFF * 0.35, 0);
        const b = pt(W + OFF, top + OFF * 0.35, D);
        this._modDimSeg(g, a.x, a.y, a.z, b.x, b.y, b.z, String(D), {
          kind: 'modDim', moduleId: mid, axis: 'd',
        });
      }
      if (showH) {
        // высота: слева у фасада, от низа корпуса до верха
        const a = pt(-OFF, elev, D + OFF * 0.45);
        const b = pt(-OFF, top, D + OFF * 0.45);
        this._modDimSeg(g, a.x, a.y, a.z, b.x, b.y, b.z, String(H), {
          kind: 'modDim', moduleId: mid, axis: 'h',
        });
      }
    }
  }

  _dimLabel(g, text, x, y, z) {
    // как eKitchen: только число, единицы подразумеваются (мм)
    const div = document.createElement('div');
    div.className = 'mlabel dim';
    div.textContent = String(text).replace(/\s*мм\s*$/i, '').trim();
    const lab = new CSS2DObject(div);
    lab.position.set(x, y, z);
    g.add(lab);
  }

  /**
   * Стена с толщей по поясам кривизны. openings=[] — глухая стена.
   * opts.cornerEnd — соседняя стена: квадратный угол вшивается в эту же геометрию (без 45° и без отдельного меша).
   */
  _wallWithOpenings(s, openings, wallMat, thick = 140, opts = {}) {
    const noCapStart = !!opts.noCapStart;
    const noCapEnd = !!opts.noCapEnd;
    const cornerEnd = opts.cornerEnd || null;
    const len = Math.max(100, s.lenFloor || s.len || 1);
    const hWall = Math.max(200, s.hA || 2700, s.hB || 2700);
    const refNx = s.nx || 0, refNz = s.nz || 0;
    const belts = (s.belts?.length >= 2 ? s.belts : [
      { a: s.a0, b: s.b0, yA: 0, yB: 0 },
      { a: s.aR || s.a0, b: s.bR || s.b0, yA: s.yRef || 900, yB: s.yRef || 900 },
      { a: s.a1, b: s.b1, yA: s.hA || hWall, yB: s.hB || hWall },
    ]).map((b) => ({
      a: b.a, b: b.b,
      yA: +b.yA || 0, yB: +b.yB || 0,
    }));

    const root = new THREE.Group();
    root.userData.wallThick = thick;
    root.userData.wallLen = len;
    root.userData.nx = refNx;
    root.userData.nz = refNz;

    /** Точка на внутренней поверхности: along — мм от a0 по полу, y — высота. */
    const sampleWall = (along, y) => {
      const t = Math.max(0, Math.min(len, +along || 0)) / len;
      const yy = Math.max(0, +y || 0);
      let lo = belts[0], hi = belts[belts.length - 1];
      for (let k = 0; k < belts.length - 1; k++) {
        const a = belts[k], b = belts[k + 1];
        const yLo = (a.yA + a.yB) * 0.5;
        const yHi = (b.yA + b.yB) * 0.5;
        if (yy >= yLo - 1e-3 && yy <= yHi + 1e-3) { lo = a; hi = b; break; }
        if (k === belts.length - 2) { lo = a; hi = b; }
      }
      const yLo = (lo.yA + lo.yB) * 0.5;
      const yHi = (hi.yA + hi.yB) * 0.5;
      const u = Math.abs(yHi - yLo) > 1e-3 ? (yy - yLo) / (yHi - yLo) : 0;
      const ax = lo.a.x + (hi.a.x - lo.a.x) * u;
      const az = lo.a.z + (hi.a.z - lo.a.z) * u;
      const bx = lo.b.x + (hi.b.x - lo.b.x) * u;
      const bz = lo.b.z + (hi.b.z - lo.b.z) * u;
      const yA = lo.yA + (hi.yA - lo.yA) * u;
      const yB = lo.yB + (hi.yB - lo.yB) * u;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      const py = yA + (yB - yA) * t;
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.hypot(dx, dz) || 1;
      const tx = dx / segLen, tz = dz / segLen;
      let nx = dz / segLen, nz = -dx / segLen;
      if (nx * refNx + nz * refNz < 0) { nx = -nx; nz = -nz; }
      return { x: px, y: py, z: pz, tx, tz, nx, nz };
    };
    root.userData.sampleWall = sampleWall;
    // проём: вертикаль/горизонталь в мире; XZ берём на высоте центра (глубина едет со стеной)
    root.userData.placeOpening = (mesh, along, y, zDepth = thick / 2) => {
      const p = sampleWall(along, y);
      mesh.position.set(p.x + p.nx * zDepth, y, p.z + p.nz * zDepth);
      const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(-p.tx, 0, -p.tz),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(p.nx, 0, p.nz),
      );
      mesh.quaternion.setFromRotationMatrix(basis);
    };

    const mat = wallMat.clone();
    mat.side = THREE.DoubleSide;
    mat.flatShading = false;

    const pad = 4;
    const holes = openings.map((op) => {
      const t0 = Math.max(0, (+op.offset || 0) - pad);
      const t1 = Math.min(len, (+op.offset || 0) + (+op.width || 900) + pad);
      const y0 = Math.max(0, (+op.sill || 0) - pad);
      const y1 = Math.min(hWall, (+op.sill || 0) + (+op.height || 1400) + pad);
      const yMid = (y0 + y1) / 2;
      const L = sampleWall(t0, yMid);
      const R = sampleWall(t1, yMid);
      return { t0, t1, y0, y1, yMid, L, R };
    }).filter((h) => h.t1 > h.t0 + 20 && h.y1 > h.y0 + 20);

    /** Угол проёма: отвесные стойки + горизонтальные ригеля (XZ с yMid проёма). */
    const sampleOpeningAware = (t, y) => {
      for (const h of holes) {
        const onV = y >= h.y0 - 1 && y <= h.y1 + 1;
        const onH = t >= h.t0 - 1 && t <= h.t1 + 1;
        if (onV && Math.abs(t - h.t0) < 1.5) {
          return { x: h.L.x, y, z: h.L.z, tx: h.L.tx, tz: h.L.tz, nx: h.L.nx, nz: h.L.nz };
        }
        if (onV && Math.abs(t - h.t1) < 1.5) {
          return { x: h.R.x, y, z: h.R.z, tx: h.R.tx, tz: h.R.tz, nx: h.R.nx, nz: h.R.nz };
        }
        if (onH && (Math.abs(y - h.y0) < 1.5 || Math.abs(y - h.y1) < 1.5)) {
          const u = (t - h.t0) / Math.max(1, h.t1 - h.t0);
          return {
            x: h.L.x + (h.R.x - h.L.x) * u,
            y,
            z: h.L.z + (h.R.z - h.L.z) * u,
            tx: h.L.tx, tz: h.L.tz, nx: h.L.nx, nz: h.L.nz,
          };
        }
      }
      return sampleWall(t, y);
    };

    // геометрия стены: прямоугольная толща + верх/низ с нормалью ±Y (однотонно, без запила 45°)
    const pos = [];
    const nrm = [];
    const idx = [];
    const vmap = new Map();
    /** side: 0 внутр, 1 наруж; face: 's' бок / 'u' верх / 'd' низ — раздельные нормали */
    const vid = (t, y, side, face = 's') => {
      const k = `${t.toFixed(2)}_${y.toFixed(2)}_${side}_${face}`;
      if (vmap.has(k)) return vmap.get(k);
      const p = sampleOpeningAware(t, y);
      const i = pos.length / 3;
      if (side === 0) {
        pos.push(p.x, p.y, p.z);
      } else {
        pos.push(p.x + p.nx * thick, p.y, p.z + p.nz * thick);
      }
      if (face === 'u') nrm.push(0, 1, 0);
      else if (face === 'd') nrm.push(0, -1, 0);
      else if (side === 0) nrm.push(-p.nx, 0, -p.nz);
      else nrm.push(p.nx, 0, p.nz);
      vmap.set(k, i);
      return i;
    };
    const quad = (a, b, c, d) => {
      idx.push(a, b, c, a, c, d);
    };
    const addPrism = (t0, t1, y0, y1) => {
      if (t1 - t0 < 2 || y1 - y0 < 2) return;
      const i00 = vid(t0, y0, 0), i10 = vid(t1, y0, 0);
      const i11 = vid(t1, y1, 0), i01 = vid(t0, y1, 0);
      const o00 = vid(t0, y0, 1), o10 = vid(t1, y0, 1);
      const o11 = vid(t1, y1, 1), o01 = vid(t0, y1, 1);
      quad(i00, i10, i11, i01); // внутренняя
      quad(o10, o00, o01, o11); // наружная
      // верх/низ — отдельные вершины с нормалью ±Y (однотонный торец)
      const d00 = vid(t0, y0, 0, 'd'), d10 = vid(t1, y0, 0, 'd');
      const d1o = vid(t1, y0, 1, 'd'), d0o = vid(t0, y0, 1, 'd');
      quad(d00, d0o, d1o, d10);
      const u00 = vid(t0, y1, 0, 'u'), u10 = vid(t1, y1, 0, 'u');
      const u1o = vid(t1, y1, 1, 'u'), u0o = vid(t0, y1, 1, 'u');
      quad(u00, u10, u1o, u0o);
      // торцы на стыках соседей пропускаем — иначе Z-fighting
      if (!(noCapStart && Math.abs(t0) < 1.5)) {
        const c00 = vid(t0, y0, 0), c01 = vid(t0, y1, 0);
        const c0o1 = vid(t0, y1, 1), c0o0 = vid(t0, y0, 1);
        quad(c00, c01, c0o1, c0o0);
      }
      if (!(noCapEnd && Math.abs(t1 - len) < 1.5)) {
        const c10 = vid(t1, y0, 0), c1o0 = vid(t1, y0, 1);
        const c1o1 = vid(t1, y1, 1), c11 = vid(t1, y1, 0);
        quad(c10, c1o0, c1o1, c11);
      }
    };

    // резы только по контуру проёмов (не по каждому поясу) — меньше швов
    const tCuts = [0, len];
    for (const h of holes) tCuts.push(h.t0, h.t1);
    tCuts.sort((a, b) => a - b);
    const ts = [];
    for (const t of tCuts) {
      if (!ts.length || Math.abs(t - ts[ts.length - 1]) > 2) ts.push(t);
    }
    const yCuts = [0, hWall];
    for (const h of holes) yCuts.push(h.y0, h.y1);
    // на завальной стене — ещё узлы поясов, чтобы кривизна не спрямлялась
    if (s.complex) {
      for (const b of belts) yCuts.push((b.yA + b.yB) * 0.5);
    }
    yCuts.sort((a, b) => a - b);
    const ys = [];
    for (const y of yCuts) {
      if (!ys.length || Math.abs(y - ys[ys.length - 1]) > 2) ys.push(y);
    }

    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      const tMid = (t0 + t1) * 0.5;
      for (let j = 0; j < ys.length - 1; j++) {
        const y0 = ys[j], y1 = ys[j + 1];
        const yMid = (y0 + y1) * 0.5;
        if (holes.some((h) => tMid > h.t0 && tMid < h.t1 && yMid > h.y0 && yMid < h.y1)) continue;
        addPrism(t0, t1, y0, y1);
      }
    }

    // квадратный наружный угол в той же геометрии (без 45° и без второго меша)
    // только выпуклый наружный угол (CCW): на вогнутом заливка торчит «столбиком»
    if (cornerEnd && noCapEnd) {
      const vx = s.b0?.x, vz = s.b0?.z;
      if (vx != null && vz != null) {
        const d1x = (+s.b0.x) - (+s.a0.x), d1z = (+s.b0.z) - (+s.a0.z);
        const d2x = (+cornerEnd.b0.x) - (+cornerEnd.a0.x);
        const d2z = (+cornerEnd.b0.z) - (+cornerEnd.a0.z);
        const l1 = Math.hypot(d1x, d1z) || 1;
        const l2 = Math.hypot(d2x, d2z) || 1;
        const sinTurn = (d1x * d2z - d1z * d2x) / (l1 * l2);
        const fill = sinTurn > 0.06 ? wallCornerFillPts(vx, vz, s, cornerEnd, thick) : null;
        if (fill) {
          const hC = Math.max(hWall, +s.hB || 0, +cornerEnd.hA || 0, +cornerEnd.hB || 0);
          // микросдвиг по Y — убирает Z-fighting с торцом соседней стены / полом
          const yBot = 0.15;
          const yTop = hC + 0.15;
          const [va, vm, vb] = fill;
          const bot = [{ x: vx, z: vz }, va, vm, vb];
          const pushCorner = (x, y, z, nx, ny, nz) => {
            pos.push(x, y, z);
            nrm.push(nx, ny, nz);
            return pos.length / 3 - 1;
          };
          const di = bot.map((p) => pushCorner(p.x, yBot, p.z, 0, -1, 0));
          const ui = bot.map((p) => pushCorner(p.x, yTop, p.z, 0, 1, 0));
          quad(di[0], di[1], di[2], di[3]);
          quad(ui[0], ui[3], ui[2], ui[1]);
          for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
            const pa = bot[a], pb = bot[b];
            const dx = pb.x - pa.x, dz = pb.z - pa.z;
            const sl = Math.hypot(dx, dz) || 1;
            let sx = dz / sl, sz = -dx / sl;
            const mx = (pa.x + pb.x) * 0.5 - vx, mz = (pa.z + pb.z) * 0.5 - vz;
            if (sx * mx + sz * mz < 0) { sx = -sx; sz = -sz; }
            const i0 = pushCorner(pa.x, yBot, pa.z, sx, 0, sz);
            const i1 = pushCorner(pb.x, yBot, pb.z, sx, 0, sz);
            const i2 = pushCorner(pb.x, yTop, pb.z, sx, 0, sz);
            const i3 = pushCorner(pa.x, yTop, pa.z, sx, 0, sz);
            quad(i0, i1, i2, i3);
          }
        }
      }
    }

    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
    }

    return root;
  }

  /** Модель окна/двери: рама + стекло/полотно + раскладка (не сплошной бокс). */
  _buildOpeningModel(op) {
    const root = new THREE.Group();
    const W = Math.max(100, +op.width || 900);
    const H = Math.max(100, +op.height || 1400);
    const isWin = op.type !== 'door';
    const fillCol = op.color != null ? +op.color : (isWin ? 0x9ec9e8 : 0x6b4f2a);
    const frameCol = op.frameColor != null ? +op.frameColor : (isWin ? 0x1a1a1a : 0x4a3728);
    const frameMat = new THREE.MeshStandardMaterial({ color: frameCol, roughness: 0.65, metalness: 0.05 });
    frameMat.emissive = new THREE.Color(0x000000);
    frameMat.emissiveIntensity = 0;
    const fillMat = new THREE.MeshStandardMaterial({
      color: fillCol,
      transparent: isWin,
      opacity: isWin ? 0.42 : 1,
      roughness: isWin ? 0.12 : 0.75,
      metalness: isWin ? 0.15 : 0,
      side: THREE.DoubleSide,
      depthWrite: !isWin,
    });
    fillMat.emissive = new THREE.Color(0x000000);
    fillMat.emissiveIntensity = 0;

    const ft = Math.max(28, Math.min(55, Math.round(Math.min(W, H) * 0.045))); // ширина профиля
    const fd = isWin ? 70 : 50; // глубина рамы
    const mt = Math.max(18, Math.round(ft * 0.55)); // штапик / импост

    const addBox = (w, h, d, x, y, z, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      root.add(m);
      return m;
    };

    // наружная рама (полый прямоугольник из 4 брусков)
    addBox(W, ft, fd, 0, H / 2 - ft / 2, 0, frameMat); // верх
    addBox(W, ft, fd, 0, -H / 2 + ft / 2, 0, frameMat); // низ
    addBox(ft, H - 2 * ft, fd, -W / 2 + ft / 2, 0, 0, frameMat); // лево
    addBox(ft, H - 2 * ft, fd, W / 2 - ft / 2, 0, 0, frameMat); // право

    const innerW = W - 2 * ft;
    const innerH = H - 2 * ft;
    // раскладка: 1–2 стойки / ригеля по габариту
    const nCol = isWin ? (W >= 1500 ? 2 : W >= 900 ? 1 : 0) : 0;
    const nRow = isWin ? (H >= 1400 ? 1 : 0) : 0;
    const cellsX = nCol + 1;
    const cellsY = nRow + 1;
    const cellW = (innerW - nCol * mt) / cellsX;
    const cellH = (innerH - nRow * mt) / cellsY;

    for (let c = 0; c < nCol; c++) {
      const x = -innerW / 2 + cellW * (c + 1) + mt * c + mt / 2;
      addBox(mt, innerH, fd * 0.85, x, 0, 0, frameMat);
    }
    for (let r = 0; r < nRow; r++) {
      const y = -innerH / 2 + cellH * (r + 1) + mt * r + mt / 2;
      addBox(innerW, mt, fd * 0.85, 0, y, 0, frameMat);
    }

    // стёкла / полотно двери — только внутри ячеек (цвет заполнения)
    const glassZ = isWin ? fd * 0.08 : -fd * 0.15;
    const glassD = isWin ? 8 : fd * 0.55;
    for (let iy = 0; iy < cellsY; iy++) {
      for (let ix = 0; ix < cellsX; ix++) {
        const cx = -innerW / 2 + cellW * ix + mt * ix + cellW / 2;
        const cy = -innerH / 2 + cellH * iy + mt * iy + cellH / 2;
        const gw = Math.max(10, cellW - 4);
        const gh = Math.max(10, cellH - 4);
        addBox(gw, gh, glassD, cx, cy, glassZ, fillMat);
      }
    }

    // подоконник внутрь комнаты (−Z: у стены +Z = наружу в толщу)
    if (isWin) {
      const sillD = 120, sillH = 28, sillOver = 40;
      const sillMat = new THREE.MeshStandardMaterial({ color: 0xd8d0c4, roughness: 0.7 });
      sillMat.emissive = new THREE.Color(0x000000);
      const sill = addBox(
        W + sillOver, sillH, sillD,
        0, -H / 2 + sillH / 2, -(fd / 2 + sillD / 2 - 12),
        sillMat,
      );
      sill.userData.isSill = true;
    }

    return root;
  }

  _addOpening(g, op, L, D, H) {
    if (!op.id) return;
    const WALL_THICK = 140;
    const root = this._buildOpeningModel(op);
    const off = (+op.offset || 0) + (+op.width || 0) / 2;
    const y = (+op.sill || 0) + (+op.height || 0) / 2;
    let edgeIndex = op.edgeIndex != null ? +op.edgeIndex : null;

    const wallRoot = (this.wallMeshes || []).find(
      (m) => !m.isMesh && edgeIndex != null && m.userData?.edgeIndex === edgeIndex,
    ) || (this.wallMeshes || []).find(
      (m) => !m.isMesh && op.wall && m.userData?.wall === op.wall,
    );

    const ctorUd = {
      pickCtor: true, ctorKind: 'opening', ctorId: op.id,
      edgeIndex, wall: op.wall, offset: +op.offset || 0, width: +op.width || 0,
      sill: +op.sill || 0, height: +op.height || 0,
    };
    root.userData = { ...ctorUd };
    root.traverse((o) => {
      if (o.isMesh) o.userData = { ...o.userData, ...ctorUd };
    });

    if (wallRoot) {
      edgeIndex = wallRoot.userData.edgeIndex;
      ctorUd.edgeIndex = edgeIndex;
      root.userData.edgeIndex = edgeIndex;
      const thick = wallRoot.userData.wallThick || WALL_THICK;
      const place = wallRoot.userData.placeOpening;
      if (place) place(root, off, y, thick / 2);
      else {
        root.position.set(off, y, thick / 2);
        root.rotation.set(0, 0, 0);
      }
      wallRoot.add(root);
      if (op.type !== 'door') {
        const sky = new THREE.Mesh(
          new THREE.PlaneGeometry((+op.width || 900) + 200, (+op.height || 1400) + 200),
          new THREE.MeshBasicMaterial({ color: 0x7eb6e8, side: THREE.DoubleSide }),
        );
        if (place) place(sky, off, y, thick + 40);
        else sky.position.set(off, y, thick + 40);
        sky.userData = { ...ctorUd, isExterior: true };
        wallRoot.add(sky);
        root.userData.exterior = sky;
      }
    } else {
      if (op.wall === 'back') root.position.set(off, y, -WALL_THICK / 2);
      else if (op.wall === 'front') { root.position.set(L - off, y, D + WALL_THICK / 2); root.rotation.y = Math.PI; }
      else if (op.wall === 'left') { root.position.set(-WALL_THICK / 2, y, off); root.rotation.y = Math.PI / 2; }
      else { root.position.set(L + WALL_THICK / 2, y, D - off); root.rotation.y = -Math.PI / 2; }
      g.add(root);
    }
    this.ctorOpeningMeshes.set(op.id, { mesh: root, frame: null, root, wallRoot: wallRoot || null });
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

    this.fixMeshes.clear();
    this._fixtureById.clear();
    for (const f of fixtures) {
      this._fixtureById.set(f.id, f);
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
      this.fixMeshes.set(f.id, mesh);
    }
    this._applyLayers();
    // в «Линиях» коммуникации всегда видны (как каркас мебели), даже если roomGroup скрыт
    if (this.lineMode) {
      this.fixGroup.visible = true;
      this.fixGroup.traverse((o) => {
        if (o.userData?.fixtureKind) o.visible = true;
      });
    }
    this._rebuildDocks();
    this._rebuildFixtureHandles();
    this._rebuildCtorLineOverlay();
    this._rebuildModuleDims(build);
  }

  /**
   * CAD-gizmo: модули — только стрелки сдвига;
   * техника/конструкции — стрелки + кольцо/кубики по необходимости.
   */
  _rebuildFixtureHandles(live = false) {
    if (this._fixHandleDrag && !live) return;
    this.fixHandleGroup.clear();
    this._gizmoOrigin = null;
    this._gizmoRingR = null;
    if (this.lineMode) return;

    let target = null; // { kind, id, w,d,h, origin, rotX,rotY,rotZ, scaleMode, fullRot }
    if (this.sel?.fixtureId) {
      const id = this.sel.fixtureId;
      const f = this._fixtureById.get(id);
      const mesh = this.fixMeshes.get(id);
      if (!f || !mesh) return;
      const def = FIXTURE_CATALOG[f.type] || FIXTURE_CATALOG[f.type === 'socket_kitchen' || f.type === 'socket_double' ? 'socket_block' : ''];
      if (!def) return;
      const livePose = live ? this._fixGizmoLive : null;
      const { w, d, h } = fixtureDims({
        ...f,
        type: def === FIXTURE_CATALOG.socket_block && (f.type === 'socket_kitchen' || f.type === 'socket_double')
          ? 'socket_block' : f.type,
        w: livePose?.w ?? f.w,
        d: livePose?.d ?? f.d,
        h: livePose?.h ?? f.h,
      });
      const pose = { ...f, ...(livePose || {}) };
      const c0 = fixtureCenter(pose, { w, d, h, def });
      target = {
        kind: 'fixture',
        id,
        w, d, h,
        origin: new THREE.Vector3(c0.x, c0.y, c0.z),
        rotX: +pose.rx || 0,
        rotY: +pose.rot || 0,
        rotZ: +pose.rz || 0,
        scaleMode: def.kind === 'pipe' ? 'pipe' : 'box',
        fullRot: true,
        compactHint: def.kind === 'socket' || def.kind === 'vent',
      };
    } else if (this.sel?.obstacleId) {
      const id = this.sel.obstacleId;
      const mesh = this.ctorObstacleMeshes.get(id);
      const ud = mesh?.userData;
      if (!mesh || !ud) return;
      const livePose = live ? this._fixGizmoLive : null;
      const w = +(livePose?.w ?? ud.w) || 400;
      const d = +(livePose?.d ?? ud.d) || 400;
      const y0 = +(livePose?.y0 ?? ud.y0) || 0;
      const y1 = +(livePose?.y1 ?? ud.y1) || 2700;
      const h = Math.max(10, y1 - y0);
      const x = +(livePose?.x ?? ud.x) || 0;
      const z = +(livePose?.z ?? ud.z) || 0;
      const rotY = +(livePose?.rot ?? ud.rot) || 0;
      target = {
        kind: 'obstacle',
        id,
        w, d, h, y0, y1, x, z,
        origin: new THREE.Vector3(x + w / 2, y0 + h / 2, z + d / 2),
        rotX: 0,
        rotY,
        rotZ: 0,
        scaleMode: 'box',
        fullRot: false, // только yaw
        compactHint: false,
      };
    } else if (this.sel?.openingId) {
      const id = this.sel.openingId;
      const pack = this.ctorOpeningMeshes.get(id);
      const mesh = pack?.mesh;
      if (!mesh) return;
      const livePose = live ? this._fixGizmoLive : null;
      const ud = mesh.userData || {};
      const w = +(livePose?.width ?? ud.width ?? 900);
      const h = +(livePose?.height ?? ud.height ?? 1400);
      const sill = +(livePose?.sill ?? ud.sill ?? 0);
      const world = new THREE.Vector3();
      mesh.getWorldPosition(world);
      // центр проёма в мире
      target = {
        kind: 'opening',
        id,
        w, d: 80, h, sill,
        origin: world.clone(),
        rotX: 0, rotY: 0, rotZ: 0,
        scaleMode: 'opening',
        fullRot: false,
        compactHint: false,
        wallAlong: null,
      };
      // ось стены — из родителя
      const wr = pack.wallRoot;
      if (wr?.userData) {
        const nx = +wr.userData.nx || 0, nz = +wr.userData.nz || 0;
        // вдоль стены = перпендикуляр нормали
        target.wallAlong = new THREE.Vector3(-nz, 0, nx).normalize();
        target.wallNormal = new THREE.Vector3(nx, 0, nz).normalize();
        const eul = new THREE.Euler().setFromQuaternion(wr.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');
        target.rotY = (eul.y * 180) / Math.PI;
      }
    } else if (this.sel?.moduleId && !String(this.sel.moduleId).startsWith('__top')) {
      const id = this.sel.moduleId;
      const m = (this.build?.items || []).find((q) => q.module?.id === id)?.module;
      if (!m?.p) return;
      const livePose = live ? this._fixGizmoLive : null;
      const w = +(livePose?.w ?? m.p.width) || 600;
      const d = +(livePose?.d ?? m.p.depth) || 560;
      const h = +(livePose?.h ?? m.p.height) || 720;
      const elev = +(livePose?.elev ?? m.p.elev) || 0;
      const x = +(livePose?.x ?? m.x) || 0;
      const z = +(livePose?.z ?? m.z) || 0;
      const rotY = +(livePose?.rot ?? m.rot) || 0;
      const a = (rotY * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      const lx = w * 0.5, lz = d * 0.5;
      target = {
        kind: 'module',
        id,
        w, d, h, elev, x, z,
        origin: new THREE.Vector3(x + lx * c + lz * s, elev + h * 0.5, z - lx * s + lz * c),
        rotX: 0,
        rotY,
        rotZ: 0,
        // модуль: только стрелки сдвига (без кольца поворота и кубиков размера)
        scaleMode: 'none',
        fullRot: false,
        moveOnly: true,
        compactHint: false,
      };
    } else {
      return;
    }

    const { w, d, h, origin } = target;
    const eul = new THREE.Euler(
      (target.rotX * Math.PI) / 180,
      (target.rotY * Math.PI) / 180,
      (target.rotZ * Math.PI) / 180,
      'YXZ',
    );
    const m4 = new THREE.Matrix4().makeRotationFromEuler(eul);
    const xAxis = new THREE.Vector3(1, 0, 0).applyMatrix4(m4).normalize();
    const yAxis = new THREE.Vector3(0, 1, 0).applyMatrix4(m4).normalize();
    const zAxis = new THREE.Vector3(0, 0, 1).applyMatrix4(m4).normalize();
    if (target.kind === 'opening' && target.wallAlong) {
      xAxis.copy(target.wallAlong);
      zAxis.copy(target.wallNormal || zAxis);
      yAxis.set(0, 1, 0);
    }

    const size = Math.max(w, d, h);
    const compact = target.compactHint || size < 220;
    const ringR = compact
      ? Math.max(48, Math.min(95, size * 0.85 + 36))
      : Math.max(90, Math.min(220, Math.max(w, d, h * 0.25) * 0.45 + 70));
    const arrowLen = compact
      ? Math.max(55, Math.min(110, size * 0.75 + 40))
      : Math.max(120, Math.min(280, Math.min(h, 2000) * 0.2 + 100));
    const tube = compact ? Math.max(6, Math.min(12, ringR * 0.11)) : Math.max(10, Math.min(18, ringR * 0.1));
    const hubR = compact ? 10 : 18;
    const cubeS = compact ? 14 : 26;
    this._gizmoOrigin = origin.clone();
    this._gizmoRingR = ringR;
    const tag = (obj, axis) => {
      const meta = { id: target.id, axis, kind: target.kind };
      obj.userData = { ...(obj.userData || {}), fixHandle: meta, pick: true };
      obj.traverse((o) => {
        if (o.isMesh || o.isLine) {
          o.userData = { fixHandle: meta, pick: true };
          o.renderOrder = 1000;
          if (o.material) {
            o.material.depthTest = false;
            o.material.depthWrite = false;
            if (o.material.color && o.material.userData.baseColor == null) {
              o.material.userData.baseColor = o.material.color.getHex();
            }
            if (o.material.userData.baseOpacity == null) {
              o.material.userData.baseOpacity = o.material.opacity ?? 1;
            }
          }
        }
      });
      this.fixHandleGroup.add(obj);
    };

    if (target.kind === 'opening') {
      // проём: вдоль стены, высота подоконника, ширина/высота
      tag(this._gizmoArrow(origin, xAxis, 0xe11d48, arrowLen, compact), 'moveX');
      tag(this._gizmoArrow(origin, yAxis, 0x16a34a, arrowLen * 0.75, compact), 'moveY');
      const hub = new THREE.Mesh(
        new THREE.OctahedronGeometry(hubR, 0),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
      );
      hub.position.copy(origin);
      tag(hub, 'moveX');
      const cube = (axis, color, pos) => {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(cubeS, cubeS, cubeS),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
        );
        m.position.copy(pos);
        tag(m, axis);
      };
      cube('w', 0x3b82f6, origin.clone().add(xAxis.clone().multiplyScalar(w / 2 + 18)));
      cube('h', 0x22c55e, origin.clone().add(yAxis.clone().multiplyScalar(h / 2 + 18)));
      return;
    }

    tag(this._gizmoArrow(origin, xAxis, 0xe11d48, arrowLen, compact), 'moveX');
    tag(this._gizmoArrow(origin, yAxis, 0x16a34a, arrowLen, compact), 'moveY');
    tag(this._gizmoArrow(origin, zAxis, 0x2563eb, arrowLen * 0.85, compact), 'moveZ');

    const hub = new THREE.Mesh(
      new THREE.OctahedronGeometry(hubR, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
    );
    hub.position.copy(origin);
    tag(hub, 'moveXZ');

    if (target.moveOnly || target.scaleMode === 'none') return;

    if (target.fullRot) {
      tag(this._gizmoRotRing(origin, ringR, 0xf87171, xAxis, tube), 'rotX');
      tag(this._gizmoRotRing(origin, ringR, 0xf59e0b, yAxis, tube), 'rotY');
      tag(this._gizmoRotRing(origin, ringR, 0x60a5fa, zAxis, tube), 'rotZ');
    } else {
      tag(this._gizmoRotRing(origin, ringR, 0xf59e0b, yAxis, tube), 'rotY');
    }

    const cube = (axis, color, pos) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(cubeS, cubeS, cubeS),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      m.position.copy(pos);
      tag(m, axis);
    };
    cube('h', 0x22c55e, origin.clone().add(yAxis.clone().multiplyScalar(h * 0.5 + (compact ? 12 : 20))));
    if (target.scaleMode === 'pipe') {
      const rad = Math.max(w, d) / 2 + (compact ? 20 : 36);
      cube('diam', 0x3b82f6, origin.clone().add(xAxis.clone().multiplyScalar(rad)));
    } else {
      cube('w', 0x3b82f6, origin.clone().add(xAxis.clone().multiplyScalar(w / 2 + (compact ? 10 : 18))));
      cube('d', 0xa855f7, origin.clone().add(zAxis.clone().multiplyScalar(d / 2 + (compact ? 12 : 24))));
    }
  }

  _gizmoArrow(origin, dir, color, length = 180, compact = false) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    const tip = compact ? 28 : 42;
    const rad = compact ? 3.5 : 5.5;
    const shaftH = Math.max(28, length - tip);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, shaftH, 10), mat);
    shaft.position.y = shaftH / 2;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(compact ? 10 : 15, tip, 14), mat.clone());
    cone.position.y = shaftH + tip / 2;
    g.add(shaft, cone);
    g.position.copy(origin);
    const nd = dir.clone().normalize();
    if (nd.lengthSq() > 1e-8) g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nd);
    return g;
  }

  /** Пунктирное кольцо; tube тонкий — центр остаётся кликабельным для drag объекта. */
  _gizmoRotRing(origin, radius, color, axisDir = new THREE.Vector3(0, 1, 0), tube = 12) {
    const g = new THREE.Group();
    const pts = [];
    const N = 72;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color, dashSize: Math.max(10, radius * 0.18), gapSize: Math.max(6, radius * 0.12),
      transparent: true, opacity: 0.95,
    }));
    line.computeLineDistances();
    const hit = new THREE.Mesh(
      new THREE.TorusGeometry(radius, tube, 8, 48),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false,
      }),
    );
    hit.rotation.x = Math.PI / 2;
    const hitPad = new THREE.Mesh(
      new THREE.TorusGeometry(radius, tube * 1.7, 6, 40),
      new THREE.MeshBasicMaterial({ visible: false, depthTest: false }),
    );
    hitPad.rotation.x = Math.PI / 2;
    g.add(line, hit, hitPad);
    g.position.copy(origin);
    const nd = axisDir.clone().normalize();
    if (nd.lengthSq() > 1e-8) g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nd);
    return g;
  }

  /** Подсветка элемента gizmo при наведении / активном drag (только цвет, без scale). */
  _setGizmoHover(axis) {
    if (this._gizmoHoverAxis === axis) return;
    this._gizmoHoverAxis = axis;
    for (const root of this.fixHandleGroup.children) {
      const a = root.userData?.fixHandle?.axis;
      const on = !!(axis && a === axis);
      root.traverse((o) => {
        const mat = o.material;
        if (!mat?.color || !o.userData?.fixHandle) return;
        if (mat.userData.baseColor == null) mat.userData.baseColor = mat.color.getHex();
        if (mat.userData.baseOpacity == null) mat.userData.baseOpacity = mat.opacity ?? 1;
        const base = mat.userData.baseColor;
        const baseOp = mat.userData.baseOpacity;
        if (on) {
          mat.color.setHex(0xffe066);
          mat.opacity = Math.min(1, Math.max(0.45, baseOp < 0.2 ? 0.45 : baseOp + 0.35));
        } else {
          mat.color.setHex(base);
          mat.opacity = baseOp;
        }
      });
    }
    if (this.renderer?.domElement) {
      this.renderer.domElement.style.cursor = axis ? 'grab' : '';
    }
  }

  _hitFixHandle(e) {
    if (!this.fixHandleGroup.children.length) return null;
    this.ray.setFromCamera(this._ndc(e), this.camera);
    this.ray.params.Line = { threshold: 16 };
    const hits = this.ray.intersectObjects(this.fixHandleGroup.children, true);
    // экранный «просвет» в центре колец — там тянем объект (hub / корпус), не rot
    let rotDead = 0;
    let centerDist = Infinity;
    if (this._gizmoOrigin && this._gizmoRingR) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const c = this._gizmoOrigin.clone().project(this.camera);
      const sx = (c.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-c.y * 0.5 + 0.5) * rect.height + rect.top;
      centerDist = Math.hypot(e.clientX - sx, e.clientY - sy);
      const edge = this._gizmoOrigin.clone().add(new THREE.Vector3(this._gizmoRingR, 0, 0)).project(this.camera);
      const ex = (edge.x * 0.5 + 0.5) * rect.width + rect.left;
      const ey = (-edge.y * 0.5 + 0.5) * rect.height + rect.top;
      const ringPx = Math.max(24, Math.hypot(ex - sx, ey - sy));
      rotDead = ringPx * 0.58;
    }
    // на ободе кольца чуть приоритетнее стрелок; в центре — наоборот
    const nearRim = centerDist >= rotDead;
    hits.sort((a, b) => {
      const ax = (() => { let o = a.object; while (o && !o.userData?.fixHandle) o = o.parent; return o?.userData?.fixHandle?.axis || ''; })();
      const bx = (() => { let o = b.object; while (o && !o.userData?.fixHandle) o = o.parent; return o?.userData?.fixHandle?.axis || ''; })();
      const pr = (s) => {
        if (s.startsWith('rot')) return nearRim ? 0 : 2;
        if (s === 'moveXZ') return nearRim ? 1 : 0;
        return 1;
      };
      const d = pr(ax) - pr(bx);
      return d !== 0 ? d : a.distance - b.distance;
    });
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData?.fixHandle) o = o.parent;
      const axis = o?.userData?.fixHandle?.axis;
      if (!axis) continue;
      if (axis.startsWith('rot') && centerDist < rotDead) continue;
      return { ...h, object: o };
    }
    return null;
  }

  /** Угол точки вокруг оси axis через origin. */
  _angleAroundAxis(origin, axis, point) {
    const n = axis.clone().normalize();
    let ref = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(n, ref).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    const d = point.clone().sub(origin);
    return Math.atan2(d.dot(v), d.dot(u));
  }

  /** Экранный угол мыши вокруг проекции центра — стабильный поворот колец. */
  _screenAngleAround(origin, e) {
    const v = origin.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
    return Math.atan2(e.clientY - sy, e.clientX - sx);
  }

  /** Live-превью объекта + gizmo следует за ним. */
  _applyFixtureLive(id, base, patch, hoverAxis = null) {
    const live = { ...base, ...patch };
    this._fixGizmoLive = live;
    const cLive = fixtureCenter(live, live);
    const mesh = this.fixMeshes.get(id);
    if (mesh) {
      mesh.position.set(cLive.x, cLive.y, cLive.z);
      mesh.rotation.order = 'YXZ';
      mesh.rotation.x = ((+live.rx || 0) * Math.PI) / 180;
      mesh.rotation.y = ((+live.rot || 0) * Math.PI) / 180;
      mesh.rotation.z = ((+live.rz || 0) * Math.PI) / 180;
      const sx = base.w > 0 ? live.w / base.w : 1;
      const sy = base.h > 0 ? live.h / base.h : 1;
      const sz = base.d > 0 ? live.d / base.d : 1;
      mesh.scale.set(sx, sy, sz);
    }
    if (this.press?.gizmoOrigin) this.press.gizmoOrigin.set(cLive.x, cLive.y, cLive.z);
    this.h.onDraggingFixture?.(id, live);
    this._gizmoHoverAxis = null;
    this._rebuildFixtureHandles(true);
    if (hoverAxis) this._setGizmoHover(hoverAxis);
    this._scheduleLiveDims();
  }

  _applyObstacleLive(id, base, patch, hoverAxis = null) {
    const live = { ...base, ...patch };
    if (live.y1 == null && live.h != null) live.y1 = (+live.y0 || 0) + (+live.h || 100);
    if (live.h == null) live.h = Math.max(10, (+live.y1 || 0) - (+live.y0 || 0));
    this._fixGizmoLive = live;
    const mesh = this.ctorObstacleMeshes.get(id);
    if (mesh) {
      const w = +live.w || 400, d = +live.d || 400;
      const y0 = +live.y0 || 0, y1 = +live.y1 || (y0 + (+live.h || 100));
      const oh = Math.max(10, y1 - y0);
      mesh.position.set(+live.x + w / 2, y0 + oh / 2, +live.z + d / 2);
      mesh.rotation.y = ((+live.rot || 0) * Math.PI) / 180;
      const sx = base.w > 0 ? w / base.w : 1;
      const sy = base.h > 0 ? oh / base.h : 1;
      const sz = base.d > 0 ? d / base.d : 1;
      mesh.scale.set(sx, sy, sz);
      mesh.userData = {
        ...mesh.userData,
        x: +live.x, z: +live.z, w, d, y0, y1, rot: +live.rot || 0,
      };
      if (this.press?.gizmoOrigin) {
        this.press.gizmoOrigin.set(+live.x + w / 2, y0 + oh / 2, +live.z + d / 2);
      }
    }
    this.h.onDraggingCtor?.('obstacle', id, {
      x: live.x, z: live.z, w: live.w, d: live.d, y0: live.y0, y1: live.y1, rot: live.rot,
    });
    this._gizmoHoverAxis = null;
    this._rebuildFixtureHandles(true);
    if (hoverAxis) this._setGizmoHover(hoverAxis);
    this._scheduleLiveDims();
  }

  _applyOpeningLive(id, base, patch, hoverAxis = null) {
    const live = { ...base, ...patch };
    this._fixGizmoLive = live;
    const pack = this.ctorOpeningMeshes.get(id);
    if (pack?.mesh) {
      const w = +live.width || 900;
      const h = +live.height || 1400;
      const sill = +live.sill || 0;
      const offC = (+live.offset || 0) + w / 2;
      const y = sill + h / 2;
      const thick = pack.wallRoot?.userData?.wallThick || 140;
      const place = pack.wallRoot?.userData?.placeOpening;
      if (place) {
        place(pack.mesh, offC, y, thick / 2);
        const sky = pack.mesh.userData?.exterior;
        if (sky) place(sky, offC, y, thick + 40);
      } else {
        pack.mesh.position.set(offC, y, thick / 2);
      }
      pack.mesh.userData = {
        ...pack.mesh.userData,
        width: w, height: h, sill, offset: +live.offset || 0,
      };
      if (this.press?.gizmoOrigin) pack.mesh.getWorldPosition(this.press.gizmoOrigin);
    }
    this.h.onDraggingCtor?.('opening', id, {
      offset: live.offset, sill: live.sill, width: live.width, height: live.height,
    });
    this._gizmoHoverAxis = null;
    this._rebuildFixtureHandles(true);
    if (hoverAxis) this._setGizmoHover(hoverAxis);
    this._scheduleLiveDims();
  }

  /** Live-превью модуля под CAD-gizmo (позиция / elev / поворот / габарит). */
  _applyModuleLive(id, base, patch, hoverAxis = null) {
    const live = { ...base, ...patch };
    this._fixGizmoLive = live;
    const grp = this.modGroups.get(id);
    if (grp) {
      const elevY = (+live.elev || 0) - (+base.elev || 0);
      grp.position.set(+live.x, elevY, +live.z);
      grp.rotation.y = ((+live.rot || 0) * Math.PI) / 180;
      const body = grp.children.find((c) => c.isGroup) || grp.children[0];
      if (body) {
        const sx = base.w > 0 ? (+live.w || base.w) / base.w : 1;
        const sy = base.h > 0 ? (+live.h || base.h) / base.h : 1;
        const sz = base.d > 0 ? (+live.d || base.d) / base.d : 1;
        body.scale.set(sx, sy, sz);
      }
      const a = ((+live.rot || 0) * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      const w = +live.w || base.w, d = +live.d || base.d, h = +live.h || base.h;
      const elev = +live.elev || 0;
      const lx = w * 0.5, lz = d * 0.5;
      if (this.press?.gizmoOrigin) {
        this.press.gizmoOrigin.set(
          +live.x + lx * c + lz * s,
          elev + h * 0.5,
          +live.z - lx * s + lz * c,
        );
      }
    }
    this.h.onDragging?.(id, +live.x, +live.z);
    this._gizmoHoverAxis = null;
    this._rebuildFixtureHandles(true);
    if (hoverAxis) this._setGizmoHover(hoverAxis);
    this._scheduleLiveDims();
  }

  _cameraVerticalPlane(at) {
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const up = new THREE.Vector3(0, 1, 0);
    let right = new THREE.Vector3().crossVectors(up, camDir);
    if (right.lengthSq() < 1e-6) right = new THREE.Vector3(1, 0, 0);
    else right.normalize();
    const n = new THREE.Vector3().crossVectors(right, up).normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, at);
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
   * walk — изнутри, top — сверху, 3d/orbit — изометрия, front — спереди,
   * wallElev — 2D-развёртка стены (орто).
   */
  _applyViewControls(navKind) {
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    if (navKind === 'walk') {
      this.controls.enabled = false;
      return;
    }
    this.controls.enabled = true;
    if (navKind === 'top' || navKind === 'wallElev') {
      this.controls.enableRotate = false;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      this.controls.screenSpacePanning = true;
    } else {
      this.controls.enableRotate = true;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.controls.screenSpacePanning = false;
    }
  }

  setView(kind) {
    const L = this.room?.length || 4000, D = this.room?.depth || 3500, H = this.room?.height || 2700;
    const t = new THREE.Vector3(L / 2, H / 2.5, D / 2);
    const d = Math.max(L, D, H) * 1.6;
    this.walkDrag = null;
    this._lookPitch = 0;

    // 2D-развёртка стены (wallEdge:0 …) или legacy wallA–D → индекс 0–3
    let edgeIdx = null;
    const we = /^wallEdge:?(\d+)$/i.exec(kind);
    if (we) edgeIdx = +we[1];
    else if (/^wall[A-Za-z]$/.test(kind) || /^wall:[A-Za-z]$/.test(kind)) {
      const letter = kind.replace(/^wall:?/i, '').toUpperCase();
      edgeIdx = letter.charCodeAt(0) - 65;
    }
    if (edgeIdx != null && edgeIdx >= 0) {
      this.navMode = 'wallElev';
      this._applyViewControls('wallElev');
      this._setWallElevationView(edgeIdx);
      this.h.onNavMode?.(`wallEdge:${edgeIdx}`);
      return;
    }

    // выход из развёртки → снова перспектива
    this._usePerspectiveCamera();
    this.controls.minZoom = 0;
    this.controls.maxZoom = Infinity;

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
    if (this.camera?.isOrthographicCamera) {
      const z = this.camera.zoom / (factor || 1);
      this.camera.zoom = THREE.MathUtils.clamp(z, 0.25, 6);
      this.camera.updateProjectionMatrix();
      this.controls.update();
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

  /**
   * Сдвиг камеры и target в плоскости экрана (угол взгляда не меняется).
   * sx: −1 влево / +1 вправо; sy: −1 вниз / +1 вверх.
   */
  panCamera(sx = 0, sy = 0, stepMm = null) {
    if (!sx && !sy) return;
    if (this.navMode === 'walk') {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const sp = stepMm ?? 250;
      this.camera.position.addScaledVector(right, sx * sp);
      this.camera.position.y += sy * sp;
      this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, 1200, 1800);
      return;
    }
    const t = this.controls.target;
    const offset = this.camera.position.clone().sub(t);
    const dist = Math.max(400, offset.length());
    const toTarget = t.clone().sub(this.camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(toTarget, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    else right.normalize();
    const up = new THREE.Vector3().crossVectors(right, toTarget).normalize();
    const sp = stepMm ?? Math.min(800, Math.max(120, dist * 0.08));
    const delta = right.multiplyScalar(sx * sp).add(up.multiplyScalar(sy * sp));
    this.camera.position.add(delta);
    t.add(delta);
    this.controls.update();
  }

  /** @deprecated угол больше не крутим с панели — оставлен для совместимости, делает pan/zoom. */
  orbitCamera(yawDeg = 0, pitchDeg = 0) {
    if (pitchDeg) this.zoomCamera(pitchDeg > 0 ? 1 / 1.15 : 1.15);
    if (yawDeg) this.panCamera(yawDeg > 0 ? 1 : -1, 0);
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

    if (this.navMode === 'walk') {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      // WASD / стрелки — только перемещение (без поворота угла)
      let mx = 0, mz = 0;
      if (this.keysHeld.has('ArrowUp') || this.keysHeld.has('KeyW')) { mx += forward.x; mz += forward.z; }
      if (this.keysHeld.has('ArrowDown') || this.keysHeld.has('KeyS')) { mx -= forward.x; mz -= forward.z; }
      if (this.keysHeld.has('ArrowLeft') || this.keysHeld.has('KeyA')) { mx -= right.x; mz -= right.z; }
      if (this.keysHeld.has('ArrowRight') || this.keysHeld.has('KeyD')) { mx += right.x; mz += right.z; }

      if (this.walkDrag) {
        mx += forward.x * this.walkDrag.vz + right.x * this.walkDrag.vx;
        mz += forward.z * this.walkDrag.vz + right.z * this.walkDrag.vx;
      }

      if (mx || mz) {
        const len = Math.hypot(mx, mz) || 1;
        this.camera.position.x += (mx / len) * speed * dt;
        this.camera.position.z += (mz / len) * speed * dt;
      }
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

    // 2D-развёртка стены: стрелки/WASD — панорама в плоскости экрана, PgUp/Dn — зум
    if (this.navMode === 'wallElev') {
      let panX = 0, panY = 0, dolly = 0;
      if (this.keysHeld.has('ArrowLeft') || this.keysHeld.has('KeyA')) panX -= 1;
      if (this.keysHeld.has('ArrowRight') || this.keysHeld.has('KeyD')) panX += 1;
      if (this.keysHeld.has('ArrowUp') || this.keysHeld.has('KeyW')) panY += 1;
      if (this.keysHeld.has('ArrowDown') || this.keysHeld.has('KeyS')) panY -= 1;
      if (this.keysHeld.has('PageUp')) dolly -= 1;
      if (this.keysHeld.has('PageDown')) dolly += 1;
      if (this.walkDrag) { panX += this.walkDrag.vx; panY -= this.walkDrag.vz; }
      if (panX || panY) {
        const toTarget = this.controls.target.clone().sub(this.camera.position).normalize();
        const right = new THREE.Vector3().crossVectors(toTarget, new THREE.Vector3(0, 1, 0));
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
        else right.normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const half = Math.max(
          Math.abs(this.camera.right - this.camera.left),
          Math.abs(this.camera.top - this.camera.bottom),
        ) / (2 * Math.max(0.01, this.camera.zoom));
        const sp = Math.min(700, Math.max(120, half * 0.45)) * this._navSpeed() * dt;
        const delta = right.multiplyScalar(panX * sp).add(up.multiplyScalar(panY * sp));
        this.camera.position.add(delta);
        this.controls.target.add(delta);
        this.controls.update();
      }
      if (dolly) {
        this.zoomCamera(1 + dolly * 0.9 * dt * this._navSpeed());
      }
      return;
    }

    // Изометрия / спереди: WASD и стрелки — панорама и зум (угол не крутим)
    if (this.navMode === 'orbit' || this.navMode === 'front') {
      let panX = 0, panY = 0, dolly = 0;
      if (this.keysHeld.has('ArrowLeft') || this.keysHeld.has('KeyA')) panX -= 1;
      if (this.keysHeld.has('ArrowRight') || this.keysHeld.has('KeyD')) panX += 1;
      if (this.keysHeld.has('ArrowUp') || this.keysHeld.has('KeyW')) dolly -= 1; // приблизить
      if (this.keysHeld.has('ArrowDown') || this.keysHeld.has('KeyS')) dolly += 1; // отдалить
      if (this.keysHeld.has('PageUp')) dolly -= 1;
      if (this.keysHeld.has('PageDown')) dolly += 1;
      if (!panX && !panY && !dolly) return;
      const tgt = this.controls.target;
      const offset = this.camera.position.clone().sub(tgt);
      const dist = Math.max(400, offset.length());
      if (panX || panY) {
        const toTarget = tgt.clone().sub(this.camera.position).normalize();
        const right = new THREE.Vector3().crossVectors(toTarget, new THREE.Vector3(0, 1, 0));
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
        else right.normalize();
        const up = new THREE.Vector3().crossVectors(right, toTarget).normalize();
        const sp = Math.min(900, Math.max(150, dist * 0.55)) * this._navSpeed() * dt;
        const delta = right.multiplyScalar(panX * sp).add(up.multiplyScalar(panY * sp));
        this.camera.position.add(delta);
        tgt.add(delta);
      }
      if (dolly) {
        const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(tgt));
        sph.radius = THREE.MathUtils.clamp(
          sph.radius * (1 + dolly * 0.7 * dt * this._navSpeed()),
          400,
          60000,
        );
        offset.setFromSpherical(sph);
        this.camera.position.copy(tgt).add(offset);
      }
      this.camera.lookAt(tgt);
      this.controls.update();
    }
  }

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Точка на плоскости drag под курсором (не hit меша — иначе объект «улетает»). */
  _hitDragPlane(e, plane, out = new THREE.Vector3()) {
    if (!plane) return null;
    this.ray.setFromCamera(this._ndc(e), this.camera);
    if (!this.ray.ray.intersectPlane(plane, out)) return null;
    return out;
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
    const hit = this.ray.intersectObjects(planes, true)[0];
    if (hit) return hit;
    // Помещение скрыто — ставим на плоскость пола
    const pt = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt)) return { point: pt, object: { userData: { plane: 'floor' } } };
    return null;
  }

  // Для объектов: сначала мебель (столешница, корпус), потом пол/стены.
  // Настенные коммуникации (розетки/решётки) — сразу стена, без привязки к модулю.
  _hitForFixture(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const def = this.placeFixture ? FIXTURE_CATALOG[this.placeFixture] : null;
    const wallOnly = def && (def.kind === 'socket' || def.kind === 'vent' || def.kind === 'pipe');
    if (!wallOnly) {
      const meshes = [];
      this.furnGroup.traverse((o) => { if (o.userData?.pick && o.isMesh) meshes.push(o); });
      const f = this.ray.intersectObjects(meshes, false)[0];
      if (f && f.object.userData?.moduleId) return { point: f.point, moduleId: f.object.userData.moduleId, wall: null };
    }
    const p = this._hitPlane(e);
    if (!p) return null;
    const ud = p.object?.userData || {};
    // собрать wall/edgeIndex/nx по цепочке родителей (у меша-ребёнка nx мог не быть)
    let o = p.object;
    let wallUd = { ...ud };
    while (o) {
      if (o.userData) wallUd = { ...wallUd, ...o.userData };
      if (wallUd.nx != null && wallUd.nz != null && (wallUd.wall || wallUd.edgeIndex != null || wallUd.roomPart === 'wall')) break;
      o = o.parent;
    }
    // запасной вариант: нормаль из сегмента комнаты по edgeIndex
    if ((wallUd.nx == null || wallUd.nz == null) && wallUd.edgeIndex != null && this.room) {
      try {
        const seg = roomWallSegments3D(this.room).find((s) => s.edgeIndex === +wallUd.edgeIndex);
        if (seg) { wallUd.nx = seg.nx; wallUd.nz = seg.nz; }
      } catch (_) { /* */ }
    }
    return {
      point: p.point,
      moduleId: null,
      wall: wallUd.wall || (wallUd.plane === 'wall' ? 'edge' : null),
      edgeIndex: wallUd.edgeIndex,
      nx: wallUd.nx,
      nz: wallUd.nz,
    };
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
    this.dockGroup.traverse((o) => {
      if (o.userData?.dock && o.isMesh && o.parent?.name !== 'dockGhost') meshes.push(o);
    });
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
    this._dockHotSock = null;
    this._dockGhostKey = null;
    if (!this._dockActive() || this.mode !== 'select') return;
    const moverId = this.sel.moduleId || this.press?.moduleId || null;
    const socks = this.h.dockSockets?.(moverId) || [];
    for (const s of socks) {
      const g = new THREE.Group();
      g.position.set(s.hostX ?? s.x, 0, s.hostZ ?? s.z);
      g.rotation.y = ((s.rot || 0) * Math.PI) / 180;
      const lx = s.lx != null ? s.lx : 0;
      const ly = s.ly != null ? s.ly : 0;
      const lz = s.lz != null ? s.lz : 0;
      const stack = !!s.stack || s.stripMode === 'stack';
      // бок: вертикальная полоска; стек: горизонтальная пластина на верху/низу
      const hitGeo = stack
        ? new THREE.BoxGeometry(s.stripW || 300, 40, s.stripD || 500)
        : new THREE.BoxGeometry(56, s.stripH || 700, s.stripD || 500);
      const visGeo = stack
        ? new THREE.BoxGeometry(s.stripW || 300, 5, s.stripD || 500)
        : new THREE.BoxGeometry(5, s.stripH || 700, s.stripD || 500);
      const hit = new THREE.Mesh(
        hitGeo,
        new THREE.MeshBasicMaterial({
          color: 0x1f6feb, transparent: true, opacity: 0.05,
          depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      hit.position.set(lx, ly, lz);
      hit.userData.dock = s;
      hit.renderOrder = 19;
      const vis = new THREE.Mesh(
        visGeo,
        new THREE.MeshBasicMaterial({
          color: stack ? 0x0d9488 : 0x1f6feb, transparent: true, opacity: 0.55,
          depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      vis.position.set(lx, ly, lz);
      vis.userData.dock = s;
      vis.userData.dockVis = true;
      vis.renderOrder = 20;
      g.add(hit);
      g.add(vis);
      g.userData.dock = s;
      this.dockGroup.add(g);
    }
  }

  _clearDockGhost() {
    const old = this.dockGroup.getObjectByName('dockGhost');
    if (!old) return;
    old.traverse((c) => {
      c.geometry?.dispose?.();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose?.();
      }
    });
    this.dockGroup.remove(old);
    this._dockGhostKey = null;
  }

  _updateDockGhost() {
    // во время drag модуль сам на позе — ghost не нужен
    if (!this._dockHotId || this.press?.drag) {
      this._clearDockGhost();
      return;
    }
    const sock = this._dockHotSock;
    if (!sock?.pose || !sock.ghost) {
      this._clearDockGhost();
      return;
    }
    const { w, d, h, elev } = sock.ghost;
    const key = `${sock.pose.x}|${sock.pose.z}|${elev}|${sock.pose.rot}|${w}|${d}|${h}`;
    if (key === this._dockGhostKey && this.dockGroup.getObjectByName('dockGhost')) return;
    this._clearDockGhost();
    this._dockGhostKey = key;
    const g = new THREE.Group();
    g.name = 'dockGhost';
    g.position.set(sock.pose.x, 0, sock.pose.z);
    g.rotation.y = ((sock.pose.rot || 0) * Math.PI) / 180;
    // depthTest:false — без Z-fight мерцания с модулями
    const mat = new THREE.MeshBasicMaterial({
      color: 0x067647, transparent: true, opacity: 0.2,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    box.position.set(w * 0.5, elev + h * 0.5, d * 0.5);
    box.renderOrder = 22;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({
        color: 0x067647, transparent: true, opacity: 0.9,
        depthTest: false, depthWrite: false,
      }),
    );
    edges.position.copy(box.position);
    edges.renderOrder = 23;
    g.add(box);
    g.add(edges);
    g.traverse((o) => { o.raycast = () => {}; });
    this.dockGroup.add(g);
  }

  _setDockHot(id, sock = null) {
    if (this._dockHotId === id) {
      if (sock) this._dockHotSock = sock;
      return;
    }
    this._dockHotId = id;
    this._dockHotSock = id ? sock : null;
    this.dockGroup.traverse((o) => {
      if (!o.isMesh || !o.userData?.dock) return;
      if (o.parent?.name === 'dockGhost') return;
      const on = o.userData.dock.id === id;
      o.material.color.setHex(on ? 0x067647 : 0x1f6feb);
      if (o.userData.dockVis) o.material.opacity = on ? 0.9 : 0.5;
      else o.material.opacity = on ? 0.14 : 0.06;
    });
    this._updateDockGhost();
  }

  _down(e) {
    if (e.button !== 0 && e.button !== 2) return;
    this.ctrlHeld = e.ctrlKey || e.metaKey;
    this.shiftHeld = e.shiftKey;
    if (this.tapeMode && e.button === 0) {
      this.press = { x: e.clientX, y: e.clientY, tape: true };
      this.controls.enabled = false;
      return;
    }
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
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -info.y);
      const start = this._hitDragPlane(e, plane);
      if (!start) return;
      const hx = wh.object?.position?.x ?? wh.point?.x ?? start.x;
      const hz = wh.object?.position?.z ?? wh.point?.z ?? start.z;
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this._wallHandleDrag = info;
      this.press = {
        x: e.clientX, y: e.clientY,
        wallHandle: info,
        drag: true,
        plane,
        start: start.clone(),
        wallBase: { x: hx, z: hz },
      };
      this.h.onWallHandleDown?.(info);
      this._drawWallHandleBaseline();
      e.preventDefault();
      return;
    }

    // CAD-gizmo: коммуникации / объекты / конструкции
    const fh = this._hitFixHandle(e);
    if (fh?.object?.userData?.fixHandle) {
      const info = { ...fh.object.userData.fixHandle };
      const gizmoKind = info.kind || 'fixture';
      let origin = null;
      let fixBase = null;
      let rotX = 0, rotY = 0, rotZ = 0;
      if (gizmoKind === 'fixture') {
        const f = this._fixtureById.get(info.id);
        if (!f) { /* skip */ } else {
          const dims = fixtureDims(f);
          const c0 = fixtureCenter(f, dims);
          origin = new THREE.Vector3(c0.x, c0.y, c0.z);
          rotX = +f.rx || 0; rotY = +f.rot || 0; rotZ = +f.rz || 0;
          fixBase = {
            x: +f.x, z: +f.z, elev: +f.elev || 0,
            rot: rotY, rx: rotX, rz: rotZ,
            w: dims.w, d: dims.d, h: dims.h,
            kind: c0.kind,
          };
        }
      } else if (gizmoKind === 'obstacle') {
        const mesh = this.ctorObstacleMeshes.get(info.id);
        const ud = mesh?.userData;
        if (ud) {
          const w = +ud.w || 400, d = +ud.d || 400;
          const y0 = +ud.y0 || 0, y1 = +ud.y1 || 2700;
          const h = Math.max(10, y1 - y0);
          origin = new THREE.Vector3(+ud.x + w / 2, y0 + h / 2, +ud.z + d / 2);
          rotY = +ud.rot || 0;
          fixBase = {
            x: +ud.x, z: +ud.z, y0, y1, w, d, h, rot: rotY,
            elev: y0, kind: 'obstacle',
          };
        }
      } else if (gizmoKind === 'opening') {
        const pack = this.ctorOpeningMeshes.get(info.id);
        const op = (this.room?.openings || []).find((q) => q.id === info.id);
        if (pack?.mesh && op) {
          origin = new THREE.Vector3();
          pack.mesh.getWorldPosition(origin);
          fixBase = {
            offset: +op.offset || 0,
            sill: +op.sill || 0,
            width: +op.width || 900,
            height: +op.height || 1400,
            edgeIndex: op.edgeIndex != null ? +op.edgeIndex : null,
            wall: op.wall,
            kind: 'opening',
          };
          const wr = pack.wallRoot;
          if (wr) {
            const eul = new THREE.Euler().setFromQuaternion(wr.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');
            rotY = (eul.y * 180) / Math.PI;
          }
        }
      } else if (gizmoKind === 'module') {
        const m = (this.build?.items || []).find((q) => q.module?.id === info.id)?.module;
        if (m?.p) {
          const w = +m.p.width || 600, d = +m.p.depth || 560, h = +m.p.height || 720;
          const elev = +m.p.elev || 0;
          rotY = +m.rot || 0;
          const a = (rotY * Math.PI) / 180;
          const c = Math.cos(a), s = Math.sin(a);
          const lx = w * 0.5, lz = d * 0.5;
          origin = new THREE.Vector3(
            +m.x + lx * c + lz * s,
            elev + h * 0.5,
            +m.z - lx * s + lz * c,
          );
          fixBase = {
            x: +m.x, z: +m.z, rot: rotY, elev,
            w, d, h, kind: 'module',
          };
        }
      }
      if (origin && fixBase) {
        this.controls.enabled = false;
        try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
        this._fixHandleDrag = info;
        const axis = info.axis;
        const eul0 = new THREE.Euler(
          (rotX * Math.PI) / 180, (rotY * Math.PI) / 180, (rotZ * Math.PI) / 180, 'YXZ',
        );
        const m0 = new THREE.Matrix4().makeRotationFromEuler(eul0);
        const axX = new THREE.Vector3(1, 0, 0).applyMatrix4(m0).normalize();
        const axY = new THREE.Vector3(0, 1, 0).applyMatrix4(m0).normalize();
        const axZ = new THREE.Vector3(0, 0, 1).applyMatrix4(m0).normalize();
        let plane;
        let rotAxisWorld = null;
        if (axis === 'h' || axis === 'moveY') {
          plane = this._cameraVerticalPlane(origin);
        } else if (axis === 'rotX' || axis === 'rotY' || axis === 'rotZ') {
          rotAxisWorld = axis === 'rotX' ? axX : axis === 'rotY' ? axY : axZ;
          plane = new THREE.Plane().setFromNormalAndCoplanarPoint(rotAxisWorld.clone(), origin);
        } else {
          plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -origin.y);
        }
        const isRot = axis === 'rotX' || axis === 'rotY' || axis === 'rotZ';
        const startPt = (!isRot && plane) ? (this._hitDragPlane(e, plane) || fh.point) : fh.point;
        const startAng = isRot
          ? this._screenAngleAround(origin, e)
          : Math.atan2(startPt.z - origin.z, startPt.x - origin.x);
        this._setGizmoHover(axis);
        if (this.renderer?.domElement) this.renderer.domElement.style.cursor = 'grabbing';
        this.press = {
          x: e.clientX, y: e.clientY,
          fixHandle: info,
          drag: true,
          plane,
          start: startPt.clone(),
          startAng,
          screenRot: isRot,
          gizmoOrigin: origin.clone(),
          rotAxisWorld: rotAxisWorld?.clone?.() || null,
          fixBase,
        };
        e.preventDefault();
        return;
      }
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
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const start = this._hitDragPlane(e, plane);
      if (!start) return;
      this.sel = { moduleId: mid, panelKey: null, fixtureId: null, obstacleId: null, openingId: null };
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this.press.plane = plane;
      this.press.start = start.clone();
      this.press.drag = true;
      this.press.moduleId = mid;
      this.press.axisLock = !!e.shiftKey; // Shift = ортогональ вдоль ряда (ось стены)
      if (this._dockActive()) this._rebuildDocks();
      e.preventDefault();
    } else if (fix && fix.userData.fixtureId === this.sel.fixtureId) {
      const f = this._fixtureById.get(fix.userData.fixtureId);
      const dims = f ? fixtureDims(f) : null;
      const c0 = f && dims ? fixtureCenter(f, dims) : null;
      const elev = +(f?.elev || 0);
      // Shift — менять высоту от пола в вертикальной плоскости, иначе сдвиг по полу
      const vert = !!e.shiftKey;
      const plane = vert
        ? this._cameraVerticalPlane(new THREE.Vector3(c0?.x ?? +f.x, c0?.y ?? elev, c0?.z ?? +f.z))
        : new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const start = this._hitDragPlane(e, plane);
      if (!start) return;
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this.press.plane = plane;
      this.press.start = start.clone();
      this.press.drag = true;
      this.press.fixtureId = fix.userData.fixtureId;
      this.press.fixVert = vert;
      this.press.fixBase = f && dims
        ? {
          x: +f.x, z: +f.z, elev, rot: +f.rot || 0, rx: +f.rx || 0, rz: +f.rz || 0,
          w: dims.w, d: dims.d, h: dims.h, kind: FIXTURE_CATALOG[f.type]?.kind,
        }
        : null;
      e.preventDefault();
    } else if (ctorHit && (
      (ctorHit.ctorKind === 'obstacle' && (e.shiftKey || ctorHit.ctorId === this.sel.obstacleId))
      || (ctorHit.ctorKind === 'opening' && (e.shiftKey || ctorHit.ctorId === this.sel.openingId))
    )) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const start = this._hitDragPlane(e, plane);
      if (!start) return;
      this.sel = {
        moduleId: null, panelKey: null, fixtureId: null,
        obstacleId: ctorHit.ctorKind === 'obstacle' ? ctorHit.ctorId : null,
        openingId: ctorHit.ctorKind === 'opening' ? ctorHit.ctorId : null,
      };
      this.setRoomSelection(null);
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture?.(e.pointerId); } catch (_) { /* */ }
      this.press.plane = plane;
      this.press.start = start.clone();
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
      // sticky: при промахе ghost не гасим (иначе мигает, когда курсор на превью)
      if (d) this._setDockHot(d.id, d);
    }
    // hover подсветка элементов gizmo (когда не тянем)
    if (!this.press?.drag && !this._fixHandleDrag) {
      const fh = this._hitFixHandle(e);
      this._setGizmoHover(fh?.object?.userData?.fixHandle?.axis || null);
    }
    const pr = this.press;
    if (!pr || !pr.drag) return;
    if (!pr.dragging && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 4) return;
    if (!pr.dragging) {
      pr.dragging = true;
      this._clearDockGhost();
    }
    // поворот колец — только экранный угол (без плоскости, иначе срывается)
      if (pr.fixHandle && pr.screenRot) {
      const base = pr.fixBase || {};
      const axis = pr.fixHandle.axis;
      const gk = pr.fixHandle.kind || 'fixture';
      const origin = pr.gizmoOrigin || new THREE.Vector3(+base.x, +base.elev || 0, +base.z);
      const ang = this._screenAngleAround(origin, e);
      let delta = ((ang - (pr.startAng || 0)) * 180) / Math.PI;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      const snapAng = (deg) => {
        let d = deg % 360;
        if (d < 0) d += 360;
        const snapped = Math.round(d / 15) * 15;
        return Math.abs(snapped - d) < 4 ? snapped % 360 : Math.round(d);
      };
      const patch = {};
      if (axis === 'rotY') patch.rot = snapAng((+base.rot || 0) + delta);
      else if (axis === 'rotX') patch.rx = snapAng((+base.rx || 0) + delta);
      else patch.rz = snapAng((+base.rz || 0) + delta);
      pr.newFix = patch;
      if (gk === 'obstacle') this._applyObstacleLive(pr.fixHandle.id, base, patch, axis);
      else if (gk === 'opening') this._applyOpeningLive(pr.fixHandle.id, base, patch, axis);
      else if (gk === 'module') this._applyModuleLive(pr.fixHandle.id, base, patch, axis);
      else this._applyFixtureLive(pr.fixHandle.id, base, patch, axis);
      return;
    }
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const pt = new THREE.Vector3();
    if (!pr.plane || !this.ray.ray.intersectPlane(pr.plane, pt)) return;
    if (pr.wallHandle) {
      const bx = pr.wallBase?.x ?? pr.start?.x ?? pt.x;
      const bz = pr.wallBase?.z ?? pr.start?.z ?? pt.z;
      const nx = bx + (pt.x - (pr.start?.x ?? pt.x));
      const nz = bz + (pt.z - (pr.start?.z ?? pt.z));
      this.h.onWallHandleDrag?.(pr.wallHandle, nx, nz);
      // сдвинуть саму ручку визуально
      for (const o of this.wallHandleGroup.children) {
        const ud = o.userData?.wallHandle;
        if (ud && ud.vertIndex === pr.wallHandle.vertIndex && ud.layer === pr.wallHandle.layer) {
          o.position.x = nx;
          o.position.z = nz;
        }
      }
      return;
    }
    if (pr.fixHandle) {
      const base = pr.fixBase || {};
      const axis = pr.fixHandle.axis;
      const gk = pr.fixHandle.kind || 'fixture';
      const patch = {};
      const eul0 = new THREE.Euler(
        ((+base.rx || 0) * Math.PI) / 180,
        ((+base.rot || 0) * Math.PI) / 180,
        ((+base.rz || 0) * Math.PI) / 180,
        'YXZ',
      );
      const m0 = new THREE.Matrix4().makeRotationFromEuler(eul0);
      const xAxis = new THREE.Vector3(1, 0, 0).applyMatrix4(m0).normalize();
      const zAxis = new THREE.Vector3(0, 0, 1).applyMatrix4(m0).normalize();
      if (gk === 'obstacle') {
        const cx0 = +base.x + (+base.w || 0) / 2;
        const cz0 = +base.z + (+base.d || 0) / 2;
        if (axis === 'moveX') {
          const dx = pt.x - (pr.start?.x ?? cx0);
          const dz = pt.z - (pr.start?.z ?? cz0);
          const along = dx * xAxis.x + dz * xAxis.z;
          const ncx = cx0 + along * xAxis.x;
          const ncz = cz0 + along * xAxis.z;
          patch.x = Math.round((ncx - (+base.w || 0) / 2) / 10) * 10;
          patch.z = Math.round((ncz - (+base.d || 0) / 2) / 10) * 10;
        } else if (axis === 'moveZ') {
          const dx = pt.x - (pr.start?.x ?? cx0);
          const dz = pt.z - (pr.start?.z ?? cz0);
          const along = dx * zAxis.x + dz * zAxis.z;
          const ncx = cx0 + along * zAxis.x;
          const ncz = cz0 + along * zAxis.z;
          patch.x = Math.round((ncx - (+base.w || 0) / 2) / 10) * 10;
          patch.z = Math.round((ncz - (+base.d || 0) / 2) / 10) * 10;
        } else if (axis === 'moveXZ') {
          const ncx = Math.round(pt.x / 10) * 10;
          const ncz = Math.round(pt.z / 10) * 10;
          patch.x = ncx - (+base.w || 0) / 2;
          patch.z = ncz - (+base.d || 0) / 2;
        } else if (axis === 'moveY') {
          const h = +base.h || 100;
          const cy = Math.round(pt.y / 10) * 10;
          const y0 = Math.max(0, cy - h / 2);
          patch.y0 = Math.round(y0 / 10) * 10;
          patch.y1 = patch.y0 + h;
        } else if (axis === 'h') {
          const y0 = +base.y0 || 0;
          patch.y1 = Math.max(y0 + 40, Math.round(pt.y / 10) * 10);
          patch.h = patch.y1 - y0;
        } else if (axis === 'w') {
          const t = (pt.x - cx0) * xAxis.x + (pt.z - cz0) * xAxis.z;
          const nw = Math.max(50, Math.round(Math.abs(t) * 2 / 10) * 10);
          patch.w = nw;
          patch.x = Math.round((cx0 - nw / 2) / 10) * 10;
        } else if (axis === 'd') {
          const t = (pt.x - cx0) * zAxis.x + (pt.z - cz0) * zAxis.z;
          const nd = Math.max(50, Math.round(Math.abs(t) * 2 / 10) * 10);
          patch.d = nd;
          patch.z = Math.round((cz0 - nd / 2) / 10) * 10;
        }
        pr.newFix = { ...patch };
        this._applyObstacleLive(pr.fixHandle.id, base, patch, axis);
        return;
      }
      if (gk === 'opening') {
        if (axis === 'moveX' || axis === 'moveXZ') {
          try {
            const segs = roomWallSegments(this.room);
            let s = null;
            if (base.edgeIndex != null) s = segs[base.edgeIndex];
            else s = segs.find((q) => q.wall === base.wall) || segs[0];
            if (s && s.len > 1) {
              const tx = (s.x2 - s.x1) / s.len, tz = (s.z2 - s.z1) / s.len;
              const along = (pt.x - s.x1) * tx + (pt.z - s.z1) * tz;
              const ww = +base.width || 900;
              patch.offset = Math.max(0, Math.round((along - ww / 2) / 10) * 10);
            }
          } catch (_) { /* */ }
        } else if (axis === 'moveY') {
          const sill = Math.max(0, Math.round((pt.y - (+base.height || 1400) / 2) / 10) * 10);
          patch.sill = sill;
        } else if (axis === 'h') {
          const sill = +base.sill || 0;
          patch.height = Math.max(200, Math.round((pt.y - sill) / 10) * 10);
        } else if (axis === 'w') {
          const origin = pr.gizmoOrigin || pt;
          const dist = Math.hypot(pt.x - origin.x, pt.z - origin.z);
          patch.width = Math.max(200, Math.round(dist * 2 / 10) * 10);
        }
        pr.newFix = { ...patch };
        this._applyOpeningLive(pr.fixHandle.id, base, patch, axis);
        return;
      }
      if (gk === 'module') {
        // центр модуля в мире (для осей и resize)
        const a0 = ((+base.rot || 0) * Math.PI) / 180;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const ocx = +base.x + (+base.w || 0) * 0.5 * c0 + (+base.d || 0) * 0.5 * s0;
        const ocz = +base.z - (+base.w || 0) * 0.5 * s0 + (+base.d || 0) * 0.5 * c0;
        if (axis === 'moveX') {
          const dx = pt.x - (pr.start?.x ?? ocx);
          const dz = pt.z - (pr.start?.z ?? ocz);
          const along = dx * xAxis.x + dz * xAxis.z;
          let nx = +base.x + along * xAxis.x;
          let nz = +base.z + along * xAxis.z;
          const sn = this.h.snap?.(pr.fixHandle.id, nx, nz) || { x: nx, z: nz };
          patch.x = Math.round(sn.x / 10) * 10;
          patch.z = Math.round(sn.z / 10) * 10;
        } else if (axis === 'moveZ') {
          const dx = pt.x - (pr.start?.x ?? ocx);
          const dz = pt.z - (pr.start?.z ?? ocz);
          const along = dx * zAxis.x + dz * zAxis.z;
          let nx = +base.x + along * zAxis.x;
          let nz = +base.z + along * zAxis.z;
          const sn = this.h.snap?.(pr.fixHandle.id, nx, nz) || { x: nx, z: nz };
          patch.x = Math.round(sn.x / 10) * 10;
          patch.z = Math.round(sn.z / 10) * 10;
        } else if (axis === 'moveXZ') {
          const ncx = Math.round(pt.x / 10) * 10;
          const ncz = Math.round(pt.z / 10) * 10;
          // pt — на полу у центра; переводим в угол модуля
          let nx = ncx - (+base.w || 0) * 0.5 * c0 - (+base.d || 0) * 0.5 * s0;
          let nz = ncz + (+base.w || 0) * 0.5 * s0 - (+base.d || 0) * 0.5 * c0;
          const sn = this.h.snap?.(pr.fixHandle.id, nx, nz) || { x: nx, z: nz };
          patch.x = Math.round(sn.x / 10) * 10;
          patch.z = Math.round(sn.z / 10) * 10;
        } else if (axis === 'moveY') {
          const h = +base.h || 720;
          const cy = Math.round(pt.y / 10) * 10;
          patch.elev = Math.max(0, Math.round((cy - h / 2) / 10) * 10);
        } else if (axis === 'h') {
          const elev = +base.elev || 0;
          patch.h = Math.max(200, Math.round((pt.y - elev) / 10) * 10);
        } else if (axis === 'w') {
          const t = (pt.x - ocx) * xAxis.x + (pt.z - ocz) * xAxis.z;
          patch.w = Math.max(150, Math.round(Math.abs(t) * 2 / 10) * 10);
        } else if (axis === 'd') {
          const t = (pt.x - ocx) * zAxis.x + (pt.z - ocz) * zAxis.z;
          patch.d = Math.max(150, Math.round(Math.abs(t) * 2 / 10) * 10);
        }
        let applied = { ...patch };
        if (this._dockActive() && (patch.x != null || patch.z != null || patch.elev != null)) {
          const live = { ...base, ...patch };
          const socks = this.h.dockSockets?.(pr.fixHandle.id, {
            x: live.x, z: live.z, elev: live.elev,
          }) || [];
          let best = null, bestScore = Infinity;
          for (const s of socks) {
            if (!s.pose) continue;
            const dd = Math.hypot(s.pose.x - live.x, s.pose.z - live.z);
            if (s.stack) {
              if (dd > 110) continue;
              const score = dd + (s.hAlign === 'left' ? 0 : 14);
              if (score < bestScore) { bestScore = score; best = s; }
            } else if (dd <= 80) {
              const score = dd + (s.vAlign === 'bottom' ? 0 : 18);
              if (score < bestScore) { bestScore = score; best = s; }
            }
          }
          if (best?.pose) {
            applied = {
              ...applied,
              x: best.pose.x, z: best.pose.z,
              elev: best.pose.elev, rot: best.pose.rot,
            };
            this._setDockHot(best.id, best);
          }
        }
        pr.newFix = { ...applied };
        this._applyModuleLive(pr.fixHandle.id, base, applied, axis);
        return;
      }
      if (axis === 'moveX') {
        const dx = pt.x - (pr.start?.x ?? base.x);
        const dz = pt.z - (pr.start?.z ?? base.z);
        const along = dx * xAxis.x + dz * xAxis.z;
        patch.x = Math.round((base.x + along * xAxis.x) / 10) * 10;
        patch.z = Math.round((base.z + along * xAxis.z) / 10) * 10;
      } else if (axis === 'moveZ') {
        const dx = pt.x - (pr.start?.x ?? base.x);
        const dz = pt.z - (pr.start?.z ?? base.z);
        const along = dx * zAxis.x + dz * zAxis.z;
        patch.x = Math.round((base.x + along * zAxis.x) / 10) * 10;
        patch.z = Math.round((base.z + along * zAxis.z) / 10) * 10;
      } else if (axis === 'moveY') {
        // pt.y — центр; elev = низ (для труб центр − h/2)
        const cy = Math.round(pt.y / 10) * 10;
        const elev = (base.kind === 'socket' || base.kind === 'vent') ? cy : cy - (+base.h || 100) * 0.5;
        patch.elev = Math.max(0, Math.round(elev / 10) * 10);
      } else if (axis === 'moveXZ') {
        const ncx = Math.round(pt.x / 10) * 10;
        const ncz = Math.round(pt.z / 10) * 10;
        // для fixture x/z — опорная точка (как в данных), не обязательно центр
        patch.x = Math.round((+base.x + (ncx - (pr.start?.x ?? ncx))) / 10) * 10;
        patch.z = Math.round((+base.z + (ncz - (pr.start?.z ?? ncz))) / 10) * 10;
      } else if (axis === 'h') {
        const origin = pr.gizmoOrigin;
        const bottom = origin ? origin.y - (+base.h || 100) * 0.5 : (+base.elev || 0);
        patch.h = Math.max(40, Math.round((pt.y - bottom) / 10) * 10);
      } else if (axis === 'diam') {
        const dist = Math.hypot(pt.x - (+base.x || 0), pt.z - (+base.z || 0));
        const diam = Math.max(16, Math.round((dist - 36) * 2 / 2) * 2);
        patch.w = diam;
        patch.d = diam;
      } else if (axis === 'w') {
        const t = (pt.x - (+base.x || 0)) * xAxis.x + (pt.z - (+base.z || 0)) * xAxis.z;
        patch.w = Math.max(20, Math.round(Math.abs(t) * 2 / 5) * 5);
      } else if (axis === 'd') {
        const t = (pt.x - (+base.x || 0)) * zAxis.x + (pt.z - (+base.z || 0)) * zAxis.z;
        patch.d = Math.max(4, Math.round(Math.max(0, Math.abs(t) - 24) / 2) * 2);
      }
      pr.newFix = { ...patch };
      this._applyFixtureLive(pr.fixHandle.id, base, patch, axis);
      return;
    }
    if (pr.fixtureId && pr.fixBase) {
      const base = pr.fixBase;
      let patch = {};
      if (pr.fixVert || e.shiftKey) {
        const cy = Math.round(pt.y / 10) * 10;
        const elev = Math.max(0, Math.round((cy - ((base.kind === 'socket' || base.kind === 'vent') ? 0 : (base.h || 0) * 0.5)) / 10) * 10);
        patch = { elev };
      } else {
        const nx = Math.round((base.x + (pt.x - pr.start.x)) / 10) * 10;
        const nz = Math.round((base.z + (pt.z - pr.start.z)) / 10) * 10;
        patch = { x: nx, z: nz };
      }
      pr.newFix = patch;
      // gizmo едет вместе с предметом
      this._applyFixtureLive(pr.fixtureId, base, patch, null);
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
        // магнит: бок — по XZ; стек — по XZ (elev подтягивается к верху/низу)
        const curElev = +m.p.elev || 0;
        const socks = this.h.dockSockets?.(pr.moduleId, {
          x: nx, z: nz, elev: curElev,
        }) || [];
        let best = null, bestScore = Infinity;
        for (const s of socks) {
          if (!s.pose) continue;
          const dd = Math.hypot(s.pose.x - nx, s.pose.z - nz);
          if (s.stack) {
            if (dd > 110) continue;
            const hBias = s.hAlign === 'left' ? 0 : s.hAlign === 'right' ? 14 : 8;
            const score = dd + hBias;
            if (score < bestScore) { bestScore = score; best = s; }
          } else {
            if (dd > 80) continue;
            const vBias = s.vAlign === 'bottom' ? 0 : s.vAlign === 'top' ? 18 : 8;
            const score = dd + vBias;
            if (score < bestScore) { bestScore = score; best = s; }
          }
        }
        if (best) {
          sn = {
            x: best.pose.x, z: best.pose.z, rot: best.pose.rot,
            elev: best.pose.elev, dock: best,
          };
          this._setDockHot(best.id, best);
        }
      }
      pr.newPos = sn;
      const grp = this.modGroups.get(pr.moduleId);
      if (grp) {
        // elev в геометрии локальный — на время snap сдвигаем группу по Y
        const elevY = (sn.elev != null && sn.dock)
          ? (sn.elev - (+m.p.elev || 0))
          : 0;
        grp.position.set(sn.x, elevY, sn.z);
        if (sn.rot != null) grp.rotation.y = (sn.rot * Math.PI) / 180;
      }
      this.h.onDragging?.(pr.moduleId, sn.x, sn.z);
      this._scheduleLiveDims();
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
      this._scheduleLiveDims();
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
        const w = +base.width || 900;
        const offC = offset + w / 2;
        const y = sill + (+base.height || 1400) / 2;
        const thick = pack.wallRoot?.userData?.wallThick || 140;
        const place = pack.wallRoot?.userData?.placeOpening;
        if (place) {
          place(pack.mesh, offC, y, thick / 2);
          const sky = pack.mesh.userData?.exterior;
          if (sky) place(sky, offC, y, thick + 40);
        } else {
          pack.mesh.position.set(offC, y, thick / 2);
          const sky = pack.mesh.userData?.exterior;
          if (sky) sky.position.set(offC, y, thick + 40);
        }
      }
      this.h.onDraggingCtor?.('opening', pr.ctorId, pr.newCtor);
      this._scheduleLiveDims();
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

    if (pr.tape) {
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) <= 8) this._tapeClick(e);
      this._lastTap = null;
      return;
    }

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
      if (pr.fixHandle && pr.newFix) {
        this._fixHandleDrag = null;
        this._fixGizmoLive = null;
        this._gizmoHoverAxis = null;
        const gk = pr.fixHandle.kind || 'fixture';
        if (gk === 'obstacle') this.h.onPatchObstacle?.(pr.fixHandle.id, pr.newFix);
        else if (gk === 'opening') this.h.onPatchOpening?.(pr.fixHandle.id, pr.newFix);
        else if (gk === 'module') this.h.onPatchModule?.(pr.fixHandle.id, pr.newFix);
        else this.h.onResizeFixture?.(pr.fixHandle.id, pr.newFix);
        this._lastTap = null;
        return;
      }
      if (pr.fixtureId && pr.newFix) {
        this.h.onMoveFixture?.(pr.fixtureId, pr.newFix);
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
    if (pr.fixHandle) {
      this._fixHandleDrag = null;
      this._fixGizmoLive = null;
      this._gizmoHoverAxis = null;
      this._rebuildFixtureHandles();
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
      // key-repeat при удержании Ctrl иначе каждые ~30мс сносит ghost
      const was = this.ctrlHeld;
      this.ctrlHeld = true;
      if (!was && !this._navKeysDown()) {
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
      if (this.tapeMode) {
        if (this.tapePending) {
          this.tapePending = null;
          this._clearTapePreview();
          this.h.onTapeHint?.('Первая точка сброшена. Esc ещё раз — выключить рулетку.');
        } else {
          this.setTapeMode(false);
        }
        e.preventDefault();
        return;
      }
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
