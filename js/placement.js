// Привязка техники, моек и смесителей к модулю под курсором.
// Объект хранит moduleId и локальное смещение (lx, ly, lz) в СК модуля; мировая позиция вычисляется заново
// при каждой сборке, поэтому объект следует за модулем при перемещении и повороте.

import { FIXTURE_CATALOG } from './fixtures.js';
import { moduleGen, frontT, isLib, localToWorld, worldToLocal, th } from './model.js';

const TOP_T = (prj) => th(prj.settings.topMat);

function moduleDims(m) {
  return { W: +m.p.width, H: +m.p.height, D: +m.p.depth, TF: frontT(m), elev: +m.p.elev || 0, plinth: +m.p.plinth || 0 };
}

// Какие модули подходят для типа объекта
function acceptsModule(def, type, m) {
  const gen = moduleGen(m);
  if (def.kind === 'sink' || def.kind === 'mixer' || type === 'hob_60') return gen === 'base';
  if (type === 'oven_60' || type === 'dishwasher_60') return gen === 'base' || gen === 'tall';
  if (type === 'microwave') return gen === 'wall' || gen === 'tall';
  if (type === 'hood_60') return gen === 'wall' || gen === 'base';
  return false;
}

export function findModuleAt(prj, type, x, z, preferId = null) {
  const def = FIXTURE_CATALOG[type];
  const cands = prj.modules.filter((m) => acceptsModule(def, type, m));
  if (preferId) {
    const m = cands.find((q) => q.id === preferId);
    if (m) return m;
  }
  // Попадание точки в план модуля (с учётом свеса столешницы)
  for (const m of cands) {
    const { W, D, TF } = moduleDims(m);
    const { lx, lz } = worldToLocal(m, x, z);
    if (lx >= 0 && lx <= W && lz >= -20 && lz <= D + TF + (prj.settings.topOverhang ?? 30) + 20) return m;
  }
  // Для вытяжки и СВЧ — модуль, в чьём интервале вдоль стены находится курсор
  for (const m of cands) {
    const { W } = moduleDims(m);
    const { lx } = worldToLocal(m, x, z);
    if (lx >= 0 && lx <= W) return m;
  }
  return null;
}

// Локальное положение объекта внутри модуля
export function localPlacement(prj, type, m) {
  const def = FIXTURE_CATALOG[type];
  const { W, H, D, TF, elev, plinth } = moduleDims(m);
  const ctDepth = D + TF + (prj.settings.topOverhang ?? 30);
  const top = elev + H + (prj.settings.countertop ? TOP_T(prj) : 0);
  const cx = W / 2;
  switch (def.kind === 'appliance' ? type : def.kind) {
    case 'sink':          return { lx: cx, ly: top, lz: ctDepth / 2 + 10 };
    case 'mixer':         return { lx: cx, ly: top, lz: Math.max(50, ctDepth / 2 - def.d / 2 - 230) };
    case 'hob_60':        return { lx: cx, ly: top, lz: (ctDepth - def.d) / 2 };
    case 'oven_60':
    case 'dishwasher_60': return { lx: cx, ly: elev + plinth, lz: D + TF - def.d };
    case 'microwave':     return { lx: cx, ly: elev + Math.max(0, (H - def.h) / 2), lz: D + TF - def.d };
    case 'hood_60':       return moduleGen(m) === 'wall'
      ? { lx: cx, ly: elev - def.h, lz: 0 }
      : { lx: cx, ly: top + 650, lz: 0 };
    default:              return { lx: cx, ly: top, lz: ctDepth / 2 };
  }
}

// Как модуль меняется при встройке техники
export function adaptModule(type, m) {
  const P = m.p;
  if (isLib(m)) return null;
  if (type === 'oven_60') { P.doors = 0; P.drawers = 0; P.shelves = 0; return 'у модуля убраны двери, ящики и полки под духовку'; }
  if (type === 'dishwasher_60') { P.shelves = 0; P.drawers = 0; if (P.doors === 0) P.doors = 1; P.back = false; return 'у модуля убраны полки и задняя стенка под посудомойку'; }
  if (type === 'microwave') { P.shelves = 0; return 'у модуля убраны полки под СВЧ'; }
  return null;
}

// Мировая позиция объекта (для привязанных — через модуль)
export function resolveFixture(prj, f) {
  if (!f.moduleId) return f;
  const m = prj.modules.find((q) => q.id === f.moduleId);
  if (!m) return { ...f, moduleId: null };
  const w = localToWorld(m, +f.lx, +f.ly, +f.lz);
  return { ...f, x: w.x, z: w.z, elev: w.y, rot: ((+m.rot || 0) + (+f.lrot || 0)) % 360 };
}

export const resolveFixtures = (prj) => prj.fixtures.map((f) => resolveFixture(prj, f));

// Предпросмотр и постановка: возвращает поля для объекта
export function snapFixture(prj, type, point, hit) {
  const def = FIXTURE_CATALOG[type];
  const m = findModuleAt(prj, type, point.x, point.z, hit?.moduleId);
  if (m && def.kind !== 'socket' && def.kind !== 'pipe' && type !== 'fridge_60') {
    const lp = localPlacement(prj, type, m);
    const w = localToWorld(m, lp.lx, lp.ly, lp.lz);
    return { moduleId: m.id, lx: lp.lx, ly: lp.ly, lz: lp.lz, lrot: 0, x: w.x, z: w.z, elev: w.y, rot: +m.rot || 0, module: m };
  }
  // Свободная постановка: стена или пол
  const room = prj.room;
  let x = point.x, z = point.z, rot = hit?.rot ?? 0, elev = def.elev ?? 0;
  if (hit?.wall) {
    elev = Math.round(point.y - (def.kind === 'pipe' ? 0 : def.h / 2));
    if (def.kind === 'pipe') elev = def.elev ?? 0;
    if (hit.wall === 'back') { rot = 0; z = 0; }
    else if (hit.wall === 'front') { rot = 180; z = room.depth; }
    else if (hit.wall === 'left') { rot = 90; x = 0; }
    else { rot = 270; x = room.length; }
  }
  return { moduleId: null, x: Math.round(x), z: Math.round(z), elev: Math.max(0, Math.round(elev)), rot };
}

