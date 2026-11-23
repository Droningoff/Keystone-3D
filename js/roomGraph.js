// Графовая модель помещения для гибкого рисования стен
// vertices: [{id, x, z}]
// edges: [{id, from, to, len, lock}]
// Углы вычисляются динамически

const RAD = Math.PI / 180;
export const norm360 = (a) => ((a % 360) + 360) % 360;
const r1 = (v) => Math.round(v * 10) / 10;

let nextVertexId = 0;
let nextEdgeId = 0;

function genVertexId() { return `v${nextVertexId++}`; }
function genEdgeId() { return `e${nextEdgeId++}`; }

/** Пустой граф */
export function emptyGraph(x0 = 0, z0 = 0) {
  const id = genVertexId();
  return { vertices: [{ id, x: x0, z: z0 }], edges: [] };
}

/** Получить точку по id */
export function getVertex(g, id) {
  return g.vertices.find(v => v.id === id);
}

/** Получить все рёбра у вершины */
export function edgesAtVertex(g, vertexId) {
  return g.edges.filter(e => e.from === vertexId || e.to === vertexId);
}

/** Направление ребра от вершины (в градусах) */
export function edgeDirection(g, edge, fromVertex) {
  const from = getVertex(g, fromVertex);
  const toId = edge.from === fromVertex ? edge.to : edge.from;
  const to = getVertex(g, toId);
  if (!from || !to) return 0;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return norm360(Math.atan2(dz, dx) / RAD);
}

/** Длина ребра (вычисляется из координат) */
export function edgeLength(g, edge) {
  const from = getVertex(g, edge.from);
  const to = getVertex(g, edge.to);
  if (!from || !to) return edge.len || 0;
  return Math.round(Math.hypot(to.x - from.x, to.z - from.z));
}

/** Угол между двумя рёбрами у общей вершины (в градусах) — один из двух секторов */
export function angleBetweenEdges(g, edge1, edge2, atVertex) {
  const h1 = edgeDirection(g, edge1, atVertex);
  const h2 = edgeDirection(g, edge2, atVertex);
  return norm360(180 - (h2 - h1));
}

/**
 * Угол комнаты у вершины между двумя стенами + бисектриса для подписи.
 * Берётся сектор, обращённый к центроиду (внутрь помещения), а не «внешний» 360−α.
 */
export function roomCornerAngle(g, edge1, edge2, atVertex) {
  const v = getVertex(g, atVertex);
  if (!v) return { ang: 90, bis: 0 };
  const h1 = edgeDirection(g, edge1, atVertex);
  const h2 = edgeDirection(g, edge2, atVertex);
  const sector1 = norm360(h2 - h1) || 360;
  const sector2 = 360 - sector1;
  const bis1 = norm360(h1 + sector1 / 2);
  const bis2 = norm360(h1 + sector1 + sector2 / 2);
  const c = graphCentroid(g);
  const toC = norm360(Math.atan2(c.z - v.z, c.x - v.x) / RAD);
  const diff = (a, b) => Math.min(norm360(a - b), norm360(b - a));
  const use1 = diff(toC, bis1) <= diff(toC, bis2);
  const ang = use1 ? sector1 : sector2;
  return { ang: ang >= 359.5 ? 0 : r1(ang), bis: use1 ? bis1 : bis2 };
}

/** Переместить вершину (с проверкой фиксации рёбер) */
export function moveVertex(g, vertexId, x, z) {
  const v = getVertex(g, vertexId);
  if (!v) return false;
  const at = edgesAtVertex(g, vertexId);
  if (at.some((e) => e.lock)) return false;
  v.x = x;
  v.z = z;
  at.forEach((e) => { e.len = edgeLength(g, e); });
  return true;
}

/** Абсолютное направление ребра from→to */
export function edgeHeading(g, edge) {
  const from = getVertex(g, edge.from);
  const to = getVertex(g, edge.to);
  if (!from || !to) return 0;
  return norm360(Math.atan2(to.z - from.z, to.x - from.x) / RAD);
}

/**
 * Задать направление ухода ребра от pivotId (поворачивает ветку вокруг pivot).
 */
export function setEdgeLeaveHeading(g, edgeId, pivotId, headingDeg) {
  const edge = g.edges.find((e) => e.id === edgeId);
  if (!edge || edge.lock) return false;
  if (edge.from !== pivotId && edge.to !== pivotId) return false;
  // Ориентируем ребро: from = pivot, чтобы setEdgeHeading вращал нужную ветку
  if (edge.from !== pivotId) {
    const t = edge.from;
    edge.from = edge.to;
    edge.to = t;
  }
  return setEdgeHeading(g, edgeId, headingDeg);
}

/**
 * Внутренний угол у pivot между refEdge и edge → выставить угол newAng (со стороны комнаты).
 */
export function setEdgeInteriorAngle(g, edgeId, refEdgeId, pivotId, newAng) {
  const edge = g.edges.find((e) => e.id === edgeId);
  const ref = g.edges.find((e) => e.id === refEdgeId);
  const pivot = getVertex(g, pivotId);
  if (!edge || !ref || !pivot || edge.lock) return false;
  const a = Math.min(359, Math.max(1, +newAng || 90));
  const leaveRef = edgeDirection(g, ref, pivotId);
  const c = graphCentroid(g);
  const toC = norm360(Math.atan2(c.z - pivot.z, c.x - pivot.x) / RAD);
  const diff = (x, y) => Math.min(norm360(x - y), norm360(y - x));
  let best = norm360(leaveRef + a);
  let bestDiff = Infinity;
  for (const sign of [1, -1]) {
    const leaveH = norm360(leaveRef + sign * a);
    const bis = norm360(leaveRef + sign * (a / 2));
    const d = diff(bis, toC);
    if (d < bestDiff) { bestDiff = d; best = leaveH; }
  }
  return setEdgeLeaveHeading(g, edgeId, pivotId, best);
}

/**
 * Описание угла стены для таблицы: первая / одиночная — направление;
 * иначе — внутренний угол к соседней стене у общего угла.
 */
export function wallTableAngle(g, edge) {
  const heading = edgeHeading(g, edge);
  for (const vid of [edge.from, edge.to]) {
    const others = edgesAtVertex(g, vid).filter((e) => e.id !== edge.id);
    if (!others.length) continue;
    // Берём самую «раннюю» соседнюю стену как опорную
    const ref = others.slice().sort((a, b) => g.edges.indexOf(a) - g.edges.indexOf(b))[0];
    const { ang } = roomCornerAngle(g, ref, edge, vid);
    return { kind: 'int', value: ang, pivot: vid, refId: ref.id, heading };
  }
  return { kind: 'dir', value: r1(heading), pivot: edge.from, refId: null, heading };
}

/** Добавить новую вершину */
export function addVertex(g, x, z) {
  const id = genVertexId();
  g.vertices.push({ id, x, z });
  return id;
}

/** Добавить ребро между вершинами */
export function addEdge(g, fromId, toId, lock = false) {
  const from = getVertex(g, fromId);
  const to = getVertex(g, toId);
  if (!from || !to) return null;
  const len = Math.round(Math.hypot(to.x - from.x, to.z - from.z));
  const id = genEdgeId();
  const edge = { id, from: fromId, to: toId, len, lock };
  g.edges.push(edge);
  return edge;
}

/** Удалить последнее ребро и связанную вершину (если она больше не используется) */
export function undoLastEdge(g) {
  if (!g.edges.length) return;
  const lastEdge = g.edges.pop();
  // Проверяем, используются ли вершины в других рёбрах
  [lastEdge.from, lastEdge.to].forEach(vId => {
    if (vId === g.vertices[0]?.id) return; // первую вершину не удаляем
    const used = g.edges.some(e => e.from === vId || e.to === vId);
    if (!used) {
      g.vertices = g.vertices.filter(v => v.id !== vId);
    }
  });
}

/** Массив точек для совместимости со старым кодом */
export function graphToPoints(g) {
  if (!g.vertices.length) return [];
  // Сортируем вершины по порядку обхода (пока просто по id)
  return g.vertices.map(v => ({ x: v.x, z: v.z, id: v.id }));
}

/** Конвертация из старой модели chain в граф */
export function chainToGraph(chain) {
  if (!chain || !chain.walls?.length) {
    return emptyGraph(chain?.x0 || 0, chain?.z0 || 0);
  }
  
  const g = { vertices: [], edges: [] };
  let x = chain.x0 || 0;
  let z = chain.z0 || 0;
  let h = chain.dir || 0;
  
  // Стартовая вершина
  const startId = genVertexId();
  g.vertices.push({ id: startId, x, z });
  
  let prevId = startId;
  chain.walls.forEach((wall, i) => {
    if (i > 0) h += 180 - (wall.ang || 180);
    x += Math.cos(h * RAD) * wall.len;
    z += Math.sin(h * RAD) * wall.len;
    
    const vId = genVertexId();
    g.vertices.push({ id: vId, x: Math.round(x), z: Math.round(z) });
    
    const eId = genEdgeId();
    g.edges.push({
      id: eId,
      from: prevId,
      to: vId,
      len: Math.round(wall.len),
      lock: !!wall.lock
    });
    
    prevId = vId;
  });

  // Замыкающая стена: в chain она не в walls, а флаг closed (как в chainSegments)
  if (chain.closed && g.vertices.length >= 3) {
    const first = g.vertices[0];
    const last = g.vertices[g.vertices.length - 1];
    const len = Math.round(Math.hypot(first.x - last.x, first.z - last.z));
    if (len > 10) {
      g.edges.push({
        id: genEdgeId(),
        from: last.id,
        to: first.id,
        len,
        lock: false,
      });
    }
  }
  
  return g;
}

/** Конвертация из графа в старую модель chain (для совместимости) */
export function graphToChain(g) {
  if (!g.vertices.length) return { x0: 0, z0: 0, dir: 0, closed: false, walls: [] };
  
  const start = g.vertices[0];
  const x0 = start.x;
  const z0 = start.z;
  
  if (!g.edges.length) {
    return { x0, z0, dir: 0, closed: false, walls: [] };
  }
  
  // Строим цепочку рёбер (пока предполагаем последовательный порядок)
  const walls = [];
  let currentId = start.id;
  let prevH = null;
  
  const usedEdges = new Set();
  
  while (true) {
    const nextEdge = g.edges.find(e => 
      !usedEdges.has(e.id) && (e.from === currentId || e.to === currentId)
    );
    
    if (!nextEdge) break;
    usedEdges.add(nextEdge.id);
    
    const nextId = nextEdge.from === currentId ? nextEdge.to : nextEdge.from;
    const next = getVertex(g, nextId);
    if (!next) break;
    
    const prev = getVertex(g, currentId);
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const h = norm360(Math.atan2(dz, dx) / RAD);
    
    if (prevH === null) {
      // Первая стена
      walls.push({ len: nextEdge.len, ang: 180, lock: nextEdge.lock });
    } else {
      const ang = norm360(180 - (h - prevH));
      walls.push({ len: nextEdge.len, ang: r1(ang), lock: nextEdge.lock });
    }
    
    prevH = h;
    currentId = nextId;
  }
  
  const dir = g.edges.length > 0 ? edgeDirection(g, g.edges[0], start.id) : 0;
  
  return { x0, z0, dir: r1(dir), closed: false, walls };
}

/** BBox графа */
export function graphBBox(g) {
  if (!g.vertices.length) return { x1: 0, z1: 0, x2: 1000, z2: 1000 };
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  g.vertices.forEach(v => {
    x1 = Math.min(x1, v.x);
    z1 = Math.min(z1, v.z);
    x2 = Math.max(x2, v.x);
    z2 = Math.max(z2, v.z);
  });
  return { x1, z1, x2, z2 };
}

/** Центроид вершин */
export function graphCentroid(g) {
  if (!g.vertices.length) return { x: 0, z: 0 };
  let x = 0, z = 0;
  g.vertices.forEach((v) => { x += v.x; z += v.z; });
  return { x: x / g.vertices.length, z: z / g.vertices.length };
}

/**
 * Нормаль ребра «наружу» (от центроида). flip=-1 — инверсия стороны комнаты.
 * Формула как в roomPlan: (dz,-dx) при обходе.
 */
export function edgeOutwardNormal(g, edge, flip = 1) {
  const from = getVertex(g, edge.from);
  const to = getVertex(g, edge.to);
  if (!from || !to) return { nx: 0, nz: -1 };
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  let nx = dz / len, nz = -dx / len;
  if (g.vertices.length >= 2) {
    const c = graphCentroid(g);
    const mx = (from.x + to.x) / 2, mz = (from.z + to.z) / 2;
    // если нормаль смотрит к центроиду — это внутрь, разворачиваем
    if (nx * (c.x - mx) + nz * (c.z - mz) > 0) { nx = -nx; nz = -nz; }
  }
  return { nx: nx * flip, nz: nz * flip };
}

/** Вершины, достижимые от rootId, не переходя через excludeEdgeId */
export function reachableFrom(g, rootId, excludeEdgeId = null) {
  const seen = new Set([rootId]);
  const q = [rootId];
  while (q.length) {
    const id = q.pop();
    for (const e of edgesAtVertex(g, id)) {
      if (e.id === excludeEdgeId) continue;
      const next = e.from === id ? e.to : e.from;
      if (seen.has(next)) continue;
      seen.add(next);
      q.push(next);
    }
  }
  return seen;
}

/** Пересчитать len у всех рёбер из координат */
export function syncEdgeLengths(g) {
  g.edges.forEach((e) => { e.len = edgeLength(g, e); });
}

/** Изменить длину ребра: from фиксирован, ветка to сдвигается */
export function setEdgeLength(g, edgeId, newLen) {
  const edge = g.edges.find((e) => e.id === edgeId);
  if (!edge || edge.lock) return false;
  const len = Math.max(10, Math.round(newLen));
  const from = getVertex(g, edge.from);
  const to = getVertex(g, edge.to);
  if (!from || !to) return false;
  const dx = to.x - from.x, dz = to.z - from.z;
  const cur = Math.hypot(dx, dz) || 1;
  const tx = dx / cur, tz = dz / cur;
  const nx = from.x + tx * len, nz = from.z + tz * len;
  const ddx = nx - to.x, ddz = nz - to.z;
  for (const id of reachableFrom(g, edge.to, edge.id)) {
    const v = getVertex(g, id);
    if (v) { v.x = Math.round(v.x + ddx); v.z = Math.round(v.z + ddz); }
  }
  syncEdgeLengths(g);
  return true;
}

/** Задать абсолютное направление ребра (°) — поворот ветки to вокруг from */
export function setEdgeHeading(g, edgeId, headingDeg) {
  const edge = g.edges.find((e) => e.id === edgeId);
  if (!edge || edge.lock) return false;
  const from = getVertex(g, edge.from);
  const to = getVertex(g, edge.to);
  if (!from || !to) return false;
  const old = Math.atan2(to.z - from.z, to.x - from.x);
  const next = (norm360(headingDeg) * Math.PI) / 180;
  const d = next - old;
  const cos = Math.cos(d), sin = Math.sin(d);
  for (const id of reachableFrom(g, edge.to, edge.id)) {
    const v = getVertex(g, id);
    if (!v) continue;
    const rx = v.x - from.x, rz = v.z - from.z;
    v.x = Math.round(from.x + rx * cos - rz * sin);
    v.z = Math.round(from.z + rx * sin + rz * cos);
  }
  syncEdgeLengths(g);
  return true;
}

/** Угол между направлениями (как в roomPlan.angBetween) */
export function angBetween(fromDeg, toDeg) {
  return norm360(180 - (toDeg - fromDeg));
}

/** Смежность: id → [{ to, edgeId }] */
function adjacency(g) {
  const adj = new Map();
  g.vertices.forEach((v) => adj.set(v.id, []));
  g.edges.forEach((e) => {
    adj.get(e.from)?.push({ to: e.to, edgeId: e.id });
    adj.get(e.to)?.push({ to: e.from, edgeId: e.id });
  });
  return adj;
}

/**
 * Упорядоченные вершины контура (полилиния по рёбрам).
 * Для дерева стен — путь от листа к листу; для цикла — обход кольца без дубля старта.
 */
export function graphToOrderedVertices(g) {
  if (!g.vertices.length) return [];
  if (!g.edges.length) return [{ ...g.vertices[0] }];
  const adj = adjacency(g);
  const deg = (id) => adj.get(id)?.length || 0;
  const leaves = g.vertices.filter((v) => deg(v.id) === 1);
  const startId = leaves[0]?.id || g.vertices[0].id;

  const out = [];
  const used = new Set();
  let cur = startId;
  const start = getVertex(g, cur);
  out.push({ id: start.id, x: start.x, z: start.z });

  while (used.size < g.edges.length) {
    const next = (adj.get(cur) || []).find((n) => !used.has(n.edgeId));
    if (!next) break;
    used.add(next.edgeId);
    cur = next.to;
    const v = getVertex(g, cur);
    if (!v) break;
    if (cur === startId && used.size === g.edges.length) break;
    out.push({ id: v.id, x: v.x, z: v.z });
  }
  return out;
}

/** Упорядоченные точки контура (полилиния по рёбрам). */
export function graphToOrderedPoints(g) {
  return graphToOrderedVertices(g).map((v) => ({ x: v.x, z: v.z }));
}

/** Глубокая копия графа */
export function cloneGraph(g) {
  return JSON.parse(JSON.stringify(g || { vertices: [], edges: [] }));
}

/** Совпадает ли топология (id вершин/рёбер и концы рёбер) */
export function sameGraphTopology(a, b) {
  if (!a || !b) return false;
  if (a.vertices.length !== b.vertices.length || a.edges.length !== b.edges.length) return false;
  const av = new Set(a.vertices.map((v) => v.id));
  if (b.vertices.some((v) => !av.has(v.id))) return false;
  const ae = new Map(a.edges.map((e) => [e.id, e]));
  return b.edges.every((e) => {
    const x = ae.get(e.id);
    return x && ((x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from));
  });
}

/**
 * Подтянуть топологию уровня к эталонному (пол): те же id, координаты старых вершин сохраняются.
 */
export function syncGraphTopology(target, template) {
  if (!template?.edges?.length) return { vertices: [], edges: [] };
  if (sameGraphTopology(target, template)) return target || cloneGraph(template);
  const oldPos = new Map((target?.vertices || []).map((v) => [v.id, v]));
  const oldLock = new Map((target?.edges || []).map((e) => [e.id, e.lock]));
  const g = cloneGraph(template);
  g.vertices.forEach((v) => {
    const o = oldPos.get(v.id);
    if (o) { v.x = o.x; v.z = o.z; }
  });
  g.edges.forEach((e) => {
    if (oldLock.has(e.id)) e.lock = !!oldLock.get(e.id);
    else e.lock = false;
    e.len = edgeLength(g, e);
  });
  return g;
}

/** Граф — замкнутый контур (цикл, покрывающий все рёбра) */
export function isGraphClosed(g) {
  if (g.edges.length < 3 || g.vertices.length < 3) return false;
  if (g.edges.length !== g.vertices.length) return false;
  const adj = adjacency(g);
  return g.vertices.every((v) => (adj.get(v.id) || []).length === 2);
}
