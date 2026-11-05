// Каталог фурнитуры (из линейки Самолет) + правила авторасстановки по панелям модуля.

let catalog = null;

export async function loadHwCatalog() {
  if (catalog) return catalog;
  const url = new URL('../data/hardware_catalog.json', import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Каталог фурнитуры: ' + r.status);
  catalog = await r.json();
  return catalog;
}

export const hwCatalog = () => catalog;
export const hwItems = () => catalog?.items || [];
export const hwById = (id) => (catalog?.items || []).find((it) => it.id === id);
export const hwCategories = () => catalog?.categories || [];
export const hwItemsByCat = (cat) => {
  const all = hwItems();
  return !cat || cat === 'all' ? all : all.filter((it) => it.cat === cat);
};

/** Сколько петель на высоту фасада (мм). */
export function hingeCountForHeight(h) {
  if (h <= 900) return 2;
  if (h <= 1600) return 3;
  if (h <= 2000) return 4;
  return 5;
}

function hingesYs(y1, y2, n) {
  if (n <= 1) return [(y1 + y2) / 2];
  const m = 80;
  const a = y1 + m, b = y2 - m;
  if (b <= a) return [(y1 + y2) / 2];
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

/**
 * Автофурнитура по панелям шаблона.
 * @returns {Array<object>}
 */
export function autoFittingsForModule(m, panels, opts = {}) {
  const W = +m.p.width || 600;
  const D = +m.p.depth || 560;
  const elev = +m.p.elev || 0;
  const pl = +m.p.plinth || 0;
  const hingeId = opts.hingeId || 'hinge_sensys_110';
  const legId = opts.legId || 'leg_plinth';
  const hangerId = opts.hangerId || 'hanger_scarpi4';
  const slideId = opts.slideId || 'slide_ball';
  const shelfId = opts.shelfId || 'shelf_psf';
  const handleId = opts.handleId || 'handle_128';
  const out = [];
  let seq = 1;

  const add = (catalogId, extra = {}) => {
    const it = hwById(catalogId);
    if (!it) return;
    const key = `hw_${seq++}`;
    const [gw, gh, gd] = it.gab || [40, 40, 40];
    const cx = extra.x ?? 0, cy = extra.y ?? 0, cz = extra.z ?? 0;
    const vertical = extra.vertical;
    out.push({
      key,
      catalogId: it.id,
      name: it.name,
      art: it.art || '',
      mesh: it.mesh,
      bazisFile: it.bazisFile || '',
      mount: it.mount || (it.mesh === 'hinge' ? 'pair' : 'face'),
      side: extra.side || 'left',
      vertical: vertical == null ? true : vertical,
      x1: cx - gw / 2, y1: cy - gh / 2, z1: cz - gd / 2,
      x2: cx + gw / 2, y2: cy + gh / 2, z2: cz + gd / 2,
      panelKey: extra.panelKey || null,
    });
  };

  const isWall = m.type === 'wall' || m.p?.kind === 'wall';
  const isBaseLike = !isWall;

  for (const p of panels) {
    if (p.openable !== 'door' || p.orient !== 'F') continue;
    const side = p.hinge === 'right' ? 'right' : 'left';
    const y1 = p.b1, y2 = p.b2;
    const n = hingeCountForHeight(y2 - y1);
    for (const y of hingesYs(y1, y2, n)) {
      const pose = hingePoseOnDoor(p, side, y, hingeId);
      if (pose) out.push({ ...pose, key: `hw_${seq++}` });
    }
    const hy = isWall ? y1 + 90 : isBaseLike && (m.type === 'base' || m.type === 'sink' || m.type === 'base_drawers')
      ? y2 - 90
      : Math.max(y1 + 100, Math.min(1000, y2 - 100));
    const hxx = side === 'left' ? p.a2 - 40 : p.a1 + 40;
    // ручка снаружи фасада (pos + t)
    add(handleId, {
      side, x: hxx, y: hy, z: (p.pos || D) + (p.t || 18) + 8,
      panelKey: p.key, vertical: true,
    });
  }

  for (const p of panels) {
    if (p.openable !== 'drawer' || p.orient !== 'F') continue;
    const y = (p.b1 + p.b2) / 2;
    const travel = Math.min(450, Math.max(250, D - 80));
    // направляющие: gab по глубине
    const it = hwById(slideId);
    if (it) {
      const [, ,] = it.gab;
      add(slideId, { x: 18, y, z: D / 2, panelKey: p.key, side: 'left' });
      // подправим z-габарит через пересчёт после add — проще вручную:
      const lastL = out[out.length - 1];
      lastL.z1 = 40; lastL.z2 = 40 + travel; lastL.y1 = y - 10; lastL.y2 = y + 10;
      lastL.x1 = 8; lastL.x2 = 20;
      add(slideId, { x: W - 18, y, z: D / 2, panelKey: p.key, side: 'right' });
      const lastR = out[out.length - 1];
      lastR.z1 = 40; lastR.z2 = 40 + travel; lastR.y1 = y - 10; lastR.y2 = y + 10;
      lastR.x1 = W - 20; lastR.x2 = W - 8;
    }
    add(handleId, {
      x: W / 2, y: p.b2 - 40, z: (p.pos || D) + 15,
      panelKey: p.key, vertical: false,
    });
  }

  for (const p of panels) {
    if (p.role !== 'shelf' || p.orient !== 'H') continue;
    const y = p.pos + (p.t || 16) / 2;
    const z1 = p.b1 + 40, z2 = Math.max(z1 + 10, p.b2 - 40);
    add(shelfId, { x: p.a1 - 2, y, z: z1 });
    add(shelfId, { x: p.a1 - 2, y, z: z2 });
    add(shelfId, { x: p.a2 + 2, y, z: z1 });
    add(shelfId, { x: p.a2 + 2, y, z: z2 });
  }

  if (pl > 0 && isBaseLike) {
    const inset = 50;
    const y = elev + pl / 2;
    for (const [x, z] of [[inset, inset], [W - inset, inset], [inset, D - inset], [W - inset, D - inset]]) {
      add(legId, { x, y, z });
      const last = out[out.length - 1];
      last.y1 = elev; last.y2 = elev + pl;
    }
  }

  if (isWall) {
    const y = elev + (+m.p.height || 720) - 40;
    add(hangerId, { x: 40, y, z: 35, side: 'left' });
    add(hangerId, { x: W - 40, y, z: 35, side: 'right' });
  }

  return out;
}

export function fittingsSummary(fittings) {
  const map = new Map();
  for (const f of fittings || []) {
    const id = f.catalogId;
    if (!id) continue;
    map.set(id, (map.get(id) || 0) + 1);
  }
  return [...map.entries()].map(([id, qty]) => {
    const it = hwById(id);
    return { id, name: it?.name || id, art: it?.art || '', price: it?.price || 0, qty };
  });
}

/**
 * Посадка петли на дверь: чашка уходит в фасад с внутренней стороны,
 * корпус — внутрь корпуса. z2 никогда не дальше наружной плоскости фасада.
 */
export function hingePoseOnDoor(door, side, y, catalogId = 'hinge_sensys_110') {
  const it = hwById(catalogId);
  if (!it || !door) return null;
  // глубина gab: чашка ~12 мм в дверь + рычаг ~48 мм в корпус (не 80 — иначе «выпирает»)
  const gw = 42, gh = 70, gd = 60;
  const T = Math.max(12, +door.t || 18);
  const zInner = +door.pos || 0;
  const zOuter = zInner + T;
  const cupInto = Math.min(12, T - 2); // чашка внутри толщины фасада
  const z2 = Math.min(zOuter - 0.5, zInner + cupInto);
  const z1 = z2 - gd;
  const sd = side === 'right' ? 'right' : 'left';
  const hx = sd === 'right' ? door.a2 - 22 : door.a1 + 22;
  return {
    catalogId: it.id,
    name: it.name,
    art: it.art || '',
    mesh: it.mesh,
    bazisFile: it.bazisFile || '',
    mount: it.mount || 'pair',
    side: sd,
    vertical: true,
    x1: hx - gw / 2, y1: y - gh / 2, z1,
    x2: hx + gw / 2, y2: y + gh / 2, z2,
    panelKey: door.key,
  };
}

/** Предложенные слоты петель по дверям модуля (для призраков / быстрой вставки). */
export function suggestHingeSlots(panels, opts = {}) {
  const hingeId = opts.hingeId || 'hinge_sensys_110';
  const slots = [];
  for (const p of panels || []) {
    if (p.openable !== 'door' || p.orient !== 'F') continue;
    const side = p.hinge === 'right' ? 'right' : 'left';
    const n = hingeCountForHeight(p.b2 - p.b1);
    for (const y of hingesYs(p.b1, p.b2, n)) {
      const pose = hingePoseOnDoor(p, side, y, hingeId);
      if (pose) slots.push({ ...pose, doorKey: p.key, y });
    }
  }
  return slots;
}

/** Габарит новой позиции фурнитуры в центре модуля / у выбранной детали. */
export function defaultFittingPose(it, m, selPanel) {
  const [gw, gh, gd] = it.gab || [40, 40, 40];
  const W = +m.p.width || 600;
  const D = +m.p.depth || 560;
  const H = +m.p.height || 720;
  const elev = +m.p.elev || 0;
  if (it.mesh === 'hinge' && selPanel?.orient === 'F' && selPanel.openable === 'door') {
    const side = selPanel.hinge === 'right' ? 'right' : 'left';
    const y = (selPanel.b1 + selPanel.b2) / 2;
    const pose = hingePoseOnDoor(selPanel, side, y, it.id);
    if (pose) return { key: '', ...pose };
  }
  let cx = W / 2, cy = elev + H / 2, cz = D / 2;
  let side = 'left';
  if (selPanel?.orient === 'F' && selPanel.openable === 'door') {
    side = selPanel.hinge === 'right' ? 'right' : 'left';
    cx = side === 'right' ? selPanel.a2 - 22 : selPanel.a1 + 22;
    cy = (selPanel.b1 + selPanel.b2) / 2;
    cz = (selPanel.pos || D) + (selPanel.t || 18) / 2;
  } else if (it.mesh === 'leg') {
    cx = 50; cy = elev + (+m.p.plinth || 100) / 2; cz = 50;
  } else if (it.mesh === 'hanger') {
    cx = 40; cy = elev + H - 40; cz = 35;
  } else if (it.mesh === 'handle') {
    cx = W - 40; cy = elev + H * 0.55;
    cz = D + 18 + 8;
  }
  return {
    key: '',
    catalogId: it.id,
    name: it.name,
    art: it.art || '',
    mesh: it.mesh,
    bazisFile: it.bazisFile || '',
    mount: it.mount || (it.mesh === 'hinge' ? 'pair' : 'face'),
    side,
    vertical: it.mesh !== 'handle' || it.use?.includes('door'),
    x1: cx - gw / 2, y1: cy - gh / 2, z1: cz - gd / 2,
    x2: cx + gw / 2, y2: cy + gh / 2, z2: cz + gd / 2,
    panelKey: selPanel?.key || null,
  };
}

/** Дополнить fitting полями каталога (bazisFile/mount) перед выгрузкой. */
export function enrichFitting(f) {
  if (!f) return f;
  const it = f.catalogId ? hwById(f.catalogId) : null;
  if (it) {
    if (!f.bazisFile) f.bazisFile = it.bazisFile || '';
    if (!f.mount) f.mount = it.mount || (it.mesh === 'hinge' ? 'pair' : 'face');
    if (!f.mesh) f.mesh = it.mesh;
  }
  return f;
}

/** Центр панели в мировых мм (H/V/F как в panelBox). */
function panelCenter(p) {
  if (p.orient === 'H') {
    return { x: (p.a1 + p.a2) / 2, y: p.pos + (p.t || 0) / 2, z: (p.b1 + p.b2) / 2 };
  }
  if (p.orient === 'V') {
    return { x: p.pos + (p.t || 0) / 2, y: (p.a1 + p.a2) / 2, z: (p.b1 + p.b2) / 2 };
  }
  // F
  return { x: (p.a1 + p.a2) / 2, y: (p.b1 + p.b2) / 2, z: p.pos + (p.t || 0) / 2 };
}

/**
 * Сдвинуть фурнитуру вместе с панелью (по дельте центра).
 * prev — снимок панели до правки.
 */
export function moveFittingsWithPanel(fittings, prev, next) {
  if (!prev || !next || !fittings?.length) return;
  const oldKey = prev.key;
  const newKey = next.key;
  const a = panelCenter(prev);
  const b = panelCenter(next);
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  if (!dx && !dy && !dz && oldKey === newKey) return;
  for (const f of fittings) {
    if (f.panelKey !== oldKey) continue;
    if (newKey !== oldKey) f.panelKey = newKey;
    f.x1 += dx; f.x2 += dx;
    f.y1 += dy; f.y2 += dy;
    f.z1 += dz; f.z2 += dz;
  }
}
