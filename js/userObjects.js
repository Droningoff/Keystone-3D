// Личный каталог 3D-объектов пользователя (OBJ + MTL + текстуры, можно в ZIP).
// Метаданные и сетки — в IndexedDB, записи привязаны к логину.
// Сетка хранится нормализованной: мм, ось Y вверх, центр по X/Z, низ на y=0, «лицо» объекта смотрит в +Z.

import * as THREE from 'three';

const DB_NAME = 'ks3d-user-objects';
const DB_VER = 1;
const LEGACY_FRAGMENTS_KEY = 'furniture-fragments-catalog-v1';
const LEGACY_FRAGMENTS_DB = 'ks3d-fragment-meshes';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UNIT_SCALE = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export const UNIT_LABELS = { mm: 'мм', cm: 'см', m: 'м', in: 'дюймы' };
export const DEFAULT_OBJECT_COLOR = '#b8bcc2';
const TEXTURE_MAX_PX = 1024;

let _dbPromise = null;
let _owner = 'guest';
const _items = new Map();
const _meshes = new Map();

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meshes')) db.createObjectStore('meshes', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB недоступна'));
  });
  return _dbPromise;
}

async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const req = fn(os);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
  });
}

/** Убрать данные старого импорта .fr3d (каталог фрагментов и их сетки). */
export function purgeLegacyFragments() {
  try { localStorage.removeItem(LEGACY_FRAGMENTS_KEY); } catch (_) { /* */ }
  try { indexedDB.deleteDatabase(LEGACY_FRAGMENTS_DB); } catch (_) { /* */ }
}

/** Загрузить каталог текущего пользователя в память (вызывать после входа). */
export async function initUserObjects(owner) {
  _owner = String(owner || 'guest');
  _items.clear();
  _meshes.clear();
  const all = (await idb('items', 'readonly', (os) => os.getAll())) || [];
  for (const it of all) if (it.owner === _owner) _items.set(it.id, it);
  const ids = [..._items.keys()];
  const meshes = await Promise.all(ids.map((id) => idb('meshes', 'readonly', (os) => os.get(id)).catch(() => null)));
  for (const m of meshes) if (m) _meshes.set(m.id, m);
  return _items.size;
}

export function userObjectsOwner() { return _owner; }

export function listUserObjects({ archived = false } = {}) {
  return [..._items.values()]
    .filter((it) => !!it.archived === !!archived)
    .sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''), 'ru')
      || String(a.title || '').localeCompare(String(b.title || ''), 'ru'));
}

export function archivedUserObjectsCount() {
  let n = 0;
  for (const it of _items.values()) if (it.archived) n++;
  return n;
}

export function getUserObject(id) { return (id && _items.get(id)) || null; }
export function getUserObjectMesh(id) { return (id && _meshes.get(id)) || null; }

export function userObjectCategories() {
  const set = new Set();
  for (const it of _items.values()) if (it.category) set.add(it.category);
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

function newId() {
  return 'uo' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function itemFromMeta(base, meta, meshRec) {
  return {
    ...base,
    title: String(meta.title || base.title || 'Объект').trim() || 'Объект',
    category: String(meta.category ?? base.category ?? '').trim(),
    place: meta.place === 'wall' ? 'wall' : 'floor',
    color: meta.color || base.color || DEFAULT_OBJECT_COLOR,
    useMaterials: meta.useMaterials ?? base.useMaterials ?? true,
    w: Math.round(meshRec?.w ?? base.w ?? 100),
    h: Math.round(meshRec?.h ?? base.h ?? 100),
    d: Math.round(meshRec?.d ?? base.d ?? 100),
    thumb: meta.thumb ?? base.thumb ?? '',
    source: {
      fileName: meta.fileName ?? base.source?.fileName ?? '',
      units: meta.units ?? base.source?.units ?? 'mm',
      upAxis: meta.upAxis ?? base.source?.upAxis ?? 'y',
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function addUserObject(meta, meshRec) {
  const id = newId();
  const item = itemFromMeta({ id, owner: _owner, archived: false, createdAt: new Date().toISOString() }, meta, meshRec);
  const mesh = { ...meshRec, id };
  await idb('meshes', 'readwrite', (os) => os.put(mesh));
  await idb('items', 'readwrite', (os) => os.put(item));
  _meshes.set(id, mesh);
  _items.set(id, item);
  return item;
}

/** Заменить 3D-модель объекта; метаданные (название, категория…) можно обновить тем же вызовом. */
export async function replaceUserObjectMesh(id, meta, meshRec) {
  const old = _items.get(id);
  if (!old) throw new Error('объект не найден в каталоге');
  const item = itemFromMeta(old, meta, meshRec);
  const mesh = { ...meshRec, id };
  await idb('meshes', 'readwrite', (os) => os.put(mesh));
  await idb('items', 'readwrite', (os) => os.put(item));
  _meshes.set(id, mesh);
  _items.set(id, item);
  return { item, old };
}

export async function updateUserObject(id, patch) {
  const old = _items.get(id);
  if (!old || !patch) return null;
  const item = { ...old, ...patch, id, owner: old.owner, updatedAt: new Date().toISOString() };
  await idb('items', 'readwrite', (os) => os.put(item));
  _items.set(id, item);
  return item;
}

export function setUserObjectArchived(id, archived) {
  return updateUserObject(id, { archived: !!archived });
}

export async function deleteUserObject(id) {
  await idb('items', 'readwrite', (os) => os.delete(id));
  await idb('meshes', 'readwrite', (os) => os.delete(id));
  _items.delete(id);
  _meshes.delete(id);
}

// ---------- Разбор файлов ----------

const baseName = (s) => String(s || '').split(/[\\/]/).pop();
const lowerBase = (s) => baseName(s).toLowerCase();
const stemOf = (s) => baseName(s).replace(/\.[^.]+$/, '');

/** Распаковать ZIP средствами браузера (stored / deflate). */
export async function unzipFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`«${file.name}» — не ZIP-архив`);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const nameBytes = buf.subarray(p + 46, p + 46 + nlen);
    // без флага UTF-8 Проводник Windows пишет имена в OEM-кодировке (cp866)
    const name = new TextDecoder((flags & 0x800) ? 'utf-8' : 'ibm866').decode(nameBytes);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data.slice();
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`ZIP: метод сжатия ${method} не поддерживается (файл ${name})`);
    }
    out.push(new File([bytes], baseName(name)));
  }
  return out;
}

/** Разбор Wavefront OBJ: v / vt / vn / f / usemtl / mtllib, отрицательные индексы. */
export function parseObjText(text) {
  const V = [], VT = [], VN = [];
  const positions = [], uvs = [], normals = [];
  const byMat = new Map();
  const mtllibs = [];
  const keyMap = new Map();
  let curMat = '';
  let allNormals = true;
  let anyUv = false;

  const resolve = (s, len) => {
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return -1;
    return n < 0 ? len + n : n - 1;
  };
  const vertex = (tok) => {
    let idx = keyMap.get(tok);
    if (idx !== undefined) return idx;
    const parts = tok.split('/');
    const vi = resolve(parts[0], V.length / 3);
    if (vi < 0 || vi * 3 + 2 >= V.length) return -1;
    const ti = parts[1] ? resolve(parts[1], VT.length / 2) : -1;
    const ni = parts[2] ? resolve(parts[2], VN.length / 3) : -1;
    idx = positions.length / 3;
    positions.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
    if (ti >= 0 && ti * 2 + 1 < VT.length) { uvs.push(VT[ti * 2], VT[ti * 2 + 1]); anyUv = true; } else uvs.push(0, 0);
    if (ni >= 0 && ni * 3 + 2 < VN.length) normals.push(VN[ni * 3], VN[ni * 3 + 1], VN[ni * 3 + 2]);
    else { normals.push(0, 0, 0); allNormals = false; }
    keyMap.set(tok, idx);
    return idx;
  };

  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t[0] === '#') continue;
    const sp = t.indexOf(' ');
    const kw = sp < 0 ? t : t.slice(0, sp);
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    if (kw === 'v') {
      const p = rest.split(/\s+/);
      V.push(+p[0] || 0, +p[1] || 0, +p[2] || 0);
    } else if (kw === 'vt') {
      const p = rest.split(/\s+/);
      VT.push(+p[0] || 0, +p[1] || 0);
    } else if (kw === 'vn') {
      const p = rest.split(/\s+/);
      VN.push(+p[0] || 0, +p[1] || 0, +p[2] || 0);
    } else if (kw === 'f') {
      const face = [];
      for (const tok of rest.split(/\s+/)) {
        const i = vertex(tok);
        if (i >= 0) face.push(i);
      }
      if (face.length < 3) continue;
      let arr = byMat.get(curMat);
      if (!arr) { arr = []; byMat.set(curMat, arr); }
      for (let i = 1; i + 1 < face.length; i++) arr.push(face[0], face[i], face[i + 1]);
    } else if (kw === 'usemtl') {
      curMat = rest;
    } else if (kw === 'mtllib') {
      if (rest) mtllibs.push(rest);
    }
  }

  if (!positions.length || !byMat.size) return null;
  const indices = [];
  const groups = [];
  const materialNames = [];
  for (const [name, arr] of byMat) {
    if (!arr.length) continue;
    groups.push({ start: indices.length, count: arr.length, materialIndex: materialNames.length });
    materialNames.push(name);
    for (const i of arr) indices.push(i);
  }
  return {
    positions: new Float32Array(positions),
    normals: allNormals ? new Float32Array(normals) : null,
    uvs: anyUv ? new Float32Array(uvs) : null,
    indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    groups,
    materialNames,
    mtllibs,
    vertexCount: positions.length / 3,
    triCount: indices.length / 3,
  };
}

/** Разбор MTL: newmtl / Kd / d / Tr / map_Kd. */
export function parseMtlText(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t[0] === '#') continue;
    const sp = t.indexOf(' ');
    const kw = (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    if (kw === 'newmtl') {
      cur = { name: rest, color: null, opacity: 1, mapName: '' };
      out[rest] = cur;
    } else if (!cur) {
      continue;
    } else if (kw === 'kd') {
      const p = rest.split(/\s+/).map(Number);
      if (p.length >= 3 && p.every(Number.isFinite)) cur.color = p.slice(0, 3);
    } else if (kw === 'd') {
      const v = parseFloat(rest);
      if (Number.isFinite(v)) cur.opacity = Math.max(0, Math.min(1, v));
    } else if (kw === 'tr') {
      const v = parseFloat(rest);
      if (Number.isFinite(v)) cur.opacity = Math.max(0, Math.min(1, 1 - v));
    } else if (kw === 'map_kd') {
      // опции вида «-s 1 1 1 file.jpg» — имя файла в конце
      cur.mapName = rest.startsWith('-') ? rest.split(/\s+/).pop() : rest;
    }
  }
  return out;
}

const rgbToHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

async function imageFileToDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, TEXTURE_MAX_PX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * k));
  cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  return /\.png$/i.test(file.name) ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.9);
}

/**
 * Набор выбранных файлов (OBJ/MTL/картинки/ZIP) → список источников, по одному на каждый OBJ.
 * @returns {Promise<Array<{fileName, parsed, materials, warnings, rawBox}>>}
 */
export async function readObjSources(fileList) {
  const input = [...(fileList || [])];
  const total = input.reduce((s, f) => s + (f.size || 0), 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new Error(`файлы занимают ${(total / 1048576).toFixed(1)} МБ, допустимо до ${MAX_UPLOAD_BYTES / 1048576} МБ`);
  }
  const files = [];
  for (const f of input) {
    if (/\.zip$/i.test(f.name)) files.push(...await unzipFile(f));
    else files.push(f);
  }
  const objs = files.filter((f) => /\.obj$/i.test(f.name));
  if (!objs.length) throw new Error('среди выбранных файлов нет .obj');
  const mtls = files.filter((f) => /\.mtl$/i.test(f.name));
  const images = new Map(files.filter((f) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)).map((f) => [lowerBase(f.name), f]));

  const out = [];
  for (const objFile of objs) {
    const warnings = [];
    const parsed = parseObjText(await objFile.text());
    if (!parsed) throw new Error(`«${objFile.name}»: в файле нет граней`);

    let mtlDefs = {};
    const wanted = parsed.mtllibs.map(lowerBase);
    const found = mtls.filter((m) => wanted.includes(lowerBase(m.name)));
    const useMtls = found.length ? found
      : (mtls.length === 1 || objs.length === 1 ? mtls : mtls.filter((m) => stemOf(m.name).toLowerCase() === stemOf(objFile.name).toLowerCase()));
    for (const m of useMtls) Object.assign(mtlDefs, parseMtlText(await m.text()));
    if (wanted.length && !useMtls.length) {
      warnings.push(`нет файла материалов ${parsed.mtllibs.map(baseName).join(', ')} — модель будет одного цвета`);
    }

    const materials = [];
    for (const name of parsed.materialNames) {
      const def = mtlDefs[name];
      const mat = { name, color: def?.color ? rgbToHex(def.color) : null, opacity: def?.opacity ?? 1, map: '' };
      if (def?.mapName) {
        const img = images.get(lowerBase(def.mapName));
        if (img) {
          try { mat.map = await imageFileToDataUrl(img); } catch (_) { warnings.push(`не удалось прочитать текстуру ${img.name}`); }
        } else {
          warnings.push(`нет текстуры ${baseName(def.mapName)}`);
        }
      }
      materials.push(mat);
    }
    if (materials.some((m) => m.map) && !parsed.uvs) warnings.push('у модели нет текстурных координат — текстуры не лягут');

    out.push({
      fileName: objFile.name,
      parsed,
      materials,
      hasMaterials: materials.some((m) => m.color || m.map),
      warnings: [...new Set(warnings)],
      rawBox: rawBox(parsed.positions),
    });
  }
  return out;
}

function rawBox(P) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, sx: maxX - minX, sy: maxY - minY, sz: maxZ - minZ };
}

/** Угадать единицы: модель меньше 10 единиц по всем осям — скорее всего метры. */
export function guessUnits(source) {
  const b = source?.rawBox;
  if (!b) return 'mm';
  const m = Math.max(b.sx, b.sy, b.sz);
  if (m <= 10) return 'm';
  return 'mm';
}

/** Источник + единицы + ось «вверх» → нормализованная запись сетки для каталога. */
export function normalizeSource(source, { units = 'mm', upAxis = 'y' } = {}) {
  const src = source.parsed;
  const s = UNIT_SCALE[units] || 1;
  const P = src.positions, N = src.normals;
  const pos = new Float32Array(P.length);
  const nrm = N ? new Float32Array(N.length) : null;
  const zUp = upAxis === 'z';
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    pos[i] = x * s;
    pos[i + 1] = (zUp ? z : y) * s;
    pos[i + 2] = (zUp ? -y : z) * s;
    if (nrm) {
      const a = N[i], b = N[i + 1], c = N[i + 2];
      nrm[i] = a;
      nrm[i + 1] = zUp ? c : b;
      nrm[i + 2] = zUp ? -b : c;
    }
  }
  const b = rawBox(pos);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx;
    pos[i + 1] -= b.minY;
    pos[i + 2] -= cz;
  }
  let normals = nrm;
  if (!normals) {
    const tmp = new THREE.BufferGeometry();
    tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tmp.setIndex(new THREE.BufferAttribute(src.indices, 1));
    tmp.computeVertexNormals();
    normals = tmp.getAttribute('normal').array;
  }
  return {
    positions: pos,
    normals,
    uvs: src.uvs,
    indices: src.indices,
    groups: src.groups.map((g) => ({ ...g })),
    materials: source.materials.map((m) => ({ ...m })),
    w: Math.max(1, b.sx),
    h: Math.max(1, b.sy),
    d: Math.max(1, b.sz),
    vertexCount: src.vertexCount,
    triCount: src.triCount,
  };
}

// ---------- Three.js ----------

const _texCache = new Map();
function textureFor(url) {
  if (!url) return null;
  let tex = _texCache.get(url);
  if (!tex) {
    tex = new THREE.TextureLoader().load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    _texCache.set(url, tex);
  }
  return tex;
}

async function preloadTextures(meshRec) {
  const urls = (meshRec?.materials || []).map((m) => m.map).filter((u) => u && !_texCache.has(u));
  await Promise.all(urls.map(async (u) => {
    try {
      const tex = await new THREE.TextureLoader().loadAsync(u);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      _texCache.set(u, tex);
    } catch (_) { /* */ }
  }));
}

const toFloat32 = (a) => (a instanceof Float32Array ? a : new Float32Array(a));
const toIndex = (a) => (a instanceof Uint32Array || a instanceof Uint16Array ? a : new Uint32Array(a));

/**
 * Группа Three.js из нормализованной сетки.
 * opts: { w, h, d — габарит экземпляра; mirror; color — свой цвет (перекрывает материалы);
 *         useMaterials — брать цвета/текстуры из MTL; onWall — пивот по центру высоты }.
 * Каждой группе материалов — свой Mesh с одним материалом (viewer клонирует material у выделенного).
 */
export function buildUserObjectNode(meshRec, opts = {}) {
  const root = new THREE.Group();
  if (!meshRec?.positions?.length) return root;
  const geoBase = {
    position: new THREE.BufferAttribute(toFloat32(meshRec.positions), 3),
    normal: meshRec.normals ? new THREE.BufferAttribute(toFloat32(meshRec.normals), 3) : null,
    uv: meshRec.uvs ? new THREE.BufferAttribute(toFloat32(meshRec.uvs), 2) : null,
    index: new THREE.BufferAttribute(toIndex(meshRec.indices), 1),
  };
  const groups = meshRec.groups?.length ? meshRec.groups : [{ start: 0, count: geoBase.index.count, materialIndex: 0 }];
  const fallback = opts.color || opts.baseColor || DEFAULT_OBJECT_COLOR;

  const holder = new THREE.Group();
  for (const g of groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', geoBase.position);
    if (geoBase.uv) geo.setAttribute('uv', geoBase.uv);
    geo.setIndex(geoBase.index);
    if (geoBase.normal) geo.setAttribute('normal', geoBase.normal);
    else geo.computeVertexNormals();
    geo.setDrawRange(g.start, g.count);
    geo.computeBoundingSphere();

    const src = meshRec.materials?.[g.materialIndex] || null;
    const useSrc = !opts.color && opts.useMaterials !== false && src;
    const map = useSrc && src.map ? textureFor(src.map) : null;
    const opacity = useSrc ? (src.opacity ?? 1) : 1;
    const mat = new THREE.MeshStandardMaterial({
      color: map ? 0xffffff : (useSrc && src.color ? src.color : fallback),
      map,
      roughness: 0.55,
      metalness: 0.1,
      transparent: opacity < 0.999,
      opacity,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.userObjectMesh = true;
    holder.add(mesh);
  }

  const bw = +meshRec.w || 1, bh = +meshRec.h || 1, bd = +meshRec.d || 1;
  const w = +opts.w || bw, h = +opts.h || bh, d = +opts.d || bd;
  holder.scale.set((w / bw) * (opts.mirror ? -1 : 1), h / bh, d / bd);
  if (opts.onWall) holder.position.y = -h / 2;
  root.add(holder);
  return root;
}

let _thumbRenderer = null;

/** PNG-превью (dataURL) для карточки каталога: вид спереди-сбоку-сверху. */
export async function renderUserObjectThumb(meshRec, opts = {}) {
  const size = opts.size || 192;
  await preloadTextures(meshRec);
  if (!_thumbRenderer) {
    _thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    _thumbRenderer.setPixelRatio(1);
  }
  const r = _thumbRenderer;
  r.setSize(size, size, false);
  r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.2, 2, 1.6);
  scene.add(sun);
  const node = buildUserObjectNode(meshRec, opts);
  scene.add(node);
  const w = +meshRec.w || 1, h = +meshRec.h || 1, d = +meshRec.d || 1;
  const radius = Math.max(1, 0.5 * Math.hypot(w, h, d));
  const cam = new THREE.PerspectiveCamera(30, 1, radius / 50, radius * 50);
  const dir = new THREE.Vector3(0.9, 0.75, 1.4).normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05;
  const target = new THREE.Vector3(0, h / 2, 0);
  cam.position.copy(target).addScaledVector(dir, dist);
  cam.lookAt(target);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  node.traverse((o) => {
    if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
  });
  return url;
}

// ---------- Экспорт / импорт каталога ----------

function typedToB64(arr) {
  if (!arr) return null;
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  const type = arr instanceof Uint32Array ? 'u32' : arr instanceof Uint16Array ? 'u16' : 'f32';
  return { type, data: btoa(bin) };
}

function b64ToTyped(o) {
  if (!o?.data) return null;
  const bin = atob(o.data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  if (o.type === 'u32') return new Uint32Array(u8.buffer);
  if (o.type === 'u16') return new Uint16Array(u8.buffer);
  return new Float32Array(u8.buffer);
}

/** Весь личный каталог (включая архив) → Blob JSON. */
export function exportUserObjectsBlob() {
  const items = [..._items.values()].map((it) => {
    const m = _meshes.get(it.id);
    return {
      ...it,
      mesh: m ? {
        ...m,
        positions: typedToB64(toFloat32(m.positions)),
        normals: m.normals ? typedToB64(toFloat32(m.normals)) : null,
        uvs: m.uvs ? typedToB64(toFloat32(m.uvs)) : null,
        indices: typedToB64(toIndex(m.indices)),
      } : null,
    };
  });
  const json = JSON.stringify({ format: 'ks3d-user-objects', version: 1, exportedAt: new Date().toISOString(), owner: _owner, items });
  return new Blob([json], { type: 'application/json' });
}

/** Импорт файла экспорта в каталог текущего пользователя; совпадающие id получают новые. */
export async function importUserObjectsFile(file) {
  const data = JSON.parse(await file.text());
  if (data?.format !== 'ks3d-user-objects' || !Array.isArray(data.items)) {
    throw new Error('это не файл каталога объектов Keystone-3D');
  }
  let n = 0;
  for (const raw of data.items) {
    if (!raw?.mesh?.positions) continue;
    const id = _items.has(raw.id) || !raw.id ? newId() : raw.id;
    const { mesh: rm, ...meta } = raw;
    const mesh = {
      ...rm,
      id,
      positions: b64ToTyped(rm.positions),
      normals: b64ToTyped(rm.normals),
      uvs: b64ToTyped(rm.uvs),
      indices: b64ToTyped(rm.indices),
    };
    const item = { ...meta, id, owner: _owner, updatedAt: new Date().toISOString() };
    await idb('meshes', 'readwrite', (os) => os.put(mesh));
    await idb('items', 'readwrite', (os) => os.put(item));
    _meshes.set(id, mesh);
    _items.set(id, item);
    n++;
  }
  return n;
}
