// Генерация скрипта Базис-Мебельщик (API 2361 и новее).
// Lib-модули: Load(.b3d) целиком. Параметрические: панели + OpenFurniture/Mount1.
// Важно: после построения нужен Action.Commit().

import { MATERIALS, EDGES } from './catalog.js?v=20261028m';
import { isLib } from './model.js?v=20261029j';
import { samoletIndex } from './samolet.js?v=20261029j';

const RUNTIME = String.raw`
var __log = [];
var __count = 0;
var __libs = 0;
var __furns = 0;
var __fs = null;
try { __fs = require('fs'); } catch (e) {}
function __err(where, e) { if (__log.length < 80) __log.push(where + ': ' + e); }
function __exists(p) {
  try { return __fs && __fs.existsSync(p); } catch (e) { return false; }
}
function __mat(name, t) {
  try {
    if (typeof materialData !== 'undefined' && materialData.SetupActiveMaterial) { materialData.SetupActiveMaterial(name, t, 0); return; }
  } catch (e) { __err('materialData.SetupActiveMaterial', e); }
  try { ActiveMaterial.Make(name, t); } catch (e) { __err('ActiveMaterial.Make', e); }
}
function __butt(p, idx, name, t, w, sign) {
  try {
    var b = p.Butts.Add();
    b.ElemIndex = idx; b.Material = name; b.Thickness = t; b.Width = w; b.Sign = sign; b.ClipPanel = true;
    return;
  } catch (e) { __err('Butts.Add', e); }
  try {
    materialData.SetupActiveButtMaterial(name, t, w, true, sign, 0, true, 0);
    panelOperations.AddButt(p, idx);
  } catch (e) { __err('panelOperations.AddButt', e); }
}
function __tex(p, dir) {
  if (!dir) return;
  try {
    var v = (typeof TextureOrientation !== 'undefined') ? (dir === 'H' ? TextureOrientation.Horizontal : TextureOrientation.Vertical) : (dir === 'H' ? 1 : 2);
    p.TextureOrientation = v;
  } catch (e) { __err('TextureOrientation', e); }
}
function __fin(p, name, art, tex) {
  try { p.Name = name; p.ArtPos = art; } catch (e) { __err('Name/ArtPos', e); }
  __tex(p, tex);
  try { p.Build(); } catch (e) { __err('Build ' + name, e); }
  __count++;
}
function __block(name) { try { return BeginBlock(name); } catch (e) { __err('BeginBlock', e); return null; } }
function __endblock() { try { EndBlock(); } catch (e) { __err('EndBlock', e); } }
function __place(block, x, z, rot) {
  if (!block) return;
  if (rot) {
    try { block.RotateGCS(AxisY, rot); } catch (e) { try { block.RotateY(rot); } catch (e2) { __err('Rotate', e2); } }
  }
  try { block.TranslateGCS(NewVector(x, 0, z)); } catch (e) { try { block.Translate(NewVector(x, 0, z)); } catch (e2) { __err('Translate', e2); } }
}
function __lib(name, file, px, py, pz, zx, zz) {
  if (!__exists(file)) { __err('нет файла', file); return null; }
  var b = null;
  try { b = AddBlock(name); } catch (e) { __err('AddBlock ' + name, e); return null; }
  var loaded = false;
  try { b.Load(file); loaded = true; } catch (e) { __err('Load ' + file, e); }
  if (!loaded) {
    try {
      if (typeof modelIOOperations !== 'undefined' && modelIOOperations.LoadFileIntoCurrentModel) {
        modelIOOperations.LoadFileIntoCurrentModel(file, b);
        loaded = true;
      }
    } catch (e) { __err('LoadFileIntoCurrentModel', e); }
  }
  if (!loaded) return null;
  try { b.Build(); } catch (e) { __err('Build ' + name, e); }
  try { b.SetDefaultTransform(); } catch (e) { __err('SetDefaultTransform', e); }
  try { b.Orient(NewVector(zx, 0, zz), NewVector(0, 1, 0)); } catch (e) { __err('Orient', e); }
  try { b.Position = NewVector(px, py, pz); } catch (e) { __err('Position', e); }
  try { b.Name = name; } catch (e) {}
  __libs++;
  return b;
}
/** OpenFurniture + Mount1 на панель (ручка, полкодержатель, ножка, навес). */
function __furn1(file, panel, x, y, z, ang) {
  if (!file) return null;
  if (!__exists(file)) { __err('нет .f3d', file); return null; }
  var f = null;
  try { f = OpenFurniture(file); } catch (e) { __err('OpenFurniture', e); return null; }
  if (!f) return null;
  try {
    f.Mount1(panel, x, y, z, ang || 0);
    __furns++;
    return f;
  } catch (e) { __err('Mount1 ' + file, e); }
  try {
    if (typeof fastenerOperations !== 'undefined' && fastenerOperations.CreateFurnitureInfo) {
      var info = fastenerOperations.CreateFurnitureInfo(file);
      fastenerOperations.MountFurniture(info, { panel1: panel, position: NewVector(x, y, z) });
      __furns++;
      return info;
    }
  } catch (e2) { __err('MountFurniture', e2); }
  return null;
}
/** Петля: Mount между боковиной и фасадом. */
function __furnPair(file, pCarc, pFront, x, y, z) {
  if (!file) return null;
  if (!__exists(file)) { __err('нет .f3d', file); return null; }
  var f = null;
  try { f = OpenFurniture(file); } catch (e) { __err('OpenFurniture pair', e); return null; }
  if (!f) return null;
  try {
    f.Mount(pCarc, pFront, x, y, z);
    __furns++;
    return f;
  } catch (e) {
    __err('Mount pair', e);
    try { f.Mount1(pFront, x, y, z, 0); __furns++; return f; } catch (e2) { __err('Mount1 fallback', e2); }
  }
  return null;
}
function __commit() {
  try { Action.Commit(); } catch (e) { __err('Action.Commit', e); }
  try { Model.Build(); } catch (e) { try { Action.Commit(); } catch (e2) {} }
}
`;

const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const n = (v) => String(Math.round(v * 100) / 100);

function panelCall(p) {
  const { a1, b1, a2, b2, pos } = p;
  const fn = p.orient === 'H' ? 'AddHorizPanel' : p.orient === 'V' ? 'AddVertPanel' : 'AddFrontPanel';
  return `${fn}(${n(a1)}, ${n(b1)}, ${n(a2)}, ${n(b2)}, ${n(pos)})`;
}

const texDir = (p) => (p.grain === 'u' ? 'H' : p.grain === 'v' ? 'V' : null);

function safeIdent(key) {
  return String(key || 'p').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

export function resolveSamoletBase(prj) {
  return String(prj.settings?.samoletPath || samoletIndex()?.source || '').replace(/[\\/]+$/, '');
}

export function resolveUserCatalogBase(prj) {
  return String(prj.settings?.userCatalogPath || '').replace(/[\\/]+$/, '');
}

/** Папка с .f3d фурнитуры Базиса */
export function resolveFurnitureBase(prj) {
  return String(prj.settings?.furniturePath || prj.furniturePath || '').replace(/[\\/]+$/, '');
}

export function bazisExportCheck(prj, build) {
  const libBase = resolveSamoletBase(prj);
  const userBase = resolveUserCatalogBase(prj);
  const libs = (build?.items || []).filter((it) => !it.virtual && isLib(it.module));
  const samLibs = libs.filter((it) => !it.module.lib?.user);
  const userLibs = libs.filter((it) => it.module.lib?.user);
  const missing = [];
  if (samLibs.length && !libBase) {
    missing.push('Не задана папка с .b3d линейки (вкладка «Каталог» → путь)');
  }
  if (userLibs.length && !userBase) {
    missing.push('Не задана папка моих .b3d (вкладка «Каталог»)');
  }
  return { ok: !missing.length, libBase, userBase, libs: libs.length, samLibs: samLibs.length, userLibs: userLibs.length, missing };
}

function emitFittings(L, fittings, panelVars) {
  if (!fittings?.length) return;
  L.push('  // ---- Фурнитура (OpenFurniture + Mount) ----');
  for (const f of fittings) {
    const fname = String(f.bazisFile || '').replace(/\//g, '\\');
    if (!fname) {
      L.push(`  // пропуск ${f.name || f.key}: нет bazisFile (.f3d)`);
      continue;
    }
    const fileExpr = `__furnBase + '\\\\' + ${q(fname)}`;
    const cx = ((+f.x1) + (+f.x2)) / 2;
    const cy = ((+f.y1) + (+f.y2)) / 2;
    const cz = ((+f.z1) + (+f.z2)) / 2;
    const mesh = f.mesh || '';
    const mount = f.mount || (mesh === 'hinge' ? 'pair' : 'face');
    const frontVar = f.panelKey && panelVars[f.panelKey] ? panelVars[f.panelKey] : null;
    const sideKey = f.side === 'right' ? 'side_r' : 'side_l';
    const sideVar = panelVars[sideKey] || panelVars.side_l || panelVars.side_r || null;

    L.push(`  // ${f.name || f.catalogId || mesh} [${f.art || ''}] → ${fname}`);
    if (mount === 'pair' && sideVar && frontVar) {
      L.push(`  __furnPair(${fileExpr}, ${sideVar}, ${frontVar}, ${n(cx)}, ${n(cy)}, ${n(cz)});`);
    } else if (frontVar) {
      const ang = f.vertical === false ? 90 : 0;
      L.push(`  __furn1(${fileExpr}, ${frontVar}, ${n(cx)}, ${n(cy)}, ${n(cz)}, ${ang});`);
    } else if (sideVar) {
      L.push(`  __furn1(${fileExpr}, ${sideVar}, ${n(cx)}, ${n(cy)}, ${n(cz)}, 0);`);
    } else {
      const any = Object.values(panelVars)[0];
      if (any) L.push(`  __furn1(${fileExpr}, ${any}, ${n(cx)}, ${n(cy)}, ${n(cz)}, 0);`);
      else L.push(`  // нет панели для ${f.key}`);
    }
  }
}

export function toBazisScript(prj, build) {
  const L = [];
  const stamp = new Date().toLocaleString('ru-RU');
  const libBase = resolveSamoletBase(prj);
  const userBase = resolveUserCatalogBase(prj);
  const furnBase = resolveFurnitureBase(prj);
  const libItems = (build.items || []).filter((it) => !it.virtual && isLib(it.module));
  const samItems = libItems.filter((it) => !it.module.lib?.user);
  const userItems = libItems.filter((it) => it.module.lib?.user);
  const paramItems = (build.items || []).filter((it) => !it.virtual && !isLib(it.module));
  const furnCount = paramItems.reduce((s, it) => s + (it.fittings?.length || 0), 0);

  L.push(`// Сгенерировано конструктором мебели: ${prj.name}`);
  L.push(`// ${stamp}. Самолет: ${samItems.length}. Мои .b3d: ${userItems.length}. Параметрических: ${paramItems.length}. Фурнитура: ${furnCount}.`);
  L.push('// Запуск: Базис-Мебельщик → новая пустая модель → Скрипты → выполнить → сохранить .b3d.');
  L.push('// Lib: Load(.b3d). Параметрика: Add*Panel + OpenFurniture/Mount.');
  L.push(RUNTIME);
  L.push('');
  L.push(`var __base = ${q(libBase)};`);
  L.push(`var __userBase = ${q(userBase)};`);
  L.push(`var __furnBase = ${q(furnBase)};`);
  L.push(`if (${samItems.length} > 0 && (!__base || !__exists(__base))) {`);
  L.push(`  try { __base = system.askFolder('Папка с .b3d Самолет'); } catch (e) { __err('askFolder', e); }`);
  L.push(`  if (__base) __base = String(__base).replace(/[\\\\\\/]+$/, '');`);
  L.push('}');
  L.push(`if (${userItems.length} > 0 && (!__userBase || !__exists(__userBase))) {`);
  L.push(`  try { __userBase = system.askFolder('Папка с моими .b3d'); } catch (e) { __err('askFolder user', e); }`);
  L.push(`  if (__userBase) __userBase = String(__userBase).replace(/[\\\\\\/]+$/, '');`);
  L.push('}');
  L.push(`if (${furnCount} > 0 && (!__furnBase || !__exists(__furnBase))) {`);
  L.push(`  try { __furnBase = system.askFolder('Папка с .f3d фурнитуры Базиса'); } catch (e) { __err('askFolder furn', e); }`);
  L.push(`  if (__furnBase) __furnBase = String(__furnBase).replace(/[\\\\\\/]+$/, '');`);
  L.push('}');
  L.push('');

  for (const it of build.items) {
    if (it.virtual) continue;
    const m = it.module;
    const title = `${it.index}. ${it.title}`;
    if (isLib(m)) {
      const a = ((+m.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const [bx, by, bz] = m.lib.box || [0, 0, 0];
      const px = +m.x - (bx * c + bz * s);
      const pz = +m.z - (-bx * s + bz * c);
      const py = (+m.p.elev || 0) - by;
      const relFile = String(m.lib.file || '').replace(/\//g, '\\');
      const baseVar = m.lib.user ? '__userBase' : '__base';
      const tag = m.lib.user ? 'мой .b3d' : `Самолет ${m.lib.code || '-'}`;
      L.push(`// ---- ${title}  [${tag}]  x=${m.x} z=${m.z || 0} rot=${m.rot || 0} elev=${m.p.elev || 0}`);
      L.push(`__lib(${q(`${it.index}. ${m.lib.art}`)}, ${baseVar} + '\\\\' + ${q(relFile)}, ${n(px)}, ${n(py)}, ${n(pz)}, ${n(s)}, ${n(c)});`);
      L.push('');
      continue;
    }
    L.push(`// ---- ${title}  x=${m.x} z=${m.z || 0} rot=${m.rot || 0}`);
    L.push(`var __blk = __block(${q(title)});`);
    L.push('{');
    let curMat = null, k = 0;
    const panelVars = {};
    for (const p of it.panels) {
      k++;
      const mat = MATERIALS[p.mat];
      if (!mat) continue;
      if (curMat !== p.mat) { L.push(`  __mat(${q(mat.bazis)}, ${n(mat.t)});`); curMat = p.mat; }
      const v = '__p_' + safeIdent(p.key);
      panelVars[p.key] = v;
      // алиасы для Mount петель
      if (p.key === 'side_l' || p.key === 'side_r') panelVars[p.key] = v;
      if (p.role === 'front' && p.openable === 'door' && !panelVars.__firstDoor) panelVars.__firstDoor = v;
      L.push(`  var ${v} = ${panelCall(p)};`);
      (p.butts || []).forEach((e, idx) => {
        if (!e) return;
        const ed = EDGES[e];
        if (!ed) return;
        L.push(`  __butt(${v}, ${idx}, ${q(ed.bazis)}, ${n(ed.t)}, ${n(ed.w)}, ${q(ed.sign)});`);
      });
      const tex = texDir(p);
      L.push(`  __fin(${v}, ${q(p.name)}, ${q(`${it.index}.${k}`)}, ${tex ? q(tex) : 'null'});`);
    }
    emitFittings(L, it.fittings || [], panelVars);
    L.push('}');
    L.push('__endblock();');
    L.push(`__place(__blk, ${n(+m.x || 0)}, ${n(+m.z || 0)}, ${n(+m.rot || 0)});`);
    L.push('');
  }

  L.push('__commit();');
  L.push('try { ViewAll(); } catch (e) {}');
  L.push(`alert('Модулей .b3d: ' + __libs + '\\nПанелей: ' + __count + '\\nФурнитура OpenFurniture: ' + __furns + (__log.length ? '\\n\\nОшибки:\\n' + __log.join('\\n') : '\\n\\nБез ошибок') + '\\n\\nСохраните модель в .b3d');`);
  return L.join('\n');
}

export function bazisSmokeTest() {
  return [
    '// Тест совместимости API: тумба 600x720x560 без фасада + Commit',
    RUNTIME,
    "__block('Тест');",
    '__mat(\'ЛДСП Белый 16\', 16);',
    'var p = AddVertPanel(0, 0, 560, 720, 0); __fin(p, \'Бок\', \'1\', null);',
    '__endblock();',
    '__commit();',
    "alert('Тест OK. Панелей: ' + __count);",
  ].join('\n');
}
