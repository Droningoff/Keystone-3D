// Цепочка стен от стартовой точки (для редактора «план сверху»).
// chain = { x0, z0, dir, closed, walls: [{ len, ang, lock }] }
//   dir  — направление первой стены, град (0 = +X, 90 = +Z);
//   ang  — угол между предыдущей стеной и этой со стороны комнаты (90 — прямой, 180 — продолжение);
//          у первой стены не используется;
//   lock — стена зафиксирована: длину и угол не меняют ни таблица, ни перетаскивание.
// Комната лежит справа по ходу обхода (ось Z на плане вниз) — как у контура planFloor.
// У замкнутой цепочки стена от последней точки к старту строится автоматически.

import { openChainFloorExtra } from './roomGeom.js?v=20261110a';

const RAD = Math.PI / 180;
export const norm360 = (a) => ((a % 360) + 360) % 360;
const r1 = (v) => Math.round(v * 10) / 10;

export function emptyChain(x0 = 0, z0 = 0) {
  return { x0, z0, dir: 0, closed: false, walls: [] };
}

export function chainPoints(c) {
  const pts = [{ x: +c.x0 || 0, z: +c.z0 || 0 }];
  let h = +c.dir || 0;
  (c.walls || []).forEach((w, i) => {
    if (i > 0) h += 180 - (+w.ang || 180);
    const p = pts[pts.length - 1];
    pts.push({ x: p.x + Math.cos(h * RAD) * +w.len, z: p.z + Math.sin(h * RAD) * +w.len });
  });
  return pts;
}

/** Направления стен, град */
export function chainHeadings(c) {
  const hs = [];
  let h = +c.dir || 0;
  (c.walls || []).forEach((w, i) => {
    if (i > 0) h += 180 - (+w.ang || 180);
    hs.push(norm360(h));
  });
  return hs;
}

/** Угол между стенами с направлениями hPrev → h (со стороны комнаты) */
export const angBetween = (hPrev, h) => norm360(180 - (h - hPrev));

export function chainFromPoints(pts, closed = false, locks = []) {
  const walls = [];
  let prevH = 0, dir = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
    const h = Math.atan2(dz, dx) / RAD;
    if (i === 0) dir = h;
    walls.push({ len: Math.round(Math.hypot(dx, dz)), ang: i === 0 ? 180 : r1(angBetween(prevH, h)), lock: !!locks[i] });
    prevH = h;
  }
  return { x0: pts[0].x, z0: pts[0].z, dir: r1(norm360(dir)), closed: !!closed, walls };
}

export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

/** Обход в обратную сторону — комната переходит на другую сторону стен */
export function reverseChain(c) {
  return chainFromPoints(chainPoints(c).reverse(), c.closed, c.walls.map((w) => w.lock).reverse());
}

/** Стены нарисованы против часовой — комната оказалась бы снаружи */
export const isChainReversed = (c) => {
  const pts = chainPoints(c);
  return pts.length >= 3 && signedArea(pts) < 0;
};

function mkSeg(a, b, i, closing) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return {
    x1: a.x, z1: a.z, x2: b.x, z2: b.z, len,
    midX: (a.x + b.x) / 2, midZ: (a.z + b.z) / 2,
    tx: dx / len, tz: dz / len, nx: dz / len, nz: -dx / len, // nx/nz — наружу
    index: i, letter: String.fromCharCode(65 + (i % 26)), closing,
  };
}

/** Отрезки стен (у замкнутой — с замыкающей) */
export function chainSegments(c) {
  const pts = chainPoints(c);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push(mkSeg(pts[i], pts[i + 1], i, false));
  const a = pts[pts.length - 1], b = pts[0];
  if (c.closed && c.walls.length >= 2 && Math.hypot(a.x - b.x, a.z - b.z) > 1) {
    segs.push(mkSeg(a, b, c.walls.length, true));
  }
  return segs;
}

/** Контур пола: замкнутая — по точкам, открытая — с достройкой как в помещении (openChainFloorExtra) */
export function chainFloor(c) {
  const pts = chainPoints(c);
  if (pts.length < 2) return [];
  return c.closed ? pts : [...pts, ...openChainFloorExtra(pts)];
}

export function bboxOf(pts) {
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  for (const p of pts) {
    x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x);
    z1 = Math.min(z1, p.z); z2 = Math.max(z2, p.z);
  }
  return { x1, z1, x2, z2, width: x2 - x1, depth: z2 - z1 };
}

/**
 * Поставить предмет шириной width к стене seg ({x1,z1,x2,z2,len,nx,nz}) по точке (x,z):
 * задняя сторона на стене, local +X вдоль стены, local +Z в комнату.
 */
export function wallPose(seg, x, z, width = 0) {
  const tx = (seg.x2 - seg.x1) / seg.len, tz = (seg.z2 - seg.z1) / seg.len;
  const t = (x - seg.x1) * tx + (z - seg.z1) * tz;
  const s0 = Math.max(0, Math.min(Math.max(0, seg.len - width), t - width / 2));
  const rot = r1(norm360(Math.atan2(-seg.nx, -seg.nz) / RAD));
  return { x: seg.x1 + tx * s0, z: seg.z1 + tz * s0, rot };
}
