// Параметрическая модель мебели.
// Система координат совпадает с Базис-Мебельщиком: X — вправо вдоль стены, Y — вверх, Z — от стены к зрителю.
// Панели описываются ровно теми аргументами, которые принимают функции Базиса:
//   H: AddHorizPanel(x1, z1, x2, z2, y)  — толщина откладывается вверх по Y
//   V: AddVertPanel (z1, y1, z2, y2, x)  — толщина откладывается вправо по X
//   F: AddFrontPanel(x1, y1, x2, y2, z)  — толщина откладывается вперёд по Z
// a1,b1,a2,b2 — первые четыре аргумента, pos — пятый.
// Кромки хранятся по индексам элементов контура Базиса (0..3, против часовой стрелки от точки привязки).

import { MATERIALS } from './catalog.js?v=20261028m';
import { libPanels, libModuleData } from './samolet.js?v=20261029j';
import {
  isAdvanced, ensureAdvancedFields, unifyRoomPlan, ceilingHeightAt, footprintInsideRoom, roomOutline,
} from './roomGeom.js?v=20261110a';

export const th = (id) => (MATERIALS[id] || MATERIALS.ldsp16_white).t;

const BUTT_IDX = {
  H: { back: 0, right: 1, front: 2, left: 3 },
  V: { bottom: 0, front: 1, top: 2, back: 3 },
  F: { bottom: 0, right: 1, top: 2, left: 3 },
};
export const BUTT_SIDES = {
  H: ['зад', 'право', 'перед', 'лево'],
  V: ['низ', 'перед', 'верх', 'зад'],
  F: ['низ', 'право', 'верх', 'лево'],
};

function mkPanel(orient, key, name, role, a1, b1, a2, b2, pos, mat, butts = {}, grain = null) {
  const b = [null, null, null, null];
  if (butts.all) b.fill(butts.all);
  for (const [side, e] of Object.entries(butts)) {
    if (side !== 'all' && side in BUTT_IDX[orient]) b[BUTT_IDX[orient][side]] = e || null;
  }
  return {
    key, name, role, orient,
    a1: Math.min(a1, a2), b1: Math.min(b1, b2), a2: Math.max(a1, a2), b2: Math.max(b1, b2),
    pos, mat, t: th(mat), butts: b, grain,
  };
}
const Hp = (k, n, r, x1, z1, x2, z2, y, mat, bt, g = 'u') => mkPanel('H', k, n, r, x1, z1, x2, z2, y, mat, bt, g);
const Vp = (k, n, r, z1, y1, z2, y2, x, mat, bt, g = 'v') => mkPanel('V', k, n, r, z1, y1, z2, y2, x, mat, bt, g);
const Fp = (k, n, r, x1, y1, x2, y2, z, mat, bt, g = 'v') => mkPanel('F', k, n, r, x1, y1, x2, y2, z, mat, bt, g);

export function panelBox(p) {
  const t = p.t;
  switch (p.orient) {
    case 'H': return { x1: p.a1, x2: p.a2, y1: p.pos, y2: p.pos + t, z1: p.b1, z2: p.b2 };
    case 'V': return { x1: p.pos, x2: p.pos + t, y1: p.b1, y2: p.b2, z1: p.a1, z2: p.a2 };
    case 'B': return { x1: p.x1, x2: p.x2, y1: p.y1, y2: p.y2, z1: p.z1, z2: p.z2 };
    default:  return { x1: p.a1, x2: p.a2, y1: p.b1, y2: p.b2, z1: p.pos, z2: p.pos + t };
  }
}

// Длина и ширина детали: длина — вдоль текстуры, если она задана
export function panelSize(p) {
  if (p.orient === 'B') {
    const d = [p.x2 - p.x1, p.y2 - p.y1, p.z2 - p.z1].sort((a, b) => b - a);
    return { L: d[0], W: d[1], T: d[2] };
  }
  const u = p.a2 - p.a1, v = p.b2 - p.b1;
  return p.grain === 'v' ? { L: v, W: u, T: p.t } : { L: u, W: v, T: p.t };
}

// Длина торца элемента контура: элементы 0 и 2 идут вдоль первой оси, 1 и 3 — вдоль второй
export const buttLength = (p, idx) => (idx % 2 === 0 ? p.a2 - p.a1 : p.b2 - p.b1);

export const MODULE_TYPES = {
  base:         { title: 'Тумба с дверями',   row: 'floor', gen: 'base',     p: { width: 600, height: 870, depth: 560, plinth: 100, elev: 0, shelves: 1, doors: 'auto', drawers: 0, hinge: 'left' } },
  base_drawers: { title: 'Тумба с ящиками',   row: 'floor', gen: 'base',     p: { width: 600, height: 870, depth: 560, plinth: 100, elev: 0, shelves: 0, doors: 0, drawers: 3, hinge: 'left' } },
  sink:         { title: 'Тумба под мойку',   row: 'floor', gen: 'base',     p: { width: 800, height: 870, depth: 560, plinth: 100, elev: 0, shelves: 0, doors: 'auto', drawers: 0, hinge: 'left', back: false } },
  wall:         { title: 'Навесной шкаф',     row: 'wall',  gen: 'wall',     p: { width: 600, height: 720, depth: 300, plinth: 0, elev: 1450, shelves: 2, doors: 'auto', drawers: 0, hinge: 'left' } },
  tall:         { title: 'Пенал',             row: 'floor', gen: 'tall',     p: { width: 600, height: 2100, depth: 560, plinth: 100, elev: 0, shelves: 4, doors: 'auto', drawers: 0, hinge: 'left' } },
  wardrobe:     { title: 'Шкаф распашной',    row: 'floor', gen: 'wardrobe', p: { width: 900, height: 2400, depth: 600, plinth: 70, elev: 0, shelves: 4, doors: 'auto', drawers: 0, hinge: 'left', rod: true, antresol: 450 } },
  // Модуль из библиотеки «Самолет»: геометрия и фурнитура — из исходного .b3d (см. samolet.js)
  lib:          { title: 'Модуль Самолет',    row: 'floor', gen: 'lib', hidden: true, p: { width: 600, height: 720, depth: 560, plinth: 0, elev: 0 } },
};

export const isLib = (m) => m?.type === 'lib';
/** Поведение модуля: base | wall | tall | wardrobe | panel */
export const moduleGen = (m) => (isLib(m) ? m.p.kind : MODULE_TYPES[m.type]?.gen);
/** Толщина фасада, выступающего за корпус (у lib-модулей уже входит в глубину) */
export const frontT = (m) => (isLib(m) ? 0 : th(m.mat.front));

export const DEFAULT_MATS = { carcass: 'ldsp16_white', front: 'mdf18_white_gloss', back: 'hdf3_white' };

let seq = 1;
export const newId = () => 'm' + Date.now().toString(36) + (seq++);

export function createModule(type, x = 0, params = {}, mats = {}, pos = {}) {
  const def = MODULE_TYPES[type];
  if (!def) throw new Error('Неизвестный тип модуля: ' + type);
  return {
    id: newId(), type, name: '',
    x: pos.x ?? x, z: pos.z ?? 0, rot: pos.rot ?? 0,
    p: { ...def.p, ...params },
    mat: { ...DEFAULT_MATS, ...mats },
    overrides: {},
    open: {}, // panelKey -> 0..1 (открытие фасада)
  };
}

export function createLibModule(entry, pos = {}) {
  const d = libModuleData(entry);
  return {
    id: newId(), type: 'lib', name: '',
    x: pos.x ?? 0, z: pos.z ?? 0, rot: pos.rot ?? 0,
    lib: d.lib,
    p: { ...d.p, ...(pos.elev != null ? { elev: pos.elev } : {}) },
    mat: { ...DEFAULT_MATS },
    overrides: {},
    open: {},
  };
}

export const moduleTitle = (m) => m.name || (isLib(m) ? m.lib.art : `${MODULE_TYPES[m.type].title} ${m.p.width}`);
export const moduleRow = (m) => (isLib(m) ? m.p.row : MODULE_TYPES[m.type].row);

export function defaultRoom() {
  const L = 4000, D = 3500, H = 2700;
  const plan = [
    { id: 'v0', x: 0, z: 0 }, { id: 'v1', x: L, z: 0 },
    { id: 'v2', x: L, z: D }, { id: 'v3', x: 0, z: D },
  ];
  return {
    editorMode: 'advanced', // единый режим как BPlanner Arch System
    length: L,   // X (AABB, синхронизируется с планом)
    depth: D,    // Z
    height: H,   // Y
    wallThick: 100,
    floorColor: 0xcfc6b8,
    wallColor: 0xf6f4f0,
    openings: [], // новое помещение без дверей/окон — добавляются конструкциями
    features: [], // legacy; новые проекты правят полигон
    yRef: 900,
    // уровни замера: по умолчанию пол и потолок; столешница и другие добавляются в редакторе плана
    levels: [{ id: 'floor', name: 'Пол', h: 0 }, { id: 'ceil', name: 'Потолок', h: H }],
    planFloor: plan.map((p) => ({ ...p })),
    planAtRef: plan.map((p) => ({ ...p })),
    planCeiling: plan.map((p) => ({ ...p })),
    ceiling: { mode: 'flat', height: H, samples: [] },
    obstacles: [],
    fit: { minPassage: 1000, wallCabClearance: 40, angleTolDeg: 1 },
    dimMode: 'basic', // none | basic | all
    layers: {
      ceiling: true, walls: true, floor: true,
      appliances: true, communications: true, furniture: true,
    },
    wallColors: {},
    show: 'auto',
    showWallLetters: true,
    showWallDims: true, // мастер-флаг длин стен на 3D
    showHeightDim: true, // вертикальный размер высоты помещения
    showRoomEdges: false, // окантовка стен/пола/потолка линией (углы виднее)
    edgeWidth: 4.5, // толщина окантовки, px (LineMaterial)
    showWallLens: { floor: true, mid: true, ceil: true }, // длины на уровнях
  };
}

export function defaultLighting() {
  return {
    ambient: 0.55,
    sun: 1.2,
    sunAzimuth: 35,
    sunElevation: 55,
    fill: 0.35,
    // новый проект: светильники на сцене не ставятся (только базовый hemi/sun/fill)
    ceiling: false,
    ceilingCount: 4,
    ceilingIntensity: 0.6,
    accent: false,
    accentColor: '#ffe6c2',
  };
}

export function newProject() {
  return {
    version: 3,
    showFixtures: true,
    name: 'Новый проект',
    room: defaultRoom(),
    lighting: defaultLighting(),
    settings: { gap: 2, countertop: true, topMat: 'top38_oak', topOverhang: 30 },
    modules: [],
    fixtures: [],
  };
}

/** Миграция старых проектов (одна стена → комната, только x → x/z/rot). */
export function migrateProject(prj) {
  if (!prj) return newProject();
  if (!prj.room || prj.room.width != null) {
    const w = prj.room?.width || 3000, h = prj.room?.height || 2700;
    prj.room = {
      ...defaultRoom(),
      length: w,
      depth: prj.room?.depth || 3000,
      height: h,
      openings: prj.room?.openings || defaultRoom().openings,
    };
  }
  if (!prj.lighting) prj.lighting = defaultLighting();
  if (!prj.fixtures) prj.fixtures = [];
  for (const f of prj.fixtures) {
    if (f.type === 'socket_double' || f.type === 'socket_kitchen') {
      f.type = 'socket_block';
      if (f.count == null) f.count = 2;
    }
    if (f.type === 'socket_block') {
      f.count = Math.max(1, Math.min(8, Math.round(+f.count) || 2));
    }
  }
  for (const m of prj.modules || []) {
    if (m.z == null) m.z = 0;
    if (m.rot == null) m.rot = 0;
    if (!m.open) m.open = {};
  }
  if ((prj.version || 1) < 3) {
    // Старые проёмы по умолчанию стояли за гарнитуром (окно на задней стене, дверь у пенала)
    const ops = prj.room.openings || [];
    const oldDefault = ops.length === 2
      && ops[0].wall === 'back' && ops[0].offset === 800 && ops[0].width === 1400
      && ops[1].wall === 'left' && ops[1].offset === 400 && ops[1].width === 900;
    if (oldDefault) prj.room.openings = defaultRoom().openings;
  }
  if (!prj.room.show) prj.room.show = 'auto';
  if (prj.room.showWallLetters == null) prj.room.showWallLetters = true;
  if (prj.room.showWallDims == null) prj.room.showWallDims = true;
  if (prj.room.showHeightDim == null) prj.room.showHeightDim = true;
  if (prj.room.showRoomEdges == null) prj.room.showRoomEdges = false;
  if (prj.room.edgeWidth == null || !Number.isFinite(+prj.room.edgeWidth)) prj.room.edgeWidth = 4.5;
  if (!prj.room.showWallLens || typeof prj.room.showWallLens !== 'object') {
    prj.room.showWallLens = { floor: true, mid: true, ceil: true };
  } else {
    const w = prj.room.showWallLens;
    prj.room.showWallLens = {
      floor: w.floor !== false,
      mid: w.mid !== false,
      ceil: w.ceil !== false,
    };
  }
  if (!Array.isArray(prj.room.features)) prj.room.features = [];
  if (prj.room.yRef == null) prj.room.yRef = 900;
  if (!prj.room.ceiling) prj.room.ceiling = { mode: 'flat', height: prj.room.height || 2700, samples: [] };
  if (!Array.isArray(prj.room.obstacles)) prj.room.obstacles = [];
  for (const op of prj.room.openings || []) {
    if (!op.id) op.id = 'op' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    if (op.frameColor == null) op.frameColor = 0x8b7355;
  }
  for (const ob of prj.room.obstacles || []) {
    if (!ob.id) ob.id = 'ob' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    if (ob.color == null) ob.color = 0xb0a090;
    if (ob.rot == null) ob.rot = 0;
  }
  if (!prj.room.fit) prj.room.fit = { minPassage: 1000, wallCabClearance: 40, angleTolDeg: 1 };
  if (!prj.room.dimMode) prj.room.dimMode = 'basic';
  if (!prj.room.layers) {
    prj.room.layers = {
      ceiling: true, walls: true, floor: true,
      appliances: true, communications: true, furniture: true,
    };
  }
  if (!prj.room.wallColors || typeof prj.room.wallColors !== 'object') prj.room.wallColors = {};
  // единый редактор BPlanner: всегда полигон
  unifyRoomPlan(prj.room);
  if (prj.showFixtures == null) prj.showFixtures = true;
  prj.version = 3;
  return prj;
}

const carcEdge = (mat) => (MATERIALS[mat]?.kind === 'ldsp' ? 'e04' : null);
const frontEdge = (mat) => (MATERIALS[mat]?.kind === 'ldsp' ? 'e2' : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;

export const resolveDoors = (m) => (m.p.doors === 'auto' ? (m.p.width > 600 ? 2 : 1) : Math.max(0, +m.p.doors || 0));

function hingesFor(h) { return h <= 900 ? 2 : h <= 1600 ? 3 : h <= 2000 ? 4 : 5; }

// Генерация панелей модуля в локальных координатах (x от левого края модуля)
export function genModule(m, settings = {}) {
  if (isLib(m)) {
    const panels = libPanels(m);
    const extras = [];
    // Ручки: в Самолёте часто TIP-ON без геометрии — рисуем сами.
    // Если в модели уже есть «ручка» — не дублируем.
    // Двери — всегда вертикальная скоба; ящики — горизонтальная.
    const hasHandleGeom = panels.some((p) => /ручк/.test(p.name || ''));
    if (!hasHandleGeom) {
      for (const p of panels) {
        if (p.openable !== 'door' && p.openable !== 'drawer') continue;
        const box = panelBox(p);
        if (p.openable === 'drawer') {
          extras.push({
            type: 'handle', panelKey: p.key, vertical: false,
            x: (box.x1 + box.x2) / 2, y: box.y2 - 36, z: box.z2,
          });
          continue;
        }
        const hx = p.hinge === 'right' ? box.x1 + 36 : box.x2 - 36;
        extras.push({
          type: 'handle', panelKey: p.key, vertical: true,
          x: hx, y: (box.y1 + box.y2) / 2, z: box.z2,
        });
      }
    }
    return { panels, extras, hw: {} };
  }
  const P = m.p, gen = MODULE_TYPES[m.type].gen;
  const C = m.mat.carcass, FM = m.mat.front, BM = m.mat.back;
  const T = th(C), TF = th(FM), TB = P.back === false ? 0 : th(BM);
  const W = +P.width, H = +P.height, D = +P.depth, y0 = +P.elev || 0, pl = gen === 'wall' ? 0 : (+P.plinth || 0);
  const g = settings.gap ?? 2;
  const eC = carcEdge(C), eF = frontEdge(FM);
  const out = { panels: [], extras: [], hw: {} };
  const add = (p) => out.panels.push(p);
  const hw = (k, n) => { if (n > 0) out.hw[k] = (out.hw[k] || 0) + n; };

  const z0 = TB, zF = D, top = y0 + H, cb = y0 + pl;
  const sideY1 = gen === 'wardrobe' ? y0 : cb;

  add(Vp('side_l', 'Боковина левая', 'carcass', z0, sideY1, zF, top, 0, C, { front: eC }));
  add(Vp('side_r', 'Боковина правая', 'carcass', z0, sideY1, zF, top, W - T, C, { front: eC }));
  add(Hp('bottom', 'Дно', 'carcass', T, z0, W - T, zF, cb, C, { front: eC }));
  let horiz = 1;
  if (gen === 'base') {
    add(Hp('rail_f', 'Царга передняя', 'carcass', T, zF - 100, W - T, zF, top - T, C, { front: eC }));
    add(Hp('rail_b', 'Царга задняя', 'carcass', T, z0, W - T, z0 + 100, top - T, C, {}));
    horiz += 2;
  } else {
    add(Hp('top', 'Крыша', 'carcass', T, z0, W - T, zF, top - T, C, { front: eC }));
    horiz += 1;
  }
  if (TB) add(Fp('back', 'Задняя стенка', 'back', 0, cb, W, top, 0, BM, {}, null));

  if (pl > 0) {
    if (gen === 'wardrobe') add(Fp('plinth', 'Цоколь', 'carcass', T, y0, W - T, cb, zF - 30 - T, C, { top: eC }, 'u'));
    else { add(Fp('plinth', 'Цоколь', 'carcass', 0, y0, W, cb, zF - 60, C, { top: eC }, 'u')); hw('leg', 4); }
    horiz += 1;
  }
  if (gen === 'wall') hw('hanger', 2);

  // Внутреннее наполнение
  const shelfRow = (x1, x2, ys1, ys2, n, keyPrefix) => {
    if (n <= 0) return;
    const step = (ys2 - ys1 - n * T) / (n + 1);
    for (let i = 0; i < n; i++) {
      const y = r1(ys1 + step * (i + 1) + T * i);
      add(Hp(`${keyPrefix}${i + 1}`, 'Полка', 'shelf', x1, z0, x2, zF - 20, y, C, { front: eC }));
      hw('shelfPin', 4);
    }
  };
  const innerBottom = cb + T, innerTop = top - T;

  if (gen === 'wardrobe') {
    let bodyTop = innerTop;
    if (+P.antresol > 0) {
      const aY = innerTop - (+P.antresol) - T;
      add(Hp('antresol', 'Полка антресоли', 'carcass', T, z0, W - T, zF - 20, aY, C, { front: eC }));
      horiz += 1; hw('shelfPin', 4);
      bodyTop = aY;
    }
    if (P.rod) {
      let rx1 = T, rx2 = W - T;
      if (W >= 800 && +P.shelves > 0) {
        const dx = Math.round(W / 2 - T / 2);
        add(Vp('divider', 'Перегородка', 'carcass', z0, innerBottom, zF - 20, bodyTop, dx, C, { front: eC }));
        horiz += 1;
        shelfRow(T, dx, innerBottom, bodyTop, +P.shelves, 'shelf_');
        rx1 = dx + T;
      }
      out.extras.push({ type: 'rod', x1: rx1, x2: rx2, y: bodyTop - 60, z: (z0 + zF) / 2 });
      hw('rod', 1); hw('rodHolder', 2);
    } else {
      shelfRow(T, W - T, innerBottom, bodyTop, +P.shelves, 'shelf_');
    }
  } else {
    shelfRow(T, W - T, innerBottom, gen === 'base' ? top - T : innerTop, +P.shelves, 'shelf_');
  }

  // Фасады
  const fy1 = cb + g / 2, fy2 = top - g / 2, Hf = fy2 - fy1;
  const nDr = Math.max(0, +P.drawers || 0);
  if (nDr > 0) {
    const fh = (Hf - g * (nDr - 1)) / nDr;
    for (let i = 0; i < nDr; i++) {
      const y1 = r1(fy1 + i * (fh + g)), y2 = r1(y1 + fh);
      const key = `drw${i + 1}_front`;
      add(Fp(key, `Фасад ящика ${i + 1}`, 'front', g / 2, y1, W - g / 2, y2, zF, FM, { all: eF }, 'u'));
      const last = out.panels[out.panels.length - 1];
      last.openable = 'drawer';
      last.openTravel = Math.min(zF - z0 - 40, 450);
      out.extras.push({ type: 'handle', x: W / 2, y: y2 - 40, z: zF + TF, vertical: false, panelKey: key });
      drawerBox(i + 1, y1, fh);
      hw('slide', 1); hw('handle', 1);
    }
  } else {
    const k = resolveDoors(m);
    if (k > 0) {
      const rows = gen === 'tall' && Hf > 1800
        ? [[fy1, r1(fy1 + Math.round(Hf * 0.62))], [r1(fy1 + Math.round(Hf * 0.62) + g), fy2]]
        : [[fy1, fy2]];
      const dw = (W - g * k) / k;
      rows.forEach(([y1, y2], ri) => {
        for (let j = 0; j < k; j++) {
          const x1 = r1(g / 2 + j * (dw + g)), x2 = r1(x1 + dw);
          const hinge = k === 1 ? (P.hinge || 'left') : (j < k / 2 ? 'left' : 'right');
          const key = `door${ri + 1}_${j + 1}`;
          add(Fp(key, rows.length > 1 ? `Дверь ${ri === 0 ? 'нижняя' : 'верхняя'}` : 'Дверь', 'front', x1, y1, x2, y2, zF, FM, { all: eF }));
          const last = out.panels[out.panels.length - 1];
          last.openable = 'door';
          last.hinge = hinge;
          const hy = gen === 'wall' ? y1 + 90 : gen === 'base' ? y2 - 90 : clamp(1000, y1 + 100, y2 - 100);
          out.extras.push({ type: 'handle', x: hinge === 'left' ? x2 - 40 : x1 + 40, y: hy, z: zF + TF, vertical: true, panelKey: key });
          hw('hinge', hingesFor(y2 - y1)); hw('handle', 1);
        }
      });
    }
  }
  hw('confirmat', horiz * 4);
  return out;

  function drawerBox(i, y1, fh) {
    const slide = 13, TBh = th(BM);
    const bx1 = T + slide, bx2 = W - T - slide;
    const maxL = zF - z0 - 10;
    const L = [550, 500, 450, 400, 350, 300, 250].find((l) => l <= maxL) || 250;
    const zb2 = zF - 2, zb1 = zb2 - L;
    const bh = clamp(Math.round(fh - 60), 70, 250);
    const by = Math.max(r1(y1 + 25), innerBottom + 5);
    const sy1 = by + TBh, sy2 = sy1 + bh;
    add(Hp(`drw${i}_bot`, 'Дно ящика', 'drawer', bx1, zb1, bx2, zb2, by, BM, {}, null));
    add(Vp(`drw${i}_sl`, 'Боковина ящика', 'drawer', zb1, sy1, zb2, sy2, bx1, C, { top: eC }, 'u'));
    add(Vp(`drw${i}_sr`, 'Боковина ящика', 'drawer', zb1, sy1, zb2, sy2, bx2 - T, C, { top: eC }, 'u'));
    add(Fp(`drw${i}_bk`, 'Задняя стенка ящика', 'drawer', bx1 + T, sy1, bx2 - T, sy2, zb1, C, { top: eC }, 'u'));
    add(Fp(`drw${i}_fr`, 'Передняя стенка ящика', 'drawer', bx1 + T, sy1, bx2 - T, sy2, zb2 - T, C, { top: eC }, 'u'));
  }
}

/** Локальная точка → мир (модуль в начале локальной СК, фасад вдоль +Z). */
export function localToWorld(m, lx, ly, lz) {
  const a = ((+m.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: +m.x + lx * c + lz * s, y: ly, z: +m.z - lx * s + lz * c };
}

export function worldToLocal(m, x, z) {
  const a = ((+m.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = x - +m.x, dz = z - +m.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

// Интервал проёма вдоль стены в мировых координатах
export function openingSpan(op, room) {
  if (op.edgeIndex != null && isAdvanced(room)) {
    ensureAdvancedFields(room);
    const outline = roomOutline(room);
    const i = +op.edgeIndex;
    if (i < 0 || i >= outline.length - 1) return null;
    const a = outline[i], b = outline[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len, tz = dz / len;
    const o1 = +op.offset || 0;
    const o2 = o1 + (+op.width || 0);
    const p1 = { x: a.x + tx * o1, z: a.z + tz * o1 };
    const p2 = { x: a.x + tx * o2, z: a.z + tz * o2 };
    if (Math.abs(dx) >= Math.abs(dz)) {
      return { axis: 'x', a: Math.min(p1.x, p2.x), b: Math.max(p1.x, p2.x) };
    }
    return { axis: 'z', a: Math.min(p1.z, p2.z), b: Math.max(p1.z, p2.z) };
  }
  const L = room.length, D = room.depth;
  switch (op.wall) {
    case 'back':  return { axis: 'x', a: op.offset, b: op.offset + op.width };
    case 'front': return { axis: 'x', a: L - op.offset - op.width, b: L - op.offset };
    case 'left':  return { axis: 'z', a: op.offset, b: op.offset + op.width };
    default:      return { axis: 'z', a: D - op.offset - op.width, b: D - op.offset };
  }
}

export function moduleLocalSize(m) {
  return { w: +m.p.width, h: +m.p.height, d: +m.p.depth + frontT(m), elev: +m.p.elev || 0 };
}

export function moduleBox(m) {
  const { w, h, d, elev } = moduleLocalSize(m);
  const corners = [[0, elev, 0], [w, elev, 0], [0, elev + h, 0], [w, elev + h, 0], [0, elev, d], [w, elev, d], [0, elev + h, d], [w, elev + h, d]]
    .map(([x, y, z]) => localToWorld(m, x, y, z));
  return {
    x1: Math.min(...corners.map((p) => p.x)), x2: Math.max(...corners.map((p) => p.x)),
    y1: Math.min(...corners.map((p) => p.y)), y2: Math.max(...corners.map((p) => p.y)),
    z1: Math.min(...corners.map((p) => p.z)), z2: Math.max(...corners.map((p) => p.z)),
  };
}

// Панели остаются в локальных координатах модуля; трансформ — во вьюере и в скрипте Базиса.
export function buildProject(prj) {
  const items = [];
  prj.modules.forEach((m, idx) => {
    const g = genModule(m, prj.settings);
    const panels = [], removed = [];
    for (const p of g.panels) {
      const ov = m.overrides?.[p.key];
      if (ov?.removed) { removed.push({ key: p.key, name: p.name }); continue; }
      const q = { ...p, butts: [...p.butts] };
      if (ov?.mat) { q.mat = ov.mat; q.t = th(ov.mat); }
      if (ov?.butts) q.butts = [...ov.butts];
      q.moduleId = m.id;
      q.overridden = !!ov;
      q.openAmt = m.open?.[p.key] ?? 0;
      panels.push(q);
    }
    items.push({ module: m, index: idx + 1, title: moduleTitle(m), panels, extras: g.extras, hw: g.hw, removed });
  });

  // Столешница: ряды base у стен A (rot≈0) и D (rot≈90)
  if (prj.settings.countertop) {
    const oh = prj.settings.topOverhang ?? 30;
    const pushTop = (gi, virtual, panelW, panelD, y) => {
      const p = Hp(`countertop_${gi + 1}`, 'Столешница', 'top', 0, 0, panelW, panelD + oh, y, prj.settings.topMat, {});
      p.moduleId = '__top';
      items.push({ module: virtual, virtual: true, index: prj.modules.length + gi + 1, title: `Столешница ${panelW}`, panels: [p], extras: [], hw: {}, removed: [] });
    };
    let topGi = 0;
    const baseA = prj.modules
      .filter((m) => moduleGen(m) === 'base' && Math.abs(+m.rot % 360) < 1 && Math.abs(+m.z) < 5)
      .sort((a, b) => a.x - b.x);
    const groupsA = [];
    for (const m of baseA) {
      const last = groupsA[groupsA.length - 1];
      if (last && Math.abs(m.x - last.x2) <= 1) { last.x2 = m.x + +m.p.width; last.mods.push(m); }
      else groupsA.push({ x1: +m.x, x2: +m.x + +m.p.width, mods: [m], z: +m.z });
    }
    for (const gr of groupsA) {
      const depth = Math.max(...gr.mods.map((m) => +m.p.depth + frontT(m)));
      const y = Math.max(...gr.mods.map((m) => +m.p.elev + +m.p.height));
      const virtual = { id: '__top_' + topGi, x: gr.x1, z: gr.z, rot: 0, p: { width: gr.x2 - gr.x1, height: 0, depth: depth, elev: y }, mat: { front: prj.settings.topMat }, open: {} };
      pushTop(topGi++, virtual, gr.x2 - gr.x1, depth, y);
    }
    // D / left: rot=90, origin на переднем краю; вдоль стены — по убыванию z
    const baseD = prj.modules
      .filter((m) => moduleGen(m) === 'base' && Math.abs((+m.rot % 360) - 90) < 1 && Math.abs(+m.x) < 5)
      .sort((a, b) => b.z - a.z);
    const groupsD = [];
    for (const m of baseD) {
      const last = groupsD[groupsD.length - 1];
      const zBack = +m.z - +m.p.width; // задний край слота (меньший z)
      if (last && Math.abs(last.z1 - m.z) <= 1) { last.z1 = zBack; last.mods.push(m); }
      else groupsD.push({ z2: +m.z, z1: zBack, mods: [m], x: +m.x });
    }
    for (const gr of groupsD) {
      const depth = Math.max(...gr.mods.map((m) => +m.p.depth + frontT(m)));
      const y = Math.max(...gr.mods.map((m) => +m.p.elev + +m.p.height));
      const span = gr.z2 - gr.z1;
      // origin столешницы — передний край группы (rot=90)
      const virtual = { id: '__top_' + topGi, x: gr.x, z: gr.z2, rot: 90, p: { width: span, height: 0, depth: depth, elev: y }, mat: { front: prj.settings.topMat }, open: {} };
      pushTop(topGi++, virtual, span, depth, y);
    }
  }
  return { items, issues: validate(prj, items) };
}

export function validate(prj) {
  const issues = [];
  const mods = prj.modules;
  const room = prj.room;
  const L = room.length, D = room.depth, H = room.height;
  const adv = isAdvanced(room);
  if (adv) ensureAdvancedFields(room);
  const ov = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > 0.5;
  const clearance = +(room.fit?.wallCabClearance ?? 40);
  mods.forEach((m, i) => {
    const b = moduleBox(m), n = i + 1;
    const corners = [
      { x: b.x1, z: b.z1 }, { x: b.x2, z: b.z1 },
      { x: b.x1, z: b.z2 }, { x: b.x2, z: b.z2 },
    ];
    if (adv) {
      if (!footprintInsideRoom(room, corners, 5))
        issues.push({ level: 'error', moduleId: m.id, text: `Модуль ${n} выходит за контур комнаты` });
      const ys = corners.map((c) => ceilingHeightAt(room, c.x, c.z));
      const hMin = Math.min(...ys);
      if (b.y2 > hMin - 0.5)
        issues.push({ level: 'error', moduleId: m.id, text: `Модуль ${n} выше потолка в точке (нужно ≤ ${Math.round(hMin)} мм, сейчас ${Math.round(b.y2)})` });
      else if (b.y2 > hMin - clearance)
        issues.push({ level: 'warn', moduleId: m.id, text: `Модуль ${n}: зазор до потолка < ${clearance} мм` });
    } else {
      if (b.x1 < -1 || b.x2 > L + 1 || b.z1 < -1 || b.z2 > D + 1)
        issues.push({ level: 'error', moduleId: m.id, text: `Модуль ${n} выходит за пределы комнаты (${L}×${D})` });
      if (b.y2 > H) issues.push({ level: 'error', moduleId: m.id, text: `Модуль ${n} выше потолка (${b.y2} > ${H})` });
    }
    if (!isLib(m) && (m.p.width < 150 || m.p.width > 1200)) issues.push({ level: 'warn', moduleId: m.id, text: `Модуль ${n}: нестандартная ширина ${m.p.width} мм` });
    const T = th(m.mat.carcass);
    const divided = m.type === 'wardrobe' && m.p.rod && m.p.width >= 800;
    const span = divided ? Math.round(m.p.width / 2 - 1.5 * T) : m.p.width - 2 * T;
    if (+m.p.shelves > 0 && span > 800 && T <= 16) issues.push({ level: 'warn', moduleId: m.id, text: `Модуль ${n}: полка ${span} мм из 16 мм может провисать` });
    const k = +m.p.drawers > 0 ? 0 : resolveDoors(m);
    if (k > 0 && (m.p.width - k * 2) / k > 600) issues.push({ level: 'warn', moduleId: m.id, text: `Модуль ${n}: дверь шире 600 мм` });
    for (let j = i + 1; j < mods.length; j++) {
      const c = moduleBox(mods[j]);
      if (ov(b.x1, b.x2, c.x1, c.x2) && ov(b.y1, b.y2, c.y1, c.y2) && ov(b.z1, b.z2, c.z1, c.z2))
        issues.push({ level: 'error', moduleId: m.id, text: `Модули ${n} и ${j + 1} пересекаются` });
    }
    for (const op of room.openings || []) {
      const near = { back: b.z1 < 50, front: b.z2 > D - 50, left: b.x1 < 50, right: b.x2 > L - 50 }[op.wall];
      if (!near && !adv) continue;
      if (adv && op.edgeIndex == null && !near) continue;
      const sp = openingSpan(op, room);
      if (!sp) continue;
      const [m1, m2] = sp.axis === 'x' ? [b.x1, b.x2] : [b.z1, b.z2];
      if (ov(m1, m2, sp.a, sp.b) && ov(b.y1, b.y2, op.sill, op.sill + op.height))
        issues.push({ level: 'warn', moduleId: m.id, text: `Модуль ${n} перекрывает ${op.type === 'door' ? 'дверь' : 'окно'}` });
    }
    for (const ob of room.obstacles || []) {
      const ox2 = +ob.x + +ob.w, oz2 = +ob.z + +ob.d;
      if (ov(b.x1, b.x2, +ob.x, ox2) && ov(b.z1, b.z2, +ob.z, oz2) && ov(b.y1, b.y2, +ob.y0, +ob.y1))
        issues.push({ level: 'error', moduleId: m.id, text: `Модуль ${n} пересекается с «${ob.name || 'короб'}»` });
    }
  });
  return issues;
}

export function snapPos(prj, moduleId, x, z, tol = 40) {
  const m = prj.modules.find((q) => q.id === moduleId);
  if (!m) return { x, z };
  const { w, d } = moduleLocalSize(m);
  const L = prj.room.length, D = prj.room.depth;
  const candsX = [0, L - w], candsZ = [0, D - d];
  for (const o of prj.modules) {
    if (o.id === moduleId) continue;
    if (Math.abs((+o.rot || 0) - (+m.rot || 0)) > 1) continue;
    const ob = moduleBox(o);
    candsX.push(ob.x2, ob.x1 - w);
    candsZ.push(ob.z2, ob.z1 - d);
  }
  let bx = x, bz = z, dx = tol, dz = tol;
  for (const c of candsX) { const d0 = Math.abs(c - x); if (d0 < dx) { dx = d0; bx = c; } }
  for (const c of candsZ) { const d0 = Math.abs(c - z); if (d0 < dz) { dz = d0; bz = c; } }
  let sx = Math.round(clamp(bx, 0, Math.max(0, L - w)));
  let sz = Math.round(clamp(bz, 0, Math.max(0, D - d)));
  if (isAdvanced(prj.room)) {
    // проверить footprint; если вылез — откатить к исходным clamp AABB
    const probe = { ...m, x: sx, z: sz };
    const b = moduleBox(probe);
    const corners = [
      { x: b.x1, z: b.z1 }, { x: b.x2, z: b.z1 },
      { x: b.x1, z: b.z2 }, { x: b.x2, z: b.z2 },
    ];
    if (!footprintInsideRoom(prj.room, corners, 5)) {
      sx = Math.round(x);
      sz = Math.round(z);
    }
  }
  return { x: sx, z: sz };
}

function _rangeOverlap(a1, a2, b1, b2, min = 20) {
  return Math.min(a2, b2) - Math.max(a1, b1) > min;
}

/** Сосед с тем же rot вплотную к стороне host (local left/right). */
export function sideOccupied(prj, hostId, side, tol = 6) {
  const h = prj.modules.find((q) => q.id === hostId);
  if (!h) return true;
  const { w, d, h: hh, elev } = moduleLocalSize(h);
  for (const o of prj.modules) {
    if (o.id === hostId) continue;
    if (Math.abs((+o.rot || 0) - (+h.rot || 0)) > 1) continue;
    const ow = moduleLocalSize(o);
    // нижний и навесной на одной стене не блокируют друг друга
    if (!_rangeOverlap(elev, elev + hh, ow.elev, ow.elev + ow.h, 40)) continue;
    const ol = worldToLocal(h, +o.x, +o.z);
    if (!_rangeOverlap(0, d, ol.lz, ol.lz + ow.d, 30)) continue;
    if (side === 'left' && Math.abs(ol.lx + ow.w) <= tol) return true;
    if (side === 'right' && Math.abs(ol.lx - w) <= tol) return true;
  }
  return false;
}

/** Занята ли верхняя/нижняя грань host (стек модулей). */
export function faceOccupied(prj, hostId, face, tol = 8) {
  if (face === 'left' || face === 'right') return sideOccupied(prj, hostId, face, tol);
  const h = prj.modules.find((q) => q.id === hostId);
  if (!h) return true;
  const hw = moduleLocalSize(h);
  for (const o of prj.modules) {
    if (o.id === hostId) continue;
    if (Math.abs((+o.rot || 0) - (+h.rot || 0)) > 1) continue;
    const ow = moduleLocalSize(o);
    const ol = worldToLocal(h, +o.x, +o.z);
    if (!_rangeOverlap(0, hw.w, ol.lx, ol.lx + ow.w, 40)) continue;
    if (!_rangeOverlap(0, hw.d, ol.lz, ol.lz + ow.d, 40)) continue;
    if (face === 'top' && Math.abs(ow.elev - (hw.elev + hw.h)) <= tol) return true;
    if (face === 'bottom' && Math.abs(hw.elev - (ow.elev + ow.h)) <= tol) return true;
  }
  return false;
}

/** Выравнивание бок-о-бок: низ/верх + зад/фасад. */
export function dockAlignments(mover, host) {
  const mw = mover ? moduleLocalSize(mover) : null;
  const hw = host ? moduleLocalSize(host) : null;
  const vList = ['bottom'];
  if (mw && hw && Math.abs(hw.h - mw.h) > 15) vList.push('top');
  const dList = ['back'];
  if (mw && hw && Math.abs(hw.d - mw.d) > 15) dList.push('front');
  const out = [];
  for (const vAlign of vList) {
    for (const dAlign of dList) out.push({ vAlign, dAlign });
  }
  if (mw && hw && (vList.length > 1 || dList.length > 1)) {
    out.push({ vAlign: 'center', dAlign: 'center' });
  }
  return out.length ? out : [{ vAlign: 'bottom', dAlign: 'back' }];
}

/** Выравнивание стека верх↔низ: левый/правый угол + зад/фасад. */
export function stackAlignments(mover, host) {
  const mw = mover ? moduleLocalSize(mover) : null;
  const hw = host ? moduleLocalSize(host) : null;
  const hList = ['left'];
  if (mw && hw && Math.abs(hw.w - mw.w) > 15) hList.push('right');
  const dList = ['back'];
  if (mw && hw && Math.abs(hw.d - mw.d) > 15) dList.push('front');
  const out = [];
  for (const hAlign of hList) {
    for (const dAlign of dList) out.push({ hAlign, dAlign });
  }
  if (mw && hw && (hList.length > 1 || dList.length > 1)) {
    out.push({ hAlign: 'center', dAlign: 'center' });
  }
  return out.length ? out : [{ hAlign: 'left', dAlign: 'back' }];
}

/**
 * Поза mover у грани host.
 * face/side: 'left'|'right'|'top'|'bottom'
 * opts: бок — { vAlign, dAlign }; стек — { hAlign, dAlign }.
 */
export function dockPose(mover, host, side, cornerOrOpts = 'back') {
  const opts = typeof cornerOrOpts === 'string'
    ? { dAlign: cornerOrOpts, vAlign: 'bottom', hAlign: 'left' }
    : (cornerOrOpts || {});
  const face = opts.face || side;
  const dAlign = opts.dAlign || opts.corner || 'back';
  const mw = moduleLocalSize(mover);
  const hw = moduleLocalSize(host);
  const a = ((+host.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);

  if (face === 'top' || face === 'bottom') {
    const hAlign = opts.hAlign || 'left';
    let lx = 0;
    if (hAlign === 'right') lx = hw.w - mw.w;
    else if (hAlign === 'center') lx = (hw.w - mw.w) / 2;
    let lz = 0;
    if (dAlign === 'front') lz = hw.d - mw.d;
    else if (dAlign === 'center') lz = (hw.d - mw.d) / 2;
    const elev = face === 'top' ? hw.elev + hw.h : hw.elev - mw.h;
    return {
      x: Math.round(+host.x + lx * c + lz * s),
      z: Math.round(+host.z - lx * s + lz * c),
      rot: +host.rot || 0,
      elev: Math.round(elev),
      face,
      side: face,
      stack: true,
      hAlign,
      dAlign,
      vAlign: face === 'top' ? 'top' : 'bottom',
    };
  }

  const vAlign = opts.vAlign || 'bottom';
  let lz = 0;
  if (dAlign === 'front') lz = hw.d - mw.d;
  else if (dAlign === 'center') lz = (hw.d - mw.d) / 2;
  let elev = hw.elev;
  if (vAlign === 'top') elev = hw.elev + hw.h - mw.h;
  else if (vAlign === 'center') elev = hw.elev + (hw.h - mw.h) / 2;
  const lx = face === 'left' ? -mw.w : hw.w;
  return {
    x: Math.round(+host.x + lx * c + lz * s),
    z: Math.round(+host.z - lx * s + lz * c),
    rot: +host.rot || 0,
    elev: Math.round(elev),
    face,
    side: face,
    stack: false,
    vAlign,
    dAlign,
  };
}

/** Ближайший вариант стыка к текущей позе mover (или prefer {x,z,elev,vAlign?,hAlign?}). */
export function bestDockPose(mover, host, side, prefer = null) {
  const face = prefer?.face || side;
  const px = prefer?.x ?? +mover.x;
  const pz = prefer?.z ?? +mover.z;
  const pe = prefer?.elev ?? (+mover.p.elev || 0);
  const forceV = prefer?.vAlign || null;
  const forceH = prefer?.hAlign || null;
  const forceD = prefer?.dAlign || null;
  let best = null, bestD = Infinity;
  const seen = new Set();
  const stack = face === 'top' || face === 'bottom';
  const alist = stack ? stackAlignments(mover, host) : dockAlignments(mover, host);
  for (const al of alist) {
    if (!stack && forceV && al.vAlign !== forceV) continue;
    if (stack && forceH && al.hAlign !== forceH) continue;
    if (forceD && al.dAlign !== forceD) continue;
    const pose = dockPose(mover, host, face, { ...al, face });
    const key = `${pose.x}|${pose.z}|${pose.elev}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const elevW = stack ? 0.35 : 0.15;
    const dd = Math.hypot(pose.x - px, pose.z - pz) + Math.abs(pose.elev - pe) * elevW;
    if (dd < bestD) {
      bestD = dd;
      best = { ...pose, side: face, corner: pose.dAlign };
    }
  }
  return best;
}

/**
 * Сокеты магнитного стыка:
 * - бок left/right: зоны низ/верх (тот же ряд);
 * - стек top/bottom: зоны левый/правый угол (любой ряд, тот же поворот).
 */
export function listDockSockets(prj, opt = {}) {
  const excludeId = opt.excludeId || null;
  const mover = opt.moverId ? prj.modules.find((q) => q.id === opt.moverId) : null;
  const prefer = opt.prefer || null;
  const out = [];
  for (const h of prj.modules) {
    if (!h || h.id === excludeId || h.id === mover?.id) continue;
    if (String(h.id).startsWith('__top')) continue;
    if (mover && Math.abs((+h.rot || 0) - (+mover.rot || 0)) > 1) continue;
    const { w, d, h: hh, elev } = moduleLocalSize(h);
    const ms = mover ? moduleLocalSize(mover) : null;
    const sameRow = !mover || moduleRow(h) === moduleRow(mover);

    // —— бок о бок ——
    if (sameRow) {
      const vZones = (ms && Math.abs(hh - ms.h) > 15) ? ['bottom', 'top'] : ['bottom'];
      const gap = vZones.length > 1 ? hh * 0.06 : 0;
      for (const side of ['left', 'right']) {
        if (faceOccupied(prj, h.id, side)) continue;
        const lx = side === 'left' ? -2 : w + 2;
        for (const vAlign of vZones) {
          const stripH = vZones.length > 1 ? (hh - gap) * 0.5 : hh;
          const ly = vAlign === 'top'
            ? elev + hh - stripH * 0.5
            : elev + stripH * 0.5;
          const lz = d * 0.5;
          const wp = localToWorld(h, lx, ly, lz);
          const pose = mover
            ? bestDockPose(mover, h, side, { ...(prefer || {}), vAlign, face: side })
            : null;
          const sock = {
            id: `${h.id}:${side}:${vAlign}`,
            hostId: h.id,
            side,
            face: side,
            stack: false,
            corner: pose?.dAlign || 'back',
            vAlign,
            dAlign: pose?.dAlign || 'back',
            x: wp.x, y: wp.y, z: wp.z,
            hostX: +h.x, hostZ: +h.z, rot: +h.rot || 0,
            lx, ly, lz,
            stripH,
            stripD: Math.max(60, d * 0.92),
            stripMode: 'side',
          };
          if (pose) sock.pose = pose;
          if (ms) sock.ghost = { w: ms.w, d: ms.d, h: ms.h, elev: pose?.elev ?? ms.elev };
          out.push(sock);
        }
      }
    }

    // —— стек верх ↔ низ ——
    for (const face of ['top', 'bottom']) {
      if (faceOccupied(prj, h.id, face)) continue;
      const hZones = (ms && Math.abs(w - ms.w) > 15) ? ['left', 'right'] : ['left'];
      const gap = hZones.length > 1 ? w * 0.06 : 0;
      for (const hAlign of hZones) {
        const stripW = hZones.length > 1 ? (w - gap) * 0.5 : w;
        const lx = hAlign === 'right' ? w - stripW * 0.5 : stripW * 0.5;
        const ly = face === 'top' ? elev + hh + 3 : elev - 3;
        const lz = d * 0.5;
        const wp = localToWorld(h, lx, ly, lz);
        const pose = mover
          ? bestDockPose(mover, h, face, { ...(prefer || {}), hAlign, face })
          : null;
        const sock = {
          id: `${h.id}:${face}:${hAlign}`,
          hostId: h.id,
          side: face,
          face,
          stack: true,
          corner: pose?.dAlign || 'back',
          hAlign,
          vAlign: face,
          dAlign: pose?.dAlign || 'back',
          x: wp.x, y: wp.y, z: wp.z,
          hostX: +h.x, hostZ: +h.z, rot: +h.rot || 0,
          lx, ly, lz,
          stripW,
          stripH: 8,
          stripD: Math.max(60, d * 0.92),
          stripMode: 'stack',
        };
        if (pose) sock.pose = pose;
        if (ms) sock.ghost = { w: ms.w, d: ms.d, h: ms.h, elev: pose?.elev ?? ms.elev };
        out.push(sock);
      }
    }
  }
  return out;
}

/** Ближайшая свободная грань host для пристыковки mover (Ctrl+клик по модулю). */
export function nearestDockSide(prj, moverId, hostId, preferWorldX = null, preferWorldZ = null) {
  const mover = prj.modules.find((q) => q.id === moverId);
  const host = prj.modules.find((q) => q.id === hostId);
  if (!mover || !host || mover.id === host.id) return null;
  if (Math.abs((+mover.rot || 0) - (+host.rot || 0)) > 1) return null;
  const prefer = {
    x: preferWorldX ?? +mover.x,
    z: preferWorldZ ?? +mover.z,
    elev: +mover.p.elev || 0,
  };
  const faces = [];
  if (moduleRow(mover) === moduleRow(host)) {
    for (const s of ['left', 'right']) {
      if (!faceOccupied(prj, hostId, s)) faces.push(s);
    }
  }
  for (const s of ['top', 'bottom']) {
    if (!faceOccupied(prj, hostId, s)) faces.push(s);
  }
  if (!faces.length) return null;
  let best = null, bestD = Infinity;
  for (const face of faces) {
    const pose = bestDockPose(mover, host, face, { ...prefer, face });
    if (!pose) continue;
    const elevW = pose.stack ? 0.5 : 0.85;
    const dd = Math.hypot(pose.x - prefer.x, pose.z - prefer.z)
      + Math.abs(pose.elev - prefer.elev) * elevW;
    if (dd < bestD) {
      bestD = dd;
      best = {
        hostId, side: face, face,
        corner: pose.dAlign, vAlign: pose.vAlign, dAlign: pose.dAlign,
        hAlign: pose.hAlign, stack: !!pose.stack, pose,
      };
    }
  }
  return best;
}

/** Пристыковать moverId к сокету {hostId, side/face, ...}. */
export function applyDock(prj, moverId, socket) {
  const mover = prj.modules.find((q) => q.id === moverId);
  const host = prj.modules.find((q) => q.id === socket.hostId);
  if (!mover || !host || mover.id === host.id) return null;
  if (socket.pose?.x != null) return socket.pose;
  const face = socket.face || socket.side;
  return bestDockPose(mover, host, face, {
    x: +mover.x, z: +mover.z, elev: +mover.p.elev || 0, face,
    vAlign: socket.vAlign, hAlign: socket.hAlign, dAlign: socket.dAlign,
  }) || dockPose(mover, host, face, {
    face,
    vAlign: socket.vAlign || 'bottom',
    hAlign: socket.hAlign || 'left',
    dAlign: socket.dAlign || socket.corner || 'back',
  });
}

export function nextFreeX(prj, type, row = MODULE_TYPES[type]?.row || 'floor') {
  const rowMods = prj.modules.filter((m) => moduleRow(m) === row && Math.abs(+m.rot % 360) < 1 && Math.abs(+m.z) < 5);
  return rowMods.reduce((mx, m) => Math.max(mx, +m.x + +m.p.width), 0);
}

export function toggleFront(m, panelKey) {
  if (!m.open) m.open = {};
  const cur = m.open[panelKey] ?? 0;
  m.open[panelKey] = cur > 0.5 ? 0 : 1;
  return m.open[panelKey];
}

export function setAllFronts(m, open) {
  if (!m.open) m.open = {};
  const g = genModule(m, {});
  for (const p of g.panels) {
    if (p.openable) m.open[p.key] = open ? 1 : 0;
  }
}

// Совместимость со старым API
export function snapX(prj, moduleId, x) {
  return snapPos(prj, moduleId, x, prj.modules.find((q) => q.id === moduleId)?.z || 0).x;
}
