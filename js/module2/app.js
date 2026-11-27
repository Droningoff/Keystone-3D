/**
 * Конструктор модулей v2 — шаблоны + правила + инструменты + правка + Базис.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MATERIALS } from '../catalog.js?v=20261028v2b';
import { panelBox, panelSize } from '../model.js?v=20261028v2b';
import { buildCatalogFitting } from '../hardware.js?v=20261028v2b';
import { toBazisScript } from '../bazis.js?v=20261028v2b';
import {
  movePanelBy, moveFittingBy, snapPanelDelta, makeDragPlane,
} from '../moduleInteract.js?v=20261028v2b';
import {
  TYPOLOGIES, RULES, RULES_DEFAULT, applyRules, resetRules, cloneRules,
} from './rules.js?v=20261028v2b';
import { generateModule } from './generator.js?v=20261028v2b';
import { gatePage } from '../authGate.js?v=20261127g';

const $ = (s) => document.querySelector(s);
const STORE = 'furniture-module-ctor-v2-doc';
const RULES_STORE = 'furniture-module-ctor-v2-rules';

const state = {
  typology: 'base',
  name: 'Новый модуль',
  p: { ...TYPOLOGIES.base.defaults },
  mat: { carcass: 'ldsp16_white', front: 'mdf18_white_gloss', back: 'hdf3_white' },
  panels: [],
  fittings: [],
  extras: [],
  issues: [],
  selKey: null,
  tool: 'orbit',
  ghost: true,
  openFronts: false,
  openAmt: {},
  hiddenRoles: {},
  hiddenKeys: {},
  furniturePath: '',
};

let renderer, scene, camera, controls, root;
let framingDone = false;
let drag = null;
const meshByKey = new Map();
const doorPivots = new Map();
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();

function status(msg, kind = '') {
  const el = $('#v2Status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#b42318' : kind === 'ok' ? '#067647' : '';
}

function rebuild() {
  const out = generateModule({
    typology: state.typology,
    title: state.name,
    p: state.p,
    mat: state.mat,
  });
  state.panels = out.panels;
  state.fittings = out.fittings;
  state.extras = out.extras;
  state.issues = out.issues;
  state.hiddenKeys = {};
  state.openAmt = {};
  if (!state.panels.some((p) => p.key === state.selKey)) state.selKey = state.panels[0]?.key || null;
  persist();
  renderTree();
  renderIssues();
  renderParams();
  rebuildScene({ keepCamera: framingDone });
  framingDone = true;
  const err = state.issues.filter((i) => i.level === 'error').length;
  const warn = state.issues.filter((i) => i.level === 'warn').length;
  status(
    `${TYPOLOGIES[state.typology].title}: ${state.panels.length} дет. · ${state.fittings.length} фурн.`
      + (err ? ` · ошибок ${err}` : '') + (warn ? ` · предупр. ${warn}` : ''),
    err ? 'err' : 'ok',
  );
}

function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      typology: state.typology, name: state.name, p: state.p, mat: state.mat,
      ghost: state.ghost, openFronts: state.openFronts, tool: state.tool,
      furniturePath: state.furniturePath,
    }));
  } catch (_) { /* */ }
}

function restore() {
  try {
    const savedRules = JSON.parse(localStorage.getItem(RULES_STORE) || 'null');
    if (savedRules && typeof savedRules === 'object') applyRules(savedRules);
    const d = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!d) return false;
    if (d.typology && TYPOLOGIES[d.typology]) state.typology = d.typology;
    state.name = d.name || state.name;
    state.p = { ...TYPOLOGIES[state.typology].defaults, ...d.p };
    state.mat = { ...state.mat, ...d.mat };
    state.ghost = d.ghost !== false;
    state.openFronts = !!d.openFronts;
    state.tool = d.tool === 'move' ? 'move' : 'orbit';
    state.furniturePath = d.furniturePath || '';
    return true;
  } catch (_) { return false; }
}

function persistRules() {
  try { localStorage.setItem(RULES_STORE, JSON.stringify(cloneRules(RULES))); } catch (_) { /* */ }
}

function roleColor(role) {
  if (role === 'front') return 0x6ea8fe;
  if (role === 'back') return 0xb8c0cc;
  if (role === 'shelf') return 0xd4c4a8;
  return 0xcfd4da;
}

function pickObject(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ptr.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hits = ray.intersectObjects([...meshByKey.values()], true);
  if (!hits[0]) return null;
  let o = hits[0].object;
  while (o && !o.userData?.key) o = o.parent;
  return o?.userData?.key || null;
}

function initScene() {
  const host = $('#v2Viewport');
  host.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f2f5);
  camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  camera.position.set(1400, 1100, 1800);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(300, 500, 280);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(900, 1600, 700);
  scene.add(dir);
  scene.add(new THREE.GridHelper(4000, 40, 0xc5ccd4, 0xe2e6eb));
  root = new THREE.Group();
  scene.add(root);
  scene.add(new THREE.AxesHelper(500));

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('dblclick', (ev) => {
    const key = pickObject(ev);
    const p = state.panels.find((x) => x.key === key);
    if (p?.openable) {
      const cur = state.openAmt[p.key] || 0;
      state.openAmt[p.key] = cur > 0.5 ? 0 : 1;
    }
  });
  window.addEventListener('keydown', onKeyDown);

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
    for (const [key, info] of doorPivots) {
      const target = state.openFronts ? 1 : (state.openAmt[key] || 0);
      info.cur += (target - info.cur) * 0.16;
      if (info.kind === 'door') {
        info.pivot.rotation.y = (info.hinge === 'right' ? 1 : -1) * info.cur * Math.PI * 0.48;
      } else {
        info.pivot.position.z = info.cur * (info.travel || 350);
      }
    }
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
}

function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const key = pickObject(ev);
  if (key) {
    state.selKey = key;
    renderTree();
    highlight();
    renderPartInfo();
  }
  if (state.tool !== 'move' || !key) return;
  const p = state.panels.find((x) => x.key === key);
  if (!p) return;
  const box = panelBox(p);
  const center = new THREE.Vector3(
    (box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, (box.z1 + box.z2) / 2,
  );
  const plane = makeDragPlane(center, camera);
  ray.setFromCamera(ptr, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, hit)) return;
  drag = { key, plane, last: hit.clone(), moved: false };
  controls.enabled = false;
  ev.preventDefault();
}

function onPointerMove(ev) {
  if (!drag) return;
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ptr.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(drag.plane, hit)) return;
  let dx = hit.x - drag.last.x;
  let dy = hit.y - drag.last.y;
  let dz = hit.z - drag.last.z;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && Math.abs(dz) < 0.01) return;
  const p = state.panels.find((x) => x.key === drag.key);
  if (!p) return;
  const d = snapPanelDelta(p, state.panels, dx, dy, dz);
  const next = movePanelBy(p, d.dx, d.dy, d.dz);
  const idx = state.panels.findIndex((x) => x.key === drag.key);
  state.panels[idx] = next;
  // сдвиг связанной фурнитуры
  state.fittings = state.fittings.map((f) => (
    f.panelKey === drag.key ? moveFittingBy(f, d.dx, d.dy, d.dz) : f
  ));
  drag.last.copy(hit);
  drag.moved = true;
  rebuildScene({ keepCamera: true });
}

function onPointerUp() {
  if (!drag) return;
  if (drag.moved) {
    persist();
    status('Деталь сдвинута (стрелки ±1 / Shift±10)', 'ok');
  }
  drag = null;
  controls.enabled = state.tool === 'orbit';
}

function onKeyDown(ev) {
  if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const step = ev.shiftKey ? 10 : 1;
  if (ev.key === 'h' || ev.key === 'H') {
    if (!state.selKey) return;
    state.hiddenKeys[state.selKey] = !state.hiddenKeys[state.selKey];
    rebuildScene({ keepCamera: true });
    renderPartInfo();
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (!state.selKey) return;
    // параметрическое удаление: полка/дверь/ящик → уменьшить счётчик и пересобрать
    const p = state.panels.find((x) => x.key === state.selKey);
    if (!p) return;
    if (p.role === 'shelf' && (state.p.shelves || 0) > 0) {
      state.p.shelves -= 1; renderParams(); rebuild(); return;
    }
    if (p.openable === 'door' && (state.p.doors || 0) > 0) {
      state.p.doors -= 1; renderParams(); rebuild(); return;
    }
    if (p.openable === 'drawer' && (state.p.drawers || 0) > 0) {
      state.p.drawers -= 1; renderParams(); rebuild(); return;
    }
    if (/^div_/.test(p.key) && (state.p.sections || 1) > 1) {
      state.p.sections -= 1; renderParams(); rebuild(); return;
    }
    return;
  }
  const arrows = {
    ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0],
    ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0],
  };
  if (ev.ctrlKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
    ev.preventDefault();
    nudgeSelected(0, 0, ev.key === 'ArrowUp' ? -step : step);
    return;
  }
  if (!(ev.key in arrows)) return;
  ev.preventDefault();
  const d = arrows[ev.key];
  nudgeSelected(d[0], d[1], d[2]);
}

function nudgeSelected(dx, dy, dz) {
  if (!state.selKey) return;
  const idx = state.panels.findIndex((x) => x.key === state.selKey);
  if (idx < 0) return;
  const p = state.panels[idx];
  const d = snapPanelDelta(p, state.panels, dx, dy, dz);
  state.panels[idx] = movePanelBy(p, d.dx, d.dy, d.dz);
  state.fittings = state.fittings.map((f) => (
    f.panelKey === state.selKey ? moveFittingBy(f, d.dx, d.dy, d.dz) : f
  ));
  rebuildScene({ keepCamera: true });
  renderPartInfo();
  persist();
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
  meshByKey.clear();
  doorPivots.clear();
  let cx = 0, cy = 0, cz = 0, n = 0;
  const ghost = state.ghost;

  for (const p of state.panels) {
    if (state.hiddenRoles[p.role]) continue;
    if (state.hiddenKeys[p.key]) continue;
    const box = panelBox(p);
    const w = box.x2 - box.x1, h = box.y2 - box.y1, d = box.z2 - box.z1;
    if (w < 0.2 || h < 0.2 || d < 0.2) continue;
    const geo = new THREE.BoxGeometry(w, h, d);
    const isFront = p.role === 'front';
    const mat = new THREE.MeshStandardMaterial({
      color: MATERIALS[p.mat]?.color ?? roleColor(p.role),
      roughness: 0.8, metalness: 0.02, transparent: true,
      opacity: ghost ? (isFront ? 0.3 : p.role === 'back' ? 0.25 : 0.55) : (isFront ? 0.92 : 1),
      depthWrite: !ghost || !isFront, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.key = p.key;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 18),
      new THREE.LineBasicMaterial({ color: isFront ? 0x1f6feb : 0x3a4048, transparent: true, opacity: 0.65 }),
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
      doorPivots.set(p.key, { pivot, hinge: p.hinge || 'left', kind: 'door', cur: 0 });
    } else if (p.openable === 'drawer') {
      const pivot = new THREE.Group();
      mesh.position.set(mx, my, mz);
      edges.position.copy(mesh.position);
      pivot.add(mesh); pivot.add(edges);
      root.add(pivot);
      doorPivots.set(p.key, { pivot, kind: 'drawer', travel: p.openTravel || 350, cur: 0 });
    } else {
      mesh.position.set(mx, my, mz);
      edges.position.copy(mesh.position);
      root.add(mesh); root.add(edges);
    }
    meshByKey.set(p.key, mesh);
    cx += mx; cy += my; cz += mz; n++;
  }

  const metal = new THREE.MeshStandardMaterial({ color: 0xc5cad0, roughness: 0.28, metalness: 0.85 });
  for (const f of state.fittings) {
    if (f.panelKey) {
      const hostP = state.panels.find((p) => p.key === f.panelKey);
      if (hostP && (state.hiddenRoles[hostP.role] || state.hiddenKeys[hostP.key])) continue;
    }
    const hw = buildCatalogFitting(f, metal, { width: state.p.width });
    if (hw) root.add(hw);
  }

  for (const e of state.extras) {
    if (e.type !== 'rod') continue;
    const len = e.x2 - e.x1;
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 10, len, 16),
      new THREE.MeshStandardMaterial({ color: 0xb0b6be, metalness: 0.9, roughness: 0.25 }),
    );
    rod.rotation.z = Math.PI / 2;
    rod.position.set((e.x1 + e.x2) / 2, e.y, e.z);
    root.add(rod);
  }

  if (n && !keepCamera) {
    controls.target.set(cx / n, cy / n, cz / n);
    controls.update();
  }
  highlight();
  renderPartInfo();
}

function highlight() {
  for (const [key, mesh] of meshByKey) {
    const on = key === state.selKey;
    if (mesh.userData._baseOp == null) mesh.userData._baseOp = mesh.material.opacity;
    mesh.material.emissive = new THREE.Color(on ? 0x1f6feb : 0x000000);
    mesh.material.emissiveIntensity = on ? 0.4 : 0;
    mesh.material.opacity = on ? Math.max(0.8, mesh.userData._baseOp) : mesh.userData._baseOp;
  }
}

function renderTypologyCards() {
  const host = $('#v2Types');
  host.innerHTML = '';
  for (const t of Object.values(TYPOLOGIES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'v2-type' + (t.id === state.typology ? ' active' : '');
    btn.innerHTML = `<b>${t.title}</b><span>${t.defaults.width}×${t.defaults.height}×${t.defaults.depth}</span>`;
    btn.addEventListener('click', () => {
      state.typology = t.id;
      state.p = { ...t.defaults };
      state.name = t.title;
      $('#v2Name').value = state.name;
      renderTypologyCards();
      rebuild();
    });
    host.appendChild(btn);
  }
}

function renderParams() {
  const P = state.p;
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('#v2W', P.width);
  set('#v2H', P.height);
  set('#v2D', P.depth);
  set('#v2Plinth', P.plinth ?? 0);
  set('#v2Shelves', P.shelves ?? 0);
  set('#v2Doors', P.doors === 'auto' ? 1 : (P.doors ?? 0));
  set('#v2Drawers', P.drawers ?? 0);
  set('#v2Sections', P.sections ?? 1);
  set('#v2Antresol', P.antresol ?? 0);
  set('#v2Hinge', P.hinge || 'left');
  const rodEl = $('#v2Rod');
  if (rodEl) rodEl.checked = !!P.rod;
  $('#v2Name').value = state.name;
  const doorRow = $('#v2DoorRow');
  const hingeRow = $('#v2HingeRow');
  if (doorRow) doorRow.style.display = state.typology === 'base_drawers' ? 'none' : '';
  if (hingeRow) hingeRow.style.display = +P.doors > 0 && state.typology !== 'base_drawers' ? '' : 'none';
  $('#v2ToolMove')?.classList.toggle('active', state.tool === 'move');
  $('#v2ToolOrbit')?.classList.toggle('active', state.tool === 'orbit');
  $('#v2RodBtn')?.classList.toggle('active', !!P.rod);
}

function readParams() {
  state.name = $('#v2Name').value.trim() || 'Новый модуль';
  state.p.width = +$('#v2W').value || state.p.width;
  state.p.height = +$('#v2H').value || state.p.height;
  state.p.depth = +$('#v2D').value || state.p.depth;
  state.p.plinth = +$('#v2Plinth').value || 0;
  state.p.shelves = +$('#v2Shelves').value || 0;
  state.p.doors = +$('#v2Doors').value || 0;
  state.p.drawers = +$('#v2Drawers').value || 0;
  state.p.sections = Math.max(1, Math.min(4, +$('#v2Sections')?.value || 1));
  state.p.antresol = Math.max(0, +$('#v2Antresol')?.value || 0);
  state.p.hinge = $('#v2Hinge').value || 'left';
  const rodEl = $('#v2Rod');
  if (rodEl) state.p.rod = !!rodEl.checked;
  if (state.typology === 'base_drawers') { state.p.doors = 0; state.p.shelves = 0; }
  if (state.typology === 'sink') state.p.back = false;
}

function bumpParam(key, delta, min = 0, max = 12) {
  readParams();
  const cur = +state.p[key] || 0;
  state.p[key] = Math.max(min, Math.min(max, cur + delta));
  renderParams();
  rebuild();
}

function renderTree() {
  const host = $('#v2Tree');
  host.innerHTML = '';
  const groups = { carcass: [], front: [], shelf: [], back: [], other: [] };
  for (const p of state.panels) {
    const g = groups[p.role] ? p.role : 'other';
    groups[g].push(p);
  }
  const titles = { carcass: 'Корпус', front: 'Фасады', shelf: 'Полки', back: 'Задние', other: 'Прочее' };
  for (const [g, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const h = document.createElement('div');
    h.className = 'v2-tree-h';
    h.textContent = titles[g];
    host.appendChild(h);
    for (const p of list) {
      const sz = panelSize(p);
      const btn = document.createElement('button');
      btn.type = 'button';
      const hid = state.hiddenKeys[p.key] ? ' (скрыта)' : '';
      btn.className = 'v2-tree-item' + (p.key === state.selKey ? ' active' : '');
      btn.textContent = `${p.name}${hid}  ${Math.round(sz.L)}×${Math.round(sz.W)}×${Math.round(sz.T)}`;
      btn.addEventListener('click', () => {
        state.selKey = p.key;
        renderTree();
        highlight();
        renderPartInfo();
      });
      host.appendChild(btn);
    }
  }
  if (state.extras.some((e) => e.type === 'rod')) {
    const h = document.createElement('div');
    h.className = 'v2-tree-h';
    h.textContent = 'Штанги';
    host.appendChild(h);
    state.extras.filter((e) => e.type === 'rod').forEach((e, i) => {
      const d = document.createElement('div');
      d.className = 'v2-tree-item muted';
      d.textContent = `Штанга с${e.bay || i + 1}  y=${Math.round(e.y)}`;
      host.appendChild(d);
    });
  }
}

function renderIssues() {
  const host = $('#v2Issues');
  host.innerHTML = '';
  if (!state.issues.length) {
    host.innerHTML = '<p class="ok">Правила: нарушений нет</p>';
    return;
  }
  for (const i of state.issues) {
    const d = document.createElement('div');
    d.className = 'v2-issue ' + i.level;
    d.textContent = (i.level === 'error' ? '⛔ ' : '⚠ ') + i.msg;
    host.appendChild(d);
  }
}

function renderPartInfo() {
  const host = $('#v2PartInfo');
  const p = state.panels.find((x) => x.key === state.selKey);
  if (!p) {
    host.innerHTML = '<p class="muted">Выберите деталь в дереве или на сцене</p>';
    return;
  }
  const sz = panelSize(p);
  const box = panelBox(p);
  const hid = state.hiddenKeys[p.key];
  host.innerHTML = `
    <p><b>${p.name}</b> <span class="muted">${p.key}</span></p>
    <p class="muted">${p.orient} · ${p.role}${p.openable ? ' · ' + p.openable : ''}${p.hinge ? ' · петли ' + p.hinge : ''}${hid ? ' · скрыта' : ''}</p>
    <p>Габарит: <b>${Math.round(sz.L)} × ${Math.round(sz.W)} × ${Math.round(sz.T)}</b> мм</p>
    <p class="muted">AABB ${Math.round(box.x1)}…${Math.round(box.x2)} / ${Math.round(box.y1)}…${Math.round(box.y2)} / ${Math.round(box.z1)}…${Math.round(box.z2)}</p>
    <div class="v2-part-actions">
      <button type="button" id="v2HideSel">${hid ? 'Показать' : 'Скрыть'} (H)</button>
      <button type="button" id="v2NudgeUp">↑ 10</button>
      <button type="button" id="v2NudgeDn">↓ 10</button>
    </div>
  `;
  $('#v2HideSel')?.addEventListener('click', () => {
    state.hiddenKeys[p.key] = !state.hiddenKeys[p.key];
    rebuildScene({ keepCamera: true });
    renderTree();
    renderPartInfo();
  });
  $('#v2NudgeUp')?.addEventListener('click', () => nudgeSelected(0, 10, 0));
  $('#v2NudgeDn')?.addEventListener('click', () => nudgeSelected(0, -10, 0));
}

const RULE_FIELDS = [
  ['carcassT', 'ЛДСП корпус'],
  ['frontT', 'Фасад'],
  ['frontGap', 'Зазор фасада'],
  ['hingeFromEdge', 'Петля от края'],
  ['hingeCupFromEdge', 'Чашка от торца'],
  ['shelfInset', 'Полка inset'],
  ['shelfMaxSpan', 'Макс. пролёт'],
  ['doorMaxW', 'Макс. шир. двери'],
  ['drawerMinH', 'Ящик мин H'],
  ['drawerMaxH', 'Ящик макс H'],
  ['antresolMin', 'Антресоль мин'],
];

function renderRulesEditor() {
  const host = $('#v2RulesEdit');
  if (!host) return;
  host.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'v2-rules-grid';
  for (const [key, label] of RULE_FIELDS) {
    const lab = document.createElement('label');
    lab.innerHTML = `${label} <input type="number" data-rule="${key}" value="${RULES[key]}" step="1">`;
    grid.appendChild(lab);
  }
  host.appendChild(grid);
  const actions = document.createElement('div');
  actions.className = 'v2-part-actions';
  actions.innerHTML = `
    <button type="button" id="v2RulesApply" class="primary">Применить</button>
    <button type="button" id="v2RulesReset">Сброс</button>
  `;
  host.appendChild(actions);
  $('#v2RulesApply')?.addEventListener('click', () => {
    const patch = {};
    host.querySelectorAll('input[data-rule]').forEach((inp) => {
      patch[inp.dataset.rule] = +inp.value;
    });
    applyRules(patch);
    persistRules();
    rebuild();
    status('Правила цеха применены', 'ok');
  });
  $('#v2RulesReset')?.addEventListener('click', () => {
    resetRules();
    persistRules();
    renderRulesEditor();
    rebuild();
    status('Правила сброшены к умолчанию', 'ok');
  });
}

function fillMats() {
  for (const id of ['v2MatCarc', 'v2MatFront', 'v2MatBack']) {
    const sel = $('#' + id);
    if (!sel) continue;
    sel.innerHTML = '';
    for (const [mid, m] of Object.entries(MATERIALS)) {
      const o = document.createElement('option');
      o.value = mid; o.textContent = m.name;
      sel.appendChild(o);
    }
  }
  $('#v2MatCarc').value = state.mat.carcass;
  $('#v2MatFront').value = state.mat.front;
  $('#v2MatBack').value = state.mat.back;
}

function download(name, text, mime = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function safeFile(s) {
  return String(s).replace(/[<>:"/\\|?*]+/g, '_').slice(0, 80) || 'module';
}

function exportJson() {
  const data = {
    kind: 'module-ctor-v2', version: 2,
    name: state.name, typology: state.typology, p: state.p, mat: state.mat,
    panels: state.panels, fittings: state.fittings, extras: state.extras,
    issues: state.issues, rules: cloneRules(RULES),
  };
  download(`${safeFile(state.name)}_v2.json`, JSON.stringify(data, null, 2));
  status('JSON v2 сохранён', 'ok');
}

function exportBazis() {
  if (!state.panels.length) { status('Нет деталей', 'err'); return; }
  state.furniturePath = ($('#v2FurnPath')?.value || state.furniturePath || '').trim();
  const module = {
    id: 'v2_1', type: state.typology, name: state.name,
    x: 0, z: 0, rot: 0,
    p: { ...state.p }, mat: { ...state.mat },
    overrides: {}, open: {},
  };
  const build = {
    items: [{
      index: 1, title: state.name, module,
      panels: state.panels.filter((p) => p.orient === 'H' || p.orient === 'V' || p.orient === 'F'),
      extras: state.extras, fittings: state.fittings, virtual: false,
    }],
  };
  const script = toBazisScript({
    name: state.name,
    settings: { samoletPath: '', userCatalogPath: '', furniturePath: state.furniturePath },
    furniturePath: state.furniturePath,
  }, build);
  download(`${safeFile(state.name)}.js`, script, 'text/javascript');
  persist();
  status(`Скрипт Базиса: ${state.panels.length} пан. · ${state.fittings.filter((f) => f.bazisFile).length} OpenFurniture`, 'ok');
}

function setTool(tool) {
  state.tool = tool;
  controls.enabled = tool === 'orbit';
  $('#v2ToolMove')?.classList.toggle('active', tool === 'move');
  $('#v2ToolOrbit')?.classList.toggle('active', tool === 'orbit');
  persist();
  status(tool === 'move' ? 'Режим: перемещение (drag / стрелки)' : 'Режим: обзор', 'ok');
}

function wire() {
  renderTypologyCards();
  fillMats();
  renderRulesEditor();
  renderParams();

  $('#v2Name').addEventListener('change', () => { readParams(); persist(); });
  const paramIds = [
    '#v2W', '#v2H', '#v2D', '#v2Plinth', '#v2Shelves', '#v2Doors',
    '#v2Drawers', '#v2Sections', '#v2Antresol', '#v2Hinge',
  ];
  for (const id of paramIds) {
    const el = $(id);
    if (!el) continue;
    const go = () => { readParams(); rebuild(); };
    el.addEventListener('change', go);
    if (el.tagName === 'INPUT') el.addEventListener('input', () => {
      clearTimeout(el._t);
      el._t = setTimeout(go, 120);
    });
  }
  $('#v2Rod')?.addEventListener('change', () => { readParams(); rebuild(); });
  for (const [id, key] of [['#v2MatCarc', 'carcass'], ['#v2MatFront', 'front'], ['#v2MatBack', 'back']]) {
    $(id)?.addEventListener('change', (e) => { state.mat[key] = e.target.value; rebuild(); });
  }

  $('#v2AddShelf')?.addEventListener('click', () => bumpParam('shelves', 1, 0, 12));
  $('#v2AddDoor')?.addEventListener('click', () => bumpParam('doors', 1, 0, 4));
  $('#v2AddDrawer')?.addEventListener('click', () => bumpParam('drawers', 1, 0, 6));
  $('#v2AddSection')?.addEventListener('click', () => bumpParam('sections', 1, 1, 4));
  $('#v2RodBtn')?.addEventListener('click', () => {
    readParams();
    state.p.rod = !state.p.rod;
    renderParams();
    rebuild();
  });
  $('#v2ToolOrbit')?.addEventListener('click', () => setTool('orbit'));
  $('#v2ToolMove')?.addEventListener('click', () => setTool('move'));

  $('#v2Ghost')?.addEventListener('click', () => {
    state.ghost = !state.ghost;
    $('#v2Ghost')?.classList.toggle('active', state.ghost);
    rebuildScene({ keepCamera: true });
  });
  $('#v2Open')?.addEventListener('click', () => {
    state.openFronts = !state.openFronts;
    $('#v2Open')?.classList.toggle('active', state.openFronts);
    persist();
  });
  $('#v2HideFront')?.addEventListener('click', () => {
    state.hiddenRoles.front = !state.hiddenRoles.front;
    $('#v2HideFront')?.classList.toggle('active', !!state.hiddenRoles.front);
    rebuildScene({ keepCamera: true });
  });
  $('#v2HideBack')?.addEventListener('click', () => {
    state.hiddenRoles.back = !state.hiddenRoles.back;
    $('#v2HideBack')?.classList.toggle('active', !!state.hiddenRoles.back);
    rebuildScene({ keepCamera: true });
  });
  $('#v2Export')?.addEventListener('click', exportJson);
  $('#v2Bazis')?.addEventListener('click', exportBazis);
  $('#v2Rebuild')?.addEventListener('click', () => { readParams(); rebuild(); });
  $('#v2FurnPath')?.addEventListener('change', () => {
    state.furniturePath = $('#v2FurnPath').value.trim();
    persist();
  });

  $('#v2Ghost')?.classList.toggle('active', state.ghost);
  if ($('#v2FurnPath')) $('#v2FurnPath').value = state.furniturePath;
  setTool(state.tool);
}

async function boot() {
  try {
    await gatePage();
  } catch (e) {
    console.error(e);
    return;
  }
  restore();
  initScene();
  wire();
  $('#v2Name').value = state.name;
  rebuild();
}

boot();
