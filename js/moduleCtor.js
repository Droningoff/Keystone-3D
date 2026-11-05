// Конструктор модуля: панели + фурнитура, drag/стрелки, скрытие, открытие фасадов.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MATERIALS } from './catalog.js?v=20261028n';
import {
  MODULE_TYPES, createModule, genModule, panelBox, panelSize, th, BUTT_SIDES, DEFAULT_MATS,
} from './model.js?v=20261028n';
import { toBazisScript } from './bazis.js?v=20261028n';
import { buildCatalogFitting } from './hardware.js?v=20261028n';
import {
  loadHwCatalog, hwItemsByCat, hwCategories, hwById,
  autoFittingsForModule, fittingsSummary, defaultFittingPose,
  enrichFitting, moveFittingsWithPanel, suggestHingeSlots,
} from './hwCatalog.js?v=20261028n';
import {
  movePanelBy, moveFittingBy, snapPanelDelta, resolvePanelDelta,
  makeDragPlane, rayPlaneHit, nearestHingeSlot,
} from './moduleInteract.js?v=20261028n';

const $ = (s) => document.querySelector(s);
const STORE = 'furniture-module-ctor-v4';

const state = {
  name: 'Новый модуль',
  type: 'base',
  p: { ...MODULE_TYPES.base.p },
  mat: { ...DEFAULT_MATS },
  panels: [],
  extras: [],
  fittings: [],
  hw: {},
  furniturePath: '',
  selKey: null,
  selFit: null,
  tool: 'move', // move | orbit
  hidden: {}, // key -> true
  openAmt: {}, // panelKey -> 0..1
  showHingeGhosts: true,
  frontsOpen: false,
};

let renderer, scene, camera, controls, root, ghostRoot;
let liveTimer = null;
let framingDone = false;
let fitSeq = 1;
let booted = false;
const meshByKey = new Map();
const fitMeshByKey = new Map();
const edgeByKey = new Map();
const doorPivotByKey = new Map();
let drag = null; // { kind:'panel'|'fit', key, plane, last, moved }
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();

function status(msg, kind = '') {
  const el = $('#modStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#b42318' : kind === 'ok' ? '#067647' : '';
}

function fillMatSelect(sel, prefer) {
  if (!sel) return;
  sel.innerHTML = '';
  for (const [id, m] of Object.entries(MATERIALS)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = m.name;
    sel.appendChild(o);
  }
  if (prefer && MATERIALS[prefer]) sel.value = prefer;
}

function hasDoors() {
  const drawers = +$('#pDrawers')?.value || 0;
  const doors = +$('#pDoors')?.value || 0;
  const type = $('#modType')?.value;
  if (type === 'base_drawers') return false;
  if (drawers > 0 && doors === 0) return false;
  return doors > 0;
}

function updateParamVisibility() {
  const hingeRow = $('#hingeRow');
  const doorsRow = $('#doorsRow');
  if (hingeRow) hingeRow.style.display = hasDoors() ? '' : 'none';
  if (doorsRow) doorsRow.style.display = $('#modType')?.value === 'base_drawers' ? 'none' : '';
}

function readTemplateParams() {
  const type = $('#modType').value;
  const def = MODULE_TYPES[type];
  state.type = type;
  const drawers = +$('#pDrawers').value || 0;
  let doors = +$('#pDoors').value;
  if (type === 'base_drawers' || (drawers > 0 && doors === 0)) doors = 0;
  state.p = {
    ...def.p,
    width: +$('#pW').value || def.p.width,
    height: +$('#pH').value || def.p.height,
    depth: +$('#pD').value || def.p.depth,
    plinth: +$('#pPlinth').value || 0,
    shelves: +$('#pShelves').value || 0,
    doors, drawers,
    hinge: hasDoors() ? ($('#pHinge').value || 'left') : 'left',
  };
  if (type === 'sink') state.p.back = false;
  state.mat = {
    carcass: $('#matCarc').value || DEFAULT_MATS.carcass,
    front: $('#matFront').value || DEFAULT_MATS.front,
    back: $('#matBack').value || DEFAULT_MATS.back,
  };
  state.name = $('#modName').value.trim() || 'Новый модуль';
}

function writeTemplateParams() {
  $('#modType').value = state.type;
  const P = state.p;
  $('#pW').value = P.width;
  $('#pH').value = P.height;
  $('#pD').value = P.depth;
  $('#pPlinth').value = P.plinth ?? 0;
  $('#pShelves').value = P.shelves ?? 0;
  $('#pDoors').value = P.doors === 'auto' ? (P.width > 600 ? 2 : 1) : (P.doors ?? 0);
  $('#pDrawers').value = P.drawers ?? 0;
  $('#pHinge').value = P.hinge || 'left';
  $('#modName').value = state.name;
  if ($('#matCarc')) $('#matCarc').value = state.mat.carcass;
  if ($('#matFront')) $('#matFront').value = state.mat.front;
  if ($('#matBack')) $('#matBack').value = state.mat.back;
  updateParamVisibility();
}

function moduleStub() {
  return {
    id: 'ctor1', type: state.type, name: state.name,
    x: 0, z: 0, rot: 0,
    p: { ...state.p }, mat: { ...state.mat },
    overrides: {}, open: {},
  };
}

function buildFromTemplate({ quiet = false } = {}) {
  readTemplateParams();
  updateParamVisibility();
  const m = createModule(state.type, 0, state.p, state.mat, { x: 0, z: 0, rot: 0 });
  m.name = state.name;
  const out = genModule(m);
  const prevKey = state.selKey;
  state.panels = out.panels.map((p) => ({
    ...p,
    butts: Array.isArray(p.butts) ? [...p.butts] : [null, null, null, null],
  }));
  state.extras = (out.extras || []).map((e) => ({ ...e }));
  state.hw = { ...(out.hw || {}) };
  state.fittings = autoFittingsForModule(m, state.panels);
  fitSeq = state.fittings.length + 1;
  state.selKey = state.panels.some((p) => p.key === prevKey) ? prevKey : (state.panels[0]?.key || null);
  state.selFit = null;
  // сброс скрытия/открытия под новый шаблон
  state.hidden = {};
  state.openAmt = {};
  state.frontsOpen = false;
  persist();
  renderPartList();
  renderFitList();
  renderPartProps();
  rebuildScene({ keepCamera: framingDone });
  framingDone = true;
  if (!quiet) {
    status(`«${MODULE_TYPES[state.type].title}»: ${state.panels.length} дет., ${state.fittings.length} фурн.`, 'ok');
  }
}

function scheduleTemplateRebuild() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => buildFromTemplate({ quiet: true }), 80);
}

function buildForExport() {
  const m = moduleStub();
  return {
    items: [{
      index: 1, title: state.name, module: m,
      panels: state.panels.filter((p) => p.orient === 'H' || p.orient === 'V' || p.orient === 'F'),
      extras: state.extras, hw: state.hw, fittings: state.fittings, virtual: false,
    }],
  };
}

function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      name: state.name, type: state.type, p: state.p, mat: state.mat,
      panels: state.panels, extras: state.extras, fittings: state.fittings,
      hw: state.hw, furniturePath: state.furniturePath,
      selKey: state.selKey, selFit: state.selFit,
      hidden: state.hidden, openAmt: state.openAmt, tool: state.tool,
      showHingeGhosts: state.showHingeGhosts, frontsOpen: state.frontsOpen,
    }));
  } catch (_) { /* ignore */ }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE)
      || localStorage.getItem('furniture-module-ctor-v3')
      || localStorage.getItem('furniture-module-ctor-v2');
    if (!raw) return false;
    const d = JSON.parse(raw);
    Object.assign(state, {
      name: d.name || state.name,
      type: d.type || 'base',
      p: { ...MODULE_TYPES[d.type || 'base']?.p, ...d.p },
      mat: { ...DEFAULT_MATS, ...d.mat },
      panels: Array.isArray(d.panels) ? d.panels : [],
      extras: Array.isArray(d.extras) ? d.extras : [],
      fittings: Array.isArray(d.fittings) ? d.fittings : [],
      hw: d.hw || {},
      furniturePath: d.furniturePath || '',
      selKey: d.selKey || null,
      selFit: d.selFit || null,
      hidden: d.hidden || {},
      openAmt: d.openAmt || {},
      tool: d.tool === 'orbit' ? 'orbit' : 'move',
      showHingeGhosts: d.showHingeGhosts !== false,
      frontsOpen: !!d.frontsOpen,
    });
    state.fittings.forEach(enrichFitting);
    fitSeq = state.fittings.length + 1;
    return state.panels.length > 0;
  } catch (_) { return false; }
}

function isHidden(key) {
  return !!state.hidden[key];
}

function applyToolToControls() {
  if (!controls) return;
  const orbit = state.tool === 'orbit';
  controls.enableRotate = orbit;
  controls.mouseButtons = {
    LEFT: orbit ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  // в move ЛКМ перехватываем сами — отключим rotate/pan на ЛКМ
  if (!orbit) controls.mouseButtons.LEFT = -1;
  canvasSetCursor(orbit ? 'grab' : 'default');
}

function setTool(tool) {
  state.tool = tool === 'orbit' ? 'orbit' : 'move';
  applyToolToControls();
  $('#btnToolMove')?.classList.toggle('active', state.tool === 'move');
  $('#btnToolOrbit')?.classList.toggle('active', state.tool === 'orbit');
  persist();
  status(state.tool === 'move' ? 'Режим: перемещение (ЛКМ drag, стрелки ±1 мм, Shift±10)' : 'Режим: обзор', 'ok');
}

function roleColor(role) {
  if (role === 'front') return 0x6ea8fe;
  if (role === 'back') return 0xb8c0cc;
  if (role === 'shelf' || role === 'drawer') return 0xd4c4a8;
  return 0xcfd4da;
}

function setPointer(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ptr.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
}

function pickObject(ev) {
  setPointer(ev);
  const objs = [];
  for (const m of meshByKey.values()) if (m.visible) objs.push(m);
  for (const m of fitMeshByKey.values()) if (m.visible) objs.push(m);
  if (ghostRoot?.visible) objs.push(ghostRoot);
  const hits = ray.intersectObjects(objs, true);
  if (!hits[0]) return null;
  let o = hits[0].object;
  while (o && !o.userData?.key && !o.userData?.fittingKey && !o.userData?.hingeGhost) o = o.parent;
  return o;
}

function initScene() {
  const host = $('#modViewport');
  host.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef1f4);
  camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  camera.position.set(1200, 900, 1600);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(300, 400, 280);
  controls.update();
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(800, 1400, 600);
  scene.add(dir);
  scene.add(new THREE.GridHelper(3000, 30, 0xc5ccd4, 0xdde2e8));
  root = new THREE.Group();
  ghostRoot = new THREE.Group();
  scene.add(root);
  scene.add(ghostRoot);
  scene.add(new THREE.AxesHelper(400));

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  window.addEventListener('keydown', onKeyDown);
  canvas.tabIndex = 0;

  const resize = () => {
    const w = Math.max(100, Math.min(host.clientWidth || 640, 4096));
    const h = Math.max(100, Math.min(host.clientHeight || 480, 4096));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(host);
  const tick = () => {
    requestAnimationFrame(tick);
    // анимация открытия фасадов
    for (const [key, info] of doorPivotByKey) {
      const target = state.openAmt[key] || 0;
      info.cur += (target - info.cur) * 0.18;
      if (info.kind === 'door') {
        info.pivot.rotation.y = (info.hinge === 'right' ? 1 : -1) * info.cur * (Math.PI / 2) * 0.95;
      } else if (info.kind === 'drawer') {
        info.pivot.position.z = info.baseZ + info.cur * (info.travel || 350);
      }
    }
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
  setTool(state.tool);
}

function onPointerDown(ev) {
  if (ev.button !== 0) return;
  renderer.domElement.focus();
  const o = pickObject(ev);
  if (o?.userData?.hingeGhost) {
    placeHingeAtSlot(o.userData.slot);
    return;
  }
  if (o?.userData?.fittingKey) {
    state.selFit = o.userData.fittingKey;
    state.selKey = null;
  } else if (o?.userData?.key) {
    state.selKey = o.userData.key;
    state.selFit = null;
  } else if (state.tool === 'move') {
    return;
  } else {
    return;
  }
  renderPartList(); renderFitList(); renderPartProps(); highlightSel();

  if (state.tool !== 'move') return;
  const center = new THREE.Vector3();
  if (state.selFit) {
    const f = selectedFit();
    if (!f) return;
    center.set((f.x1 + f.x2) / 2, (f.y1 + f.y2) / 2, (f.z1 + f.z2) / 2);
  } else {
    const p = selectedPanel();
    if (!p) return;
    const b = panelBox(p);
    center.set((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, (b.z1 + b.z2) / 2);
  }
  setPointer(ev);
  const plane = makeDragPlane(center, camera);
  const hit = rayPlaneHit(ray, plane);
  if (!hit) return;
  drag = {
    kind: state.selFit ? 'fit' : 'panel',
    key: state.selFit || state.selKey,
    plane,
    last: hit.clone(),
    moved: false,
  };
  controls.enabled = false;
  if (renderer?.domElement) renderer.domElement.style.cursor = 'grabbing';
}

function onPointerMove(ev) {
  if (!drag) return;
  setPointer(ev);
  const hit = rayPlaneHit(ray, drag.plane);
  if (!hit) return;
  let dx = hit.x - drag.last.x;
  let dy = hit.y - drag.last.y;
  let dz = hit.z - drag.last.z;
  if (ev.shiftKey) {
    // ось с наибольшим сдвигом
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ax >= ay && ax >= az) { dy = 0; dz = 0; }
    else if (ay >= ax && ay >= az) { dx = 0; dz = 0; }
    else { dx = 0; dy = 0; }
  }
  if (Math.hypot(dx, dy, dz) < 0.2) return;
  drag.moved = true;
  drag.last.copy(hit);
  if (drag.kind === 'panel') {
    const p = state.panels.find((x) => x.key === drag.key);
    if (!p) return;
    const prev = { ...p, butts: Array.isArray(p.butts) ? [...p.butts] : p.butts };
    const d = snapPanelDelta(p, state.panels, dx, dy, dz, 2);
    const next = movePanelBy(p, d.dx, d.dy, d.dz);
    Object.assign(p, next);
    moveFittingsWithPanel(state.fittings, prev, p);
  } else {
    const i = state.fittings.findIndex((x) => x.key === drag.key);
    if (i < 0) return;
    let f = moveFittingBy(state.fittings[i], dx, dy, dz);
    if (f.mesh === 'hinge' && state.showHingeGhosts) {
      const slot = nearestHingeSlot(f, suggestHingeSlots(state.panels), 28);
      if (slot) {
        f = {
          ...f,
          x1: slot.x1, y1: slot.y1, z1: slot.z1,
          x2: slot.x2, y2: slot.y2, z2: slot.z2,
          side: slot.side, panelKey: slot.panelKey,
        };
      }
    }
    state.fittings[i] = f;
  }
  rebuildScene({ keepCamera: true });
  if (state.selFit) renderPartProps();
  else renderPartProps();
}

function onPointerUp() {
  if (!drag) return;
  if (drag.moved) {
    persist();
    status(drag.kind === 'panel' ? 'Деталь сдвинута' : 'Фурнитура сдвинута', 'ok');
  }
  drag = null;
  controls.enabled = true;
  applyToolToControls();
}

function onDblClick(ev) {
  const o = pickObject(ev);
  const key = o?.userData?.key;
  if (!key) return;
  const p = state.panels.find((x) => x.key === key);
  if (!p || (p.openable !== 'door' && p.openable !== 'drawer')) return;
  const cur = state.openAmt[key] || 0;
  state.openAmt[key] = cur > 0.5 ? 0 : 1;
  persist();
  status(state.openAmt[key] ? 'Фасад открыт (двойной клик)' : 'Фасад закрыт', 'ok');
}

function onKeyDown(ev) {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA') return;
  const step = ev.shiftKey ? 10 : 1;
  if (ev.key === 'h' || ev.key === 'H') {
    if (state.selKey) toggleHidden(state.selKey);
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (state.selFit) deleteSelectedFit();
    else if (state.selKey) deleteSelectedPanel();
    return;
  }
  if (ev.key === 'Escape') {
    state.selKey = null; state.selFit = null;
    renderPartList(); renderFitList(); renderPartProps(); highlightSel();
    return;
  }
  const arrows = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0] };
  if (ev.key === 'PageUp') arrows.PageUp = [0, 0, -step];
  if (ev.key === 'PageDown') arrows.PageDown = [0, 0, step];
  // Ctrl+стрелки — по глубине
  if (ev.ctrlKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
    const dz = ev.key === 'ArrowUp' ? -step : step;
    nudgeSelected(0, 0, dz);
    ev.preventDefault();
    return;
  }
  const d = arrows[ev.key];
  if (!d) return;
  ev.preventDefault();
  nudgeSelected(d[0], d[1], d[2]);
}

function nudgeSelected(dx, dy, dz) {
  if (state.selFit) {
    const i = state.fittings.findIndex((x) => x.key === state.selFit);
    if (i < 0) return;
    state.fittings[i] = moveFittingBy(state.fittings[i], dx, dy, dz);
    persist();
    rebuildScene({ keepCamera: true });
    renderPartProps();
    status(`Сдвиг фурнитуры ${dx || 0},${dy || 0},${dz || 0} мм`, 'ok');
    return;
  }
  const p = selectedPanel();
  if (!p) return;
  const prev = { ...p, butts: Array.isArray(p.butts) ? [...p.butts] : p.butts };
  const d = resolvePanelDelta(p, state.panels, dx, dy, dz);
  const next = movePanelBy(p, d.dx, d.dy, d.dz);
  Object.assign(p, next);
  moveFittingsWithPanel(state.fittings, prev, p);
  persist();
  renderPartList();
  rebuildScene({ keepCamera: true });
  renderPartProps();
  status(`Сдвиг детали ${d.dx || 0},${d.dy || 0},${d.dz || 0} мм`, 'ok');
}

function canvasSetCursor(c) {
  if (renderer?.domElement) renderer.domElement.style.cursor = c;
}

function rebuildScene({ keepCamera = false } = {}) {
  while (root.children.length) {
    const o = root.children.pop();
    o.traverse((c) => {
      c.geometry?.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose();
      }
    });
  }
  while (ghostRoot.children.length) {
    const o = ghostRoot.children.pop();
    o.traverse((c) => { c.geometry?.dispose(); c.material?.dispose?.(); });
  }
  meshByKey.clear();
  fitMeshByKey.clear();
  edgeByKey.clear();
  doorPivotByKey.clear();
  let cx = 0, cy = 0, cz = 0, n = 0;

  for (const p of state.panels) {
    if (isHidden(p.key)) continue;
    const box = panelBox(p);
    const w = box.x2 - box.x1, h = box.y2 - box.y1, d = box.z2 - box.z1;
    if (w < 0.2 || h < 0.2 || d < 0.2) continue;
    const geo = new THREE.BoxGeometry(w, h, d);
    const isFront = p.role === 'front';
    const mat = new THREE.MeshStandardMaterial({
      color: MATERIALS[p.mat]?.color ?? roleColor(p.role),
      roughness: 0.82, metalness: 0, transparent: true,
      opacity: isFront ? 0.28 : p.role === 'back' ? 0.3 : 0.55,
      depthWrite: !isFront, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.key = p.key;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 18),
      new THREE.LineBasicMaterial({ color: isFront ? 0x1f6feb : 0x2a3038, transparent: true, opacity: 0.7 }),
    );
    edges.userData.key = p.key;
    const mx = (box.x1 + box.x2) / 2, my = (box.y1 + box.y2) / 2, mz = (box.z1 + box.z2) / 2;

    if (p.openable === 'door') {
      const pivot = new THREE.Group();
      const hx = p.hinge === 'right' ? box.x2 : box.x1;
      pivot.position.set(hx, my, mz);
      mesh.position.set(mx - hx, 0, 0);
      edges.position.copy(mesh.position);
      pivot.add(mesh); pivot.add(edges);
      root.add(pivot);
      doorPivotByKey.set(p.key, {
        pivot, hinge: p.hinge || 'left', kind: 'door',
        cur: state.openAmt[p.key] || 0,
      });
    } else if (p.openable === 'drawer') {
      const pivot = new THREE.Group();
      pivot.position.set(0, 0, 0);
      mesh.position.set(mx, my, mz);
      edges.position.copy(mesh.position);
      pivot.add(mesh); pivot.add(edges);
      root.add(pivot);
      doorPivotByKey.set(p.key, {
        pivot, kind: 'drawer', travel: p.openTravel || 350,
        baseZ: 0, cur: state.openAmt[p.key] || 0,
      });
    } else {
      mesh.position.set(mx, my, mz);
      edges.position.copy(mesh.position);
      root.add(mesh); root.add(edges);
    }
    meshByKey.set(p.key, mesh);
    edgeByKey.set(p.key, edges);
    cx += mx; cy += my; cz += mz; n++;
  }

  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xc5cad0, roughness: 0.25, metalness: 0.85,
  });
  for (const f of state.fittings) {
    if (f.panelKey && isHidden(f.panelKey)) continue;
    const hw = buildCatalogFitting(f, metalMat, { width: state.p.width });
    if (!hw) continue;
    root.add(hw);
    fitMeshByKey.set(f.key, hw);
  }

  rebuildHingeGhosts();

  if (n && !keepCamera) {
    controls.target.set(cx / n, cy / n, cz / n);
    controls.update();
  }
  highlightSel();
}

function rebuildHingeGhosts() {
  if (!state.showHingeGhosts) { ghostRoot.visible = false; return; }
  ghostRoot.visible = true;
  const slots = suggestHingeSlots(state.panels);
  const occupied = new Set(
    state.fittings.filter((f) => f.mesh === 'hinge').map((f) => {
      const cx = Math.round((f.x1 + f.x2) / 2);
      const cy = Math.round((f.y1 + f.y2) / 2);
      return `${f.panelKey}:${cx}:${cy}`;
    }),
  );
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b, transparent: true, opacity: 0.45, depthWrite: false, metalness: 0.3, roughness: 0.4,
  });
  for (const s of slots) {
    const cx = Math.round((s.x1 + s.x2) / 2);
    const cy = Math.round((s.y1 + s.y2) / 2);
    const id = `${s.panelKey}:${cx}:${cy}`;
    if (occupied.has(id)) continue;
    if (isHidden(s.panelKey)) continue;
    const g = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 12), mat.clone());
    g.position.set((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, (s.z1 + s.z2) / 2);
    g.userData = { hingeGhost: true, slot: s };
    ghostRoot.add(g);
  }
}

function placeHingeAtSlot(slot) {
  if (!slot) return;
  const pose = { ...slot, key: `hw_${fitSeq++}` };
  delete pose.doorKey; delete pose.y;
  state.fittings.push(pose);
  state.selFit = pose.key;
  state.selKey = null;
  persist();
  renderFitList(); renderPartList(); renderPartProps();
  rebuildScene({ keepCamera: true });
  status('Петля поставлена в слот', 'ok');
}

function placeSuggestedHinges() {
  const slots = suggestHingeSlots(state.panels);
  let added = 0;
  for (const s of slots) {
    const cx = Math.round((s.x1 + s.x2) / 2);
    const cy = Math.round((s.y1 + s.y2) / 2);
    const exists = state.fittings.some((f) => f.mesh === 'hinge' && f.panelKey === s.panelKey
      && Math.abs((f.x1 + f.x2) / 2 - cx) < 8 && Math.abs((f.y1 + f.y2) / 2 - cy) < 8);
    if (exists) continue;
    const pose = { ...s, key: `hw_${fitSeq++}` };
    delete pose.doorKey; delete pose.y;
    state.fittings.push(pose);
    added++;
  }
  persist();
  renderFitList();
  rebuildScene({ keepCamera: true });
  status(added ? `Добавлено петель: ${added}` : 'Слоты уже заняты', added ? 'ok' : '');
}

function toggleHidden(key) {
  if (!key) return;
  if (state.hidden[key]) delete state.hidden[key];
  else state.hidden[key] = true;
  persist();
  renderPartList();
  rebuildScene({ keepCamera: true });
}

function toggleHideFronts() {
  const fronts = state.panels.filter((p) => p.role === 'front' || p.openable);
  const allHidden = fronts.length && fronts.every((p) => state.hidden[p.key]);
  for (const p of fronts) {
    if (allHidden) delete state.hidden[p.key];
    else state.hidden[p.key] = true;
  }
  persist();
  renderPartList();
  rebuildScene({ keepCamera: true });
  status(allHidden ? 'Фасады показаны' : 'Фасады скрыты', 'ok');
}

function toggleOpenFronts() {
  state.frontsOpen = !state.frontsOpen;
  for (const p of state.panels) {
    if (p.openable === 'door' || p.openable === 'drawer') {
      state.openAmt[p.key] = state.frontsOpen ? 1 : 0;
    }
  }
  persist();
  status(state.frontsOpen ? 'Фасады открыты' : 'Фасады закрыты', 'ok');
}

function showAllParts() {
  state.hidden = {};
  persist();
  renderPartList();
  rebuildScene({ keepCamera: true });
  status('Все детали видны', 'ok');
}

function isolateSelected() {
  if (!state.selKey) { status('Выберите деталь', 'err'); return; }
  for (const p of state.panels) {
    state.hidden[p.key] = p.key !== state.selKey;
  }
  persist();
  renderPartList();
  rebuildScene({ keepCamera: true });
  status('Изоляция выбранной детали', 'ok');
}

function highlightSel() {
  for (const [key, mesh] of meshByKey) {
    const on = key === state.selKey;
    if (mesh.userData._baseOp == null) mesh.userData._baseOp = mesh.material.opacity;
    mesh.material.emissive = new THREE.Color(on ? 0x1f6feb : 0x000000);
    mesh.material.emissiveIntensity = on ? 0.35 : 0;
    mesh.material.opacity = on ? Math.max(0.75, mesh.userData._baseOp) : mesh.userData._baseOp;
  }
  for (const [key, obj] of fitMeshByKey) {
    const on = key === state.selFit;
    obj.traverse((c) => {
      if (!c.isMesh || !c.material?.emissive) return;
      c.material.emissive = new THREE.Color(on ? 0xc2410c : 0x000000);
      c.material.emissiveIntensity = on ? 0.45 : 0;
    });
  }
}

function renderPartList() {
  const list = $('#partList');
  $('#partCount').textContent = String(state.panels.length);
  list.innerHTML = '';
  for (const p of state.panels) {
    const sz = panelSize(p);
    const hid = isHidden(p.key);
    const open = state.openAmt[p.key] > 0.5;
    const row = document.createElement('div');
    row.className = 'part-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'part-item' + (p.key === state.selKey ? ' active' : '') + (hid ? ' dimmed' : '');
    btn.innerHTML = `<b>${p.name || p.key}</b><br><span class="role">${p.orient} · ${p.role} · ${Math.round(sz.L)}×${Math.round(sz.W)}×${Math.round(sz.T)}${open ? ' · открыт' : ''}</span>`;
    btn.addEventListener('click', () => {
      state.selKey = p.key; state.selFit = null;
      renderPartList(); renderFitList(); renderPartProps(); highlightSel();
    });
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'icon-btn';
    eye.title = hid ? 'Показать' : 'Скрыть (H)';
    eye.textContent = hid ? '👁‍🗨' : '👁';
    eye.addEventListener('click', (e) => { e.stopPropagation(); toggleHidden(p.key); });
    row.appendChild(btn);
    row.appendChild(eye);
    list.appendChild(row);
  }
}

function renderFitList() {
  const list = $('#fitList');
  $('#fitCount').textContent = String(state.fittings.length);
  list.innerHTML = '';
  for (const f of state.fittings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'part-item fit-item' + (f.key === state.selFit ? ' active' : '');
    btn.innerHTML = `<b>${f.name}</b><br><span class="role">${f.art || f.mesh} · ${f.side || ''}</span>`;
    btn.addEventListener('click', () => {
      state.selFit = f.key; state.selKey = null;
      renderPartList(); renderFitList(); renderPartProps(); highlightSel();
    });
    list.appendChild(btn);
  }
}

function selectedPanel() {
  return state.panels.find((p) => p.key === state.selKey) || null;
}
function selectedFit() {
  return state.fittings.find((f) => f.key === state.selFit) || null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderPartProps() {
  const host = $('#partProps');
  const f = selectedFit();
  if (f) {
    host.className = 'part-props';
    const panelOpts = state.panels.map((p) =>
      `<option value="${esc(p.key)}" ${f.panelKey === p.key ? 'selected' : ''}>${esc(p.name || p.key)}</option>`).join('');
    host.innerHTML = `
      <p><b>${esc(f.name)}</b><br><span class="muted">${esc(f.art || '—')} · ${esc(f.mesh)}${f.bazisFile ? ' · ' + esc(f.bazisFile) : ''}</span></p>
      <label>Деталь
        <select id="ffPanel"><option value="">—</option>${panelOpts}</select>
      </label>
      <label>Сторона
        <select id="ffSide">
          <option value="left" ${f.side === 'left' ? 'selected' : ''}>слева</option>
          <option value="right" ${f.side === 'right' ? 'selected' : ''}>справа</option>
        </select>
      </label>
      <div class="row2">
        <label>x1 <input type="number" id="ffX1" value="${f.x1}"></label>
        <label>y1 <input type="number" id="ffY1" value="${f.y1}"></label>
        <label>x2 <input type="number" id="ffX2" value="${f.x2}"></label>
        <label>y2 <input type="number" id="ffY2" value="${f.y2}"></label>
        <label>z1 <input type="number" id="ffZ1" value="${f.z1}"></label>
        <label>z2 <input type="number" id="ffZ2" value="${f.z2}"></label>
      </div>
      <p class="muted">Привязка к детали: сдвиг детали двигает фурнитуру</p>
    `;
    for (const id of ['ffPanel', 'ffSide', 'ffX1', 'ffY1', 'ffX2', 'ffY2', 'ffZ1', 'ffZ2']) {
      const el = $('#' + id);
      if (!el) continue;
      el.addEventListener('change', applyFitLive);
      if (el.tagName === 'INPUT') el.addEventListener('input', applyFitLive);
    }
    return;
  }

  const p = selectedPanel();
  if (!p) {
    host.className = 'muted';
    host.textContent = 'Выберите деталь или фурнитуру';
    return;
  }
  host.className = 'part-props';
  const sides = BUTT_SIDES[p.orient === 'F' ? 'F' : p.orient] || BUTT_SIDES.F;
  host.innerHTML = `
    <label>Имя <input id="ppName" value="${esc(p.name || '')}"></label>
    <label>Ключ <input id="ppKey" value="${esc(p.key)}"></label>
    <div class="row2">
      <label>Роль
        <select id="ppRole">
          ${['carcass', 'front', 'back', 'shelf', 'drawer'].map((r) =>
            `<option value="${r}" ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </label>
      <label>Ориент.
        <select id="ppOrient">
          ${['H', 'V', 'F'].map((o) =>
            `<option value="${o}" ${p.orient === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </label>
    </div>
    <label>Материал <select id="ppMat"></select></label>
    <div class="row2">
      <label>a1 <input type="number" step="1" id="ppA1" value="${p.a1}"></label>
      <label>b1 <input type="number" step="1" id="ppB1" value="${p.b1}"></label>
      <label>a2 <input type="number" step="1" id="ppA2" value="${p.a2}"></label>
      <label>b2 <input type="number" step="1" id="ppB2" value="${p.b2}"></label>
    </div>
    <div class="row2">
      <label>pos <input type="number" step="1" id="ppPos" value="${p.pos}"></label>
      <label>t, мм <input type="number" step="1" id="ppT" value="${p.t}"></label>
    </div>
    <p class="muted">Кромки: ${sides.join(' / ')}</p>
  `;
  fillMatSelect($('#ppMat'), p.mat);
  for (const id of ['ppName', 'ppKey', 'ppRole', 'ppOrient', 'ppMat', 'ppA1', 'ppB1', 'ppA2', 'ppB2', 'ppPos', 'ppT']) {
    const el = $('#' + id);
    if (!el) continue;
    el.addEventListener('change', applyPartPropsLive);
    if (el.tagName === 'INPUT' && el.type === 'number') el.addEventListener('input', applyPartPropsLive);
  }
}

function applyFitLive() {
  const f = selectedFit();
  if (!f) return;
  f.panelKey = $('#ffPanel')?.value || null;
  f.side = $('#ffSide').value;
  f.x1 = +$('#ffX1').value; f.y1 = +$('#ffY1').value; f.z1 = +$('#ffZ1').value;
  f.x2 = +$('#ffX2').value; f.y2 = +$('#ffY2').value; f.z2 = +$('#ffZ2').value;
  persist();
  rebuildScene({ keepCamera: true });
  status('Фурнитура обновлена', 'ok');
}

function applyPartPropsLive() {
  const p = selectedPanel();
  if (!p || !$('#ppName')) return;
  const snap = { ...p, butts: Array.isArray(p.butts) ? [...p.butts] : p.butts };
  const newKey = $('#ppKey').value.trim() || p.key;
  if (newKey !== p.key && state.panels.some((x) => x.key === newKey)) {
    status('Ключ уже занят', 'err'); return;
  }
  p.name = $('#ppName').value.trim() || p.name;
  p.role = $('#ppRole').value;
  p.orient = $('#ppOrient').value;
  p.mat = $('#ppMat').value;
  p.a1 = +$('#ppA1').value; p.b1 = +$('#ppB1').value;
  p.a2 = +$('#ppA2').value; p.b2 = +$('#ppB2').value;
  p.pos = +$('#ppPos').value;
  p.t = +$('#ppT').value || th(p.mat);
  if (newKey !== p.key) { p.key = newKey; state.selKey = newKey; }
  if (p.a1 > p.a2) [p.a1, p.a2] = [p.a2, p.a1];
  if (p.b1 > p.b2) [p.b1, p.b2] = [p.b2, p.b1];
  moveFittingsWithPanel(state.fittings, snap, p);
  persist();
  renderPartList();
  renderFitList();
  rebuildScene({ keepCamera: true });
  status('Деталь и связанная фурнитура обновлены', 'ok');
}

function renderHwCatalog() {
  const filter = $('#hwCatFilter')?.value || 'all';
  const host = $('#hwCatalog');
  host.innerHTML = '';
  for (const it of hwItemsByCat(filter)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hw-item';
    btn.innerHTML = `<b>${esc(it.name)}</b><br><span class="art">${esc(it.art || 'б/а')} · ${it.mesh}${it.samolet ? ` · Самолет×${it.samolet}` : ''}</span>`;
    btn.title = it.note || it.name;
    btn.addEventListener('click', () => addFittingFromCatalog(it.id));
    host.appendChild(btn);
  }
}

function addFittingFromCatalog(id) {
  const it = hwById(id);
  if (!it) return;
  const m = moduleStub();
  const pose = defaultFittingPose(it, m, selectedPanel());
  pose.key = `hw_${fitSeq++}`;
  state.fittings.push(pose);
  state.selFit = pose.key;
  state.selKey = null;
  persist();
  renderFitList();
  renderPartList();
  renderPartProps();
  rebuildScene({ keepCamera: true });
  status(`Добавлено: ${it.name}`, 'ok');
}

function deleteSelectedFit() {
  if (!state.selFit) { status('Выберите фурнитуру', 'err'); return; }
  const i = state.fittings.findIndex((f) => f.key === state.selFit);
  if (i < 0) return;
  state.fittings.splice(i, 1);
  state.selFit = state.fittings[i]?.key || state.fittings[i - 1]?.key || null;
  persist();
  renderFitList();
  renderPartProps();
  rebuildScene({ keepCamera: true });
  status('Фурнитура удалена', 'ok');
}

function addBlankPanel() {
  let i = 1;
  while (state.panels.some((p) => p.key === `custom_${i}`)) i++;
  const T = th(state.mat.carcass);
  const W = +state.p.width || 600, D = +state.p.depth || 560;
  state.panels.push({
    key: `custom_${i}`, name: `Деталь ${i}`, role: 'shelf', orient: 'H',
    a1: T, b1: 0, a2: W - T, b2: D - 20, pos: 300,
    mat: state.mat.carcass, t: T, butts: [null, null, null, null], grain: 'u',
  });
  state.selKey = `custom_${i}`; state.selFit = null;
  persist();
  renderPartList(); renderFitList(); renderPartProps();
  rebuildScene({ keepCamera: true });
}

function deleteSelectedPanel() {
  if (state.selFit) { deleteSelectedFit(); return; }
  if (!state.selKey) return;
  const i = state.panels.findIndex((p) => p.key === state.selKey);
  if (i < 0) return;
  const gone = state.selKey;
  state.panels.splice(i, 1);
  for (const f of state.fittings) {
    if (f.panelKey === gone) f.panelKey = null;
  }
  state.selKey = state.panels[i]?.key || state.panels[i - 1]?.key || null;
  persist();
  renderPartList(); renderFitList(); renderPartProps();
  rebuildScene({ keepCamera: true });
}

function download(name, text, mime = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function safeFile(s) {
  return String(s).replace(/[<>:"/\\|?*]+/g, '_').slice(0, 80) || 'module';
}

function saveJson() {
  readTemplateParams();
  state.furniturePath = ($('#furnPath')?.value || state.furniturePath || '').trim();
  state.fittings.forEach(enrichFitting);
  download(`${safeFile(state.name)}.json`, JSON.stringify({
    kind: 'module-ctor', version: 3,
    name: state.name, type: state.type, p: state.p, mat: state.mat,
    panels: state.panels, extras: state.extras, fittings: state.fittings, hw: state.hw,
    furniturePath: state.furniturePath,
  }, null, 2));
  persist();
  status('JSON сохранён', 'ok');
}

function loadJsonFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d || !Array.isArray(d.panels)) throw new Error('Нет panels[]');
      state.name = d.name || 'Модуль';
      state.type = d.type && MODULE_TYPES[d.type] ? d.type : 'base';
      state.p = { ...MODULE_TYPES[state.type].p, ...d.p };
      state.mat = { ...DEFAULT_MATS, ...d.mat };
      state.panels = d.panels;
      state.extras = d.extras || [];
      state.fittings = d.fittings || [];
      state.hw = d.hw || {};
      state.furniturePath = d.furniturePath || state.furniturePath || '';
      state.selKey = state.panels[0]?.key || null;
      state.selFit = null;
      state.fittings.forEach(enrichFitting);
      fitSeq = state.fittings.length + 1;
      writeTemplateParams();
      if ($('#furnPath')) $('#furnPath').value = state.furniturePath;
      persist();
      renderPartList(); renderFitList(); renderPartProps();
      rebuildScene({ keepCamera: false });
      framingDone = true;
      status(`Открыто: ${state.panels.length} дет., ${state.fittings.length} фурн.`, 'ok');
    } catch (e) { status('Ошибка JSON: ' + e.message, 'err'); }
  };
  reader.readAsText(file, 'utf-8');
}

function exportBazis() {
  readTemplateParams();
  if (!state.panels.length) { status('Нет деталей', 'err'); return; }
  state.furniturePath = ($('#furnPath')?.value || state.furniturePath || '').trim();
  state.fittings.forEach(enrichFitting);
  const script = toBazisScript({
    name: state.name,
    settings: {
      samoletPath: '',
      userCatalogPath: '',
      furniturePath: state.furniturePath,
    },
    furniturePath: state.furniturePath,
  }, buildForExport());
  const sum = fittingsSummary(state.fittings);
  download(`${safeFile(state.name)}.js`, script, 'text/javascript');
  status(`Скрипт Базиса: панели + OpenFurniture (${sum.reduce((s, x) => s + x.qty, 0)} шт.)`, 'ok');
}

function onTypeChange() {
  const type = $('#modType').value;
  const def = MODULE_TYPES[type];
  if (!def) return;
  $('#pW').value = def.p.width;
  $('#pH').value = def.p.height;
  $('#pD').value = def.p.depth;
  $('#pPlinth').value = def.p.plinth ?? 0;
  $('#pShelves').value = def.p.shelves ?? 0;
  $('#pDoors').value = def.p.doors === 'auto' ? (def.p.width > 600 ? 2 : 1) : (def.p.doors ?? 0);
  $('#pDrawers').value = def.p.drawers ?? 0;
  $('#pHinge').value = def.p.hinge || 'left';
  updateParamVisibility();
  clearTimeout(liveTimer);
  buildFromTemplate({ quiet: false });
}

function wire() {
  fillMatSelect($('#matCarc'), state.mat.carcass);
  fillMatSelect($('#matFront'), state.mat.front);
  fillMatSelect($('#matBack'), state.mat.back);

  const catSel = $('#hwCatFilter');
  catSel.innerHTML = '<option value="all">Все категории</option>';
  for (const c of hwCategories()) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.title;
    catSel.appendChild(o);
  }
  catSel.addEventListener('change', renderHwCatalog);
  renderHwCatalog();

  $('#modType').addEventListener('change', onTypeChange);
  for (const id of ['pW', 'pH', 'pD', 'pPlinth', 'pShelves', 'pDoors', 'pDrawers', 'pHinge']) {
    const el = $('#' + id);
    if (!el) continue;
    el.addEventListener('change', () => { updateParamVisibility(); scheduleTemplateRebuild(); });
    if (el.tagName === 'INPUT') el.addEventListener('input', () => { updateParamVisibility(); scheduleTemplateRebuild(); });
  }
  for (const id of ['matCarc', 'matFront', 'matBack']) {
    $('#' + id)?.addEventListener('change', scheduleTemplateRebuild);
  }
  $('#modName').addEventListener('change', () => {
    state.name = $('#modName').value.trim() || 'Новый модуль';
    persist();
  });

  $('#btnTpl').addEventListener('click', () => buildFromTemplate({ quiet: false }));
  $('#btnAddPanel').addEventListener('click', addBlankPanel);
  $('#btnDelPanel').addEventListener('click', deleteSelectedPanel);
  $('#btnDelFit').addEventListener('click', deleteSelectedFit);
  $('#btnSaveJson').addEventListener('click', saveJson);
  $('#btnLoadJson').addEventListener('click', () => $('#fileJson').click());
  $('#fileJson').addEventListener('change', () => {
    const f = $('#fileJson').files?.[0];
    if (f) loadJsonFile(f);
    $('#fileJson').value = '';
  });
  $('#btnBazis').addEventListener('click', exportBazis);
  if ($('#furnPath')) {
    $('#furnPath').value = state.furniturePath || '';
    $('#furnPath').addEventListener('change', () => {
      state.furniturePath = $('#furnPath').value.trim();
      persist();
      status('Папка .f3d: ' + (state.furniturePath || 'спросит Базис'), 'ok');
    });
  }

  $('#btnToolMove')?.addEventListener('click', () => setTool('move'));
  $('#btnToolOrbit')?.addEventListener('click', () => setTool('orbit'));
  $('#btnHideFronts')?.addEventListener('click', toggleHideFronts);
  $('#btnOpenFronts')?.addEventListener('click', toggleOpenFronts);
  $('#btnShowAll')?.addEventListener('click', showAllParts);
  $('#btnIsolate')?.addEventListener('click', isolateSelected);
  $('#btnHingeGhost')?.addEventListener('click', () => {
    state.showHingeGhosts = !state.showHingeGhosts;
    $('#btnHingeGhost')?.classList.toggle('active', state.showHingeGhosts);
    persist();
    rebuildScene({ keepCamera: true });
    status(state.showHingeGhosts ? 'Слоты петель: клик по оранжевой точке' : 'Слоты петель скрыты', 'ok');
  });
  $('#btnPlaceHinges')?.addEventListener('click', placeSuggestedHinges);
  $('#btnHingeGhost')?.classList.toggle('active', state.showHingeGhosts);
  setTool(state.tool);
}

async function boot() {
  if (booted) return;
  booted = true;
  try {
    await loadHwCatalog();
  } catch (e) {
    status('Каталог фурнитуры: ' + e.message, 'err');
  }
  try {
    initScene();
    wire();
    if (restore() && state.panels.length) {
      writeTemplateParams();
      if ($('#furnPath')) $('#furnPath').value = state.furniturePath || '';
      renderPartList(); renderFitList(); renderPartProps();
      rebuildScene({ keepCamera: false });
      framingDone = true;
      status(`Восстановлено: ${state.panels.length} дет., ${state.fittings.length} фурн.`, 'ok');
    } else {
      writeTemplateParams();
      buildFromTemplate({ quiet: false });
    }
  } catch (e) {
    console.error(e);
    status('Ошибка запуска: ' + e.message, 'err');
  }
}

boot();
