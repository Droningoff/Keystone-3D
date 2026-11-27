// Каталог техники, моек, смесителей, коммуникаций.
// Модели процедурные (примитивы Three.js) — без внешних GLB.
// Свои объекты пользователя (userobj) — сетки из личного каталога OBJ (userObjects.js).

import { buildUserObjectNode, getUserObject, getUserObjectMesh } from './userObjects.js?v=20261127k';

export const FIXTURE_CATALOG = {
  // --- Техника ---
  hob_60: {
    title: 'Варочная панель 60', category: 'Техника', kind: 'appliance',
    w: 590, d: 520, h: 50, price: 18000, place: 'countertop', color: 0x22262b,
  },
  oven_60: {
    title: 'Духовой шкаф 60', category: 'Техника', kind: 'appliance',
    w: 595, d: 560, h: 595, price: 28000, place: 'floor', color: 0x2a2e34, elev: 100,
  },
  fridge_60: {
    title: 'Холодильник 60', category: 'Техника', kind: 'appliance',
    w: 600, d: 650, h: 2000, price: 45000, place: 'floor', color: 0xe8eaed,
  },
  dishwasher_60: {
    title: 'Посудомойка 60', category: 'Техника', kind: 'appliance',
    w: 600, d: 560, h: 820, price: 32000, place: 'floor', color: 0xd8dce0, elev: 100,
  },
  hood_60: {
    title: 'Вытяжка 60', category: 'Техника', kind: 'appliance',
    w: 600, d: 480, h: 200, price: 12000, place: 'wall', color: 0xb8bcc2, elev: 1600,
  },
  microwave: {
    title: 'СВЧ встраиваемая', category: 'Техника', kind: 'appliance',
    w: 560, d: 400, h: 380, price: 15000, place: 'wall', color: 0x3a3e44, elev: 1500,
  },

  // --- Мойки ---
  sink_single: {
    title: 'Мойка врезная 1 чаша', category: 'Мойки', kind: 'sink',
    w: 500, d: 450, h: 200, price: 6500, place: 'countertop', color: 0xb0b6bc,
  },
  sink_double: {
    title: 'Мойка врезная 2 чаши', category: 'Мойки', kind: 'sink',
    w: 780, d: 480, h: 200, price: 9800, place: 'countertop', color: 0xb0b6bc,
  },
  sink_corner: {
    title: 'Мойка угловая', category: 'Мойки', kind: 'sink',
    w: 800, d: 800, h: 200, price: 12000, place: 'countertop', color: 0xa8aeb4,
  },

  // --- Смесители ---
  mixer_chrome: {
    title: 'Смеситель высокий хром', category: 'Смесители', kind: 'mixer',
    w: 50, d: 180, h: 320, price: 4500, place: 'countertop', color: 0xc0c6cc, metal: true,
  },
  mixer_black: {
    title: 'Смеситель чёрный', category: 'Смесители', kind: 'mixer',
    w: 50, d: 180, h: 300, price: 5200, place: 'countertop', color: 0x1a1a1a, metal: true,
  },

  // --- Коммуникации ---
  socket_block: {
    title: 'Блок розеток', category: 'Коммуникации', kind: 'socket',
    w: 156, d: 12, h: 80, price: 280, place: 'wall', color: 0xf5f5f5, elev: 1100,
    count: 2, // число розеток в блоке (1…8); ширина растёт с count
  },
  switch_1: {
    title: 'Выключатель', category: 'Коммуникации', kind: 'socket',
    w: 80, d: 12, h: 80, price: 200, place: 'wall', color: 0xf5f5f5, elev: 1000,
  },
  vent_round: {
    title: 'Решётка вент. круглая', category: 'Коммуникации', kind: 'vent',
    w: 150, d: 14, h: 150, price: 450, place: 'wall', color: 0xd0d4d8, elev: 2200,
  },
  vent_square: {
    title: 'Решётка вент. прямоугольная', category: 'Коммуникации', kind: 'vent',
    w: 150, d: 14, h: 150, price: 420, place: 'wall', color: 0xd0d4d8, elev: 2200,
  },
  pipe_water: {
    title: 'Труба ХВС/ГВС', category: 'Коммуникации', kind: 'pipe',
    w: 40, d: 40, h: 800, price: 0, place: 'wall', color: 0x4a90d9, elev: 0,
  },
  pipe_sewer: {
    title: 'Канализация Ø50', category: 'Коммуникации', kind: 'pipe',
    w: 50, d: 50, h: 600, price: 0, place: 'floor', color: 0x6b7280, elev: 0,
  },
  pipe_gas: {
    title: 'Газовая труба', category: 'Коммуникации', kind: 'pipe',
    w: 30, d: 30, h: 900, price: 0, place: 'wall', color: 0xd4a017, elev: 200,
  },

  // --- Свои объекты (личный каталог OBJ, userObjects.js) ---
  userobj: {
    title: 'Мой объект', category: 'Мои объекты', kind: 'userobj',
    w: 400, d: 400, h: 400, price: 0, place: 'floor', color: 0xb8bcc2, elev: 0,
  },
};

/** Старые типы → актуальные (розетки объединены в блок). */
export const FIXTURE_TYPE_ALIASES = {
  socket_double: 'socket_block',
  socket_kitchen: 'socket_block',
};

export function resolveFixtureType(type) {
  return FIXTURE_TYPE_ALIASES[type] || type;
}

/** Число розеток в блоке (1…8). */
export function socketBlockCount(f) {
  const n = Math.round(+f?.count);
  if (Number.isFinite(n) && n >= 1) return Math.min(8, n);
  // наследие: двойная / над столешницей
  if (f?.type === 'socket_double' || f?.type === 'socket_kitchen') return 2;
  return 2;
}

/** Ширина блока розеток по числу гнёзд. */
export function socketBlockWidth(count, h = 80) {
  const n = Math.max(1, Math.min(8, Math.round(+count) || 2));
  const cell = Math.max(58, Math.min(78, (+h || 80) * 0.88));
  return Math.round(n * cell + 16);
}

export function isWallPlateKind(kind) {
  return kind === 'socket' || kind === 'vent';
}

/** Свой объект на стене (как розетка): elev = центр по высоте. */
export function isUserObjWall(f, def = null) {
  const d = def || FIXTURE_CATALOG[resolveFixtureType(f?.type)] || {};
  if (d.kind !== 'userobj') return false;
  return (f?.place || d.place || 'floor') === 'wall';
}

// Ширина обода мойки; вырез в столешнице = габарит мойки минус два обода
export const SINK_RIM = 25;

let seq = 1;
export const newFixtureId = () => 'f' + Date.now().toString(36) + (seq++);

export function createFixture(type, x = 0, z = 0, rot = 0, elev) {
  const t = resolveFixtureType(type);
  const def = FIXTURE_CATALOG[t];
  if (!def) throw new Error('Неизвестный объект: ' + type);
  const f = {
    id: newFixtureId(),
    type: t,
    name: '',
    x, z, rot,
    elev: elev ?? def.elev ?? 0,
    w: def.w, d: def.d, h: def.h,
  };
  if (t === 'socket_block') {
    f.count = Math.max(1, Math.min(8, +def.count || 2));
    f.w = socketBlockWidth(f.count, f.h);
  }
  return f;
}

/** Габариты экземпляра (можно растягивать поверх каталога). */
export function fixtureDims(f) {
  const type = resolveFixtureType(f?.type);
  const def = FIXTURE_CATALOG[type] || {};
  let w = Math.max(8, +(f?.w ?? def.w ?? 40));
  const d = Math.max(4, +(f?.d ?? def.d ?? w));
  const h = Math.max(10, +(f?.h ?? def.h ?? 100));
  if (type === 'socket_block') {
    w = socketBlockWidth(socketBlockCount(f), h);
  }
  return { w, d, h, def };
}

/**
 * Геометрический центр объекта в мире.
 * elev — отметка «низа» (для труб — пол), центр выше на h/2.
 * Для розеток/выключателей/решёток elev уже середина пластины.
 */
export function fixtureCenter(f, dims = null) {
  const type = resolveFixtureType(f?.type);
  const def = FIXTURE_CATALOG[type] || {};
  const { w, d, h } = dims || fixtureDims(f);
  const elev = +f?.elev || 0;
  const y = (isWallPlateKind(def.kind) || isUserObjWall(f, def)) ? elev : elev + h * 0.5;
  return { x: +f?.x || 0, y, z: +f?.z || 0, w, d, h, elev, kind: def.kind };
}

export function fixtureTitle(f) {
  const type = resolveFixtureType(f?.type);
  return f.name || FIXTURE_CATALOG[type]?.title || type;
}

export function fixturesByCategory() {
  const map = new Map();
  for (const [id, def] of Object.entries(FIXTURE_CATALOG)) {
    if (id === 'userobj') continue; // карточки — во вкладке «Помещение» → Мои объекты
    const c = def.category;
    if (!map.has(c)) map.set(c, []);
    map.get(c).push({ id, ...def });
  }
  return map;
}

/** Коммуникации для вкладки «Помещение» (как конструкции). */
export function communicationsCatalog() {
  return Object.entries(FIXTURE_CATALOG)
    .filter(([, d]) => d.category === 'Коммуникации')
    .map(([id, def]) => ({ id, ...def }));
}

/** SVG-превью розеток / выключателей / труб / решёток. */
export const FIXTURE_ICONS = {
  socket_block: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="12" width="40" height="24" rx="3" fill="#f5f5f5" stroke="#5b636e" stroke-width="2"/><rect x="8" y="16" width="10" height="16" rx="2" fill="#e8eaed" stroke="#8b919a" stroke-width="1.2"/><rect x="19" y="16" width="10" height="16" rx="2" fill="#e8eaed" stroke="#8b919a" stroke-width="1.2"/><rect x="30" y="16" width="10" height="16" rx="2" fill="#e8eaed" stroke="#8b919a" stroke-width="1.2"/><circle cx="11" cy="21" r="1.2" fill="#5b636e"/><circle cx="15" cy="21" r="1.2" fill="#5b636e"/><circle cx="22" cy="21" r="1.2" fill="#5b636e"/><circle cx="26" cy="21" r="1.2" fill="#5b636e"/><circle cx="33" cy="21" r="1.2" fill="#5b636e"/><circle cx="37" cy="21" r="1.2" fill="#5b636e"/></svg>`,
  switch_1: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="8" width="28" height="32" rx="3" fill="#f5f5f5" stroke="#5b636e" stroke-width="2"/><rect x="16" y="14" width="16" height="20" rx="2" fill="#e8eaed" stroke="#8b919a" stroke-width="1.5"/><rect x="20" y="18" width="8" height="12" rx="1.5" fill="#fff" stroke="#5b636e" stroke-width="1.5"/><circle cx="24" cy="24" r="1.5" fill="#5b636e"/></svg>`,
  vent_round: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="18" fill="#d0d4d8" stroke="#5b636e" stroke-width="2"/><circle cx="24" cy="24" r="12" fill="none" stroke="#5b636e" stroke-width="1.5"/><circle cx="24" cy="24" r="6" fill="none" stroke="#5b636e" stroke-width="1.5"/><path d="M24 6v36M6 24h36M11 11l26 26M37 11L11 37" stroke="#5b636e" stroke-width="1.2"/></svg>`,
  vent_square: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="6" width="36" height="36" rx="2" fill="#d0d4d8" stroke="#5b636e" stroke-width="2"/><path d="M10 14h28M10 20h28M10 26h28M10 32h28" stroke="#5b636e" stroke-width="2" stroke-linecap="round"/></svg>`,
  pipe_water: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="4" width="8" height="40" rx="3" fill="#4a90d9" stroke="#2a6aa8" stroke-width="1.5"/><rect x="26" y="4" width="8" height="40" rx="3" fill="#e85d4c" stroke="#b83a2e" stroke-width="1.5"/><rect x="12" y="18" width="12" height="6" rx="1" fill="#6aa8e8"/><rect x="24" y="18" width="12" height="6" rx="1" fill="#f08070"/></svg>`,
  pipe_sewer: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="4" width="12" height="40" rx="4" fill="#6b7280" stroke="#4b5563" stroke-width="2"/><ellipse cx="24" cy="8" rx="6" ry="3" fill="#9ca3af"/><rect x="14" y="22" width="20" height="8" rx="2" fill="#7c8491" stroke="#4b5563" stroke-width="1"/><circle cx="24" cy="26" r="2" fill="#4b5563"/></svg>`,
  pipe_gas: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="4" width="8" height="40" rx="3" fill="#d4a017" stroke="#a07810" stroke-width="1.5"/><rect x="16" y="14" width="16" height="6" rx="1" fill="#e8b820"/><circle cx="24" cy="30" r="5" fill="none" stroke="#a07810" stroke-width="2"/><path d="M24 27v6M21 30h6" stroke="#a07810" stroke-width="1.5"/></svg>`,
};

function _mat(THREE, color, metal = 0.25, rough = 0.55) {
  return new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
}

function _addPipeRiser(THREE, g, { x = 0, z = 0, r, h, color, metal = 0.55, rings = true }) {
  const mat = _mat(THREE, color, metal, 0.35);
  const chrome = _mat(THREE, 0xb0b6bc, 0.85, 0.25);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat);
  body.position.set(x, h / 2, z);
  g.add(body);
  // муфты / отводы
  if (rings && h > 80) {
    for (const t of [0.08, 0.5, 0.92]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.25, r * 1.25, Math.max(8, r * 0.55), 16), chrome);
      ring.position.set(x, h * t, z);
      g.add(ring);
    }
  }
  // фланец у пола
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.7, r * 1.9, Math.max(6, r * 0.4), 16), chrome);
  flange.position.set(x, Math.max(4, r * 0.25), z);
  g.add(flange);
  // колпачок сверху
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.15, Math.max(6, r * 0.5), 16), chrome);
  cap.position.set(x, h - Math.max(3, r * 0.2), z);
  g.add(cap);
}

function _buildCommPipe(THREE, g, f, dims) {
  const { w, h } = dims;
  const type = f.type;
  if (type === 'pipe_water') {
    // пара стояков ХВС (синий) + ГВС (красный)
    const r = Math.max(6, w * 0.28);
    const gap = Math.max(r * 2.4, w * 0.55);
    _addPipeRiser(THREE, g, { x: -gap / 2, r, h, color: 0x3a7fc4, metal: 0.45 });
    _addPipeRiser(THREE, g, { x: gap / 2, r, h, color: 0xd4533d, metal: 0.45 });
    // кронштейн к стене
    const br = _mat(THREE, 0x8a9098, 0.7, 0.3);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(gap + r * 2, 8, 10), br);
    bar.position.set(0, h * 0.55, -r - 6);
    g.add(bar);
  } else if (type === 'pipe_sewer') {
    const r = Math.max(10, w / 2);
    _addPipeRiser(THREE, g, { r, h, color: 0x6b7280, metal: 0.2, rings: true });
    // раструб сверху
    const sock = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.45, r * 1.15, Math.max(28, r * 1.2), 20),
      _mat(THREE, 0x7c8491, 0.15, 0.6),
    );
    sock.position.y = h - Math.max(14, r * 0.6);
    g.add(sock);
    // ревизия
    if (h > 200) {
      const rev = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, r * 1.2, r * 1.8), _mat(THREE, 0x555b66, 0.2, 0.55));
      rev.position.set(0, h * 0.35, r * 0.6);
      g.add(rev);
    }
  } else {
    // газ
    const r = Math.max(5, w / 2);
    _addPipeRiser(THREE, g, { r, h, color: 0xd4a017, metal: 0.35 });
    // вентиль
    const valveY = Math.min(h * 0.55, Math.max(120, h * 0.4));
    const body = new THREE.Mesh(new THREE.SphereGeometry(r * 1.4, 16, 12), _mat(THREE, 0xc09010, 0.5, 0.3));
    body.position.y = valveY;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.35, r * 2.2, 10), _mat(THREE, 0xb0b6bc, 0.85, 0.25));
    stem.position.set(0, valveY + r * 1.5, 0);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(r * 1.6, r * 0.28, 8, 20), _mat(THREE, 0xb0b6bc, 0.85, 0.25));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(0, valveY + r * 2.4, 0);
    g.add(body, stem, wheel);
  }
}

function _euroSocketFace(THREE, g, x, y, z, scale = 1) {
  const dark = _mat(THREE, 0x2a2e34, 0.1, 0.7);
  const plastic = _mat(THREE, 0xe8eaed, 0.05, 0.65);
  const face = new THREE.Mesh(new THREE.BoxGeometry(28 * scale, 28 * scale, 3), plastic);
  face.position.set(x, y, z);
  g.add(face);
  for (const [dx, dy] of [[-6, 5], [6, 5], [0, -6]].map(([a, b]) => [a * scale, b * scale])) {
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(2.2 * scale, 2.2 * scale, 4, 10), dark);
    pin.rotation.x = Math.PI / 2;
    pin.position.set(x + dx, y + dy, z + 2);
    g.add(pin);
  }
}

function _buildCommSocket(THREE, g, f, dims) {
  const { w, d, h } = dims;
  const type = resolveFixtureType(f.type);
  const isSwitch = type === 'switch_1';
  const frame = _mat(THREE, 0xf2f2f2, 0.05, 0.7);
  const body = _mat(THREE, 0xe4e4e4, 0.05, 0.65);
  const back = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.min(w, h) * 0.38, Math.min(w, h) * 0.38, Math.max(d * 2, 20), 20),
    _mat(THREE, 0x9aa0a8, 0.1, 0.8),
  );
  back.rotation.x = Math.PI / 2;
  back.position.z = -Math.max(4, d);
  g.add(back);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(w, h, Math.max(4, d * 0.6)), frame);
  plate.position.z = d * 0.35;
  const rim = new THREE.Mesh(new THREE.BoxGeometry(w + 6, h + 6, 2), body);
  rim.position.z = d * 0.15;
  g.add(rim, plate);
  if (isSwitch) {
    const rocker = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, h * 0.55, 5), _mat(THREE, 0xffffff, 0.05, 0.55));
    rocker.position.set(0, 2, d * 0.35 + 4);
    rocker.rotation.x = -0.08;
    g.add(rocker);
  } else {
    const n = type === 'socket_block' ? socketBlockCount(f) : 1;
    const sc = Math.min(h, w / Math.max(1, n)) / 80;
    const cell = w / n;
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + cell * (i + 0.5);
      _euroSocketFace(THREE, g, x, 0, d * 0.35 + 3, sc);
    }
  }
}

function _buildCommVent(THREE, g, f, dims) {
  const { w, d, h } = dims;
  const type = resolveFixtureType(f.type);
  const frame = _mat(THREE, 0xd0d4d8, 0.25, 0.5);
  const dark = _mat(THREE, 0x3a3e44, 0.15, 0.65);
  if (type === 'vent_round') {
    const r = Math.min(w, h) * 0.5;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(5, d), 36), frame);
    plate.rotation.x = Math.PI / 2;
    plate.position.z = d * 0.25;
    g.add(plate);
    for (let i = 1; i <= 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * (0.22 * i), 1.3, 8, 36), dark);
      ring.position.z = d * 0.25 + Math.max(4, d * 0.45);
      g.add(ring);
    }
    for (let a = 0; a < 6; a++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(r * 1.7, 2.4, 2), dark);
      bar.position.z = d * 0.25 + 5;
      bar.rotation.z = (a * Math.PI) / 6;
      g.add(bar);
    }
  } else {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, h, Math.max(5, d)), frame);
    plate.position.z = d * 0.25;
    g.add(plate);
    const innerW = w - 14;
    const innerH = h - 14;
    const nBlades = Math.max(4, Math.round(innerH / 12));
    for (let i = 0; i < nBlades; i++) {
      const y = -innerH / 2 + (i + 0.5) * (innerH / nBlades);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(innerW, 3.2, 2.5), dark);
      blade.position.set(0, y, d * 0.25 + 4);
      blade.rotation.x = 0.4;
      g.add(blade);
    }
  }
}

/**
 * Свой объект из личного каталога: сетка масштабируется под габарит экземпляра (w/h/d),
 * зеркалится по X, цвет экземпляра перекрывает материалы модели.
 * Если модели нет (удалена или каталог другого пользователя) — полупрозрачная коробка-заглушка.
 */
function _buildUserObj(THREE, g, f, dims) {
  const { w, d, h } = dims;
  const onWall = isUserObjWall(f);
  const item = getUserObject(f.objId);
  const meshRec = getUserObjectMesh(f.objId);
  if (meshRec?.positions?.length) {
    g.add(buildUserObjectNode(meshRec, {
      w, h, d,
      mirror: !!f.mirror,
      color: f.color || null,
      useMaterials: item ? item.useMaterials !== false : true,
      baseColor: item?.color,
      onWall,
    }));
    return;
  }
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0xd97706, transparent: true, opacity: 0.35, roughness: 0.8 }),
  );
  box.position.y = onWall ? 0 : h / 2;
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(box.geometry),
    new THREE.LineBasicMaterial({ color: 0xb45309 }),
  );
  edge.position.copy(box.position);
  g.add(box, edge);
}

/** Построить группу Three.js для объекта (вызывается из viewer). */
export function buildFixtureMesh(THREE, f) {
  const type = resolveFixtureType(f.type);
  const def = FIXTURE_CATALOG[type];
  if (!def) return null;
  const dims = fixtureDims({ ...f, type });
  const { w, d, h } = dims;
  const g = new THREE.Group();
  g.userData = { fixtureId: f.id, pick: true, kind: 'fixture', fixtureKind: def.kind, w, d, h };
  const mat = new THREE.MeshStandardMaterial({
    color: def.color,
    metalness: def.metal ? 0.85 : 0.15,
    roughness: def.metal ? 0.25 : 0.7,
  });

  if (def.kind === 'mixer') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(22, 28, 20, 16), mat);
    base.position.y = 10;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(12, 14, 220, 12), mat);
    col.position.set(0, 120, 0);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 160, 12), mat);
    spout.rotation.x = Math.PI / 2;
    spout.position.set(0, 220, 70);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(14, 10, 30, 12), mat);
    tip.position.set(0, 200, 150);
    g.add(base, col, spout, tip);
  } else if (def.kind === 'sink') {
    const bw = w - SINK_RIM * 2, bd = d - SINK_RIM * 2, bh = h - 20;
    const inner = new THREE.MeshStandardMaterial({ color: def.color, metalness: 0.7, roughness: 0.35, side: THREE.BackSide });
    const bowl = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), inner);
    bowl.position.y = -bh / 2 + 2;
    g.add(bowl);
    const bar = (bw2, bd2, x, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(bw2, 4, bd2), mat); b.position.set(x, 2, z); g.add(b); };
    bar(w, SINK_RIM, 0, -d / 2 + SINK_RIM / 2);
    bar(w, SINK_RIM, 0, d / 2 - SINK_RIM / 2);
    bar(SINK_RIM, bd, -w / 2 + SINK_RIM / 2, 0);
    bar(SINK_RIM, bd, w / 2 - SINK_RIM / 2, 0);
    if (w > 600) {
      const div = new THREE.Mesh(new THREE.BoxGeometry(20, bh - 30, bd), mat);
      div.position.y = -(bh - 30) / 2;
      g.add(div);
    }
    const drain = new THREE.Mesh(new THREE.CylinderGeometry(35, 35, 3, 20), new THREE.MeshStandardMaterial({ color: 0x555a60, metalness: 0.8 }));
    drain.position.set(w > 600 ? -bw / 4 : 0, -bh + 4, 0);
    g.add(drain);
  } else if (def.kind === 'pipe') {
    _buildCommPipe(THREE, g, f, dims);
  } else if (def.kind === 'socket') {
    _buildCommSocket(THREE, g, { ...f, type }, dims);
  } else if (def.kind === 'vent') {
    _buildCommVent(THREE, g, { ...f, type }, dims);
  } else if (def.kind === 'userobj') {
    _buildUserObj(THREE, g, f, dims);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    body.position.set(0, h / 2, d / 2);
    g.add(body);
    if (type === 'oven_60' || type === 'dishwasher_60') {
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(w - 80, h - 120, 8),
        new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.5, roughness: 0.2 }),
      );
      glass.position.set(0, h / 2, d + 2);
      g.add(glass);
    }
    if (type === 'hob_60') {
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(w, 8, d),
        new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.3 }),
      );
      plate.position.set(0, 8, d / 2);
      const burners = [];
      for (const [bx, bz] of [[-120, -100], [120, -100], [-120, 100], [120, 100]]) {
        const b = new THREE.Mesh(
          new THREE.CylinderGeometry(70, 70, 6, 24),
          new THREE.MeshStandardMaterial({ color: 0x333333 }),
        );
        b.position.set(bx, 14, d / 2 + bz);
        burners.push(b);
      }
      g.add(plate, ...burners);
    }
    if (type === 'fridge_60') {
      const line = new THREE.Mesh(new THREE.BoxGeometry(w - 20, 4, 4), new THREE.MeshStandardMaterial({ color: 0x999999 }));
      line.position.set(0, h * 0.65, d + 2);
      g.add(line);
    }
  }

  // Трубы: пивот в геометрическом центре — кольца gizmo крутят от середины
  if (def.kind === 'pipe') {
    for (const c of g.children) c.position.y -= h / 2;
    const c0 = fixtureCenter(f, dims);
    g.position.set(c0.x, c0.y, c0.z);
  } else {
    g.position.set(+f.x, +f.elev, +f.z);
  }
  g.rotation.order = 'YXZ';
  g.rotation.x = ((+f.rx || 0) * Math.PI) / 180;
  g.rotation.y = ((+f.rot || 0) * Math.PI) / 180;
  g.rotation.z = ((+f.rz || 0) * Math.PI) / 180;
  return g;
}
