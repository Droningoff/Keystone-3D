import { EDGES, matsByKind } from './catalog.js?v=20261028m';
import {
  MODULE_TYPES, BUTT_SIDES, createModule, newProject, buildProject, snapPos, nextFreeX,
  moduleTitle, panelSize, resolveDoors, migrateProject, toggleFront, setAllFronts,
  createLibModule, isLib, moduleRow, listDockSockets, applyDock, nearestDockSide,
} from './model.js?v=20261110a';
import { loadSamoletIndex, samoletIndex, libGeomTried, libGeom, libPreview, ensureLibGeoms, loadLibGeom, libSpec, findLib } from './samolet.js?v=20261029j';
import { ExplodeView } from './explode.js?v=20261028m';
import { WALL_BY_ID, placeOnWall } from './walls.js?v=20261110a';
import {
  newObstacle, newOpening, ensureAdvancedFields, unifyRoomPlan, syncSimpleAABB,
  setRoomFootprint, setRoomHeight, ensureCtorIds,
  rectPlan, wallSurvey, setWallLengthAt, roomWallSegments, edgeLetter,
  planByLayer, planLayerLabel, insertVertexOnEdge, resetPlanLayerToRect,
  newFeature, featureTitle,
  levelsWithPlans, wallEdgeCount, isOpenRoom, setWallLengthAtLevel, applyDrawnRoom,
} from './roomGeom.js?v=20261110a';
import { chainFromPoints, wallPose } from './roomPlan.js?v=20261110a';
import { openPlanEditorGraph } from './planEditorGraph.js?v=20261123i';
import { validateFit } from './roomFit.js?v=20261110a';
import {
  showRoomPrompt, renderWallPropsHtml, CONSTRUCTION_CATALOG, CTOR_ICONS, renderPlanSvg,
} from './roomEdit.js?v=20261110a';
import { loadBrief, saveBrief, buildAiPrompt } from './brief.js?v=20261028m';
import { loadLlmSettings, saveLlmSettings, listModels } from './llm.js?v=20261028m';
import { planKitchenWithLlm } from './planner.js?v=20261028m';
import { Viewer } from './viewer.js?v=20261110a';
import { toBazisScript, bazisSmokeTest, bazisExportCheck, resolveSamoletBase, resolveUserCatalogBase } from './bazis.js?v=20261028m';
import { computeSpec, specToCSV, specTo1C } from './report.js?v=20261028m';
import { runCommand } from './commands.js?v=20261028m';
import { loadLibrary, addToLibrary, removeFromLibrary, exportLibraryJSON, importLibraryJSON, libraryByCategory } from './library.js?v=20261028m';
import { FIXTURE_CATALOG, createFixture, fixtureTitle, fixturesByCategory } from './fixtures.js?v=20261028m';
import { snapFixture, resolveFixtures, resolveFixture, adaptModule } from './placement.js?v=20261110a';
import {
  loadUserCatalog, userCatalogItems, userCatalogAll, addUserB3dFiles,
  archiveCatalogEntry, deleteUserEntry, isCatalogArchived, catalogArchivedCount,
} from './userCatalog.js?v=20261028m';
import {
  loadHwCatalog, autoFittingsForModule, enrichFitting,
} from './hwCatalog.js?v=20261028m';

const $ = (s) => document.querySelector(s);
const STORE = 'furniture-constructor-project';

let project = migrateProject(load() || demoProject());
let sel = { moduleId: null, panelKey: null, fixtureId: null, obstacleId: null, openingId: null };
let build = null;
let placeEntry = null;
let _selPaintTimer = 0;
const undo = [];

const emptySel = () => ({ moduleId: null, panelKey: null, fixtureId: null, obstacleId: null, openingId: null });
const viewer = new Viewer($('#viewport'), {
  onPick: (mid, key, fid) => {
    if (fid) { sel = { ...emptySel(), fixtureId: fid }; }
    else if (!mid) { sel = emptySel(); }
    else if (mid !== sel.moduleId) { sel = { ...emptySel(), moduleId: mid }; }
    else { sel = { ...emptySel(), moduleId: mid, panelKey: sel.panelKey === key ? null : key }; }
    softSelect();
  },
  onPickCtor: (kind, id) => {
    sel = {
      ...emptySel(),
      obstacleId: kind === 'obstacle' ? id : null,
      openingId: kind === 'opening' ? id : null,
    };
    softSelect();
  },
  onMoveObstacle: (id, x, z) => {
    commit();
    const ob = (project.room.obstacles || []).find((q) => q.id === id);
    if (ob) { ob.x = x; ob.z = z; }
    sel = { ...emptySel(), obstacleId: id };
    refresh();
  },
  onMoveOpening: (id, offset, sill) => {
    commit();
    const op = (project.room.openings || []).find((q) => q.id === id);
    if (op) {
      if (offset != null) op.offset = offset;
      if (sill != null) op.sill = sill;
    }
    sel = { ...emptySel(), openingId: id };
    refresh();
  },
  onDraggingCtor: (kind, id, fields) => {
    if (kind === 'obstacle') {
      const elx = $('#ctor_x'), elz = $('#ctor_z');
      if (elx && fields.x != null) elx.value = fields.x;
      if (elz && fields.z != null) elz.value = fields.z;
    } else if (kind === 'opening') {
      const elo = $('#ctor_offset'), els = $('#ctor_sill');
      if (elo && fields.offset != null) elo.value = fields.offset;
      if (els && fields.sill != null) els.value = fields.sill;
    }
  },
  onRotateObstacle: (id, d) => {
    commit();
    const ob = (project.room.obstacles || []).find((q) => q.id === id);
    if (ob) ob.rot = ((+ob.rot || 0) + d) % 360;
    sel = { ...emptySel(), obstacleId: id };
    refresh();
  },
  snap: (id, x, z) => snapPos(project, id, x, z),
  // excludeId = двигаемый модуль; маркеры на свободных боках остальных (как привязка Ctrl в eKitchen)
  dockSockets: (moverId) => listDockSockets(project, {
    excludeId: moverId || sel.moduleId,
    moverId: moverId || sel.moduleId,
  }),
  onDock: (id, socket) => dockModule(id, socket),
  onDockToHost: (moverId, hostId, wx, wz) => {
    const sock = nearestDockSide(project, moverId, hostId, wx, wz);
    if (!sock) {
      log('Нет свободного бока для привязки (другой ряд/поворот или оба бока заняты)', 'err');
      return;
    }
    dockModule(moverId, sock);
  },
  onDockMode: (on) => {
    $('#btnDock')?.classList.toggle('active', !!viewer.dockMode);
    if (on) {
      const n = listDockSockets(project, { moverId: sel.moduleId, excludeId: sel.moduleId }).length;
      log(
        sel.moduleId
          ? `Привязка (как Ctrl в eKitchen): ${n} свободных боков. Клик ◀/▶ или по модулю-соседу`
          : 'Привязка: сначала выберите модуль, затем Ctrl / G / «Стык» и клик по соседу',
        'ok',
      );
    }
  },
  onDragging: (id, x, z) => {
    const elx = $('#f_x'), elz = $('#f_z');
    if (elx) elx.value = x;
    if (elz) elz.value = z;
  },
  onMove: (id, x, z) => {
    commit();
    const m = mod(id);
    if (m) { m.x = x; m.z = z; }
    sel = { moduleId: id, panelKey: null, fixtureId: null };
    refresh();
  },
  onPlace: (x, z, wall, y, rot, edgeIndex) => placeModuleAt(x, z, wall, y, rot, edgeIndex),
  onPlaceFixture: (hit, rot) => placeFixtureAt(hit, rot),
  previewFixture: (type, hit, rot) => ({ id: '__ghost', type, ...snapFixture(project, type, hit.point, { ...hit, rot }) }),
  onToggleFront: (id, key) => {
    commit();
    const m = mod(id);
    if (!m) return;
    clearTimeout(_selPaintTimer); // не пересобирать сцену во время открытия
    const v = toggleFront(m, key);
    sel = { moduleId: id, panelKey: key, fixtureId: null };
    viewer.sel = sel;
    syncFrontAnim();
    log(`${moduleTitle(m)} · ${key}: ${v > 0.5 ? 'открыт' : 'закрыт'}`, 'ok');
  },
  onRotate: (id, d) => { commit(); const m = mod(id); if (m) m.rot = ((+m.rot || 0) + d) % 360; refresh(); },
  onRotateFixture: (id, d) => {
    commit();
    const f = project.fixtures.find((q) => q.id === id);
    if (f?.moduleId) f.lrot = ((+f.lrot || 0) + d) % 360;
    else if (f) f.rot = ((+f.rot || 0) + d) % 360;
    refresh();
  },
  onCancelPlace: () => { placeEntry = null; viewer.setMode('select'); updateModeBadge(); },
});

function demoProject() {
  const p = newProject();
  p.name = 'Кухня (пример)';
  p.room.length = 4000; p.room.depth = 3200;
  let x = 0;
  for (const [t, w] of [['tall', 600], ['base_drawers', 600], ['sink', 800], ['base', 600], ['base', 400]]) {
    p.modules.push(createModule(t, x, { width: w }, {}, { x, z: 0, rot: 0 }));
    x += w;
  }
  [[600, 600], [1200, 800], [2000, 600], [2600, 400]].forEach(([ox, w]) => {
    p.modules.push(createModule('wall', ox, { width: w }, {}, { x: ox, z: 0, rot: 0 }));
  });
  const bind = (type, mod) => {
    const s = snapFixture(p, type, { x: mod.x + mod.p.width / 2, y: 0, z: 200 }, { moduleId: mod.id });
    p.fixtures.push({ ...createFixture(type), ...s, module: undefined });
  };
  bind('sink_single', p.modules[2]);
  bind('mixer_chrome', p.modules[2]);
  bind('hob_60', p.modules[3]);
  p.fixtures.push(createFixture('socket_kitchen', 2300, 0, 0, 1100));
  p.fixtures.push(createFixture('pipe_water', 1300, 30, 0, 0));
  return p;
}

function load() { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }
function save() { localStorage.setItem(STORE, JSON.stringify(project)); }
function commit() { undo.push(JSON.stringify(project)); if (undo.length > 50) undo.shift(); }
const mod = (id) => project.modules.find((m) => m.id === id);
const fix = (id) => project.fixtures.find((f) => f.id === id);

function log(text, cls = '') {
  const d = document.createElement('div');
  d.className = cls; d.textContent = text;
  $('#log').appendChild(d);
  $('#log').scrollTop = 1e9;
}

function updateModeBadge() {
  const el = $('#modeBadge');
  if (viewer.mode === 'place') el.textContent = `Постановка: ${placeEntry?.name || ''} · R поворот`;
  else if (viewer.mode === 'placeFixture') el.textContent = `Объект: ${FIXTURE_CATALOG[viewer.placeFixture]?.title || ''} · R поворот`;
  else if (viewer.mode === 'placeCtor') {
    const c = placeCtorEntry || viewer.placeCtor;
    el.textContent = 'Конструкция: ' + (c?.title || '') + ' · Esc';
  } else el.textContent = '';
}

function placeModuleAt(x, z, wall, y, rot, edgeIndex = null) {
  if (!placeEntry) return;
  commit();
  const params = { ...placeEntry.p };
  let r = rot ?? 0;
  let px = x - params.width / 2, pz = z;
  const seg = edgeIndex != null ? roomWallSegments(project.room).find((s) => s.edgeIndex === +edgeIndex) : null;
  if (seg) {
    const p = wallPose(seg, x, z, +params.width);
    px = p.x; pz = p.z; r = p.rot;
  } else if (wall === 'back') { r = 0; pz = 0; }
  else if (wall === 'front') { r = 180; pz = project.room.depth - (+params.depth); }
  else if (wall === 'left') { r = 90; px = x; pz = z - params.width / 2; }
  else if (wall === 'right') { r = 270; px = x - (+params.depth); pz = z - params.width / 2; }
  const row = placeEntry.type === 'lib' ? params.row : MODULE_TYPES[placeEntry.type]?.row;
  if (row === 'wall' && wall) {
    params.elev = Math.max(0, Math.round(y - params.height / 2));
  }
  const pos = { x: Math.round(px), z: Math.round(pz), rot: r };
  const m = placeEntry.type === 'lib'
    ? createLibModule(placeEntry.entry, { ...pos, elev: params.elev })
    : createModule(placeEntry.type, px, params, placeEntry.mat || {}, pos);
  project.modules.push(m);
  sel = { moduleId: m.id, panelKey: null, fixtureId: null };
  viewer.setMode('select');
  placeEntry = null;
  updateModeBadge();
  log(`Поставлен: ${moduleTitle(m)}`, 'ok');
  refresh();
}

function placeFixtureAt(hit, rot) {
  const type = viewer.placeFixture;
  if (!type) return;
  const def = FIXTURE_CATALOG[type];
  const s = snapFixture(project, type, hit.point, { ...hit, rot });
  const needsModule = def.kind === 'sink' || def.kind === 'mixer' || ['hob_60', 'oven_60', 'dishwasher_60'].includes(type);
  if (needsModule && !s.moduleId) {
    log(`${def.title}: наведите курсор на подходящий модуль (нижний${type === 'oven_60' || type === 'dishwasher_60' ? ' или пенал' : ''})`, 'err');
    return;
  }
  commit();
  const { module: target, ...fields } = s;
  const f = { ...createFixture(type), ...fields };
  project.fixtures.push(f);
  if (target) {
    const note = adaptModule(type, target);
    log(`${def.title} > модуль ${project.modules.indexOf(target) + 1} (${moduleTitle(target)}), по центру${note ? '; ' + note : ''}`, 'ok');
    if (def.w > +target.p.width) log(`Внимание: ${def.title} (${def.w} мм) шире модуля (${target.p.width} мм)`, 'err');
  } else {
    log(`Поставлен объект: ${fixtureTitle(f)}`, 'ok');
  }
  sel = { moduleId: null, panelKey: null, fixtureId: f.id };
  viewer.setMode('select');
  updateModeBadge();
  refresh();
}

let geomLoading = false;
/** Обновить цели анимации фасадов без полной пересборки мешей (плавное открытие). */
function syncFrontAnim() {
  build = buildProject(project);
  viewer.syncOpenTargets(build);
  renderProps();
  save();
}

/** Смена выделения: props сразу; тяжёлый render — с задержкой (иначе срывается double-tap). */
function softSelect() {
  if (!build) { refresh(); return; }
  viewer.sel = sel;
  viewer._refreshHighlights?.();
  const m = sel.moduleId && mod(sel.moduleId);
  if (m && isLib(m) && !libGeom(m.lib.n)) {
    loadLibGeom(m.lib.n).then(() => { refresh(); });
    renderProps();
    return;
  }
  renderProps();
  clearTimeout(_selPaintTimer);
  _selPaintTimer = setTimeout(() => {
    if (!build) return;
    viewer.render(build, sel, resolveFixtures(project));
    viewer._refreshHighlights?.();
    viewer.syncOpenTargets(build);
    renderIssues();
  }, 320);
}

function refresh() {
  project = migrateProject(project);
  ensureCtorIds(project.room);
  if (sel.moduleId && !mod(sel.moduleId) && !String(sel.moduleId).startsWith('__top')) {
    sel = { ...sel, moduleId: null, panelKey: null };
  }
  if (sel.obstacleId && !(project.room.obstacles || []).some((q) => q.id === sel.obstacleId)) {
    sel = { ...sel, obstacleId: null };
  }
  if (sel.openingId && !(project.room.openings || []).some((q) => q.id === sel.openingId)) {
    sel = { ...sel, openingId: null };
  }
  const orphans = project.fixtures.filter((f) => f.moduleId && !mod(f.moduleId));
  if (orphans.length) {
    project.fixtures = project.fixtures.filter((f) => !orphans.includes(f));
    log(`Удалены объекты удалённого модуля: ${orphans.map(fixtureTitle).join(', ')}`);
  }
  if (!geomLoading && project.modules.some((m) => isLib(m) && !libGeomTried(m.lib.n))) {
    geomLoading = true;
    ensureLibGeoms(project.modules).finally(() => { geomLoading = false; refresh(); });
  }
  build = buildProject(project);
  viewer.setRoom(project.room);
  viewer.applyLighting(project.lighting);
  viewer.render(build, sel, resolveFixtures(project));
  viewer.setFixturesVisible(project.showFixtures !== false);
  $('#roomShow').value = project.room.show || 'auto';
  $('#fixShow').checked = project.showFixtures !== false;
  $('#wallLettersShow').checked = project.room.showWallLetters !== false;
  viewer.setWallLettersVisible(project.room.showWallLetters !== false);
  try { if (typeof renderPlanEditor === 'function') renderPlanEditor(); } catch(_){}
  try { if (typeof renderConstructionsLib === 'function') renderConstructionsLib(); } catch(_){}
  try { if (typeof syncLayersForm === 'function') syncLayersForm(); } catch(_){}
  try { if (typeof renderWallPropsPanel === 'function') renderWallPropsPanel(); } catch(_){}
  renderFeatures();
  viewer.syncOpenTargets(build);
  renderProps();
  renderIssues();
  renderOpenings();
  syncRoomForm();
  syncLightForm();
  const spec = computeSpec(project, build);
  const fixSum = project.fixtures.reduce((s, f) => s + (FIXTURE_CATALOG[f.type]?.price || 0), 0);
  $('#total').textContent = `${spec.panelCount} дет. · ${(spec.total + fixSum).toLocaleString('ru-RU')} ₽`;
  $('#prjName').value = project.name;
  $('#topOn').checked = !!project.settings.countertop;
  $('#topMat').value = project.settings.topMat;
  save();
}

// ---------- Вкладки ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
  };
});

// ---------- Библиотека ----------
function renderLibrary() {
  const lib = loadLibrary();
  const byCat = libraryByCategory(lib);
  const el = $('#library');
  el.innerHTML = '';
  for (const [cat, items] of byCat) {
    const h = document.createElement('h4');
    h.textContent = cat;
    el.appendChild(h);
    for (const e of items) {
      const b = document.createElement('button');
      b.textContent = (e.system ? '' : '? ') + e.name + (e.p?.width ? ` ${e.p.width}` : '');
      b.title = 'Клик — поставить по плоскости';
      b.onclick = () => {
        placeEntry = e;
        viewer.setMode('place', e);
        updateModeBadge();
        log(`Режим постановки: ${e.name}. Кликните по полу или стене.`, 'ok');
      };
      if (!e.system) {
        b.oncontextmenu = (ev) => {
          ev.preventDefault();
          if (confirm(`Удалить «${e.name}» из библиотеки?`)) {
            removeFromLibrary(e.id);
            renderLibrary();
          }
        };
      }
      el.appendChild(b);
    }
  }
}

function renderFixturesLib() {
  const el = $('#fixturesLib');
  el.innerHTML = '';
  for (const [cat, items] of fixturesByCategory()) {
    const h = document.createElement('h4');
    h.textContent = cat;
    el.appendChild(h);
    for (const e of items) {
      const b = document.createElement('button');
      b.textContent = e.title;
      b.onclick = () => {
        viewer.setMode('placeFixture', e.id);
        updateModeBadge();
        const intoModule = e.kind === 'sink' || e.kind === 'mixer' || ['hob_60', 'oven_60', 'dishwasher_60', 'microwave', 'hood_60'].includes(e.id);
        log(`Постановка: ${e.title}. ${intoModule ? 'Наведите на модуль — встанет по его центру (зелёный призрак).' : 'Кликните по полу/стене.'}`, 'ok');
      };
      el.appendChild(b);
    }
  }
}

// ---------- Библиотека «Самолет» ----------
const SAM_PAGE = 60;
let samShown = SAM_PAGE, samActive = null;
const previewQueue = [];
let previewBusy = false;

function pumpPreviews() {
  if (previewBusy) return;
  const job = previewQueue.shift();
  if (!job) return;
  previewBusy = true;
  libPreview(job.n).then((url) => {
    if (url && job.el.isConnected) job.el.innerHTML = `<img alt="" src="${url}">`;
  }).catch(() => {}).finally(() => { previewBusy = false; setTimeout(pumpPreviews, 0); });
}
const previewObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    previewObserver.unobserve(en.target);
    previewQueue.push({ n: +en.target.dataset.n, el: en.target });
  }
  pumpPreviews();
}, { root: null, rootMargin: '200px' });

function samShowArchived() {
  return !!$('#samShowArchived')?.checked;
}

function samMergedItems() {
  const idx = samoletIndex();
  const showArch = samShowArchived();
  const base = (idx?.items || []).map((e) => ({
    ...e,
    archived: isCatalogArchived(e.n),
  })).filter((e) => showArch || !e.archived);
  const mine = userCatalogItems({ includeArchived: showArch });
  return base.concat(mine);
}

function samFiltered() {
  const words = $('#samSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cat = $('#samCat').value, dec = $('#samDecor').value;
  return samMergedItems().filter((i) => (!cat || i.cat === cat) && (!dec || i.decor === dec)
    && words.every((w) => `${i.art} ${i.code} ${i.title} ${Math.round(i.w)}`.toLowerCase().includes(w)));
}

function renderSamolet(reset = true) {
  const idx = samoletIndex();
  if (!idx && !userCatalogAll().length) return;
  if (reset) samShown = SAM_PAGE;
  const list = samFiltered();
  const grid = $('#samGrid');
  grid.innerHTML = '';
  for (const e of list.slice(0, samShown)) {
    const card = document.createElement('div');
    const mine = !!e.user;
    const archived = !!e.archived || isCatalogArchived(e.n);
    card.className = 'sam-card'
      + (samActive === e.n ? ' active' : '')
      + (mine ? ' user' : '')
      + (archived ? ' archived' : '');
    card.title = `${e.art}\n${e.title} · ${Math.round(e.w)}×${Math.round(e.h)}×${Math.round(e.d)}\nКод: ${e.code || '—'}\nФурнитура: ${e.nHw ?? '—'} поз.${e.geom === 'box' ? '\nГеометрия: габарит (в Базис уйдёт полный .b3d)' : ''}${mine ? '\nМой .b3d' : ''}${archived ? '\nВ архиве' : ''}`;
    card.innerHTML = `<div class="pv" data-n="${e.n}">…</div>
      <div class="art">${e.art}</div>
      <div class="sub">${Math.round(e.w)}×${Math.round(e.h)}×${Math.round(e.d)}${e.code ? ` · код ${e.code}` : ''}</div>
      ${e.geom === 'box' ? '<div class="box-only">габарит</div>' : ''}
      ${mine ? '<div class="badge-mine">мой' + (archived ? ' · архив' : '') + '</div>' : (archived ? '<div class="badge-mine">архив</div>' : '')}
      <div class="acts">
        <button type="button" data-act="arch" title="${archived ? 'Вернуть в список' : 'Скрыть из списка (архив)'}">${archived ? 'вернуть' : 'архив'}</button>
        ${mine ? '<button type="button" data-act="del" title="Удалить из каталога навсегда">удалить</button>' : ''}
      </div>`;
    card.onclick = () => startLibPlace(e);
    card.querySelector('[data-act="arch"]').onclick = (ev) => {
      ev.stopPropagation();
      const toArch = !archived;
      archiveCatalogEntry(e, toArch);
      renderSamolet(false);
      log(toArch ? `В архиве (скрыт): ${e.art}` : `Вернул в список: ${e.art}`, 'ok');
    };
    const delBtn = card.querySelector('[data-act="del"]');
    if (delBtn) {
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (!confirm(`Удалить «${e.art}» из каталога навсегда?\nФайл .b3d на диске не трогаем.`)) return;
        deleteUserEntry(e.n);
        if (samActive === e.n) samActive = null;
        renderSamolet();
        log(`Удалён из каталога: ${e.art}`, 'ok');
      };
    }
    grid.appendChild(card);
    previewObserver.observe(card.querySelector('.pv'));
  }
  const mineN = userCatalogAll().length;
  const mineVis = userCatalogItems({ includeArchived: samShowArchived() }).length;
  const archN = catalogArchivedCount();
  const samVisible = (idx?.items || []).filter((i) => samShowArchived() || !isCatalogArchived(i.n)).length;
  const total = samVisible + mineVis;
  const full = idx?.full || 0;
  $('#samInfo').textContent = `Найдено: ${list.length} из ${total}`
    + (idx ? ` (Самолет: ${samVisible}/${idx.count}, полная геом.: ${full}` : ' (')
    + (mineN ? `; мои: ${mineN}` : '')
    + (archN ? `; в архиве: ${archN}` : '')
    + ')';
  $('#samMore').hidden = list.length <= samShown;
}

function startLibPlace(e) {
  samActive = e.n;
  loadLibGeom(e.n);
  const m = createLibModule(e);
  placeEntry = { type: 'lib', name: e.art, entry: e, p: m.p };
  viewer.setMode('place', placeEntry);
  updateModeBadge();
  document.querySelectorAll('.sam-card').forEach((c) => c.classList.toggle('active', +c.querySelector('.pv').dataset.n === e.n));
  log(`Постановка: ${e.art}. Кликните по полу или стене.`, 'ok');
}

function refreshSamCats(idx) {
  const cats = new Set((idx?.items || []).map((i) => i.cat));
  for (const e of userCatalogAll()) cats.add(e.cat || 'Мои');
  cats.add('Мои');
  const cur = $('#samCat').value;
  $('#samCat').innerHTML = '<option value="">Все категории</option>' + [...cats].map((c) => `<option>${c}</option>`).join('');
  if (cur && [...cats].includes(cur)) $('#samCat').value = cur;
}

async function initSamolet() {
  try {
    loadUserCatalog();
    const idx = await loadSamoletIndex();
    refreshSamCats(idx);
    $('#samDecor').innerHTML = '<option value="">Все декоры</option>' + Object.keys(idx.decors || {}).map((d) => `<option>${d}</option>`).join('');
    $('#samPath').value = project.settings.samoletPath || idx.source || '';
    if ($('#samUserPath')) $('#samUserPath').value = project.settings.userCatalogPath || '';
    if ($('#furnPath')) $('#furnPath').value = project.settings.furniturePath || '';
    renderSamolet();
  } catch (err) {
    loadUserCatalog();
    refreshSamCats(null);
    if ($('#samUserPath')) $('#samUserPath').value = project.settings.userCatalogPath || '';
    if ($('#furnPath')) $('#furnPath').value = project.settings.furniturePath || '';
    renderSamolet();
    $('#samInfo').textContent = 'Каталог линейки не загружен: ' + err.message + (userCatalogAll().length ? ' (мои .b3d доступны)' : '');
  }
}
$('#catLine')?.addEventListener('change', () => {
  const line = $('#catLine').value;
  log(line === 'samolet' ? 'Линейка: Самолет' : `Линейка: ${line}`, 'ok');
  renderSamolet();
});
$('#samSearch').oninput = () => renderSamolet();
$('#samCat').onchange = () => renderSamolet();
$('#samDecor').onchange = () => renderSamolet();
$('#samShowArchived')?.addEventListener('change', () => renderSamolet());
$('#samMore').onclick = () => { samShown += SAM_PAGE; renderSamolet(false); };
$('#samPath').onchange = (e) => { project.settings.samoletPath = e.target.value.trim(); save(); log('Папка .b3d линейки для Базиса: ' + project.settings.samoletPath, 'ok'); };
$('#samUserPath')?.addEventListener('change', (e) => {
  project.settings.userCatalogPath = e.target.value.trim();
  save();
  log('Папка моих .b3d для Базиса: ' + project.settings.userCatalogPath, 'ok');
});
$('#furnPath')?.addEventListener('change', (e) => {
  project.settings.furniturePath = e.target.value.trim();
  save();
  log('Папка .f3d фурнитуры для Базиса: ' + project.settings.furniturePath, 'ok');
});
$('#samAddB3d')?.addEventListener('click', () => $('#samAddB3dInput')?.click());
$('#samAddB3dInput')?.addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const added = addUserB3dFiles(files);
  if (!added.length) { log('Нет файлов .b3d', 'err'); return; }
  refreshSamCats(samoletIndex());
  renderSamolet();
  log(`Добавлено в каталог: ${added.length} шт. Укажите «Папка моих .b3d» — ту же папку, где лежат файлы на диске.`, 'ok');
  if (!project.settings.userCatalogPath) {
    alert('Файлы добавлены в каталог.\n\nУкажите ниже «Папка моих .b3d» — абсолютный путь к папке, где лежат эти .b3d на диске (браузер не отдаёт полный путь). Нужно для выгрузки в Базис.');
  }
});

// ---------- Пример кухни Самолет (первый демо-ряд вдоль стены A) ----------
async function samoletKitchen() {
  await loadSamoletIndex();
  const p = newProject();
  p.name = 'Кухня Самолет (пример)';
  p.room.length = 4000;
  p.room.depth = 3200;
  p.room.height = 2700;
  p.room.openings = [
    { id: 'op1', wall: 'right', type: 'window', offset: 1000, width: 1200, sill: 900, height: 1400 },
    { id: 'op2', wall: 'front', type: 'door', offset: 600, width: 900, sill: 0, height: 2100 },
  ];
  const put = (re, w, hand, x, elev) => {
    const e = findLib(re, w, hand);
    if (!e) { log(`Пример кухни: не найден ${re} ${w}`, 'err'); return null; }
    const m = createLibModule(e, { x, z: 0, rot: 0, ...(elev != null ? { elev } : {}) });
    p.modules.push(m);
    return m;
  };
  // Нижний ряд: пенал | 400 | мойка 800 | духовка 600 | 600 | 400 | 600
  put(/^Н-ХД-2-2040х600х560/, 600, 'left', 0);
  put(/^П-ПД-1-460х600х560/, 600, 'left', 0);
  put(/^Н-КЗ-720х400х560-1/, 400, 'left', 600);
  const sink = put(/^Н-КМ-720х800х560-М2/, 800, null, 1000);
  const oven = put(/^Н-ДО-20-720х600х560/, 600, null, 1800);
  put(/^Н-КЗ-720х600х560-2/, 600, null, 2400);
  put(/^Н-КЗ-720х400х560-1/, 400, 'right', 3000);
  put(/^Н-КЗ-720х600х560-1/, 600, 'right', 3400);
  // Верхний ряд (над тумбами, не над пеналом)
  put(/^В-К1-720х400х350/, 400, 'left', 600);
  // С = сушка INOXA (наполнение из Базиса); без -С берётся пустой корпус
  put(/^В-К2-720х800х350-С/, 800, null, 1000);
  const hoodCab = put(/^В-К2-460х600х350/, 600, null, 1800, 1710);
  put(/^В-К2-720х600х350-0/, 600, null, 2400);
  put(/^В-К1-720х400х350/, 400, 'right', 3000);
  put(/^В-К1-720х600х350/, 600, 'right', 3400);
  await ensureLibGeoms(p.modules);
  const bind = (type, m) => {
    if (!m) return;
    const s = snapFixture(p, type, { x: m.x + m.p.width / 2, y: 0, z: 200 }, { moduleId: m.id });
    const { module: _m, ...fields } = s;
    p.fixtures.push({ ...createFixture(type), ...fields });
  };
  bind('sink_single', sink);
  bind('mixer_chrome', sink);
  bind('hob_60', oven);
  bind('oven_60', oven);
  bind('hood_60', hoodCab);
  p.fixtures.push(createFixture('socket_kitchen', 2700, 0, 0, 1100));
  p.fixtures.push(createFixture('pipe_water', 1250, 30, 0, 0));
  return p;
}

$('#btnSaveLib').onclick = () => {
  const m = sel.moduleId && mod(sel.moduleId);
  if (!m) { log('Сначала выберите модуль', 'err'); return; }
  if (isLib(m)) { log('Модуль Самолет уже есть в каталоге — вкладка «Самолет»', 'err'); return; }
  const name = prompt('Название в библиотеке', moduleTitle(m));
  if (!name) return;
  addToLibrary({ type: m.type, name, p: m.p, mat: m.mat, category: 'Мои' });
  renderLibrary();
  log(`Сохранено в библиотеку: ${name}`, 'ok');
};
$('#btnExportLib').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([exportLibraryJSON()], { type: 'application/json' }));
  a.download = 'library.json';
  a.click();
};
$('#btnImportLib').onclick = () => $('#libImport').click();
$('#libImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { importLibraryJSON(await f.text()); renderLibrary(); log('Библиотека импортирована', 'ok'); }
  catch (err) { log('Ошибка импорта: ' + err.message, 'err'); }
  e.target.value = '';
};

$('#btnOpenAll').onclick = () => { commit(); project.modules.forEach((m) => setAllFronts(m, true)); syncFrontAnim(); };
$('#btnCloseAll').onclick = () => { commit(); project.modules.forEach((m) => setAllFronts(m, false)); syncFrontAnim(); };
$('#btnDock')?.addEventListener('click', () => {
  viewer.setDockMode(!viewer.dockMode);
});
$('#showGrid')?.addEventListener('change', (e) => viewer.setGridVisible(e.target.checked));
$('#showDims')?.addEventListener('change', (e) => viewer.setDimsVisible(e.target.checked));
$('#btnLines')?.addEventListener('click', () => {
  viewer.setLineMode(!viewer.lineMode);
  $('#btnLines')?.classList.toggle('active', !!viewer.lineMode);
});

function syncViewButtons(mode) {
  const map = { walk: 'walk', orbit: '3d', top: 'top', front: 'front' };
  const cur = map[mode] || '3d';
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === cur));
}
viewer.h.onNavMode = (mode) => syncViewButtons(mode);

function dockModule(id, socket) {
  const m = mod(id);
  if (!m || !socket) return;
  const pose = applyDock(project, id, socket) || socket.pose;
  if (!pose) { log('Не удалось пристыковать', 'err'); return; }
  commit();
  m.x = pose.x;
  m.z = pose.z;
  m.rot = pose.rot;
  const host = mod(socket.hostId);
  log(
    `Привязка: «${moduleTitle(m)}» → ${socket.side === 'left' ? 'слева' : 'справа'} от «${host ? moduleTitle(host) : '?'}»`,
    'ok',
  );
  refresh();
}

// ---------- Помещение ----------
function syncRoomForm() {
  const r = project.room;
  $('#roomL').value = r.length;
  $('#roomD').value = r.depth;
  $('#roomH').value = r.height;
  $('#floorColor').value = '#' + (r.floorColor >>> 0).toString(16).padStart(6, '0');
  $('#wallColor').value = '#' + (r.wallColor >>> 0).toString(16).padStart(6, '0');
}
function hexToInt(h) { return parseInt(h.replace('#', ''), 16); }

['roomL', 'roomD', 'roomH'].forEach((id) => {
  $('#' + id).onchange = (e) => {
    commit();
    if (id === 'roomH') {
      setRoomHeight(project.room, +e.target.value);
    } else {
      const L = id === 'roomL' ? +e.target.value : +project.room.length;
      const D = id === 'roomD' ? +e.target.value : +project.room.depth;
      setRoomFootprint(project.room, L, D);
    }
    refresh();
  };
});
$('#floorColor').oninput = (e) => { project.room.floorColor = hexToInt(e.target.value); viewer.setRoom(project.room); save(); };
$('#wallColor').oninput = (e) => { project.room.wallColor = hexToInt(e.target.value); viewer.setRoom(project.room); save(); };

function renderFeatures() {
  const el = $('#features');
  if (!el) return;
  const list = project.room.features || [];
  if (!list.length) {
    el.innerHTML = '<p class="muted">Нет ниш и выступов — комната прямоугольная.</p>';
    return;
  }
  el.innerHTML = list.map((f, i) => `
    <div class="opening-card">
      <div class="muted" style="font-weight:600;margin-bottom:4px">${featureTitle(f)}</div>
      <select data-ft="${i}" data-f="kind">
        <option value="niche" ${f.kind !== 'jut' ? 'selected' : ''}>Ниша (наружу)</option>
        <option value="jut" ${f.kind === 'jut' ? 'selected' : ''}>Выступ (внутрь)</option>
      </select>
      <select data-ft="${i}" data-f="wall">
        ${['back', 'right', 'front', 'left'].map((w) => `<option value="${w}" ${f.wall === w ? 'selected' : ''}>${WALL_BY_ID[w]?.title || w}</option>`).join('')}
      </select>
      <label>Отступ <input type="number" data-ft="${i}" data-f="offset" value="${f.offset}" step="10"></label>
      <label>Ширина <input type="number" data-ft="${i}" data-f="width" value="${f.width}" step="10"></label>
      <label>Глубина <input type="number" data-ft="${i}" data-f="depth" value="${f.depth}" step="10"></label>
      <label>Имя <input type="text" data-ft="${i}" data-f="name" value="${f.name || ''}" placeholder="необязательно"></label>
      <button data-del-ft="${i}" class="danger">Удалить</button>
    </div>`).join('');
  el.querySelectorAll('[data-ft]').forEach((inp) => {
    inp.onchange = () => {
      commit();
      const f = project.room.features[+inp.dataset.ft];
      const key = inp.dataset.f;
      f[key] = inp.tagName === 'SELECT' || key === 'name' ? inp.value : +inp.value;
      if (key === 'kind' && f.kind !== 'jut') f.kind = 'niche';
      refresh();
    };
  });
  el.querySelectorAll('[data-del-ft]').forEach((b) => {
    b.onclick = () => {
      commit();
      project.room.features.splice(+b.dataset.delFt, 1);
      refresh();
    };
  });
}
if ($('#btnAddNiche')) $('#btnAddNiche').onclick = () => {
  commit();
  (project.room.features ||= []).push(newFeature({ kind: 'niche', wall: 'back', offset: 1000, width: 900, depth: 400 }));
  refresh();
};
if ($('#btnAddJut')) $('#btnAddJut').onclick = () => {
  commit();
  (project.room.features ||= []).push(newFeature({ kind: 'jut', wall: 'back', offset: 1200, width: 600, depth: 300, name: 'Выступ' }));
  refresh();
};

function renderOpenings() {
  const el = $('#openings');
  if (!el) return;
  el.innerHTML = (project.room.openings || []).map((op, i) => `
    <div class="opening-card">
      <select data-op="${i}" data-f="wall">
        ${['back', 'right', 'front', 'left'].map((w) => `<option value="${w}" ${op.wall === w ? 'selected' : ''}>${WALL_BY_ID[w]?.title || w}</option>`).join('')}
      </select>
      <select data-op="${i}" data-f="type">
        <option value="window" ${op.type === 'window' ? 'selected' : ''}>Окно</option>
        <option value="door" ${op.type === 'door' ? 'selected' : ''}>Дверь</option>
      </select>
      <label>Отступ <input type="number" data-op="${i}" data-f="offset" value="${op.offset}" step="10"></label>
      <label>Ширина <input type="number" data-op="${i}" data-f="width" value="${op.width}" step="10"></label>
      <label>Подоконник <input type="number" data-op="${i}" data-f="sill" value="${op.sill}" step="10"></label>
      <label>Высота <input type="number" data-op="${i}" data-f="height" value="${op.height}" step="10"></label>
      <button data-del-op="${i}" class="danger">Удалить</button>
    </div>`).join('');
  el.querySelectorAll('[data-op]').forEach((inp) => {
    inp.onchange = () => {
      commit();
      const op = project.room.openings[+inp.dataset.op];
      const f = inp.dataset.f;
      op[f] = inp.tagName === 'SELECT' ? inp.value : +inp.value;
      refresh();
    };
  });
  el.querySelectorAll('[data-del-op]').forEach((b) => {
    b.onclick = () => {
      commit();
      project.room.openings.splice(+b.dataset.delOp, 1);
      refresh();
    };
  });
}
$('#btnAddOpening').onclick = () => {
  commit();
  const op = newOpening({ wall: 'back', type: 'window', offset: 500, width: 1200, sill: 900, height: 1400 });
  project.room.openings.push(op);
  sel = { ...emptySel(), openingId: op.id };
  refresh();
};

// ---------- Свет ----------
function syncLightForm() {
  const L = project.lighting;
  $('#ltAmbient').value = L.ambient;
  $('#ltSun').value = L.sun;
  $('#ltAz').value = L.sunAzimuth;
  $('#ltEl').value = L.sunElevation;
  $('#ltFill').value = L.fill;
  $('#ltCeil').checked = !!L.ceiling;
  $('#ltCeilN').value = L.ceilingCount;
  $('#ltCeilI').value = L.ceilingIntensity;
  $('#ltAccent').checked = !!L.accent;
  $('#ltAccentC').value = L.accentColor || '#ffe6c2';
}
function bindLight(id, key, parse = (v) => +v) {
  $('#' + id).oninput = (e) => {
    project.lighting[key] = e.target.type === 'checkbox' ? e.target.checked : parse(e.target.value);
    viewer.applyLighting(project.lighting);
    save();
  };
}
bindLight('ltAmbient', 'ambient');
bindLight('ltSun', 'sun');
bindLight('ltAz', 'sunAzimuth');
bindLight('ltEl', 'sunElevation');
bindLight('ltFill', 'fill');
bindLight('ltCeil', 'ceiling');
bindLight('ltCeilN', 'ceilingCount');
bindLight('ltCeilI', 'ceilingIntensity');
bindLight('ltAccent', 'accent');
bindLight('ltAccentC', 'accentColor', (v) => v);

// ---------- Свойства ----------
const opt = (list, v) => list.map((m) => `<option value="${m.id}" ${m.id === v ? 'selected' : ''}>${m.name}</option>`).join('');
const numField = (id, label, v, step = 1) => `<label>${label}<input type="number" id="${id}" value="${v}" step="${step}"></label>`;

function colorToHex(c, fallback = '#b0a090') {
  if (c == null || c === '') return fallback;
  const n = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);
  if (!Number.isFinite(n)) return fallback;
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
}

function renderCtorProps(el) {
  const ob = sel.obstacleId && (project.room.obstacles || []).find((q) => q.id === sel.obstacleId);
  const op = sel.openingId && (project.room.openings || []).find((q) => q.id === sel.openingId);
  if (!ob && !op) return false;
  const bind = (id, fn) => { const f = $('#' + id); if (f) f.onchange = () => { commit(); fn(f); refresh(); }; };
  if (ob) {
    el.innerHTML = `
      <h3>Конструкция: ${ob.name || 'Короб'}</h3>
      <label>Наименование<input type="text" id="ctor_name" value="${ob.name || ''}"></label>
      <div class="props-grid">
        ${numField('ctor_x', 'X', ob.x, 10)}
        ${numField('ctor_z', 'Z', ob.z, 10)}
        ${numField('ctor_rot', 'Поворот °', ob.rot || 0, 90)}
        ${numField('ctor_w', 'Ширина', ob.w, 10)}
        ${numField('ctor_d', 'Глубина', ob.d, 10)}
        ${numField('ctor_y0', 'От пола', ob.y0, 10)}
        ${numField('ctor_y1', 'До (Y)', ob.y1, 10)}
        <label>Цвет<input type="color" id="ctor_color" value="${colorToHex(ob.color, '#b0a090')}"></label>
      </div>
      <p class="muted">Перетаскивание на сцене · R — поворот 90° · Delete — удалить</p>
      <div class="btnrow" style="margin-top:8px">
        <button id="ctor_rot90">Повернуть 90°</button>
        <button id="ctor_del" class="danger">Удалить</button>
      </div>`;
    bind('ctor_name', (f) => { ob.name = f.value.trim(); });
    bind('ctor_x', (f) => { ob.x = +f.value; });
    bind('ctor_z', (f) => { ob.z = +f.value; });
    bind('ctor_rot', (f) => { ob.rot = +f.value; });
    bind('ctor_w', (f) => { ob.w = Math.max(10, +f.value); });
    bind('ctor_d', (f) => { ob.d = Math.max(10, +f.value); });
    bind('ctor_y0', (f) => { ob.y0 = +f.value; });
    bind('ctor_y1', (f) => { ob.y1 = Math.max(ob.y0 + 10, +f.value); });
    const col = $('#ctor_color');
    if (col) col.oninput = () => { commit(); ob.color = hexToInt(col.value); viewer.setRoom(project.room); viewer._refreshHighlights?.(); save(); };
    $('#ctor_rot90').onclick = () => { commit(); ob.rot = ((+ob.rot || 0) + 90) % 360; refresh(); };
    $('#ctor_del').onclick = () => {
      commit();
      project.room.obstacles = (project.room.obstacles || []).filter((q) => q.id !== ob.id);
      sel = emptySel();
      refresh();
    };
    return true;
  }
  const defFill = op.type === 'door' ? '#6b4f2a' : '#9ec9e8';
  el.innerHTML = `
    <h3>${op.type === 'door' ? 'Дверь' : 'Окно'}</h3>
    <div class="props-grid">
      <label>Тип<select id="ctor_type"><option value="window" ${op.type === 'window' ? 'selected' : ''}>Окно</option><option value="door" ${op.type === 'door' ? 'selected' : ''}>Дверь</option></select></label>
      ${numField('ctor_offset', 'Отступ', op.offset, 10)}
      ${numField('ctor_width', 'Ширина', op.width, 10)}
      ${numField('ctor_sill', 'Подоконник', op.sill, 10)}
      ${numField('ctor_height', 'Высота', op.height, 10)}
      <label>Цвет заполнения<input type="color" id="ctor_color" value="${colorToHex(op.color, defFill)}"></label>
      <label>Цвет рамы<input type="color" id="ctor_frame" value="${colorToHex(op.frameColor, '#8b7355')}"></label>
    </div>
    <p class="muted">Перетаскивание вдоль стены · Shift+drag — подоконник · Delete — удалить</p>
    <div class="btnrow" style="margin-top:8px">
      <button id="ctor_del" class="danger">Удалить</button>
    </div>`;
  bind('ctor_type', (f) => { op.type = f.value; });
  bind('ctor_offset', (f) => { op.offset = Math.max(0, +f.value); });
  bind('ctor_width', (f) => { op.width = Math.max(100, +f.value); });
  bind('ctor_sill', (f) => { op.sill = Math.max(0, +f.value); });
  bind('ctor_height', (f) => { op.height = Math.max(100, +f.value); });
  const c1 = $('#ctor_color'), c2 = $('#ctor_frame');
  if (c1) c1.oninput = () => { commit(); op.color = hexToInt(c1.value); viewer.setRoom(project.room); viewer._refreshHighlights?.(); save(); };
  if (c2) c2.oninput = () => { commit(); op.frameColor = hexToInt(c2.value); viewer.setRoom(project.room); viewer._refreshHighlights?.(); save(); };
  $('#ctor_del').onclick = () => {
    commit();
    project.room.openings = (project.room.openings || []).filter((q) => q.id !== op.id);
    sel = emptySel();
    refresh();
  };
  return true;
}

function renderProps() {
  const el = $('#props');
  if (sel.obstacleId || sel.openingId) {
    if (renderCtorProps(el)) return;
  }
  if (sel.fixtureId) return renderFixtureProps(el, fix(sel.fixtureId));
  const m = sel.moduleId && mod(sel.moduleId);
  if (!m) {
    const obs = project.room.obstacles || [];
    const ops = project.room.openings || [];
    el.innerHTML = `<h3>Проект</h3><p class="muted">Выберите модуль, объект или конструкцию. Двойной клик по фасаду — открыть/закрыть.</p>` +
      `<h4>Модули</h4>` +
      project.modules.map((q, i) => `<div><a href="#" data-sel="${q.id}">${i + 1}. ${moduleTitle(q)}</a> <span class="muted">(${q.x},${q.z}) ${q.rot || 0}°</span></div>`).join('') +
      `<h4>Объекты</h4>` +
      (project.fixtures.length ? project.fixtures.map((f) => `<div><a href="#" data-fix="${f.id}">${fixtureTitle(f)}</a></div>`).join('') : '<p class="muted">нет</p>') +
      `<h4>Конструкции</h4>` +
      (obs.length || ops.length
        ? obs.map((q) => `<div><a href="#" data-ob="${q.id}">${q.name || 'Короб'}</a> <span class="muted">${q.w}×${q.d}</span></div>`).join('')
          + ops.map((q) => `<div><a href="#" data-op="${q.id}">${q.type === 'door' ? 'Дверь' : 'Окно'}</a> <span class="muted">${q.width}×${q.height}</span></div>`).join('')
        : '<p class="muted">нет — вкладка Помещение → Конструкции</p>');
    el.querySelectorAll('[data-sel]').forEach((a) => a.onclick = (e) => { e.preventDefault(); sel = { ...emptySel(), moduleId: a.dataset.sel }; refresh(); });
    el.querySelectorAll('[data-fix]').forEach((a) => a.onclick = (e) => { e.preventDefault(); sel = { ...emptySel(), fixtureId: a.dataset.fix }; refresh(); });
    el.querySelectorAll('[data-ob]').forEach((a) => a.onclick = (e) => { e.preventDefault(); sel = { ...emptySel(), obstacleId: a.dataset.ob }; softSelect(); });
    el.querySelectorAll('[data-op]').forEach((a) => a.onclick = (e) => { e.preventDefault(); sel = { ...emptySel(), openingId: a.dataset.op }; softSelect(); });
    return;
  }
  const it = build.items.find((i) => i.module?.id === m.id);
  const p = it?.panels.find((q) => q.key === sel.panelKey);
  if (p) return p.orient === 'B' ? renderLibPanelProps(el, m, it, p) : renderPanelProps(el, m, it, p);
  if (isLib(m)) return renderLibProps(el, m, it);

  const P = m.p, gen = MODULE_TYPES[m.type].gen, idx = project.modules.indexOf(m) + 1;
  const openKeys = it.panels.filter((q) => q.openable);
  el.innerHTML = `
    <h3>Модуль ${idx}: ${MODULE_TYPES[m.type].title}</h3>
    <label>Наименование<input type="text" id="f_name" value="${m.name || ''}" placeholder="${moduleTitle(m)}"></label>
    <div class="props-grid">
      ${numField('f_x', 'X', m.x, 10)}
      ${numField('f_z', 'Z', m.z || 0, 10)}
      ${numField('f_rot', 'Поворот °', m.rot || 0, 90)}
      ${numField('f_width', 'Ширина', P.width, 10)}
      ${numField('f_height', 'Высота', P.height, 10)}
      ${numField('f_depth', 'Глубина', P.depth, 10)}
      ${gen === 'wall' ? numField('f_elev', 'От пола', P.elev, 10) : numField('f_plinth', 'Цоколь', P.plinth, 10)}
      ${numField('f_shelves', 'Полок', P.shelves)}
      ${numField('f_drawers', 'Ящиков', P.drawers)}
      <label>Двери<select id="f_doors">${['auto', 0, 1, 2, 3, 4].map((v) => `<option value="${v}" ${String(P.doors) === String(v) ? 'selected' : ''}>${v === 'auto' ? `авто (${resolveDoors(m)})` : v}</option>`).join('')}</select></label>
      <label>Петли<select id="f_hinge"><option value="left" ${P.hinge === 'left' ? 'selected' : ''}>слева</option><option value="right" ${P.hinge === 'right' ? 'selected' : ''}>справа</option></select></label>
      ${gen === 'wardrobe' ? numField('f_antresol', 'Антресоль', P.antresol, 10) + `<label class="chk"><input type="checkbox" id="f_rod" ${P.rod ? 'checked' : ''}>Штанга</label>` : ''}
    </div>
    <label>Корпус<select id="f_carcass">${opt(matsByKind('ldsp'), m.mat.carcass)}</select></label>
    <label>Фасады<select id="f_front">${opt(matsByKind('mdf', 'ldsp'), m.mat.front)}</select></label>
    <label>Задняя стенка<select id="f_back">${opt(matsByKind('hdf', 'ldsp'), m.mat.back)}</select></label>
    ${openKeys.length ? `<h4>Фасады</h4><div class="btnrow">${openKeys.map((q) => `<button data-tog="${q.key}">${q.name}: ${(m.open?.[q.key] || 0) > 0.5 ? 'открыт' : 'закрыт'}</button>`).join('')}</div>` : ''}
    <div class="btnrow" style="margin-top:8px">
      <button id="b_rot">Повернуть 90°</button>
      <button id="b_dup">Дублировать</button>
      <button id="b_apply_all">Материалы > всем</button>
      <button id="b_del" class="danger">Удалить</button>
    </div>
    <p class="muted">Деталей: ${it.panels.length}. Двойной клик по фасаду — открыть/закрыть.</p>`;

  const bind = (id, fn) => { const f = $('#' + id); if (f) f.onchange = () => { commit(); fn(f); refresh(); }; };
  bind('f_name', (f) => m.name = f.value.trim());
  bind('f_x', (f) => m.x = +f.value);
  bind('f_z', (f) => m.z = +f.value);
  bind('f_rot', (f) => m.rot = +f.value);
  for (const k of ['width', 'height', 'depth', 'elev', 'plinth', 'shelves', 'drawers', 'antresol']) {
    bind('f_' + k, (f) => { P[k] = Math.max(0, +f.value); if (k === 'drawers' && P.drawers > 0) P.doors = 0; });
  }
  bind('f_doors', (f) => { P.doors = f.value === 'auto' ? 'auto' : +f.value; if (P.doors !== 0) P.drawers = 0; });
  bind('f_hinge', (f) => P.hinge = f.value);
  bind('f_rod', (f) => P.rod = f.checked);
  for (const k of ['carcass', 'front', 'back']) bind('f_' + k, (f) => m.mat[k] = f.value);
  el.querySelectorAll('[data-tog]').forEach((b) => b.onclick = () => { commit(); toggleFront(m, b.dataset.tog); syncFrontAnim(); });
  $('#b_rot').onclick = () => { commit(); m.rot = ((+m.rot || 0) + 90) % 360; refresh(); };
  $('#b_del').onclick = () => { commit(); project.modules = project.modules.filter((q) => q !== m); sel = { moduleId: null, panelKey: null, fixtureId: null }; refresh(); };
  $('#b_dup').onclick = () => {
    commit();
    const c = JSON.parse(JSON.stringify(m));
    c.id = createModule('base').id;
    c.x = nextFreeX(project, m.type, moduleRow(m));
    project.modules.push(c);
    sel = { moduleId: c.id, panelKey: null, fixtureId: null };
    refresh();
  };
  $('#b_apply_all').onclick = () => { commit(); project.modules.forEach((q) => q.mat = { ...m.mat }); log('Материалы применены ко всем', 'ok'); refresh(); };
}

function renderFixtureProps(el, f) {
  if (!f) { sel.fixtureId = null; return renderProps(); }
  const def = FIXTURE_CATALOG[f.type];
  const host = f.moduleId && mod(f.moduleId);
  const bind = (id, fn) => { const inp = $('#' + id); if (inp) inp.onchange = () => { commit(); fn(inp); refresh(); }; };
  const head = `
    <h3>${fixtureTitle(f)}</h3>
    <p class="muted">${def?.category || ''} · ${def?.price ? def.price.toLocaleString('ru-RU') + ' ₽' : ''}</p>`;

  if (host) {
    const center = +host.p.width / 2;
    el.innerHTML = head + `
      <p>Встроен в модуль ${project.modules.indexOf(host) + 1}: <a href="#" id="fx_host">${moduleTitle(host)}</a>. Двигается вместе с модулем.</p>
      <div class="props-grid">
        ${numField('fx_dx', 'Смещение от центра', Math.round(+f.lx - center), 10)}
        ${numField('fx_lz', 'От задней стенки', Math.round(+f.lz), 10)}
      </div>
      <label>Наименование<input type="text" id="fx_name" value="${f.name || ''}"></label>
      <div class="btnrow">
        <button id="fx_center">По центру модуля</button>
        <button id="fx_unbind">Отвязать</button>
        <button id="fx_del" class="danger">Удалить</button>
      </div>`;
    bind('fx_dx', (i) => f.lx = center + +i.value);
    bind('fx_lz', (i) => f.lz = +i.value);
    $('#fx_center').onclick = () => { commit(); f.lx = center; refresh(); };
    $('#fx_unbind').onclick = () => {
      commit();
      const w = resolveFixture(project, f);
      Object.assign(f, { x: Math.round(w.x), z: Math.round(w.z), elev: Math.round(w.elev), rot: w.rot, moduleId: null });
      refresh();
    };
    $('#fx_host').onclick = (e) => { e.preventDefault(); sel = { moduleId: host.id, panelKey: null, fixtureId: null }; refresh(); };
  } else {
    el.innerHTML = head + `
      <div class="props-grid">
        ${numField('fx_x', 'X', f.x, 10)}
        ${numField('fx_z', 'Z', f.z, 10)}
        ${numField('fx_elev', 'Высота от пола', f.elev, 10)}
        ${numField('fx_rot', 'Поворот °', f.rot || 0, 90)}
      </div>
      <label>Наименование<input type="text" id="fx_name" value="${f.name || ''}"></label>
      <div class="btnrow"><button id="fx_rot">Повернуть 90°</button><button id="fx_del" class="danger">Удалить</button></div>`;
    bind('fx_x', (i) => f.x = +i.value);
    bind('fx_z', (i) => f.z = +i.value);
    bind('fx_elev', (i) => f.elev = +i.value);
    bind('fx_rot', (i) => f.rot = +i.value);
    $('#fx_rot').onclick = () => { commit(); f.rot = ((+f.rot || 0) + 90) % 360; refresh(); };
  }
  bind('fx_name', (i) => f.name = i.value.trim());
  $('#fx_del').onclick = () => { commit(); project.fixtures = project.fixtures.filter((q) => q !== f); sel.fixtureId = null; refresh(); };
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLibProps(el, m, it) {
  const idx = project.modules.indexOf(m) + 1, L = m.lib, P = m.p;
  const sp = libSpec(m);
  const hwList = Array.isArray(sp.hw) ? sp.hw : [];
  const openKeys = it.panels.filter((q) => q.openable);
  const g = libGeom(L.n);
  const hwTop = hwList.slice(0, 16).map((h) => `<div>${escHtml(h.name)}${h.art ? ` <span class="muted">[${escHtml(h.art)}]</span>` : ''} — ${h.qty}</div>`).join('');
  const geomReady = !!g;
  const hwHint = hwList.length
    ? hwTop + (hwList.length > 16 ? '<div>… полный список — в спецификации</div>' : '')
    : (!libGeomTried(L.n)
      ? 'загрузка геометрии…'
      : (g == null ? 'файл геометрии не найден' : 'в модели нет позиций фурнитуры (часто у geom=box)'));
  if (!libGeomTried(L.n)) loadLibGeom(L.n).then(() => softSelect());
  el.innerHTML = `
    <h3>Модуль ${idx}: Самолет</h3>
    <div class="art" style="font-weight:600;word-break:break-all">${escHtml(L.art)}</div>
    <p class="muted">${escHtml(L.cat)} · ${P.width}×${P.height}×${P.depth}${L.code ? ` · код ${escHtml(L.code)}` : ''}${L.decor ? ` · декор ${escHtml(L.decor)}` : ''}${hwList.length ? ` · фурн. ${hwList.length}` : ''}</p>
    <label>Наименование<input type="text" id="f_name" value="${escHtml(m.name || '')}" placeholder="${escHtml(moduleTitle(m))}"></label>
    <div class="props-grid">
      ${numField('f_x', 'X', m.x, 10)}
      ${numField('f_z', 'Z', m.z || 0, 10)}
      ${numField('f_rot', 'Поворот °', m.rot || 0, 90)}
      ${numField('f_elev', 'От пола', P.elev || 0, 10)}
    </div>
    ${openKeys.length ? `<h4>Фасады <span class="muted">(двойной клик по фасаду)</span></h4><div class="btnrow">${openKeys.map((q) => `<button data-tog="${q.key}">${escHtml(q.name)}: ${(m.open?.[q.key] || 0) > 0.5 ? 'открыт' : 'закрыт'}</button>`).join('')}</div>` : '<p class="muted">Открываемых фасадов нет (или геометрия ещё грузится)</p>'}
    <h4>Фурнитура (${hwList.length} поз.)</h4>
    <div class="muted" style="font-size:11px">${hwHint}</div>
    <div class="btnrow" style="margin-top:8px">
      <button id="b_rot">Повернуть 90°</button>
      <button id="b_dup">Дублировать</button>
      <button id="b_del" class="danger">Удалить</button>
    </div>
    <p class="muted">Деталей: ${sp.panels.length}, элементов модели: ${it.panels.length}. В Базис вставляется исходный файл:<br><code style="word-break:break-all">${L.file}</code></p>`;
  const bind = (id, fn) => { const f = $('#' + id); if (f) f.onchange = () => { commit(); fn(f); refresh(); }; };
  bind('f_name', (f) => m.name = f.value.trim());
  bind('f_x', (f) => m.x = +f.value);
  bind('f_z', (f) => m.z = +f.value);
  bind('f_rot', (f) => m.rot = +f.value);
  bind('f_elev', (f) => P.elev = Math.max(0, +f.value));
  el.querySelectorAll('[data-tog]').forEach((b) => b.onclick = () => { commit(); toggleFront(m, b.dataset.tog); syncFrontAnim(); });
  $('#b_rot').onclick = () => { commit(); m.rot = ((+m.rot || 0) + 90) % 360; refresh(); };
  $('#b_del').onclick = () => { commit(); project.modules = project.modules.filter((q) => q !== m); sel = { moduleId: null, panelKey: null, fixtureId: null }; refresh(); };
  $('#b_dup').onclick = () => {
    commit();
    const c = JSON.parse(JSON.stringify(m));
    c.id = createModule('base').id;
    c.x = nextFreeX(project, 'lib', moduleRow(m));
    project.modules.push(c);
    sel = { moduleId: c.id, panelKey: null, fixtureId: null };
    refresh();
  };
}

function renderLibPanelProps(el, m, it, p) {
  const s = panelSize(p);
  el.innerHTML = `
    <h3>Деталь: ${p.name}</h3>
    <p class="muted">Модуль ${it.index} · ${m.lib.art}${p.openable ? ' · фасад (двойной клик — открыть/закрыть)' : ''}</p>
    <table><tr><th>Длина</th><th>Ширина</th><th>Толщина</th></tr><tr><td>${Math.round(s.L * 10) / 10}</td><td>${Math.round(s.W * 10) / 10}</td><td>${Math.round(s.T * 10) / 10}</td></tr></table>
    <p>Материал: ${p.matName || '—'}</p>
    <p class="muted">Деталь из исходной модели Самолета; материал и кромка правятся в Базисе.</p>
    <div class="btnrow" style="margin-top:8px">
      <button id="p_back">< К модулю</button>
      ${p.openable ? `<button id="p_tog">${(m.open?.[p.key] || 0) > 0.5 ? 'Закрыть' : 'Открыть'}</button>` : ''}
    </div>`;
  $('#p_back').onclick = () => { sel.panelKey = null; refresh(); };
  const tog = $('#p_tog');
  if (tog) tog.onclick = () => { commit(); toggleFront(m, p.key); syncFrontAnim(); };
}

function renderPanelProps(el, m, it, p) {
  const s = panelSize(p);
  const ov = m.overrides[p.key] || {};
  const kinds = p.role === 'front' ? ['mdf', 'ldsp'] : p.role === 'back' ? ['hdf', 'ldsp'] : p.role === 'top' ? ['top'] : ['ldsp', 'hdf'];
  const sides = BUTT_SIDES[p.orient];
  el.innerHTML = `
    <h3>Деталь: ${p.name}</h3>
    <p class="muted">Модуль ${it.index}${p.openable ? ' · фасад (двойной клик — открыть/закрыть)' : ''}</p>
    <table><tr><th>Длина</th><th>Ширина</th><th>Толщина</th></tr><tr><td>${s.L}</td><td>${s.W}</td><td>${s.T}</td></tr></table>
    <label>Материал<select id="p_mat">${opt(matsByKind(...kinds), p.mat)}</select></label>
    <div class="butts"><b>Кромка</b><br>${p.butts.map((e, i) => `
      <label>${sides[i]} <select data-butt="${i}"><option value="">—</option>${Object.entries(EDGES).map(([id, ed]) => `<option value="${id}" ${e === id ? 'selected' : ''}>${ed.sign}</option>`).join('')}</select></label>`).join('')}
    </div>
    <div class="btnrow" style="margin-top:8px">
      <button id="p_back">< К модулю</button>
      ${p.openable ? `<button id="p_tog">${(m.open?.[p.key] || 0) > 0.5 ? 'Закрыть' : 'Открыть'}</button>` : ''}
      ${Object.keys(ov).length ? '<button id="p_reset">Сбросить правки</button>' : ''}
      <button id="p_del" class="danger">Удалить деталь</button>
    </div>`;
  const setOv = (fn) => { commit(); const o = m.overrides[p.key] || (m.overrides[p.key] = {}); fn(o); refresh(); };
  $('#p_mat').onchange = (e) => setOv((o) => o.mat = e.target.value);
  el.querySelectorAll('[data-butt]').forEach((s2) => s2.onchange = () => setOv((o) => { o.butts = [...(o.butts || p.butts)]; o.butts[+s2.dataset.butt] = s2.value || null; }));
  $('#p_back').onclick = () => { sel.panelKey = null; refresh(); };
  const tog = $('#p_tog'); if (tog) tog.onclick = () => { commit(); toggleFront(m, p.key); syncFrontAnim(); };
  $('#p_del').onclick = () => { setOv((o) => o.removed = true); sel.panelKey = null; refresh(); };
  const r = $('#p_reset'); if (r) r.onclick = () => { commit(); delete m.overrides[p.key]; refresh(); };
}

function renderIssues() {
  const el = $('#issues');
  if (!build.issues.length) { el.innerHTML = '<div class="none">Ошибок нет</div>'; return; }
  el.innerHTML = build.issues.map((i) => `<div class="${i.level}" data-mid="${i.moduleId}">${i.text}</div>`).join('');
  el.querySelectorAll('[data-mid]').forEach((d) => d.onclick = () => { sel = { moduleId: d.dataset.mid, panelKey: null, fixtureId: null }; refresh(); });
}

$('#topMat').innerHTML = opt(matsByKind('top'), project.settings.topMat);
$('#prjName').onchange = (e) => { project.name = e.target.value; save(); };
$('#topOn').onchange = (e) => { commit(); project.settings.countertop = e.target.checked; refresh(); };
$('#topMat').onchange = (e) => { commit(); project.settings.topMat = e.target.value; refresh(); };
$('#frontMode').onchange = (e) => viewer.setFrontMode(e.target.value);
$('#roomShow').onchange = (e) => { project.room.show = e.target.value; viewer.setRoom(project.room); save(); };
$('#fixShow').onchange = (e) => { project.showFixtures = e.target.checked; viewer.setFixturesVisible(e.target.checked); save(); };
$('#wallLettersShow').onchange = (e) => {
  project.room.showWallLetters = e.target.checked;
  viewer.setWallLettersVisible(e.target.checked);
  save();
};
document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => viewer.setView(b.dataset.view));

$('#cmdForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#cmd').value;
  if (!text.trim()) return;
  log('> ' + text);
  const snapshot = JSON.stringify(project);
  const res = runCommand(text, {
    project,
    selected: () => (sel.moduleId ? mod(sel.moduleId) : null),
    select: (id) => { sel = { moduleId: id, panelKey: null, fixtureId: null }; },
  });
  if (res.changed) undo.push(snapshot);
  log(res.msg, res.ok ? 'ok' : 'err');
  $('#cmd').value = '';
  refresh();
};

function download(name, text, mime, bom = true) {
  const blob = new Blob([bom ? '\uFEFF' + text : text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = () => project.name.replace(/[\\/:*?"<>|]+/g, '_');

function showSpec() {
  const s = computeSpec(project, build);
  const fixRows = project.fixtures.map((f) => {
    const d = FIXTURE_CATALOG[f.type];
    return `<tr><td>${fixtureTitle(f)}</td><td>${d?.category || ''}</td><td class="num">${(d?.price || 0).toLocaleString('ru-RU')}</td></tr>`;
  });
  const fixSum = project.fixtures.reduce((a, f) => a + (FIXTURE_CATALOG[f.type]?.price || 0), 0);
  const money = (v) => v.toLocaleString('ru-RU');
  const tbl = (head, rows) => `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table>`;
  const mods = build.items.filter((it) => !it.virtual);
  $('#specBody').innerHTML = `
    <h2>${project.name}</h2>
    <h3>Изделия</h3>${tbl(['№', 'Изделие', 'Код', 'Габариты', 'Деталей', 'Цена'], s.modules.map((m) => `<tr><td>${m.index}</td><td>${m.title}</td><td>${m.code}</td><td>${m.size}</td><td class="num">${m.panels}</td><td class="num">${money(m.cost)}</td></tr>`))}
    ${mods.length ? `<h3>Взрыв-схема модуля</h3>
    <div class="explode-wrap">
      <div id="explodeView" class="explode-view"></div>
      <div class="explode-ctl">
        <label>Модуль<select id="exMod">${mods.map((it) => `<option value="${it.module.id}">${it.index}. ${it.title}</option>`).join('')}</select></label>
        <label>Разлёт деталей: <b id="exVal">60%</b><input type="range" id="exFactor" min="0" max="3" step="0.05" value="0.6"></label>
        <label class="chk"><input type="checkbox" id="exFronts" checked> Показывать фасады</label>
        <div class="btnrow"><button id="exFit" type="button">Вписать</button><button id="exPng" type="button">Сохранить PNG</button></div>
        <div id="exInfo" class="muted" style="margin-top:6px;font-size:12px"></div>
      </div>
    </div>` : ''}
    <h3>Техника и коммуникации</h3>${fixRows.length ? tbl(['Наименование', 'Категория', 'Цена'], fixRows) : '<p class="muted">нет</p>'}
    <p><b>Мебель: ${money(s.total)} ₽ · Объекты: ${money(fixSum)} ₽ · Итого: ${money(s.total + fixSum)} ₽</b></p>
    <h3>Фурнитура</h3>${tbl(['Наименование', 'Артикул', 'Кол.', 'Цена', 'Сумма'], s.hwRows.map((r) => `<tr><td>${r.name}</td><td>${r.art || ''}</td><td class="num">${r.qty}</td><td class="num">${money(r.price)}</td><td class="num">${money(r.sum)}</td></tr>`))}
    <h3>Детали</h3>${tbl(['Мод.', 'Деталь', 'Поз.', 'Длина', 'Ширина', 'Толщ.', 'Материал', 'Кромка', 'Кол.'], s.details.map((d) => `<tr><td>${d.module}</td><td>${d.name}</td><td>${d.art || ''}</td><td class="num">${d.L}</td><td class="num">${d.W}</td><td class="num">${d.T}</td><td>${d.mat}</td><td>${d.edges}</td><td class="num">${d.qty}</td></tr>`))}`;
  $('#specDlg').showModal();
  if (mods.length) initExplode(mods);
}

let explodeView = null;
function initExplode(mods) {
  explodeView?.dispose();
  explodeView = new ExplodeView($('#explodeView'));
  const show = () => {
    const it = mods.find((q) => q.module.id === $('#exMod').value) || mods[0];
    explodeView.setFactor(+$('#exFactor').value);
    explodeView.setItem(it, { fronts: $('#exFronts').checked });
    const groups = new Set(it.panels.map((p) => (p.group != null ? 'g' + p.group : p.key)));
    $('#exInfo').textContent = `Элементов: ${it.panels.length}, групп разлёта: ${groups.size}. Мышь: вращение, колесо — масштаб.`;
  };
  if (sel.moduleId && mods.some((q) => q.module.id === sel.moduleId)) $('#exMod').value = sel.moduleId;
  $('#exMod').onchange = show;
  $('#exFronts').onchange = show;
  $('#exFactor').oninput = (e) => { $('#exVal').textContent = Math.round(e.target.value * 100) + '%'; explodeView.setFactor(+e.target.value); };
  if ($('#exFit')) $('#exFit').onclick = () => explodeView.fit();
  if ($('#exPng')) $('#exPng').onclick = () => {
    explodeView.draw();
    const a = document.createElement('a');
    a.href = explodeView.renderer.domElement.toDataURL('image/png');
    a.download = `${safeName()}_взрыв_${$('#exMod').selectedOptions[0].textContent.replace(/[\\/:*?"<>|]+/g, '_')}.png`;
    a.click();
  };
  requestAnimationFrame(show);
}
$('#specDlg').addEventListener('close', () => { explodeView?.dispose(); explodeView = null; });

const actions = {
  undo: () => { const s = undo.pop(); if (s) { project = migrateProject(JSON.parse(s)); refresh(); log('Отменено'); } },
  new: () => {
    if (!confirm('Создать новый проект?')) return;
    commit(); project = newProject(); sel = { moduleId: null, panelKey: null, fixtureId: null }; refresh();
    openRoomPlan(true);
  },
  demoKitchen: async () => {
    if (project.modules.length && !confirm('Открыть «Кухня Самолет (пример)»? Текущий проект можно вернуть через ?.')) return;
    try {
      const p = await samoletKitchen();
      commit();
      project = p;
      sel = { moduleId: null, panelKey: null, fixtureId: null };
      refresh();
      viewer.setView('3d');
      log(`Пример кухни: ${p.modules.length} модулей Самолет, ${p.fixtures.length} объектов`, 'ok');
    } catch (err) { log('Не удалось собрать пример кухни: ' + err.message, 'err'); }
  },
  open: () => $('#fileOpen').click(),
  save: () => download(`${safeName()}.json`, JSON.stringify(project, null, 1), 'application/json', false),
  spec: showSpec,
  bazis: async () => {
    const errs = build.issues.filter((i) => i.level === 'error');
    if (errs.length && !confirm(`Ошибок: ${errs.length}. Всё равно выгрузить?`)) return;
    if (!project.settings.samoletPath && samoletIndex()?.source) {
      project.settings.samoletPath = samoletIndex().source;
    }
    const chk = bazisExportCheck(project, build);
    if (!chk.ok) {
      log(chk.missing.join('; '), 'err');
      alert(chk.missing.join('\n') + '\n\nУкажите папки на вкладке «Каталог».');
      return;
    }
    if (chk.samLibs && !resolveSamoletBase(project)) {
      log('Нет пути к .b3d Самолет', 'err');
      return;
    }
    if (chk.userLibs && !resolveUserCatalogBase(project)) {
      log('Нет пути к папке моих .b3d', 'err');
      return;
    }
    try { await loadHwCatalog(); } catch (_) { /* optional */ }
    // параметрические модули: автофурнитура с bazisFile для OpenFurniture
    for (const it of build.items || []) {
      if (it.virtual || isLib(it.module) || it.fittings?.length) continue;
      it.fittings = autoFittingsForModule(it.module, it.panels).map(enrichFitting);
    }
    const script = toBazisScript(project, build);
    download(`${safeName()}_bazis.js`, script, 'text/javascript');
    const furnN = (build.items || []).reduce((s, it) => s + (it.fittings?.length || 0), 0);
    log(`Скрипт Базиса: ${chk.samLibs || 0} Самолет + ${chk.userLibs || 0} моих + OpenFurniture×${furnN}. Запустите в новой модели.`, 'ok');
  },
  bazisTest: () => { download('bazis_api_test.js', bazisSmokeTest(), 'text/javascript'); log('Тест Базиса сохранён', 'ok'); },
  csv: () => download(`${safeName()}_spec.csv`, specToCSV(computeSpec(project, build)), 'text/csv'),
  onec: () => download(`${safeName()}_1c.json`, JSON.stringify(specTo1C(project, computeSpec(project, build)), null, 1), 'application/json'),
};
document.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => actions[b.dataset.act]());
$('#fileOpen').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { commit(); project = migrateProject(JSON.parse(await f.text())); sel = { moduleId: null, panelKey: null, fixtureId: null }; refresh(); log(`Открыт ${f.name}`, 'ok'); }
  catch (err) { log('Не удалось открыть: ' + err.message, 'err'); }
  e.target.value = '';
};

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); actions.undo(); }
  if (e.key === 'Delete') {
    commit();
    if (sel.obstacleId) {
      project.room.obstacles = (project.room.obstacles || []).filter((q) => q.id !== sel.obstacleId);
      sel = emptySel();
    } else if (sel.openingId) {
      project.room.openings = (project.room.openings || []).filter((q) => q.id !== sel.openingId);
      sel = emptySel();
    } else if (sel.fixtureId) {
      project.fixtures = project.fixtures.filter((f) => f.id !== sel.fixtureId);
      sel = emptySel();
    } else if (sel.moduleId && !String(sel.moduleId).startsWith('__top')) {
      const m = mod(sel.moduleId);
      if (sel.panelKey) { if (!isLib(m)) (m.overrides[sel.panelKey] ||= {}).removed = true; sel.panelKey = null; }
      else { project.modules = project.modules.filter((q) => q !== m); sel = emptySel(); }
    }
    refresh();
  }
  if (e.key === 'Escape') { sel = emptySel(); viewer.setMode('select'); placeEntry = null; updateModeBadge(); refresh(); }
});

// ---------- Опросник ТЗ > промпт ИИ ----------
let brief = loadBrief();

function readBriefForm() {
  brief = {
    shape: $('#brShape').value,
    mainWall: $('#brMain').value,
    secondWall: $('#brSecond').value,
    corner: $('#brCorner').value,
    fill: $('#brFill').value,
    tall: $('#brTall').value,
    sink: $('#brSink').checked ? 'yes' : 'no',
    hob: $('#brHob').checked ? 'yes' : 'no',
    oven: $('#brOven').checked ? 'yes' : 'no',
    dishwasher: $('#brDw').checked ? 'yes' : 'no',
    hood: $('#brHood').checked ? 'yes' : 'no',
    decor: $('#brDecor').value,
    depth: $('#brDepth').value,
    replace: $('#brReplace').checked,
    freeText: $('#brFree').value,
  };
  saveBrief(brief);
  return brief;
}

function fillBriefForm() {
  const b = brief;
  $('#brShape').value = b.shape;
  $('#brMain').value = b.mainWall;
  $('#brSecond').value = b.secondWall;
  $('#brCorner').value = b.corner;
  $('#brFill').value = b.fill;
  $('#brTall').value = b.tall;
  $('#brSink').checked = b.sink === 'yes';
  $('#brHob').checked = b.hob === 'yes';
  $('#brOven').checked = b.oven === 'yes';
  $('#brDw').checked = b.dishwasher === 'yes';
  $('#brHood').checked = b.hood === 'yes';
  $('#brDecor').value = b.decor || 'KF';
  $('#brDepth').value = b.depth || '560';
  $('#brReplace').checked = b.replace !== false;
  $('#brFree').value = b.freeText || '';
  syncBriefShape();
}

function syncBriefShape() {
  const corner = $('#brShape').value !== 'linear';
  $('#brSecondWrap').style.display = corner ? '' : 'none';
  $('#brCornerWrap').style.display = corner ? '' : 'none';
}

function refreshBriefPreview() {
  const text = buildAiPrompt(project, readBriefForm());
  $('#brPreview').value = text;
  const L = project.room.length, D = project.room.depth;
  $('#brHint').textContent = `Комната ${L}?${D}. Стены A=${L}, B=${D}, C=${L}, D=${D} мм. Промпт для вставки в чат ИИ.`;
  return text;
}

document.querySelectorAll('#tab-brief select, #tab-brief input, #tab-brief textarea').forEach((el) => {
  if (el.id === 'brPreview') return;
  el.addEventListener('change', () => { syncBriefShape(); refreshBriefPreview(); });
  el.addEventListener('input', () => { if (el.id === 'brFree') refreshBriefPreview(); });
});
$('#brShape').addEventListener('change', syncBriefShape);

$('#brCopy').onclick = async () => {
  const text = refreshBriefPreview();
  try {
    await navigator.clipboard.writeText(text);
    log('Промпт скопирован — вставьте в чат ИИ (Ctrl+V)', 'ok');
  } catch {
    $('#brPreview').select();
    log('Не удалось в буфер — выделите превью и скопируйте вручную (Ctrl+C)', 'err');
  }
};
$('#brDownload').onclick = () => {
  const text = refreshBriefPreview();
  download(`${safeName()}_tz_ai.md`, text, 'text/markdown', false);
  log('ТЗ сохранено в .md — можно приложить к сообщению в чат ИИ', 'ok');
};
$('#brToCmd').onclick = () => {
  const b = readBriefForm();
  const corner = b.shape === 'corner'
    ? ` угловую, угол ${b.corner}, основная стена ${b.mainWall}`
    : b.shape === 'u' ? ` П-образную, основная стена ${b.mainWall}` : ` линейную вдоль стены ${b.mainWall}`;
  const tall = b.tall === 'none' ? '' : `, пенал ${b.tall === 'right' ? 'справа' : 'слева'}`;
  const rows = ({ full: 'нижние и верхние модули', base_only: 'только нижние', wall_only: 'только верхние' })[b.fill];
  const phrase = `Построй кухню${corner}${tall}. ${rows}. Декор ${b.decor}.`
    + (b.sink === 'yes' ? ' С мойкой.' : '')
    + (b.hob === 'yes' ? ' С варочной.' : '')
    + (b.oven === 'yes' ? ' С духовкой.' : '')
    + (b.freeText ? ' ' + b.freeText.trim() : '')
    + ' (полный промпт — вкладка «ТЗ > ИИ»).';
  $('#cmd').value = phrase;
  log('Краткая фраза в поле команд. Для сборки через ИИ скопируйте полный промпт кнопкой выше.', 'ok');
};

// Обновлять превью при смене вкладки на brief
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    if (t.dataset.tab === 'brief') refreshBriefPreview();
  });
});

fillBriefForm();

// ---------- LLM (LM Studio) ----------
let llmSettings = loadLlmSettings();

function fillLlmForm() {
  $('#llmUrl').value = llmSettings.baseUrl;
  $('#llmMode').value = llmSettings.mode || 'lmstudio';
  $('#llmKey').value = llmSettings.apiKey || '';
  const sel = $('#llmModel');
  const cur = llmSettings.model || '';
  if (![...sel.options].some((o) => o.value === cur) && cur) {
    const o = document.createElement('option');
    o.value = cur; o.textContent = cur;
    sel.appendChild(o);
  }
  sel.value = cur;
}

function readLlmForm() {
  llmSettings = {
    ...llmSettings,
    baseUrl: $('#llmUrl').value.trim() || 'http://127.0.0.1:1234',
    mode: $('#llmMode').value,
    model: $('#llmModel').value,
    apiKey: $('#llmKey').value.trim(),
  };
  saveLlmSettings(llmSettings);
  return llmSettings;
}

async function refreshLlmModels() {
  const st = $('#llmStatus');
  try {
    readLlmForm();
    st.textContent = 'Запрос списка моделей…';
    const models = await listModels(llmSettings);
    const sel = $('#llmModel');
    const prev = sel.value;
    sel.innerHTML = '<option value="">— авто (загруженная) —</option>'
      + models.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    st.textContent = models.length
      ? `Моделей: ${models.length}` + (models.some((m) => m.loaded) ? ', есть загруженные ?' : ' (ни одна не загружена в LM Studio)')
      : 'Список пуст';
  } catch (e) {
    st.textContent = 'Не удалось связаться с сервером: ' + e.message
      + '. Проверьте LM Studio > Developer > Local Server (Start) и CORS.';
  }
}

$('#llmRefresh').onclick = () => refreshLlmModels();
['llmUrl', 'llmMode', 'llmModel', 'llmKey'].forEach((id) => {
  $('#' + id).onchange = () => readLlmForm();
});

$('#llmBuild').onclick = async () => {
  const st = $('#llmStatus');
  const btn = $('#llmBuild');
  btn.disabled = true;
  try {
    await loadSamoletIndex();
    readLlmForm();
    const b = readBriefForm();
    const { project: p, report, plan } = await planKitchenWithLlm(project, b, llmSettings, (m) => { st.textContent = m; });
    commit();
    project = p;
    sel = { moduleId: null, panelKey: null, fixtureId: null };
    refresh();
    viewer.setView('3d');
    st.textContent = `Готово: ${p.modules.length} модулей, ${(plan.fixtures || []).length} объектов.`;
    log('LLM: ' + report.slice(0, 12).join(' · ') + (report.length > 12 ? '…' : ''), 'ok');
  } catch (e) {
    st.textContent = 'Ошибка: ' + e.message;
    log('LLM: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

fillLlmForm();

renderLibrary();
renderFixturesLib();
loadUserCatalog();
initSamolet();
log('Готово. Вкладка «ТЗ > ИИ» — опросник для сборки кухни через агента. Стены A–D.');

// ===== Keystone patches (viewport bar, column resize, constructions place) =====
let placeCtorEntry = null;
let planEditLayer = 'floor';
let _planResizeObs = null;
let _planLastW = 0;
let _planDragBase = null;

function renderWallPropsPanel(part) {
  const el = $('#wallPropsPanel');
  if (!el) return;
  const wallSel = part || (viewer.roomSel?.kind === 'wall' ? viewer.roomSel : null);
  if (!wallSel || wallSel.kind === 'ceiling' || wallSel.edgeIndex == null) {
    if (viewer.roomSel?.kind === 'ceiling') {
      el.innerHTML = `<p class="muted">Потолок: режим ${project.room.ceiling?.mode || 'flat'}, точек ${project.room.ceiling?.samples?.length || 0}.</p>`;
      return;
    }
    el.innerHTML = renderWallPropsHtml(null);
    return;
  }
  ensureAdvancedFields(project.room);
  const survey = wallSurvey(project.room, wallSel.edgeIndex);
  const keepFocus = viewer.propFocus;
  el.innerHTML = renderWallPropsHtml(survey);
  el.querySelectorAll('[data-wp]').forEach((inp) => {
    const focusKey = () => {
      const k = inp.dataset.wp;
      if (k === 'wallColor' || k.startsWith('len:')) { viewer.setPropFocus(null); return; }
      viewer.setPropFocus(k);
      renderPlanEditor();
    };
    inp.onfocus = focusKey;
    inp.onpointerdown = focusKey;
    inp.onblur = () => {
      setTimeout(() => {
        if (!el.contains(document.activeElement)) {
          viewer.setPropFocus(null);
          renderPlanEditor();
        }
      }, 120);
    };
    inp.onchange = () => {
      commit();
      const key = inp.dataset.wp;
      const v = +inp.value;
      if (key === 'wallColor') {
        (project.room.wallColors ||= {})[wallSel.edgeIndex] = parseInt(inp.value.replace('#', ''), 16);
      } else if (key === 'lengthFloor') setWallLengthAt(project.room, wallSel.edgeIndex, 0, v);
      else if (key === 'lengthRef') setWallLengthAt(project.room, wallSel.edgeIndex, project.room.yRef || 900, v);
      else if (key === 'lengthCeil') setWallLengthAt(project.room, wallSel.edgeIndex, project.room.height || 2700, v);
      else if (key.startsWith('len:')) setWallLengthAtLevel(project.room, wallSel.edgeIndex, key.slice(4), v);
      const foc = key === 'wallColor' || key.startsWith('len:') ? null : key;
      refresh();
      viewer.setPropFocus(foc);
      const again = el.querySelector(`[data-wp="${key}"]`);
      if (again) again.focus();
    };
  });
  if (keepFocus) {
    viewer.setPropFocus(keepFocus);
    const again = el.querySelector(`[data-wp="${keepFocus}"]`);
    if (again) again.focus();
  }
}

async function placeCommOnWall(part) {
  const segs = roomWallSegments(project.room);
  const seg = segs[part.edgeIndex];
  if (!seg) return;
  const tx = (seg.x2 - seg.x1) / seg.len, tz = (seg.z2 - seg.z1) / seg.len;
  const along = Math.round(((part.point?.x ?? seg.midX) - seg.x1) * tx + ((part.point?.z ?? seg.midZ) - seg.z1) * tz);
  const res = await showRoomPrompt({
    title: `Коммуникация на стене ${part.letter}`,
    fields: [
      { key: 'kind', label: 'Тип: socket | pipe_water | pipe_sewer | pipe_gas', type: 'text', value: 'socket' },
      { key: 'offset', label: 'Отступ вдоль стены, мм', value: Math.max(0, along), step: 10 },
      { key: 'elev', label: 'Высота от пола, мм', value: Math.round(part.y || 1100), step: 10 },
    ],
  });
  if (!res) return;
  const kindRaw = String(res.kind || 'socket').trim().toLowerCase();
  const type = kindRaw === 'socket' || kindRaw === 'socket_kitchen' ? 'socket_kitchen'
    : kindRaw.includes('sewer') ? 'pipe_sewer'
    : kindRaw.includes('gas') ? 'pipe_gas'
    : kindRaw.includes('water') || kindRaw.includes('pipe') ? 'pipe_water'
    : 'socket_kitchen';
  const wall = seg.wall || 'back';
  const pose = placeOnWall(project.room, wall, +res.offset || 0, 0, 40);
  commit();
  const f = createFixture(type, pose.x, pose.z, pose.rot, +res.elev || 1100);
  project.fixtures.push(f);
  refresh();
  log(`Коммуникация ${fixtureTitle(f)} на стене ${part.letter} @ ${res.offset}/${res.elev}`, 'ok');
}

function syncPlanLayerButtons() {
  const box = document.querySelector('.plan-layers');
  const lvls = project.room.levels || [];
  if (!lvls.some((l) => l.id === planEditLayer)) planEditLayer = 'floor';
  if (box) {
    box.innerHTML = lvls.map((l) => `<button type="button" data-plan-layer="${l.id}"
      title="${l.name}, ${Math.round(+l.h)} мм">${l.name}</button>`).join('');
  }
  document.querySelectorAll('[data-plan-layer]').forEach((b) => {
    b.classList.toggle('active', b.dataset.planLayer === planEditLayer);
  });
}
document.querySelector('.plan-layers')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-plan-layer]');
  if (!b) return;
  planEditLayer = b.dataset.planLayer;
  renderPlanEditor();
});

/** Гибкий редактор плана: стены от любой вершины, длины/углы, без обязательного замыкания. */
function openRoomPlan(isNew = false) {
  const room = project.room;
  ensureAdvancedFields(room);
  const closed = !isOpenRoom(room);
  const nW = wallEdgeCount(room);
  const levels = isNew
    ? [
      { id: 'floor', name: 'Пол', h: 0 },
      { id: 'ceil', name: 'Потолок', h: +room.height || 2700 },
    ]
    : levelsWithPlans(room).map((l) => {
      const pts = (closed ? l.plan : l.plan.slice(0, nW + 1)).map((p) => ({ x: +p.x, z: +p.z }));
      return { id: l.id, name: l.name, h: l.h, chain: chainFromPoints(pts, closed) };
    });
  openPlanEditorGraph({
    levels,
    wallThick: room.wallThick || 100,
    onApply: ({ closed: cl, levels: lv, wallThick }) => {
      if (!isNew) commit();
      if (isNew) room.openings = [];
      room.wallColors = {};
      applyDrawnRoom(room, { levels: lv, closed: cl });
      room.wallThick = wallThick;
      const n = wallEdgeCount(room);
      planEditLayer = 'floor';
      log(`Помещение: ${n} стен, контур ${cl ? 'замкнут' : 'открыт'}, уровней ${lv.length} (${lv.map((l) => l.name).join(', ')})`, 'ok');
      refresh();
      renderPlanEditor();
      viewer.setView('3d');
    },
  });
}
document.querySelector('#btnPlanFromPoint')?.addEventListener('click', () => openRoomPlan(false));

function renderPlanEditor() {
  const wrap = document.querySelector('#planSvgWrap');
  if (!wrap || typeof renderPlanSvg !== 'function') return;
  ensureAdvancedFields(project.room);
  syncPlanLayerButtons();
  const verts = planByLayer(project.room, planEditLayer);
  const selEdge = viewer.roomSel?.kind === 'wall' ? viewer.roomSel.edgeIndex : null;
  const opts = {
    verts,
    layerLabel: planLayerLabel(planEditLayer, project.room),
    selectedEdge: selEdge,
    propFocus: viewer.propFocus || null,
    baseline: _planDragBase,
    onEdgeClick: (ei) => {
      unifyRoomPlan(project.room);
      viewer.setRoomSelection({ kind: 'wall', edgeIndex: ei, letter: edgeLetter(ei) });
      renderWallPropsPanel({ kind: 'wall', edgeIndex: ei, letter: edgeLetter(ei) });
      renderPlanEditor();
    },
    onVertexDown: (i) => {
      // снимок ДО изменения — Ctrl+Z вернёт исходное
      commit();
      unifyRoomPlan(project.room);
      ensureAdvancedFields(project.room);
      const plan = planByLayer(project.room, planEditLayer);
      _planDragBase = {
        i,
        verts: plan.map((p) => ({ x: +p.x, z: +p.z })),
      };
    },
    onVertexDrag: (i, x, z) => {
      unifyRoomPlan(project.room);
      ensureAdvancedFields(project.room);
      const plan = planByLayer(project.room, planEditLayer);
      if (!plan[i]) return;
      plan[i].x = x; plan[i].z = z;
      if (planEditLayer === 'floor') syncSimpleAABB(project.room);
      opts.baseline = _planDragBase;
      opts.verts = plan;
      renderPlanSvg(wrap, project.room, opts);
    },
    onVertexUp: () => {
      _planDragBase = null;
      refresh();
      renderWallPropsPanel();
    },
  };
  renderPlanSvg(wrap, project.room, opts);
  _planLastW = Math.round(wrap.clientWidth);
  if (!_planResizeObs) {
    _planResizeObs = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width || wrap.clientWidth);
      if (!wrap.isConnected || w < 40 || w === _planLastW) return;
      _planLastW = w;
      renderPlanEditor();
    });
    _planResizeObs.observe(wrap);
  }
}

function renderConstructionsLib() {
  const el = document.querySelector('#constructionsLib');
  if (!el || !CONSTRUCTION_CATALOG) return;
  const activeId = viewer.mode === 'placeCtor' ? (placeCtorEntry?.id || viewer.placeCtor?.id) : null;
  el.innerHTML = CONSTRUCTION_CATALOG.map((c) => `
    <button type="button" class="ctor-card${activeId === c.id ? ' active' : ''}" data-ctor="${c.id}">
      <div class="ctor-ico">${(CTOR_ICONS && CTOR_ICONS[c.id]) || ''}</div>
      <div class="ctor-title">${c.title}</div>
      <div class="muted">${c.kind === 'opening' ? `${c.width}×${c.height}` : `${c.w}×${c.d}`}</div>
    </button>`).join('');
  el.querySelectorAll('[data-ctor]').forEach((node) => {
    node.onclick = () => {
      const c = CONSTRUCTION_CATALOG.find((q) => q.id === node.dataset.ctor);
      if (!c) return;
      placeCtorEntry = c;
      viewer.setMode('placeCtor', c);
      updateModeBadge();
      renderConstructionsLib();
      log(c.kind === 'opening'
        ? `Постановка «${c.title}»: клик по стене. Esc — отмена.`
        : `Постановка «${c.title}»: клик по полу. Esc — отмена.`, 'ok');
    };
  });
}

function placeCtorAt(ctor, hit, rot = 0) {
  if (!ctor || !hit) return;
  commit();
  unifyRoomPlan(project.room);
  if (ctor.kind === 'opening') {
    const segs = roomWallSegments(project.room);
    const ei = hit.edgeIndex != null ? +hit.edgeIndex : 0;
    const seg = segs[ei];
    const w = +ctor.width || 900;
    let offset = 500;
    let wall = hit.wall || seg?.wall || 'back';
    if (seg && hit.point) {
      const tx = (seg.x2 - seg.x1) / seg.len;
      const tz = (seg.z2 - seg.z1) / seg.len;
      const along = (hit.point.x - seg.x1) * tx + (hit.point.z - seg.z1) * tz;
      offset = Math.max(0, Math.round(along - w / 2));
      wall = seg.wall || wall;
    }
    let sill = +ctor.sill || 0;
    if (ctor.type === 'window' && hit.y != null) sill = Math.max(0, Math.round(hit.y - (+ctor.height || 1400) / 2));
    if (ctor.type === 'door') sill = 0;
    const op = newOpening({
      wall, edgeIndex: ei, type: ctor.type,
      offset, width: w, sill, height: +ctor.height || 2100,
    });
    project.room.openings.push(op);
    sel = { ...emptySel(), openingId: op.id };
    log(`Проём «${ctor.title}» · ${edgeLetter(ei)} · ${offset}`, 'ok');
  } else {
    const w = +ctor.w || 400, d = +ctor.d || 400;
    const x = Math.round((hit.point?.x ?? 500) - w / 2);
    const z = Math.round((hit.point?.z ?? 500) - d / 2);
    const ob = newObstacle({
      w, d, y0: +ctor.y0 || 0, y1: Math.min(+ctor.y1 || 2700, project.room.height || 2700),
      name: ctor.name || ctor.title, x, z, rot: rot || 0,
    });
    (project.room.obstacles ||= []).push(ob);
    sel = { ...emptySel(), obstacleId: ob.id };
    log(`Конструкция «${ctor.title}» @ ${x},${z}`, 'ok');
  }
  refresh();
  renderConstructionsLib();
}

function initColumnResize() {
  const left = document.querySelector('aside.left');
  const right = document.querySelector('aside.right');
  if (!left || !right) return;
  const KEY_L = 'ks3d-aside-left-w', KEY_R = 'ks3d-aside-right-w';
  const apply = (el, w) => {
    const n = Math.max(180, Math.min(Math.floor(window.innerWidth * 0.5), Math.round(w)));
    el.style.width = n + 'px';
    return n;
  };
  const savedL = +localStorage.getItem(KEY_L), savedR = +localStorage.getItem(KEY_R);
  if (savedL >= 180) apply(left, savedL);
  if (savedR >= 180) apply(right, savedR);
  document.querySelectorAll('.col-resizer').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const side = handle.dataset.side;
      const aside = side === 'left' ? left : right;
      const startX = e.clientX, startW = aside.getBoundingClientRect().width;
      handle.classList.add('active');
      const onMove = (ev) => apply(aside, side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX));
      const onUp = () => {
        handle.classList.remove('active');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        localStorage.setItem(side === 'left' ? KEY_L : KEY_R, String(Math.round(aside.getBoundingClientRect().width)));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  });
}

function setLineModeUi(on) {
  viewer.setLineMode(!!on);
  document.querySelector('#btnLines')?.classList.toggle('active', !!viewer.lineMode);
  document.querySelector('#btnLinesBar')?.classList.toggle('active', !!viewer.lineMode);
}

// wire viewer placeCtor / wall hooks if viewer already constructed
if (typeof viewer !== 'undefined' && viewer.h) {
  viewer.h.onPlaceCtor = (ctor, hit, rot) => placeCtorAt(ctor, hit, rot);
  viewer.h.onPlaceCtorHint = (msg) => log(msg, 'warn');
  viewer.h.onWallSelect = (part) => {
    if ($('#commsMode')?.checked && part?.kind === 'wall') {
      placeCommOnWall(part);
      return;
    }
    renderWallPropsPanel(part);
    if (part?.kind === 'wall') {
      document.querySelector('.tab[data-tab="room"]')?.click();
      renderPlanEditor();
    }
  };
  viewer.h.onWallHandleDown = (info) => {
    commit();
    unifyRoomPlan(project.room);
    ensureAdvancedFields(project.room);
    const layer = info.layer || 'floor';
    const plan = planByLayer(project.room, layer);
    _planDragBase = {
      i: info.vertIndex,
      verts: plan.map((p) => ({ x: +p.x, z: +p.z })),
      layer,
    };
    planEditLayer = layer;
    syncPlanLayerButtons();
    viewer.setWallHandleBaseline?.(_planDragBase);
  };
  viewer.h.onWallHandleDrag = (info, x, z) => {
    unifyRoomPlan(project.room);
    ensureAdvancedFields(project.room);
    const layer = info.layer || 'floor';
    const plan = planByLayer(project.room, layer);
    if (!plan[info.vertIndex]) return;
    plan[info.vertIndex].x = Math.round(x / 10) * 10;
    plan[info.vertIndex].z = Math.round(z / 10) * 10;
    if (layer === 'floor') syncSimpleAABB(project.room);
    // лёгкий live-preview без полной пересборки мебели
    if (!viewer._wallHandleDragRaf) {
      viewer._wallHandleDragRaf = requestAnimationFrame(() => {
        viewer._wallHandleDragRaf = 0;
        viewer.setRoom(project.room);
        viewer.setWallHandleBaseline?.(_planDragBase);
        renderPlanEditor();
      });
    }
  };
  viewer.h.onWallHandleUp = () => {
    _planDragBase = null;
    viewer.setWallHandleBaseline?.(null);
    refresh();
    renderWallPropsPanel();
  };
  const prevCancel = viewer.h.onCancelPlace;
  viewer.h.onCancelPlace = () => {
    placeCtorEntry = null;
    prevCancel?.();
    viewer.setMode('select');
    if (typeof updateModeBadge === 'function') updateModeBadge();
    renderConstructionsLib();
  };
}

document.querySelector('#btnLinesBar')?.addEventListener('click', () => setLineModeUi(!viewer.lineMode));
document.querySelectorAll('#viewCmdBar [data-cam]').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const act = b.dataset.cam;
    if (act === 'zoomIn') viewer.zoomCamera?.(1 / 1.2);
    else if (act === 'zoomOut') viewer.zoomCamera?.(1.2);
    else if (act === 'reset') viewer.setView(viewer.navMode === 'orbit' ? '3d' : (viewer.navMode || '3d'));
    else if (act === 'left') viewer.orbitCamera?.(-15, 0);
    else if (act === 'right') viewer.orbitCamera?.(15, 0);
    else if (act === 'up') viewer.orbitCamera?.(0, 12);
    else if (act === 'down') viewer.orbitCamera?.(0, -12);
  });
});

if (document.querySelector('#btnAddFloorVert')) {
  document.querySelector('#btnAddFloorVert').onclick = () => {
    commit();
    ensureAdvancedFields(project.room);
    const selEi = viewer.roomSel?.kind === 'wall' ? viewer.roomSel.edgeIndex : null;
    if (selEi != null) {
      const ni = insertVertexOnEdge(project.room, selEi);
      viewer.setRoomSelection({ kind: 'wall', edgeIndex: ni, letter: edgeLetter(ni) });
      log('Вершина на стене ' + edgeLetter(selEi), 'ok');
    } else {
      const last = project.room.planFloor[project.room.planFloor.length - 1];
      const p = { id: 'v' + Date.now().toString(36), x: (last?.x || 0) + 500, z: last?.z || 0 };
      project.room.planFloor.push(p);
      project.room.planAtRef.push({ ...p, id: p.id + 'r' });
      (project.room.planCeiling ||= []).push({ ...p, id: p.id + 'c' });
      syncSimpleAABB(project.room);
    }
    refresh();
  };
}

initColumnResize();
try { renderConstructionsLib(); } catch (_) {}
try { renderPlanEditor(); } catch (_) {}

refresh();
viewer.setView('3d');
