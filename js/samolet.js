// Библиотека модулей «Самолет»: каталог (data/samolet/index.json) и геометрия модулей (data/samolet/m/<n>.json).
// Данные собраны tools/samolet_catalog.py из выгрузки B3D_Json (work/roundtrip/batch_Самолет).
// Геометрия детали: [x1,y1,z1,x2,y2,z2, вид, индекс материала, группа, имя] в СК исходного .b3d.

import * as THREE from 'three';
import { buildHardwareMesh } from './hardware.js?v=20261029j';

const BASE = './data/samolet/';
let index = null;
const byN = new Map();
const geoms = new Map();
const pending = new Map();
const previewCache = new Map();

export async function loadSamoletIndex() {
  if (index) return index;
  const r = await fetch(BASE + 'index.json');
  if (!r.ok) throw new Error('Не найден каталог Самолет: ' + r.status);
  index = await r.json();
  for (const it of index.items) byN.set(it.n, it);
  return index;
}

export const samoletIndex = () => index;
export const libEntry = (n) => byN.get(+n);
export const libGeom = (n) => geoms.get(+n);
export const libGeomTried = (n) => geoms.has(+n);

/** Регистрация пользовательского модуля (n ≥ 100000) в индекс и карту геометрии */
export function registerLibEntry(e) {
  if (!e || e.n == null) return;
  byN.set(+e.n, e);
}
export function unregisterLibEntry(n) {
  n = +n;
  byN.delete(n);
  geoms.delete(n);
  previewCache.delete(n);
  for (const k of [`ghost:${n}`, `hwghost:${n}`, `sensys:${n}`, `sensys3:${n}`, `sensys4:${n}`, `bazis1:${n}`, `bazis2:${n}`]) {
    previewCache.delete(k);
  }
}
export function registerLibGeom(n, g) {
  geoms.set(+n, g || null);
}

export function loadLibGeom(n) {
  n = +n;
  if (geoms.has(n)) return Promise.resolve(geoms.get(n));
  if (pending.has(n)) return pending.get(n);
  // Пользовательские id не лежат в data/samolet/m/
  if (n >= 100000) {
    geoms.set(n, null);
    return Promise.resolve(null);
  }
  const pr = fetch(`${BASE}m/${n}.json?v=20261028m`).then((r) => (r.ok ? r.json() : null)).then((g) => {
    pending.delete(n);
    geoms.set(n, g || null);
    return g;
  }).catch(() => { pending.delete(n); geoms.set(n, null); return null; });
  pending.set(n, pr);
  return pr;
}

export async function ensureLibGeoms(modules) {
  const ns = [...new Set(modules.filter((m) => m.type === 'lib' && m.lib).map((m) => +m.lib.n))];
  await Promise.all(ns.map(loadLibGeom));
}

// Категория каталога → поведение в конструкторе
const KIND = { 'Навесные': 'wall', 'Нижние': 'base', 'Пеналы': 'tall', 'Прочее': 'panel', 'Мои': 'base' };
export const libKind = (e) => KIND[e.cat] || 'base';
export const libRow = (e) => (libKind(e) === 'wall' ? 'wall' : 'floor');
// Ножки нижних модулей и пеналов в Самолете — фурнитура, а не геометрия, поэтому корпус поднимаем на 100 мм
// Антресоли (П-ПД, высота < 900) ставятся над пеналом 2040 на ножках
export const libDefaultElev = (e) => {
  const k = libKind(e);
  if (k === 'tall' && e.h < 900) return 2140;
  return { wall: 1450, base: 100, tall: 100 }[k] ?? 0;
};

/** Поиск позиции каталога: шаблон артикула, ширина, сторона; предпочтение — полная геометрия */
export function findLib(re, w = null, hand = null, decor = 'KF') {
  if (!index) return null;
  const c = index.items.filter((i) => re.test(i.art) && (w == null || Math.round(+i.w) === w) && (hand == null || i.hand === hand));
  const prefer = (pred) => c.find(pred);
  // decor в индексе иногда CC при артикуле *_KF — также смотрим имя
  const decorOk = (i) => !decor || i.decor === decor || (i.art && i.art.includes(decor));
  return prefer((i) => i.geom === 'full' && decorOk(i))
    || prefer((i) => i.geom === 'full')
    || prefer((i) => decorOk(i))
    || c[0] || null;
}

/** Параметры модуля конструктора по позиции каталога */
export function libModuleData(e) {
  const b = e.box;
  return {
    lib: {
      n: e.n, art: e.art, code: e.code, file: e.file, cat: e.cat, decor: e.decor, hand: e.hand, box: b,
      user: !!e.user,
    },
    p: {
      width: Math.round(b[3] - b[0]), height: Math.round(b[4] - b[1]), depth: Math.round(b[5] - b[2]),
      elev: libDefaultElev(e), plinth: 0, row: libRow(e), kind: libKind(e),
    },
  };
}

const hex = (s) => (typeof s === 'number' ? s : parseInt(String(s || '#cccccc').replace('#', ''), 16));

function partStyle(kind, matName, decor, partName = '') {
  const mn = (matName || '').toLowerCase();
  const pn = (partName || '').toLowerCase();
  if (/стекл|прозрач/.test(mn)) return { color: 0xcfe6f0, glass: true };
  if (kind === 'front') return { color: hex(index?.decors?.[decor] ?? '#e8e1d3'), gloss: decor === 'WG' };
  if (kind === 'metal') {
    if (/ножк|цокол|опор/.test(pn)) return { color: 0x2a2c30, metal: true };
    if (/суш|решет|траектор|профиль|поддон|inoxa|корзин/.test(pn)) return { color: 0xd8dde3, metal: true };
    if (/петл|навес|scarpi|аметист/.test(pn)) return { color: 0xa8adb4, metal: true };
    return { color: 0xb8bcc2, metal: true };
  }
  if (kind === 'back' || /двп|хдф|hdf/.test(mn)) return { color: 0xf0eee9 };
  if (kind === 'body') return { color: 0xd4d6d8, metal: /алюм|сталь|метал/.test(mn) };
  return { color: 0xefeeea };
}

const ROLE = { front: 'front', back: 'back', metal: 'metal', body: 'carcass', panel: 'carcass' };

/** Детали lib-модуля в локальных координатах модуля (x от левого края, y от пола с учётом подъёма) */
export function libPanels(m) {
  const g = libGeom(m.lib.n);
  const b = m.lib.box || [0, 0, 0, +m.p.width, +m.p.height, +m.p.depth];
  const elev = +m.p.elev || 0;
  if (!g) {
    return [{
      key: 'box', name: 'Габарит (загрузка…)', role: 'carcass', orient: 'B',
      x1: 0, y1: elev, z1: 0, x2: +m.p.width, y2: elev + +m.p.height, z2: +m.p.depth,
      t: 16, mat: null, butts: [null, null, null, null], color: 0xdddddd, group: 0,
    }];
  }
  const fronts = g.fronts || {};
  // Группа корпуса — та, где лежит самая большая деталь; её не двигаем вместе с ящиками
  let carcGroup = 0, best = -1;
  g.parts.forEach((q) => {
    const v = (q[3] - q[0]) * (q[4] - q[1]) * (q[5] - q[2]);
    if (q[6] !== 'front' && v > best) { best = v; carcGroup = q[8]; }
  });
  const out = [];
  const frontByGroup = new Map();
  g.parts.forEach((q, i) => {
    const [x1, y1, z1, x2, y2, z2, kind, mi, grp, name] = q;
    const matName = g.mats[mi] || '';
    const st = partStyle(kind, matName, m.lib.decor, name);
    const p = {
      key: 'p' + i, name: name || 'Деталь', role: ROLE[kind] || 'carcass', orient: 'B',
      x1: x1 - b[0], x2: x2 - b[0], y1: y1 - b[1] + elev, y2: y2 - b[1] + elev, z1: z1 - b[2], z2: z2 - b[2],
      t: Math.min(x2 - x1, y2 - y1, z2 - z1), mat: null, matName, butts: [null, null, null, null],
      group: grp, ...st,
    };
    let f = fronts[i] ?? fronts[String(i)];
    // Н-ЯЩ: фасады как ящики; любой другой фасад без fronts — дверь (чтобы открывалось)
    if (kind === 'front' && /Н-ЯЩ|ЯЩ/.test(m.lib?.art || '')) f = { t: 'drawer' };
    else if (!f && kind === 'front') {
      const right = /(?:пр\)|right|\(пр)/i.test(m.lib?.art || '') || m.lib?.hand === 'right';
      f = { t: 'door', hinge: right ? 'right' : 'left' };
    }
    if (f) {
      if (f.t === 'drawer') {
        p.openable = 'drawer';
        p.openTravel = Math.max(150, Math.min((z1 - b[2]) - 40, 450));
        if (grp !== carcGroup && !frontByGroup.has(grp)) frontByGroup.set(grp, p.key);
      } else {
        p.openable = 'door';
        p.hinge = f.hinge === 'right' ? 'right' : 'left';
        if (grp !== carcGroup && !frontByGroup.has(grp)) frontByGroup.set(grp, p.key);
      }
    }
    out.push(p);
  });
  // Ящик целиком (короб, направляющие) и детали группы фасада — с фасадом;
  // петли в отдельных группах остаются на корпусе (группа не в frontByGroup)
  for (const p of out) {
    if (p.openable) continue;
    const fk = frontByGroup.get(p.group);
    if (fk) p.follow = fk;
  }
  return out;
}

/** Спецификация lib-модуля: детали и фурнитура из исходной модели */
export function libSpec(m) {
  const g = libGeom(m.lib.n);
  if (!g) return { panels: [], hw: [] };
  const hw = Array.isArray(g.hw) ? g.hw : Object.entries(g.hw || {}).map(([name, qty]) => ({ name, art: '', qty }));
  return { panels: Array.isArray(g.panels) ? g.panels : [], hw };
}

// ---------- Превью: один общий offscreen-рендерер, результат кэшируется как dataURL ----------
let pr = null;

function previewRig() {
  if (pr) return pr;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(280, 280, false);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(0.85, 1.25, 1.1);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.position.set(-1.0, 0.55, 0.4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(0.2, 0.3, -1.0);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100000);
  pr = { renderer, scene, camera };
  return pr;
}

/**
 * Превью каталога «как Базис» (прозрачный режим):
 * полупрозрачный корпус/фасады + рёбра; вся опознанная фурнитура — процедурные меши.
 * Кэш bazis1 — не менять без явного OK пользователя.
 */
export async function libPreview(n) {
  n = +n;
  // bazis2: сильнее прозрачность + чуть крупнее петли на карточке
  const cacheKey = `bazis2:${n}`;
  if (previewCache.has(cacheKey)) return previewCache.get(cacheKey);
  const g = await loadLibGeom(n);
  const e = libEntry(n);
  if (!g || !e) return null;
  const { renderer, scene, camera } = previewRig();
  renderer.setClearColor(0x000000, 0);
  const grp = new THREE.Group();
  const panels = libPanels({ lib: { n, decor: e.decor, box: e.box }, p: { width: e.w, height: e.h, depth: e.d, elev: 0 } });
  const edgeBody = new THREE.LineBasicMaterial({ color: 0x222830, transparent: true, opacity: 0.9 });
  const edgeFront = new THREE.LineBasicMaterial({ color: 0x4a5560, transparent: true, opacity: 0.5 });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xb8c0c8, roughness: 0.25, metalness: 0.9, transparent: false, opacity: 1,
  });
  const HW_RE = /петл|ножк|цокол|навес|scarpi|аметист|полкодерж|tip-?on|типон|ручк|скоб|направл|шарик/;
  const SKIP_RE = /заглуш|крышк|креплен|тело по|профиль|вертикаль|горизонтал|траектор/;
  for (const p of panels) {
    const box = { x1: p.x1, y1: p.y1, z1: p.z1, x2: p.x2, y2: p.y2, z2: p.z2 };
    const w = box.x2 - box.x1, h = box.y2 - box.y1, d = box.z2 - box.z1;
    if (w < 0.5 || h < 0.5 || d < 0.5) continue;
    const isMetal = p.role === 'metal' || p.metal;
    const isFront = p.role === 'front';
    const pnNorm = (p.name || '').toLowerCase().replace(/\r/g, ' ');

    if (isMetal && HW_RE.test(pnNorm) && !SKIP_RE.test(pnNorm)) {
      let drawBox = box;
      if (/ножк|цокол/.test(pnNorm)) {
        if (drawBox.y2 > 0) drawBox = { ...drawBox, y2: 0 };
        if (drawBox.y2 - drawBox.y1 < 40) drawBox = { ...drawBox, y1: -100, y2: 0 };
      }
      const hw = buildHardwareMesh({ ...p, name: pnNorm }, drawBox, metalMat, {
        width: e.w, carcassBottom: 0, hingeBoost: 1.12,
      });
      if (hw) { grp.add(hw); continue; }
    }
    // служебные траектории/профили Базиса — не кубами
    if (isMetal && SKIP_RE.test(pnNorm)) continue;

    // Базис transparent: корпус едва виден, фасад почти стекло, фурнитура непрозрачна
    let opacity = 0.14;
    if (isFront) opacity = 0.07;
    else if (p.role === 'back') opacity = 0.11;
    else if (isMetal) opacity = 0.28;
    else if (p.role === 'shelf' || /полк/.test(pnNorm)) opacity = 0.16;

    const mat = new THREE.MeshStandardMaterial({
      color: isMetal ? (p.color || 0xb0b6be) : isFront ? 0xf2f5f8 : (p.color || 0xdce1e6),
      roughness: isMetal ? 0.4 : 0.9,
      metalness: isMetal ? 0.55 : 0,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, (box.z1 + box.z2) / 2);
    grp.add(mesh);
    const em = isFront ? edgeFront : edgeBody;
    const ed = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 12), em);
    ed.position.copy(mesh.position);
    grp.add(ed);
  }
  scene.add(grp);
  const bbox = new THREE.Box3().setFromObject(grp);
  const c = bbox.getCenter(new THREE.Vector3()), s = bbox.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z) * 0.58 + 1;
  const dist = r / Math.sin((camera.fov * Math.PI) / 360);
  // ракурс ближе к изометрии Базиса
  camera.position.set(c.x + dist * 0.62, c.y + dist * 0.42, c.z + dist * 0.72);
  camera.lookAt(c);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(grp);
  grp.traverse((o) => {
    o.geometry?.dispose();
    if (o.material && o.material !== edgeBody && o.material !== edgeFront && o.material !== metalMat) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
  edgeBody.dispose(); edgeFront.dispose(); metalMat.dispose();
  previewCache.set(cacheKey, url);
  return url;
}

export function clearLibPreviewCache() {
  previewCache.clear();
}
