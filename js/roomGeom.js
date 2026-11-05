// Контур комнаты с нишами (наружу) и выступами (внутрь).
// Стены: back z=0, right x=L, front z=D, left x=0.

import { wallId, WALL_BY_CODE, wallLetter } from './walls.js';

/** Нормаль наружу и направление вдоль стены (единичные) */
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
    const sign = f.kind === 'niche' ? 1 : -1; // наружу / внутрь
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

/** Замкнутый контур пола CCW: back → right → front → left */
export function roomOutline(room) {
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
  // замкнуть
  if (out.length && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) > 0.5) {
    out.push({ ...out[0] });
  }
  return out;
}

/** Отрезки стен для мешей: {x1,z1,x2,z2, wallHint, len} */
export function roomWallSegments(room) {
  const outline = roomOutline(room);
  const segs = [];
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i], b = outline[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    // подсказка стены по доминирующей оси и положению
    let wallHint = 'back';
    if (Math.abs(dx) >= Math.abs(dz)) wallHint = dz <= 0 ? (a.z + b.z < room.depth ? 'back' : 'front') : 'front';
    else wallHint = dx >= 0 ? 'right' : 'left';
    // точнее: нормаль внутрь комнаты ≈ перпендикуляр влево при обходе CCW → наружу вправо
    const nx = dz / len, nz = -dx / len; // наружу при CCW
    if (Math.abs(nx) > Math.abs(nz)) wallHint = nx > 0 ? 'right' : 'left';
    else wallHint = nz > 0 ? 'front' : 'back';
    segs.push({
      x1: a.x, z1: a.z, x2: b.x, z2: b.z, len,
      midX: (a.x + b.x) / 2, midZ: (a.z + b.z) / 2,
      angle: Math.atan2(dx, dz), // для плоскости: смотрит вдоль? используем atan2(dx,dz) осторожно
      yaw: Math.atan2(nx, nz), // поворот плоскости стены: нормаль наружу в +local Z after rot?
      nx, nz,
      wall: wallHint,
      letter: wallLetter(wallHint),
    });
  }
  return segs;
}

/** AABB контура */
export function roomBounds(room) {
  const o = roomOutline(room);
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  for (const p of o) {
    x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x);
    z1 = Math.min(z1, p.z); z2 = Math.max(z2, p.z);
  }
  return { x1, z1, x2, z2, width: x2 - x1, depth: z2 - z1 };
}

export function newFeature(partial = {}) {
  return {
    id: 'rf' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    kind: 'niche', // niche | jut
    wall: 'back',
    offset: 800,
    width: 900,
    depth: 400,
    name: '',
    ...partial,
  };
}

export const featureTitle = (f) => {
  const kind = f.kind === 'jut' ? 'Выступ' : 'Ниша';
  const L = WALL_BY_CODE[wallLetter(f.wall)]?.letter || f.wall;
  return f.name || `${kind} ${L} ${f.width}×${f.depth}`;
};
