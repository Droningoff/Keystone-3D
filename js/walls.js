// Именование стен латинскими буквами (вид сверху).
// A — задняя (z=0), B — правая (x=L), C — передняя (z=D), D — левая (x=0).
// По часовой стрелке: A → B → C → D.

export const WALL_ORDER = ['A', 'B', 'C', 'D'];

export const WALL_BY_CODE = {
  A: { id: 'back',  letter: 'A', title: 'A — задняя',  axis: 'x', from: 'left' },
  B: { id: 'right', letter: 'B', title: 'B — правая',  axis: 'z', from: 'back' },
  C: { id: 'front', letter: 'C', title: 'C — передняя', axis: 'x', from: 'right' },
  D: { id: 'left',  letter: 'D', title: 'D — левая',   axis: 'z', from: 'front' },
};

export const WALL_BY_ID = Object.fromEntries(
  Object.values(WALL_BY_CODE).map((w) => [w.id, w]),
);

export const wallLetter = (idOrLetter) => {
  if (WALL_BY_CODE[idOrLetter]) return idOrLetter;
  return WALL_BY_ID[idOrLetter]?.letter || idOrLetter;
};

export const wallId = (idOrLetter) => {
  if (WALL_BY_ID[idOrLetter]) return idOrLetter;
  return WALL_BY_CODE[idOrLetter]?.id || idOrLetter;
};

export const wallTitle = (idOrLetter) => {
  const L = wallLetter(idOrLetter);
  return WALL_BY_CODE[L]?.title || String(idOrLetter);
};

/** Длина стены в мм */
export function wallLength(room, idOrLetter) {
  const id = wallId(idOrLetter);
  return id === 'back' || id === 'front' ? +room.length : +room.depth;
}

/** Углы комнаты: пара стен (буквы), сходящихся в углу */
export const CORNERS = {
  'A-D': { walls: ['A', 'D'], title: 'угол A–D (задняя–левая)', side: 'left' },
  'A-B': { walls: ['A', 'B'], title: 'угол A–B (задняя–правая)', side: 'right' },
  'C-D': { walls: ['C', 'D'], title: 'угол C–D (передняя–левая)', side: 'left' },
  'C-B': { walls: ['C', 'B'], title: 'угол C–B (передняя–правая)', side: 'right' },
};

/**
 * Позиция модуля у стены: offset — от начала стены (WALL_BY_CODE.from), мм;
 * width/depth — габарит модуля в плане.
 */
export function placeOnWall(room, idOrLetter, offset, width, depth) {
  const L = +room.length, D = +room.depth;
  const id = wallId(idOrLetter);
  const o = Math.max(0, +offset || 0);
  const w = +width || 0, d = +depth || 0;
  switch (id) {
    case 'back':  return { x: o, z: 0, rot: 0 };
    case 'right': return { x: L - d, z: o, rot: 270 };
    case 'front': return { x: L - o - w, z: D - d, rot: 180 };
    // rot=90: локальный +X → −Z, поэтому начало (offset) — передний край модуля (больший z)
    case 'left':  return { x: 0, z: D - o, rot: 90 };
    default:      return { x: o, z: 0, rot: 0 };
  }
}
