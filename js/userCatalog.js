// Пользовательский каталог изделий (.b3d): добавление, архив, удаление.
// Метаданные и габаритная геометрия — в localStorage; в Базис уходит исходный .b3d с фурнитурой.
// ID: n >= USER_N0, чтобы не пересекаться с каталогом Самолет.

import { registerLibGeom, registerLibEntry, unregisterLibEntry } from './samolet.js?v=20261029j';

export const USER_N0 = 100000;
const STORE = 'furniture-user-catalog-v1';
const ARCHIVE_STORE = 'furniture-catalog-archive-v1'; // скрытые позиции Самолета (n)

const SERIES = [
  ['ВКБС', 'Нижние'], ['ФММ', 'Прочее'], ['ГВ-КУ', 'Навесные'], ['ГВ-КВ', 'Навесные'], ['ГВ-К', 'Навесные'],
  ['В-КУ', 'Навесные'], ['В-КВ', 'Навесные'], ['В-ФД', 'Навесные'], ['В-К', 'Навесные'],
  ['Н-КУ', 'Нижние'], ['Н-КЗ', 'Нижние'], ['Н-КМ', 'Нижние'], ['Н-ЯЩ', 'Нижние'], ['Н-КБ', 'Нижние'],
  ['Н-ДО', 'Нижние'], ['Н-ХД', 'Пеналы'], ['П-', 'Пеналы'],
];

let items = [];
let loaded = false;
/** Скрытые из списка позиции каталога Самолет (не user) */
let samArchived = new Set();
let archiveLoaded = false;

function loadSamArchive() {
  if (archiveLoaded) return;
  archiveLoaded = true;
  try {
    const arr = JSON.parse(localStorage.getItem(ARCHIVE_STORE) || '[]');
    samArchived = new Set((Array.isArray(arr) ? arr : []).map(Number));
  } catch {
    samArchived = new Set();
  }
}

function persistSamArchive() {
  localStorage.setItem(ARCHIVE_STORE, JSON.stringify([...samArchived]));
}

function seriesCat(name) {
  for (const [pre, cat] of SERIES) {
    if (name.startsWith(pre)) return cat;
  }
  return 'Мои';
}

function dimsFromName(name) {
  const m = /(\d{2,4})х(\d{2,4})х(\d{2,4})/i.exec(name);
  if (!m) return { w: 600, h: 720, d: 560 };
  return { h: +m[1], w: +m[2], d: +m[3] };
}

function boxParts(w, h, d, t = 16) {
  const P = [
    [0, 0, 0, t, h, d, 'panel'], [w - t, 0, 0, w, h, d, 'panel'],
    [t, 0, 0, w - t, t, d, 'panel'], [t, h - t, 0, w - t, h, d, 'panel'],
    [t, t, 0, w - t, h - t, 3, 'back'], [1.5, 1.5, d, w - 1.5, h - 1.5, d + 18, 'front'],
  ];
  return {
    mats: ['ЛДСП (габарит)'],
    parts: P.map((p, i) => [...p.slice(0, 6), p[6], 0, i, '']),
    panels: [],
    hw: [],
    fronts: { 5: { t: 'door', hinge: 'left' } },
  };
}

function persist() {
  // geomData храним — иначе после перезагрузки нет превью/сцены
  localStorage.setItem(STORE, JSON.stringify({ items }));
}

function nextN() {
  let max = USER_N0 - 1;
  for (const e of items) if (e.n > max) max = e.n;
  return max + 1;
}

function publish(e) {
  registerLibEntry(e);
  registerLibGeom(e.n, e.geomData);
}

export function loadUserCatalog() {
  loadSamArchive();
  if (loaded) return items;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    items = Array.isArray(raw.items) ? raw.items : [];
  } catch {
    items = [];
  }
  for (const e of items) {
    if (!e.geomData) e.geomData = boxParts(e.w, e.h, e.d);
    publish(e);
  }
  return items;
}

/** Архив Самолета + user: скрыт ли n */
export function isCatalogArchived(n) {
  loadUserCatalog();
  n = +n;
  if (n >= USER_N0) {
    const e = items.find((x) => x.n === n);
    return !!(e && e.archived);
  }
  return samArchived.has(n);
}

export function catalogArchivedCount() {
  loadUserCatalog();
  return samArchived.size + items.filter((e) => e.archived).length;
}

export function userCatalogItems({ includeArchived = false } = {}) {
  loadUserCatalog();
  return items.filter((e) => includeArchived || !e.archived);
}

export function userCatalogAll() {
  loadUserCatalog();
  return items.slice();
}

export function getUserEntry(n) {
  loadUserCatalog();
  return items.find((e) => e.n === +n) || null;
}

/** Добавить один или несколько File (.b3d). Возвращает созданные записи. */
export function addUserB3dFiles(fileList, opts = {}) {
  loadUserCatalog();
  const out = [];
  for (const file of fileList) {
    const name = file.name || '';
    if (!/\.b3d$/i.test(name)) continue;
    const stem = name.replace(/\.b3d$/i, '');
    const { w, h, d } = dimsFromName(stem);
    const hand = /\(лев\)/i.test(stem) ? 'left' : /\(пр\)/i.test(stem) ? 'right' : null;
    const decor = (stem.match(/_(KF|CC|SS|WG)\b/) || [])[1] || null;
    const cat = opts.cat || seriesCat(stem);
    const n = nextN();
    const geomData = boxParts(w, h, d);
    const entry = {
      n,
      art: stem,
      file: name,
      cat,
      title: 'Мой модуль',
      decor,
      hand,
      code: '',
      w, h, d,
      box: [0, 0, 0, w, h, d + 18],
      geom: 'box',
      nParts: 6,
      nHw: 0,
      user: true,
      archived: false,
      addedAt: new Date().toISOString(),
      geomData,
    };
    items.push(entry);
    publish(entry);
    out.push(entry);
  }
  if (out.length) persist();
  return out;
}

/** Подставить детальную геометрию из JSON (опционально, если есть рядом с .b3d). */
export function setUserGeom(n, geomObj) {
  loadUserCatalog();
  const e = items.find((x) => x.n === +n);
  if (!e || !geomObj?.parts) return false;
  e.geomData = geomObj;
  e.geom = 'full';
  e.nParts = (geomObj.panels || []).length;
  e.nHw = Array.isArray(geomObj.hw) ? geomObj.hw.reduce((s, h) => s + (h.qty || 0), 0) : 0;
  publish(e);
  persist();
  return true;
}

export function archiveUserEntry(n, archived = true) {
  loadUserCatalog();
  const e = items.find((x) => x.n === +n);
  if (!e) return false;
  e.archived = !!archived;
  persist();
  return true;
}

/** Архив любой позиции каталога (Самолет или мой .b3d). */
export function archiveCatalogEntry(eOrN, archived = true) {
  loadUserCatalog();
  const n = typeof eOrN === 'object' ? +eOrN.n : +eOrN;
  const user = typeof eOrN === 'object' ? !!eOrN.user : n >= USER_N0;
  if (user) return archiveUserEntry(n, archived);
  if (archived) samArchived.add(n);
  else samArchived.delete(n);
  persistSamArchive();
  return true;
}

export function deleteUserEntry(n) {
  loadUserCatalog();
  const i = items.findIndex((x) => x.n === +n);
  if (i < 0) return false;
  items.splice(i, 1);
  unregisterLibEntry(n);
  persist();
  return true;
}

export function isUserLib(eOrN) {
  const n = typeof eOrN === 'object' ? eOrN?.n : eOrN;
  return +n >= USER_N0;
}
