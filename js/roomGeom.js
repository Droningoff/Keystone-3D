// Контур комнаты: simple (прямоугольник + ниши/выступы) и advanced (полигон + контур на yRef + потолок).
// Стены simple: back z=0, right x=L, front z=D, left x=0.

import { wallId, WALL_BY_CODE, wallLetter } from './walls.js?v=20261106a';

/** Единый редактор как BPlanner: полигон, если есть planFloor. */
export function isAdvanced(room) {
  return !!(room?.planFloor?.length >= 3);
}

/**
 * Привести комнату к единому полигональному плану (BPlanner Arch System).
 * Simple+ниши запекаются в контур; дальше только planFloor/planAtRef.
 */
export function unifyRoomPlan(room) {
  if (!room) return room;
  if (room.planFloor?.length >= 3) {
    room.editorMode = 'advanced';
    ensureAdvancedFields(room);
    syncSimpleAABB(room);
    return room;
  }
  // временно simple, чтобы roomOutline учёл features (ниши/выступы)
  room.editorMode = 'simple';
  const outline = roomOutline(room);
  const pts = [];
  for (const p of outline) {
    if (pts.length >= 3) {
      const first = pts[0];
      if (Math.hypot(first.x - p.x, first.z - p.z) < 0.5) break;
    }
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(prev.x - p.x, prev.z - p.z) < 0.5) continue;
    pts.push({ id: `v${pts.length}`, x: Math.round(p.x), z: Math.round(p.z) });
  }
  room.planFloor = pts.length >= 3 ? pts : rectPlan(room.length, room.depth);
  room.planAtRef = clonePlan(room.planFloor);
  room.planCeiling = clonePlan(room.planFloor);
  room.editorMode = 'advanced';
  ensureAdvancedFields(room);
  syncSimpleAABB(room);
  return room;
}

export function rectPlan(L, D, prefix = 'v') {
  const L0 = +L || 4000, D0 = +D || 3500;
  return [
    { id: `${prefix}0`, x: 0, z: 0 },
    { id: `${prefix}1`, x: L0, z: 0 },
    { id: `${prefix}2`, x: L0, z: D0 },
    { id: `${prefix}3`, x: 0, z: D0 },
  ];
}

export function clonePlan(verts) {
  return (verts || []).map((p, i) => ({
    id: p.id || `v${i}`,
    x: Math.round(+p.x || 0),
    z: Math.round(+p.z || 0),
  }));
}

/** Заполнить advanced-поля из прямоугольника simple (или оставить существующие). */
export function ensureAdvancedFields(room) {
  if (!room) return room;
  const L = +room.length || 4000;
  const D = +room.depth || 3500;
  const H = +room.height || 2700;
  if (!Array.isArray(room.planFloor) || room.planFloor.length < 3) {
    room.planFloor = rectPlan(L, D);
  } else {
    room.planFloor = clonePlan(room.planFloor);
  }
  if (!Array.isArray(room.planAtRef) || room.planAtRef.length !== room.planFloor.length) {
    room.planAtRef = clonePlan(room.planFloor);
  } else {
    room.planAtRef = clonePlan(room.planAtRef);
  }
  if (!Array.isArray(room.planCeiling) || room.planCeiling.length !== room.planFloor.length) {
    room.planCeiling = clonePlan(room.planAtRef);
  } else {
    room.planCeiling = clonePlan(room.planCeiling);
  }
  if (room.yRef == null || !(+room.yRef > 0)) room.yRef = 900;
  if (!room.ceiling || typeof room.ceiling !== 'object') {
    room.ceiling = { mode: 'flat', height: H, samples: [] };
  }
  if (room.ceiling.height == null) room.ceiling.height = H;
  if (!Array.isArray(room.ceiling.samples)) room.ceiling.samples = [];
  if (!room.ceiling.mode) {
    room.ceiling.mode = room.ceiling.samples.length ? 'samples' : 'flat';
  }
  if (!Array.isArray(room.obstacles)) room.obstacles = [];
  return room;
}

export function simpleToAdvanced(room) {
  return unifyRoomPlan(room);
}

/** Сжать advanced → simple AABB; возвращает предупреждения. */
export function advancedToSimple(room) {
  const warns = [];
  ensureAdvancedFields(room);
  const b = roomBounds(room);
  room.length = Math.round(b.width);
  room.depth = Math.round(b.depth);
  const minh = minCeilingHeight(room);
  if (room.ceiling?.mode === 'samples' || (room.planAtRef && planDiffers(room.planFloor, room.planAtRef))) {
    warns.push('Сложный план/потолок упрощены до прямоугольника; детали потеряны.');
  }
  room.height = Math.round(minh);
  room.editorMode = 'simple';
  room.features = room.features || [];
  return warns;
}

function planDiffers(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > 0.5 || Math.abs(a[i].z - b[i].z) > 0.5) return true;
  }
  return false;
}

/** Синхронизировать length/depth/height из advanced-контура (для совместимости). */
export function syncSimpleAABB(room) {
  if (!room) return;
  ensureAdvancedFields(room);
  const b = roomBoundsFromVerts(room.planFloor);
  // сдвиг к (0,0), если нужно — оставляем абсолютные координаты как есть
  room.length = Math.round(Math.max(b.width, 100));
  room.depth = Math.round(Math.max(b.depth, 100));
  room.height = Math.round(minCeilingHeight(room));
}

/**
 * Задать габарит помещения и масштабировать planFloor/planAtRef/planCeiling.
 * Без этого смена roomL/roomD откатывается: refresh → syncSimpleAABB читает старый полигон.
 */
export function setRoomFootprint(room, length, depth) {
  if (!room) return;
  ensureAdvancedFields(room);
  const L = Math.max(100, Math.round(+length || 4000));
  const D = Math.max(100, Math.round(+depth || 3500));
  const b = roomBoundsFromVerts(room.planFloor);
  const oldW = Math.max(1, b.width);
  const oldD = Math.max(1, b.depth);
  const sx = L / oldW;
  const sz = D / oldD;
  for (const key of ['planFloor', 'planAtRef', 'planCeiling']) {
    const arr = room[key];
    if (!arr?.length) continue;
    for (const p of arr) {
      p.x = Math.round((+p.x - b.x1) * sx);
      p.z = Math.round((+p.z - b.z1) * sz);
    }
  }
  room.length = L;
  room.depth = D;
  syncSimpleAABB(room);
}

/** Высота помещения + плоский потолок (samples не трогаем по форме). */
export function setRoomHeight(room, height) {
  if (!room) return;
  const H = Math.max(100, Math.round(+height || 2700));
  room.height = H;
  if (!room.ceiling || typeof room.ceiling !== 'object') {
    room.ceiling = { mode: 'flat', height: H, samples: [] };
  } else {
    room.ceiling.height = H;
    if (room.ceiling.mode !== 'samples' || !room.ceiling.samples?.length) {
      room.ceiling.mode = 'flat';
    }
  }
}

/** Ключ активного плана: floor | ref | ceil → массив вершин. */
export function planByLayer(room, layer) {
  ensureAdvancedFields(room);
  if (layer === 'ref') return room.planAtRef;
  if (layer === 'ceil') return room.planCeiling;
  return room.planFloor;
}

export function planLayerLabel(layer, room) {
  if (layer === 'ref') return `Столешница (yRef ${room?.yRef || 900} мм)`;
  if (layer === 'ceil') return `Потолок (${room?.height || 2700} мм)`;
  return 'Пол (0 мм)';
}

/**
 * Вставить вершину на середину ребра edgeIndex во все три контура (одинаковая топология).
 * Возвращает индекс новой вершины.
 */
export function insertVertexOnEdge(room, edgeIndex) {
  ensureAdvancedFields(room);
  const i = +edgeIndex;
  const n = room.planFloor.length;
  if (i < 0 || i >= n) return -1;
  const j = (i + 1) % n;
  const mid = (plan, a, b) => ({
    id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    x: Math.round((plan[a].x + plan[b].x) / 2),
    z: Math.round((plan[a].z + plan[b].z) / 2),
  });
  const insertAt = i + 1;
  room.planFloor.splice(insertAt, 0, mid(room.planFloor, i, j));
  room.planAtRef.splice(insertAt, 0, mid(room.planAtRef, i, j));
  room.planCeiling.splice(insertAt, 0, mid(room.planCeiling, i, j));
  syncSimpleAABB(room);
  return insertAt;
}

/** Сбросить один контур в прямоугольник L×D (остальные без изменения формы; N→4 с синхронизацией топологии). */
export function resetPlanLayerToRect(room, layer) {
  ensureAdvancedFields(room);
  const L = +room.length || 4000;
  const D = +room.depth || 3500;
  const rect = rectPlan(L, D);
  const target = planByLayer(room, layer);
  // активный — прямоугольник
  target.length = 0;
  rect.forEach((p) => target.push({ ...p }));
  // остальные: если N≠4 — привести к своему AABB-прямоугольнику из 4 вершин
  for (const key of ['planFloor', 'planAtRef', 'planCeiling']) {
    const arr = room[key];
    if (arr === target) continue;
    if (arr.length === 4) continue;
    const b = roomBoundsFromVerts(arr.length >= 3 ? arr : rect);
    const r = rectPlan(Math.max(100, b.width), Math.max(100, b.depth));
    // сдвиг в исходный min
    for (const p of r) { p.x += b.x1; p.z += b.z1; }
    arr.length = 0;
    r.forEach((p) => arr.push({ ...p }));
  }
  // выровнять id/длины
  ensureAdvancedFields(room);
  syncSimpleAABB(room);
}

export function roomBoundsFromVerts(verts) {
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  for (const p of verts || []) {
    x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x);
    z1 = Math.min(z1, p.z); z2 = Math.max(z2, p.z);
  }
  if (!Number.isFinite(x1)) return { x1: 0, z1: 0, x2: 0, z2: 0, width: 0, depth: 0 };
  return { x1, z1, x2, z2, width: x2 - x1, depth: z2 - z1 };
}

/** Нормаль наружу и направление вдоль стены (единичные) — только для rectangular simple. */
function wallAxes(wall, L, D) {
  switch (wallId(wall)) {
    case 'back':  return { ox: 0, oz: -1, tx: 1, tz: 0, x0: 0, z0: 0, len: L };
    case 'right': return { ox: 1, oz: 0, tx: 0, tz: 1, x0: L, z0: 0, len: D };
    case 'front': return { ox: 0, oz: 1, tx: -1, tz: 0, x0: L, z0: D, len: L };
    case 'left':  return { ox: -1, oz: 0, tx: 0, tz: -1, x0: 0, z0: D, len: D };
    default:      return { ox: 0, oz: -1, tx: 1, tz: 0, x0: 0, z0: 0, len: L };
  }
}

function pt(x, z) { return { x, z }; }

/**
 * Цепочка точек одной стены с врезками features (от начала стены к концу).
 * niche — комната расширяется наружу; jut — выступ внутрь комнаты.
 */
function wallChain(wall, room, features) {
  const L = +room.length, D = +room.depth;
  const ax = wallAxes(wall, L, D);
  const feats = (features || [])
    .filter((f) => wallId(f.wall) === wallId(wall))
    .map((f) => ({
      ...f,
      offset: Math.max(0, Math.min(ax.len, +f.offset || 0)),
      width: Math.max(10, +f.width || 100),
      depth: Math.max(10, +f.depth || 100),
      kind: f.kind === 'jut' || f.kind === 'bay' || f.kind === 'выступ' ? 'jut' : 'niche',
    }))
    .map((f) => ({ ...f, width: Math.min(f.width, ax.len - f.offset) }))
    .sort((a, b) => a.offset - b.offset);

  const pts = [];
  let cursor = 0;
  const at = (s, out = 0) => pt(ax.x0 + ax.tx * s + ax.ox * out, ax.z0 + ax.tz * s + ax.oz * out);

  pts.push(at(0));
  for (const f of feats) {
    const a = f.offset, b = f.offset + f.width;
    if (a > cursor + 0.5) pts.push(at(a));
    const sign = f.kind === 'niche' ? 1 : -1;
    const d = f.depth * sign;
    pts.push(at(a, d));
    pts.push(at(b, d));
    pts.push(at(b, 0));
    cursor = b;
  }
  if (cursor < ax.len - 0.5) pts.push(at(ax.len));
  else if (Math.hypot(pts[pts.length - 1].x - at(ax.len).x, pts[pts.length - 1].z - at(ax.len).z) > 0.5) {
    pts.push(at(ax.len));
  }
  return pts;
}

function closeOutline(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.x - p.x, prev.z - p.z) < 0.5) continue;
    out.push({ x: p.x, z: p.z });
  }
  if (out.length && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) > 0.5) {
    out.push({ ...out[0] });
  }
  return out;
}

/** Замкнутый контур пола CCW */
export function roomOutline(room) {
  if (isAdvanced(room) && room.planFloor?.length >= 3) {
    return closeOutline(room.planFloor);
  }
  const feats = room.features || [];
  const chains = ['back', 'right', 'front', 'left'].map((w) => wallChain(w, room, feats));
  const out = [];
  for (const ch of chains) {
    for (let i = 0; i < ch.length; i++) {
      const p = ch[i];
      const prev = out[out.length - 1];
      if (prev && Math.hypot(prev.x - p.x, prev.z - p.z) < 0.5) continue;
      out.push(p);
    }
  }
  return closeOutline(out);
}

/** Контур в плане на высоте y: пол → yRef → потолок (три сечения как в BPlanner). */
export function planAtHeight(room, y) {
  ensureAdvancedFields(room);
  const floor = room.planFloor;
  const mid = room.planAtRef;
  const top = room.planCeiling;
  const yRef = +room.yRef || 900;
  const H = Math.max(yRef + 1, +room.height || 2700);
  const yy = Math.max(0, +y || 0);
  const lerp = (a, b, t) => a.map((p, i) => {
    const q = b[i] || p;
    return { id: p.id, x: p.x + t * (q.x - p.x), z: p.z + t * (q.z - p.z) };
  });
  if (yy <= 0) return clonePlan(floor);
  if (yy >= H) return clonePlan(top);
  if (yy <= yRef) return lerp(floor, mid, yRef > 0 ? yy / yRef : 0);
  return lerp(mid, top, (yy - yRef) / (H - yRef));
}

/** Внутренний угол при вершине i, градусы (контур CCW → угол слева по ходу). */
/** Внутренний угол между двумя стенами в вершине (для прямоугольника CCW = 90°). */
export function cornerAngleDeg(verts, i) {
  const n = verts.length;
  if (n < 3) return 90;
  const prev = verts[(i - 1 + n) % n];
  const cur = verts[i];
  const next = verts[(i + 1) % n];
  // лучи вдоль стен от угла
  const ax = prev.x - cur.x, az = prev.z - cur.z;
  const bx = next.x - cur.x, bz = next.z - cur.z;
  const la = Math.hypot(ax, az) || 1;
  const lb = Math.hypot(bx, bz) || 1;
  const axn = ax / la, azn = az / la;
  const bxn = bx / lb, bzn = bz / lb;
  let cos = axn * bxn + azn * bzn;
  cos = Math.max(-1, Math.min(1, cos));
  let deg = (Math.acos(cos) * 180) / Math.PI; // 0..180 между лучами
  // CCW-контур комнаты: внутренний угол слева по обходу
  const cross = axn * bzn - azn * bxn;
  if (cross > 0) deg = 360 - deg;
  return Math.round(deg * 100) / 100;
}

export function cornerAnglesAt(room, y) {
  const verts = isAdvanced(room) ? planAtHeight(room, y) : rectPlan(room.length, room.depth);
  return verts.map((_, i) => cornerAngleDeg(verts, i));
}

/** Отрезки стен для мешей: {x1,z1,x2,z2, wallHint, len, ...} */
export function roomWallSegments(room) {
  const outline = roomOutline(room);
  const segs = [];
  const L = +room.length || 4000, D = +room.depth || 3500;
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i], b = outline[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const nx = dz / len, nz = -dx / len; // наружу при CCW
    let wallHint = 'back';
    if (Math.abs(nx) > Math.abs(nz)) wallHint = nx > 0 ? 'right' : 'left';
    else wallHint = nz > 0 ? 'front' : 'back';
    segs.push({
      edgeIndex: i,
      x1: a.x, z1: a.z, x2: b.x, z2: b.z, len,
      midX: (a.x + b.x) / 2, midZ: (a.z + b.z) / 2,
      angle: Math.atan2(dx, dz),
      yaw: Math.atan2(nx, nz),
      nx, nz,
      wall: wallHint,
      letter: edgeLetter(i),
    });
  }
  // silence unused in simple features path
  void L; void D;
  return segs;
}

/** 3D-сегменты стен: три пояса (пол / yRef / потолок) → сложный контур стены. */
export function roomWallSegments3D(room) {
  ensureAdvancedFields(room);
  const floor = room.planFloor?.length >= 3 ? room.planFloor : rectPlan(room.length, room.depth);
  const mid = room.planAtRef;
  const top = room.planCeiling;
  const yRef = +room.yRef || 900;
  const n = floor.length;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = floor[i], b0 = floor[j];
    const aR = mid[i] || a0, bR = mid[j] || b0;
    const aC = top[i] || aR, bC = top[j] || bR;
    const hA = ceilingHeightAt(room, a0.x, a0.z);
    const hB = ceilingHeightAt(room, b0.x, b0.z);
    const dx = b0.x - a0.x, dz = b0.z - a0.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len, nz = -dx / len;
    let wallHint = 'back';
    if (Math.abs(nx) > Math.abs(nz)) wallHint = nx > 0 ? 'right' : 'left';
    else wallHint = nz > 0 ? 'front' : 'back';
    const lenFloor = Math.hypot(b0.x - a0.x, b0.z - a0.z);
    const lenRef = Math.hypot(bR.x - aR.x, bR.z - aR.z);
    const lenCeil = Math.hypot(bC.x - aC.x, bC.z - aC.z);
    segs.push({
      edgeIndex: i,
      a0, b0, aR, bR, a1: aC, b1: bC,
      yRef, hA, hB,
      len: lenFloor, lenFloor, lenRef, lenCeil,
      nx, nz,
      wall: wallHint,
      letter: edgeLetter(i),
      midX: (a0.x + b0.x) / 2,
      midZ: (a0.z + b0.z) / 2,
      complex: Math.abs(lenFloor - lenRef) > 1 || Math.abs(lenRef - lenCeil) > 1
        || Math.hypot(aR.x - a0.x, aR.z - a0.z) > 1
        || Math.hypot(bR.x - b0.x, bR.z - b0.z) > 1
        || Math.hypot(aC.x - aR.x, aC.z - aR.z) > 1
        || Math.hypot(bC.x - bR.x, bC.z - bR.z) > 1,
    });
  }
  return segs;
}

/** AABB контура */
export function roomBounds(room) {
  return roomBoundsFromVerts(roomOutline(room));
}

export function pointInPolygon(x, z, verts) {
  const pts = verts || [];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, zi = pts[i].z;
    const xj = pts[j].x, zj = pts[j].z;
    const intersect = ((zi > z) !== (zj > z))
      && (x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Точка внутри комнаты (с допуском наружу tol мм — для касания стены). */
export function pointInRoom(room, x, z, tol = 2) {
  const outline = roomOutline(room);
  if (outline.length < 3) return true;
  if (pointInPolygon(x, z, outline)) return true;
  if (tol <= 0) return false;
  // допуск: ближайшее ребро
  let best = Infinity;
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i], b = outline[i + 1];
    const d = distToSeg(x, z, a.x, a.z, b.x, b.z);
    if (d < best) best = d;
  }
  // если замкнутый outline дублирует первую точку — ок
  return best <= tol;
}

function distToSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len2 = dx * dx + dz * dz || 1;
  let t = ((px - x1) * dx + (pz - z1) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}

export function footprintInsideRoom(room, cornersXZ, tol = 2) {
  return (cornersXZ || []).every((p) => pointInRoom(room, p.x, p.z, tol));
}

function triangulateFan(verts) {
  const tris = [];
  if (!verts || verts.length < 3) return tris;
  for (let i = 1; i < verts.length - 1; i++) {
    tris.push([verts[0], verts[i], verts[i + 1]]);
  }
  return tris;
}

function barycentric(p, a, b, c) {
  const v0x = b.x - a.x, v0z = b.z - a.z;
  const v1x = c.x - a.x, v1z = c.z - a.z;
  const v2x = p.x - a.x, v2z = p.z - a.z;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) < 1e-9) return null;
  const v = (v2x * v1z - v1x * v2z) / den;
  const w = (v0x * v2z - v2x * v0z) / den;
  const u = 1 - v - w;
  return { u, v, w };
}

function sampleHeight(samples, x, z, fallback) {
  if (!samples?.length) return fallback;
  // exact / nearest for IDW
  let best = Infinity, bh = fallback;
  let wsum = 0, hsum = 0;
  for (const s of samples) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < 1) return +s.h;
    const w = 1 / (d * d);
    wsum += w;
    hsum += w * (+s.h);
    if (d < best) { best = d; bh = +s.h; }
  }
  if (wsum > 0 && samples.length >= 3) return hsum / wsum;
  return bh;
}

export function ceilingHeightAt(room, x, z) {
  if (!room) return 2700;
  const ceil = room.ceiling;
  const flatH = +(ceil?.height ?? room.height ?? 2700);
  if (!isAdvanced(room) || !ceil || ceil.mode === 'flat' || !ceil.samples?.length) {
    return flatH;
  }
  ensureAdvancedFields(room);
  const floor = room.planFloor;
  // высоты в вершинах плана
  const vertH = floor.map((p) => {
    const hit = ceil.samples.find((s) => Math.hypot(s.x - p.x, s.z - p.z) < 2);
    return hit ? +hit.h : sampleHeight(ceil.samples, p.x, p.z, flatH);
  });
  const tris = triangulateFan(floor.map((p, i) => ({ ...p, h: vertH[i] })));
  for (const [a, b, c] of tris) {
    const bc = barycentric({ x, z }, a, b, c);
    if (!bc) continue;
    if (bc.u >= -0.01 && bc.v >= -0.01 && bc.w >= -0.01) {
      return bc.u * a.h + bc.v * b.h + bc.w * c.h;
    }
  }
  return sampleHeight(ceil.samples, x, z, flatH);
}

export function minCeilingHeight(room) {
  if (!isAdvanced(room) || room.ceiling?.mode !== 'samples' || !room.ceiling.samples?.length) {
    return +room.height || +room.ceiling?.height || 2700;
  }
  return Math.min(...room.ceiling.samples.map((s) => +s.h));
}

export function maxCeilingHeight(room) {
  if (!isAdvanced(room) || room.ceiling?.mode !== 'samples' || !room.ceiling.samples?.length) {
    return +room.height || +room.ceiling?.height || 2700;
  }
  return Math.max(...room.ceiling.samples.map((s) => +s.h));
}

/** Длина ребра edgeIndex (advanced) или стены (simple). */
export function edgeLength(room, edgeIndexOrWall) {
  if (isAdvanced(room)) {
    const segs = roomWallSegments(room);
    const idx = +edgeIndexOrWall;
    if (Number.isFinite(idx) && segs[idx]) return segs[idx].len;
    const byWall = segs.filter((s) => s.wall === wallId(edgeIndexOrWall));
    return byWall.reduce((a, s) => a + s.len, 0) || 0;
  }
  const id = wallId(edgeIndexOrWall);
  return id === 'back' || id === 'front' ? +room.length : +room.depth;
}

/** Позиция вдоль ребра: offset от начала ребра, глубина внутрь комнаты. */
export function placeOnEdge(room, edgeIndex, offset, width, depth) {
  ensureAdvancedFields(room);
  const segs = roomWallSegments(room);
  const s = segs[+edgeIndex];
  if (!s) return { x: 0, z: 0, rot: 0 };
  const tx = (s.x2 - s.x1) / s.len;
  const tz = (s.z2 - s.z1) / s.len;
  // внутрь = −наружу
  const ix = -s.nx, iz = -s.nz;
  const o = Math.max(0, +offset || 0);
  const w = +width || 0;
  const d = +depth || 0;
  // угол модуля: локальный +Z наружу от стены? в конструкторе фасад в комнату, зад к стене
  // rot: atan2 вокруг Y — локальный +Z смотрит на фасад (в комнату) → направление ix,iz
  const rot = (Math.atan2(ix, iz) * 180) / Math.PI;
  // задний левый угол модуля у стены
  const x = s.x1 + tx * o + ix * 0;
  const z = s.z1 + tz * o + iz * 0;
  // placeOnWall для back: x=o, z=0 — зад по z=0. Модуль растёт в +local Z в комнату.
  // Для произвольного ребра: origin заднего левого угла
  void w; void d;
  return { x, z, rot: Math.round(rot * 1000) / 1000 };
}

export function newFeature(partial = {}) {
  return {
    id: 'rf' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    kind: 'niche',
    wall: 'back',
    offset: 800,
    width: 900,
    depth: 400,
    name: '',
    ...partial,
  };
}

export function newObstacle(partial = {}) {
  return {
    id: 'ob' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    x: 1000,
    z: 1000,
    w: 400,
    d: 300,
    y0: 2200,
    y1: 2700,
    name: 'Короб',
    color: 0xb0a090,
    rot: 0,
    ...partial,
  };
}

/** Стабильный id для проёма (окно/дверь). */
export function newOpening(partial = {}) {
  return {
    id: 'op' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    wall: 'back',
    type: 'window',
    offset: 500,
    width: 1200,
    sill: 900,
    height: 1400,
    color: null, // null → цвет по типу
    frameColor: 0x8b7355,
    ...partial,
  };
}

export function ensureCtorIds(room) {
  if (!room) return;
  for (const op of room.openings || []) {
    if (!op.id) op.id = 'op' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    if (op.frameColor == null) op.frameColor = 0x8b7355;
  }
  for (const ob of room.obstacles || []) {
    if (!ob.id) ob.id = 'ob' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    if (ob.color == null) ob.color = 0xb0a090;
    if (ob.rot == null) ob.rot = 0;
  }
}

export const featureTitle = (f) => {
  const kind = f.kind === 'jut' ? 'Выступ' : 'Ниша';
  const L = WALL_BY_CODE[wallLetter(f.wall)]?.letter || f.wall;
  return f.name || `${kind} ${L} ${f.width}×${f.depth}`;
};

/** Буква стены по индексу ребра: A, B, C… */
export function edgeLetter(edgeIndex) {
  const i = ((+edgeIndex % 26) + 26) % 26;
  return String.fromCharCode(65 + i);
}

/** Контур плана для высоты y: пол / столешница / потолок. */
export function planForHeight(room, y) {
  ensureAdvancedFields(room);
  const yRef = +room.yRef || 900;
  const H = +room.height || 2700;
  const yy = +y || 0;
  if (yy >= (yRef + H) * 0.5) return room.planCeiling;
  if (yy >= yRef * 0.5) return room.planAtRef;
  return room.planFloor;
}

export function wallLengthAt(room, edgeIndex, y) {
  ensureAdvancedFields(room);
  const plan = planForHeight(room, y);
  const n = plan.length;
  const i = +edgeIndex;
  if (i < 0 || i >= n) return 0;
  const a = plan[i], b = plan[(i + 1) % n];
  return Math.round(Math.hypot(b.x - a.x, b.z - a.z));
}

/** Сводка по стене для UI замерщика. */
export function wallSurvey(room, edgeIndex) {
  ensureAdvancedFields(room);
  const i = +edgeIndex;
  const n = room.planFloor.length;
  const yRef = +room.yRef || 900;
  const H = +room.height || 2700;
  const letter = edgeLetter(i);
  const startV = i;
  const endV = (i + 1) % n;
  const hint = roomWallSegments(room)[i]?.wall || 'back';
  const col = room.wallColors?.[i] ?? room.wallColors?.[hint] ?? room.wallColor ?? 0xf6f4f0;
  return {
    edgeIndex: i,
    letter,
    yRef,
    height: H,
    lengthFloor: wallLengthAt(room, i, 0),
    lengthRef: wallLengthAt(room, i, yRef),
    lengthCeil: wallLengthAt(room, i, H),
    angleStartFloor: cornerAngleDeg(room.planFloor, startV),
    angleStartRef: cornerAngleDeg(room.planAtRef, startV),
    angleStartCeil: cornerAngleDeg(room.planCeiling, startV),
    angleEndFloor: cornerAngleDeg(room.planFloor, endV),
    angleEndRef: cornerAngleDeg(room.planAtRef, endV),
    angleEndCeil: cornerAngleDeg(room.planCeiling, endV),
    startVertex: startV,
    endVertex: endV,
    wallHint: hint,
    colorHex: '#' + ((col >>> 0) & 0xffffff).toString(16).padStart(6, '0'),
  };
}

/**
 * Задать длину стены на высоте y (мм). Начало ребра фиксировано, конец двигается вдоль текущего направления.
 */
export function setWallLengthAt(room, edgeIndex, y, newLen) {
  ensureAdvancedFields(room);
  const plan = planForHeight(room, y);
  const n = plan.length;
  const i = +edgeIndex;
  if (i < 0 || i >= n) return;
  const a = plan[i];
  const b = plan[(i + 1) % n];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const L = Math.max(50, +newLen || len);
  b.x = Math.round(a.x + (dx / len) * L);
  b.z = Math.round(a.z + (dz / len) * L);
  syncSimpleAABB(room);
}

/** Сдвинуть вершину контура на высоте y к целевому внутреннему углу (градусы). */
export function setCornerAngleAt(room, vertexIndex, y, targetDeg) {
  ensureAdvancedFields(room);
  const plan = planForHeight(room, y);
  const i = +vertexIndex;
  const n = plan.length;
  if (i < 0 || i >= n) return;
  const target = +targetDeg || 90;
  for (let iter = 0; iter < 10; iter++) {
    const cur = cornerAngleDeg(plan, i);
    const delta = target - cur;
    if (Math.abs(delta) < 0.08) break;
    const prev = plan[(i - 1 + n) % n];
    const v = plan[i];
    const next = plan[(i + 1) % n];
    const ax = prev.x - v.x, az = prev.z - v.z;
    const bx = next.x - v.x, bz = next.z - v.z;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    let nx = ax / la + bx / lb;
    let nz = az / la + bz / lb;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    const step = ((delta * Math.PI) / 180) * Math.min(la, lb) * 0.45;
    v.x = Math.round(v.x + nx * step);
    v.z = Math.round(v.z + nz * step);
  }
  syncSimpleAABB(room);
}

export function setCornerAngleAtRef(room, vertexIndex, targetDeg) {
  setCornerAngleAt(room, vertexIndex, room.yRef || 900, targetDeg);
}

/** Точка замера потолка: вдоль стены offset, внутрь на distFromWall. */
export function ceilingPointAlongWall(room, edgeIndex, offsetAlong, distFromWall) {
  ensureAdvancedFields(room);
  const segs = roomWallSegments(room);
  const s = segs[+edgeIndex];
  if (!s) return { x: 0, z: 0 };
  const tx = (s.x2 - s.x1) / s.len;
  const tz = (s.z2 - s.z1) / s.len;
  const ix = -s.nx, iz = -s.nz;
  const o = Math.max(0, Math.min(s.len, +offsetAlong || 0));
  const d = Math.max(0, +distFromWall || 0);
  return {
    x: Math.round(s.x1 + tx * o + ix * d),
    z: Math.round(s.z1 + tz * o + iz * d),
  };
}

export function addCeilingSampleAlongWall(room, edgeIndex, offsetAlong, distFromWall, h) {
  ensureAdvancedFields(room);
  const p = ceilingPointAlongWall(room, edgeIndex, offsetAlong, distFromWall);
  room.ceiling.mode = 'samples';
  const hit = room.ceiling.samples.find((s) => Math.hypot(s.x - p.x, s.z - p.z) < 15);
  if (hit) hit.h = Math.round(+h);
  else room.ceiling.samples.push({ x: p.x, z: p.z, h: Math.round(+h) });
  syncSimpleAABB(room);
  return p;
}

/** Ближайшая вершина контура к точке (x,z). */
export function nearestVertexIndex(room, x, z) {
  ensureAdvancedFields(room);
  let best = 0, bd = Infinity;
  room.planFloor.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
