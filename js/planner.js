// Планировщик кухни: промпт → LLM → JSON-план → модули Самолет в проекте.

import { createLibModule } from './model.js';
import { createFixture } from './fixtures.js';
import { snapFixture } from './placement.js';
import { samoletIndex, libEntry, ensureLibGeoms, findLib } from './samolet.js';
import { placeOnWall, wallTitle } from './walls.js';
import { chat, extractJson } from './llm.js';
import { buildAiPrompt } from './brief.js';

function guessRole(art, cat) {
  const a = art || '';
  if (/^Н-КМ|^Н-КУ.*М1/.test(a) || /мойк/i.test(a)) return 'sink';
  if (/^Н-ДО|духов/i.test(a)) return 'oven';
  if (/^Н-ЯЩ|ящик/i.test(a)) return 'drawers';
  if (/^Н-КБ|^ВКБС|бутыл/i.test(a)) return 'bottle';
  if (/^Н-КУ|угл/i.test(a)) return 'corner';
  if (/^Н-ХД|^П-ПД|пенал/i.test(a) || cat === 'Пеналы') return 'tall';
  if (cat === 'Навесные' || /^В-|^ГВ-/.test(a)) return 'wall';
  if (cat === 'Нижние' || /^Н-/.test(a)) return 'base';
  return 'other';
}

/** Компактный ассортимент для промпта (не весь index) */
export function compactAssortment(brief) {
  const idx = samoletIndex();
  if (!idx) return [];
  const decor = brief.decor || 'KF';
  const depth = +brief.depth || 560;
  const out = [];
  for (const it of idx.items) {
    if (it.decor && it.decor !== decor) continue;
    // нижние/пеналы — близкая глубина; навесные — любые типичные
    const isWall = it.cat === 'Навесные';
    if (!isWall && Math.abs(+it.d - depth) > 15 && Math.abs(+it.d - 560) > 15 && Math.abs(+it.d - 570) > 15) continue;
    if (it.geom === 'box' && !/^Н-ХД|^П-ПД|^Н-ЯЩ/.test(it.art)) continue; // пеналы/ящики часто ещё box
    out.push({
      n: it.n,
      art: it.art,
      cat: it.cat,
      role: guessRole(it.art, it.cat),
      w: Math.round(it.w),
      h: Math.round(it.h),
      d: Math.round(it.d),
      hand: it.hand || '',
      full: it.geom === 'full' ? 1 : 0,
    });
  }
  // ограничиваем размер промпта: по роли не больше ~40 позиций
  const byRole = {};
  for (const r of out) {
    (byRole[r.role] ||= []).push(r);
  }
  const capped = [];
  for (const list of Object.values(byRole)) {
    list.sort((a, b) => b.full - a.full || a.w - b.w);
    capped.push(...list.slice(0, 40));
  }
  return capped;
}

function assortmentTable(rows) {
  const lines = ['n|role|w|h|d|hand|full|art'];
  for (const r of rows) {
    lines.push([r.n, r.role, r.w, r.h, r.d, r.hand || '-', r.full, r.art].join('|'));
  }
  return lines.join('\n');
}

const LAYOUT_RULES = `Правила:
- Стены: A задняя z=0, B правая, C передняя, D левая. Offset от начала стены (A от левого края, B от заднего, C от правого, D от переднего).
- Модули только из таблицы ассортимента (поле n или точный art). Не выдумывай артикулы.
- Заполни указанные стены по ТЗ без щелей; остаток 150–400 мм — узкими модулями.
- Пенал справа = больший offset на основной стене; слева = offset 0.
- Нижние: role base/sink/oven/drawers/corner/bottle/tall; верхние: role wall. elev не указывай — поставится сам.
- Ответ СТРОГО один JSON без пояснений до/после (можно в \`\`\`json):
{
  "modules": [
    { "n": 432, "wall": "A", "offset": 0, "row": "base" },
    { "n": 12, "wall": "A", "offset": 600, "row": "wall" }
  ],
  "fixtures": [
    { "type": "sink_single", "module": 0 },
    { "type": "mixer_chrome", "module": 0 },
    { "type": "hob_60", "module": 1 },
    { "type": "oven_60", "module": 1 },
    { "type": "hood_60", "module": 2 }
  ],
  "notes": "кратко"
}
module в fixtures — индекс в массиве modules (с нуля).
Типы fixtures: sink_single, mixer_chrome, hob_60, oven_60, dishwasher_60, hood_60, microwave.`;

export function buildLlmMessages(prj, brief) {
  const assort = compactAssortment(brief);
  const tz = buildAiPrompt(prj, brief);
  const user = [
    'Построй план кухни по ТЗ ниже. Верни только JSON.',
    '',
    tz,
    '',
    LAYOUT_RULES,
    '',
    `Ассортимент (decor=${brief.decor}, отфильтрован, ${assort.length} поз.):`,
    assortmentTable(assort),
  ].join('\n');

  return [
    {
      role: 'system',
      content: 'Ты планировщик корпусной мебели. Отвечаешь только валидным JSON-планом расстановки модулей Самолет. Без markdown-текста вне JSON.',
    },
    { role: 'user', content: user },
  ];
}

function resolveEntry(spec) {
  if (spec.n != null && libEntry(spec.n)) return libEntry(spec.n);
  if (spec.art) {
    const idx = samoletIndex();
    const hit = idx?.items.find((i) => i.art === spec.art);
    if (hit) return hit;
    // неточный поиск
    return findLib(new RegExp('^' + spec.art.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), null, null, null);
  }
  return null;
}

/**
 * Применить JSON-план к проекту (мутирует или создаёт новый).
 * @returns {{ project, report: string[] }}
 */
export async function applyPlan(prj, plan, brief = {}) {
  const report = [];
  if (!plan?.modules?.length) throw new Error('План без modules');

  const next = structuredClone(prj);
  if (brief.replace !== false) {
    next.modules = [];
    next.fixtures = (prj.fixtures || []).filter((f) => !f.moduleId && /^(socket_|pipe_)/.test(f.type));
  }

  const placed = [];
  for (const spec of plan.modules) {
    const e = resolveEntry(spec);
    if (!e) {
      report.push(`пропуск: не найден ${spec.n ?? spec.art}`);
      continue;
    }
    const pos = placeOnWall(next.room, spec.wall || 'A', spec.offset || 0, e.box[3] - e.box[0], e.box[5] - e.box[2]);
    // верхний ряд / антресоль
    let elev;
    if (spec.row === 'wall' || (spec.elev == null && e.cat === 'Навесные')) elev = spec.elev ?? 1450;
    else if (spec.elev != null) elev = +spec.elev;
    const m = createLibModule(e, { ...pos, ...(elev != null ? { elev } : {}) });
    if (spec.name) m.name = spec.name;
    next.modules.push(m);
    placed.push(m);
    report.push(`${wallTitle(spec.wall)} +${spec.offset || 0}: ${e.art}`);
  }

  await ensureLibGeoms(next.modules);

  for (const fx of plan.fixtures || []) {
    const host = placed[fx.module];
    if (!host) {
      report.push(`fixture ${fx.type}: нет модуля #${fx.module}`);
      continue;
    }
    const type = fx.type;
    const s = snapFixture(next, type, { x: host.x + host.p.width / 2, y: 0, z: 200 }, { moduleId: host.id });
    const { module: _m, ...fields } = s;
    next.fixtures.push({ ...createFixture(type), ...fields });
    report.push(`+ ${type} → ${host.lib.art}`);
  }

  if (plan.notes) report.push('notes: ' + plan.notes);
  return { project: next, report };
}

/** Полный цикл: LLM → план → проект */
export async function planKitchenWithLlm(prj, brief, settings, onStatus) {
  onStatus?.('Сборка промпта…');
  const messages = buildLlmMessages(prj, brief);
  onStatus?.('Запрос к модели…');
  const text = await chat(messages, settings, onStatus);
  onStatus?.('Разбор JSON…');
  const plan = extractJson(text);
  onStatus?.('Расстановка модулей…');
  const result = await applyPlan(prj, plan, brief);
  return { ...result, plan, raw: text };
}
