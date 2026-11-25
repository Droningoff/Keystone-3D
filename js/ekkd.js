/**
 * Импорт помещения из бланка eKitchen (.ekkd / XML Scene).
 * Берёт Room (контур, высота, толщина стен), DW (двери/окна) и «Короб» из Objects.
 * Координаты eKKD — метры; у нас — мм. Ось плана: X / Z (вторая координата point).
 */
import { newProject, defaultRoom } from './model.js?v=20261124ap';
import { newOpening, newObstacle, ensureAdvancedFields, syncSimpleAABB } from './roomGeom.js?v=20261110a';

const m2mm = (v) => Math.round((+v || 0) * 1000);

function xmlText(el, sel) {
  if (!el) return '';
  const n = sel ? el.querySelector(sel) : el;
  return (n?.textContent || '').trim();
}

function wallHint(dx, dz) {
  const len = Math.hypot(dx, dz) || 1;
  const nx = dz / len, nz = -dx / len;
  if (Math.abs(nx) > Math.abs(nz)) return nx > 0 ? 'right' : 'left';
  return nz > 0 ? 'front' : 'back';
}

/** Смещение проёма вдоль стены: K в метрах или доля 0..1. */
function openingOffsetMm(k, wallLenMm, widthMm) {
  const kk = +k || 0;
  const asFrac = kk >= 0 && kk <= 1.0001 && kk * wallLenMm + widthMm <= wallLenMm + 80;
  const off = asFrac ? kk * wallLenMm : kk * 1000;
  return Math.max(0, Math.round(off));
}

function parseRoomPoints(roomEl) {
  const ptsEl = [...roomEl.children].find((c) => c.tagName === 'Points');
  if (!ptsEl) return [];
  const pts = [];
  for (const p of ptsEl.children) {
    if (p.tagName !== 'point') continue;
    // контур комнаты: текст "x z"; вложенные point с атрибутами x/y — пропускаем
    if (p.hasAttribute('x')) continue;
    const parts = (p.textContent || '').trim().split(/\s+/).map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    pts.push({ x: m2mm(parts[0]), z: m2mm(parts[1]) });
  }
  // убрать дубль замыкания
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 2) pts.pop();
  }
  return pts;
}

function normalizePlan(pts) {
  if (!pts.length) return pts;
  let x1 = Infinity, z1 = Infinity;
  for (const p of pts) {
    x1 = Math.min(x1, p.x);
    z1 = Math.min(z1, p.z);
  }
  return pts.map((p, i) => ({
    id: `v${i}`,
    x: Math.round(p.x - x1),
    z: Math.round(p.z - z1),
  }));
}

/** Площадь со знаком (CCW > 0 в XZ). */
function signedArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

function parseDw(dwEl, plan) {
  if (!dwEl || plan.length < 3) return [];
  const n = plan.length;
  const openings = [];
  for (const node of dwEl.children) {
    const tag = node.tagName;
    if (tag !== 'Door' && tag !== 'Window') continue;
    const wi = +xmlText(node, 'WallInd');
    const k = +xmlText(node, 'K');
    const wMm = Math.max(100, m2mm(xmlText(node, 'W')));
    const hMm = Math.max(100, m2mm(xmlText(node, 'H') || (tag === 'Door' ? 2.1 : 1.4)));
    const sillMm = tag === 'Window' ? Math.max(0, m2mm(xmlText(node, 'H0'))) : 0;
    const i = ((Math.round(wi) % n) + n) % n;
    const a = plan[i], b = plan[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const offset = openingOffsetMm(k, len, wMm);
    openings.push(newOpening({
      type: tag === 'Door' ? 'door' : 'window',
      edgeIndex: i,
      wall: wallHint(b.x - a.x, b.z - a.z),
      offset,
      width: Math.round(wMm),
      sill: Math.round(sillMm),
      height: Math.round(hMm),
    }));
  }
  return openings;
}

/** Короб / вентшахта из gallery system\korob.wrl */
function parseKorobs(objectsEl, roomH) {
  if (!objectsEl) return [];
  const out = [];
  for (const item of objectsEl.querySelectorAll(':scope > Item, :scope > ADDITIONALITEM')) {
    const url = (xmlText(item, 'URL') || '').replace(/\\/g, '/').toLowerCase();
    const name = xmlText(item, 'ITEMNAME') || 'Короб';
    if (!url.includes('korob') && !/шахт|короб/i.test(name)) continue;
    const tr = (xmlText(item, 'translation') || '0 0 0').trim().split(/\s+/).map(Number);
    const sc = (xmlText(item, 'scale') || '1 1 1').trim().split(/\s+/).map(Number);
    const rotRaw = (xmlText(item, 'rotation') || '0 1 0 0').trim().split(/\s+/).map(Number);
    // VRML: axis + angle; Y-up → угол вокруг (0,1,0) ≈ наш rot
    let rotDeg = 0;
    if (rotRaw.length >= 4) {
      const [ax, ay, az, ang] = rotRaw;
      if (Math.abs(ay) >= Math.abs(ax) && Math.abs(ay) >= Math.abs(az)) {
        rotDeg = Math.round(((ang || 0) * 180) / Math.PI) * Math.sign(ay || 1);
      } else if (Math.abs(az) >= Math.abs(ax)) {
        rotDeg = Math.round(((ang || 0) * 180) / Math.PI) * Math.sign(az || 1);
      }
    }
    const w = Math.max(50, m2mm(sc[0] || 1));
    const h = Math.max(50, m2mm(sc[1] || 1));
    const d = Math.max(50, m2mm(sc[2] || 1));
    const cx = m2mm(tr[0] || 0);
    const cy = m2mm(tr[1] || 0);
    const cz = m2mm(tr[2] || 0);
    let y0 = Math.max(0, Math.round(cy - h / 2));
    let y1 = Math.min(roomH || 2700, Math.round(cy + h / 2));
    if (y1 <= y0) y1 = Math.min(roomH || 2700, y0 + h);
    out.push(newObstacle({
      name: name.trim() || 'Короб',
      x: Math.round(cx - w / 2),
      z: Math.round(cz - d / 2),
      w, d, y0, y1,
      rot: ((rotDeg % 360) + 360) % 360,
      color: 0xb0a090,
    }));
  }
  return out;
}

/**
 * @param {string} xmlTextStr
 * @returns {{ room: object, name: string, orderNum: string, meta: object }}
 */
export function parseEkkd(xmlTextStr) {
  const doc = new DOMParser().parseFromString(xmlTextStr, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Файл не является корректным XML / eKKD');
  }
  // корневой Scene (не вложенный Scene2)
  const root = doc.documentElement?.tagName === 'Scene' ? doc.documentElement : doc.querySelector('Scene');
  const scene = root || doc.documentElement;
  let roomEl = null;
  for (const c of scene.children || []) {
    if (c.tagName === 'Room') { roomEl = c; break; }
  }
  if (!roomEl) roomEl = doc.querySelector('Room');
  if (!roomEl) throw new Error('В файле нет блока <Room>');

  const rawPts = parseRoomPoints(roomEl);
  if (rawPts.length < 3) throw new Error('В <Room><Points> меньше 3 вершин');

  let ox = Infinity, oz = Infinity;
  for (const p of rawPts) {
    ox = Math.min(ox, p.x);
    oz = Math.min(oz, p.z);
  }
  let plan = normalizePlan(rawPts);
  const H = Math.max(2000, m2mm(xmlText(roomEl, 'RoomHeight') || 2.7));
  const thick = Math.max(50, m2mm(xmlText(roomEl, 'RoomTck') || 0.1));

  let dwEl = null;
  for (const c of scene.children || []) {
    if (c.tagName === 'DW') { dwEl = c; break; }
  }
  // WallInd относится к порядку Points в файле — парсим до разворота контура
  let openings = parseDw(dwEl, plan);

  // контур CCW для нормалей стен; рёбра проёмов перенумеровываем
  if (signedArea(plan) < 0) {
    const n = plan.length;
    const [first, ...rest] = plan;
    plan = [first, ...rest.reverse()].map((p, i) => ({ ...p, id: `v${i}` }));
    openings = openings.map((op) => {
      const i = +op.edgeIndex || 0;
      const ni = ((n - i - 1) % n + n) % n;
      const a = plan[ni], b = plan[(ni + 1) % n];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const offset = Math.max(0, Math.round(len - (+op.offset || 0) - (+op.width || 0)));
      return {
        ...op,
        edgeIndex: ni,
        offset,
        wall: wallHint(b.x - a.x, b.z - a.z),
      };
    });
  }

  let objectsEl = null;
  for (const c of scene.children || []) {
    if (c.tagName === 'Objects') { objectsEl = c; break; }
  }
  const obstacles = parseKorobs(objectsEl, H).map((ob) => ({
    ...ob,
    x: Math.round(+ob.x - ox),
    z: Math.round(+ob.z - oz),
  }));

  const xs = plan.map((p) => p.x), zs = plan.map((p) => p.z);
  const room = {
    ...defaultRoom(),
    height: H,
    wallThick: thick,
    length: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs),
    planFloor: plan.map((p) => ({ ...p })),
    planAtRef: plan.map((p) => ({ ...p, id: p.id.replace(/^v/, 'r') })),
    planCeiling: plan.map((p) => ({ ...p, id: p.id.replace(/^v/, 'c') })),
    levels: [
      { id: 'floor', name: 'Пол', h: 0 },
      { id: 'ceil', name: 'Потолок', h: H },
    ],
    ceiling: { mode: 'flat', height: H, samples: [] },
    openings,
    obstacles,
    features: [],
  };
  ensureAdvancedFields(room);
  syncSimpleAABB(room);

  const orderNum = xmlText(scene, 'AdditionalInfo > OrderNum')
    || xmlText(doc, 'OrderNum');
  const customer = xmlText(scene, 'AdditionalInfo > CustomerName')
    || xmlText(doc, 'CustomerName');
  const sceneName = xmlText(scene, 'SceneName') || xmlText(doc, 'SceneName');
  const base = sceneName.split(/[/\\]/).pop()?.replace(/\.ekkd$/i, '') || '';
  const name = orderNum || customer || base || 'Импорт eKKD';

  return {
    room,
    name,
    orderNum,
    meta: {
      customer,
      roomHeightMm: H,
      wallThickMm: thick,
      verts: plan.length,
      openings: openings.length,
      obstacles: obstacles.length,
    },
  };
}

/** Новый проект Keystone из текста .ekkd */
export function projectFromEkkd(xmlTextStr, fileName = '') {
  const parsed = parseEkkd(xmlTextStr);
  const p = newProject();
  p.name = parsed.name || fileName.replace(/\.ekkd$/i, '') || p.name;
  p.room = parsed.room;
  p.modules = [];
  p.fixtures = [];
  p.settings = { ...p.settings, sourceEkkd: fileName || null };
  return { project: p, meta: parsed.meta };
}
