// Текстовые команды на русском. Правило-ориентированный разбор; позже сюда подключается LLM,
// которая возвращает те же операции (см. applyOps).

import { MATERIALS } from './catalog.js';
import { createModule, nextFreeX, MODULE_TYPES, setAllFronts } from './model.js';

const WORDNUM = { 'один': 1, 'одна': 1, 'одну': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6 };

export const HELP = [
  'добавь тумбу 600 | тумбу с ящиками 400 | мойку 800 | верхний 600 | пенал | шкаф 1000',
  'кухня 3200 с мойкой — сгенерировать линейную кухню',
  'ширина 450, высота 720, глубина 560, цоколь 100, от пола 1400',
  '3 полки | добавь полку | без полок | 4 ящика | 2 двери | без дверей | петли справа',
  'штанга / без штанги, антресоль 400',
  'фасады шалфей | корпус графит | все фасады белый глянец | столешница камень',
  'сдвинь на 100 вправо | в начало | поверни | открой фасады | закрой фасады',
  'удали | удали все | модуль 3 (выбрать)',
].join('\n');

function norm(s) { return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }

function num(s, re) {
  const m = s.match(re);
  if (!m) return null;
  const v = m[1];
  return WORDNUM[v] ?? (isNaN(+v) ? null : +v);
}

function findMaterial(text, kinds) {
  let best = null, score = 0;
  for (const [id, m] of Object.entries(MATERIALS)) {
    if (!kinds.includes(m.kind)) continue;
    const s = m.kw.reduce((a, k) => a + (text.includes(k) ? 1 : 0), 0);
    if (s > score) { score = s; best = id; }
  }
  return best;
}

function typeFromText(t) {
  if (/мойк/.test(t)) return 'sink';
  if (/ящик/.test(t)) return 'base_drawers';
  if (/(верхн|навесн|подвесн)/.test(t)) return 'wall';
  if (/пенал/.test(t)) return 'tall';
  if (/шкаф/.test(t) && !/(кухон|навесн|верхн)/.test(t)) return 'wardrobe';
  if (/(тумб|нижн|модул)/.test(t)) return 'base';
  return null;
}

// Генерация линейной кухни на длину L
export function autoKitchen(prj, L, withSink = true) {
  const std = [800, 600, 500, 450, 400, 300];
  const plan = [];
  let rest = L;
  if (withSink && rest >= 800) { plan.push('sink:800'); rest -= 800; }
  if (rest >= 600) { plan.push('base_drawers:600'); rest -= 600; }
  while (rest >= 300) {
    const w = std.find((s) => s <= rest && (rest - s === 0 || rest - s >= 300)) || std.find((s) => s <= rest);
    plan.push(`base:${w}`); rest -= w;
  }
  if (rest > 0 && plan.length) { const [t, w] = plan[plan.length - 1].split(':'); plan[plan.length - 1] = `${t}:${+w + rest}`; }
  // мойка в середину
  if (withSink && plan.length > 2) { const s = plan.shift(); plan.splice(Math.floor(plan.length / 2), 0, s); }
  prj.modules = [];
  if (prj.room.length != null) prj.room.length = Math.max(prj.room.length || 0, L);
  else prj.room.width = Math.max(prj.room.width || 0, L);
  let x = 0;
  for (const it of plan) {
    const [t, w] = it.split(':');
    prj.modules.push(createModule(t, x, { width: +w }, {}, { x, z: 0, rot: 0 }));
    prj.modules.push(createModule('wall', x, { width: +w }, {}, { x, z: 0, rot: 0 }));
    x += +w;
  }
  return plan.length;
}

// ctx: { project, selected() -> module|null, select(id), commit(label) }
export function runCommand(input, ctx) {
  const text = norm(input);
  if (!text) return { ok: false, msg: '' };
  if (/^(помощь|справка|help|\?)$/.test(text)) return { ok: true, msg: HELP };
  const prj = ctx.project;
  const msgs = [];
  const sel = ctx.selected();
  const all = /(^|\s)(все|всех|всем)(\s|$)/.test(text);
  const targets = all ? prj.modules : sel ? [sel] : [];

  // Генерация кухни
  let m = text.match(/кухн\S*\s*(?:на\s*)?(\d{4})/);
  if (m) {
    const cnt = autoKitchen(prj, +m[1], !/без мойк/.test(text));
    return { ok: true, changed: true, msg: `Сгенерирована кухня ${m[1]} мм: ${cnt} нижних и ${cnt} верхних модулей` };
  }

  // Выбор модуля
  m = text.match(/^(?:модуль|выбери|выделить|выдели)\s*(\d+)$/);
  if (m) {
    const mod = prj.modules[+m[1] - 1];
    if (!mod) return { ok: false, msg: `Нет модуля ${m[1]}` };
    ctx.select(mod.id);
    return { ok: true, msg: `Выбран модуль ${m[1]}` };
  }

  if (/открой\s*фасад/.test(text)) {
    const list = all || !sel ? prj.modules : [sel];
    list.forEach((m) => setAllFronts(m, true));
    return { ok: true, changed: true, msg: 'Фасады открыты' };
  }
  if (/закрой\s*фасад/.test(text)) {
    const list = all || !sel ? prj.modules : [sel];
    list.forEach((m) => setAllFronts(m, false));
    return { ok: true, changed: true, msg: 'Фасады закрыты' };
  }
  if (/^(поверни|повернуть)(\s*на\s*90)?$/.test(text)) {
    if (!sel) return { ok: false, msg: 'Не выбран модуль' };
    sel.rot = ((+sel.rot || 0) + 90) % 360;
    return { ok: true, changed: true, msg: `Поворот ${sel.rot}°` };
  }

  // Удаление
  if (/^(удали|удалить|убери)\s*(все|всё)$/.test(text)) { prj.modules = []; return { ok: true, changed: true, msg: 'Все модули удалены' }; }
  if (/^(удали|удалить|убери)( модуль| его| это)?$/.test(text)) {
    if (!sel) return { ok: false, msg: 'Не выбран модуль' };
    prj.modules = prj.modules.filter((q) => q !== sel); ctx.select(null);
    return { ok: true, changed: true, msg: 'Модуль удалён' };
  }

  // Добавление модуля
  m = text.match(/^(добавь|добавить|поставь|вставь)\s+(.+)$/);
  if (m && !/полк/.test(m[2])) {
    const type = typeFromText(m[2]);
    if (!type) return { ok: false, msg: 'Не понял, какой модуль добавить. ' + HELP.split('\n')[0] };
    const w = num(m[2], /(\d{3,4})/);
    const mod = createModule(type, 0, w ? { width: w } : {});
    if (sel && !all) mod.mat = { ...sel.mat };
    mod.x = nextFreeX(prj, type);
    prj.modules.push(mod);
    ctx.select(mod.id);
    return { ok: true, changed: true, msg: `Добавлен: ${MODULE_TYPES[type].title} ${mod.p.width} (x=${mod.x})` };
  }

  // Столешница
  if (/столешниц/.test(text)) {
    if (/без столешниц|убери столешниц/.test(text)) { prj.settings.countertop = false; msgs.push('столешница отключена'); }
    else {
      const id = findMaterial(text, ['top']);
      prj.settings.countertop = true;
      if (id) { prj.settings.topMat = id; msgs.push(`столешница: ${MATERIALS[id].name}`); }
    }
  }

  if (!targets.length && !msgs.length) return { ok: false, msg: 'Выберите модуль кликом или добавьте «все» в команду' };

  for (const t of targets) {
    const p = t.p;
    const set = (k, v, label) => { if (v !== null && v !== undefined && !isNaN(v)) { p[k] = v; msgs.push(`${label} ${v}`); } };
    set('width', num(text, /ширин\S*\s*(\d+)/), 'ширина');
    set('height', num(text, /высот\S*\s*(\d+)/), 'высота');
    set('depth', num(text, /глубин\S*\s*(\d+)/), 'глубина');
    set('plinth', num(text, /цокол\S*\s*(\d+)/), 'цоколь');
    set('elev', num(text, /(?:от пола|подвес\S*|на высоте)\s*(\d+)/), 'от пола');
    set('antresol', num(text, /антресол\S*\s*(\d+)/), 'антресоль');

    let v = num(text, /(\d+|один|одна|одну|два|две|три|четыре|пять|шесть)\s*полк/) ?? num(text, /полок\s*(\d+)/);
    if (/без полок/.test(text)) v = 0;
    else if (/(добавь|еще|ещё|плюс)\s*(одну\s*)?полк/.test(text) && v === null) v = +p.shelves + 1;
    else if (/(убери|удали|минус)\s*(одну\s*)?полк/.test(text) && v === null) v = Math.max(0, +p.shelves - 1);
    set('shelves', v, 'полок');

    v = num(text, /(\d+|один|одна|два|две|три|четыре|пять|шесть)\s*ящик/) ?? num(text, /ящик\S*\s*(\d+)/);
    if (/без ящик/.test(text)) v = 0;
    if (v !== null) { set('drawers', v, 'ящиков'); if (v > 0) p.doors = 0; else if (p.doors === 0) p.doors = 'auto'; }

    v = num(text, /(\d+|одна|одну|две|два|три|четыре)\s*двер/) ?? num(text, /двер\S*\s*(\d+)/);
    if (/без двер/.test(text)) v = 0;
    if (v !== null) { set('doors', v, 'дверей'); if (v > 0) p.drawers = 0; }

    if (/петл\S*\s*(справа|право)/.test(text)) { p.hinge = 'right'; msgs.push('петли справа'); }
    if (/петл\S*\s*(слева|лево)/.test(text)) { p.hinge = 'left'; msgs.push('петли слева'); }
    if (/без штанг/.test(text)) { p.rod = false; msgs.push('без штанги'); }
    else if (/штанг/.test(text)) { p.rod = true; msgs.push('штанга'); }

    const mf = text.match(/фасад\S*\s+(.+?)(?:,|$| корпус| задн)/);
    if (mf) { const id = findMaterial(mf[1], ['mdf', 'ldsp']); if (id) { t.mat.front = id; msgs.push(`фасады: ${MATERIALS[id].name}`); } }
    const mc = text.match(/корпус\S*\s+(.+?)(?:,|$| фасад| задн)/);
    if (mc) { const id = findMaterial(mc[1], ['ldsp']); if (id) { t.mat.carcass = id; msgs.push(`корпус: ${MATERIALS[id].name}`); } }

    const mv = text.match(/(?:сдвинь|подвинь|передвинь|сместь|сдвинуть)\S*\s*(?:на\s*)?(\d+)\s*(влево|вправо|левее|правее)/);
    if (mv) { t.x = Math.max(0, +t.x + (/(влево|левее)/.test(mv[2]) ? -1 : 1) * +mv[1]); msgs.push(`x=${t.x}`); }
    if (/в начало/.test(text)) { t.x = 0; msgs.push('x=0'); }
  }

  if (!msgs.length) return { ok: false, msg: 'Команда не распознана. Введите «помощь».' };
  const uniq = [...new Set(msgs)];
  return { ok: true, changed: true, msg: (all ? 'Все модули: ' : '') + uniq.join(', ') };
}
