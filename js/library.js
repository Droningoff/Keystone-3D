// Пользовательская библиотека модулей. Базовые шаблоны + сохранённые пользователем.
// Хранение: localStorage. Импорт/экспорт JSON.

import { MODULE_TYPES, DEFAULT_MATS, newId } from './model.js';

const STORE = 'furniture-constructor-library';

export function defaultLibraryEntries() {
  return Object.entries(MODULE_TYPES).filter(([, def]) => !def.hidden).map(([type, def]) => ({
    id: 'sys_' + type,
    system: true,
    type,
    name: def.title,
    category: def.row === 'wall' ? 'Навесные' : (type === 'wardrobe' || type === 'tall' ? 'Шкафы' : 'Нижние'),
    p: { ...def.p },
    mat: { ...DEFAULT_MATS },
  }));
}

export function loadLibrary() {
  let user = [];
  try { user = JSON.parse(localStorage.getItem(STORE)) || []; } catch { /* ignore */ }
  return [...defaultLibraryEntries(), ...user];
}

export function saveUserLibrary(entries) {
  const user = entries.filter((e) => !e.system);
  localStorage.setItem(STORE, JSON.stringify(user));
}

export function addToLibrary(entry) {
  const lib = loadLibrary();
  const item = {
    id: newId(),
    system: false,
    type: entry.type,
    name: entry.name || MODULE_TYPES[entry.type]?.title || 'Модуль',
    category: entry.category || 'Мои',
    p: { ...entry.p },
    mat: { ...DEFAULT_MATS, ...entry.mat },
  };
  lib.push(item);
  saveUserLibrary(lib);
  return item;
}

export function removeFromLibrary(id) {
  const lib = loadLibrary().filter((e) => e.id !== id || e.system);
  saveUserLibrary(lib);
  return lib;
}

export function exportLibraryJSON() {
  return JSON.stringify(loadLibrary().filter((e) => !e.system), null, 2);
}

export function importLibraryJSON(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Ожидается массив модулей');
  const cur = loadLibrary().filter((e) => !e.system);
  for (const e of arr) {
    if (!MODULE_TYPES[e.type]) continue;
    cur.push({
      id: newId(),
      system: false,
      type: e.type,
      name: e.name || MODULE_TYPES[e.type].title,
      category: e.category || 'Импорт',
      p: { ...MODULE_TYPES[e.type].p, ...e.p },
      mat: { ...DEFAULT_MATS, ...e.mat },
    });
  }
  saveUserLibrary(cur);
  return loadLibrary();
}

export function libraryByCategory(lib = loadLibrary()) {
  const map = new Map();
  for (const e of lib) {
    const c = e.category || 'Прочее';
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(e);
  }
  return map;
}
