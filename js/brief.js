// Опросник ТЗ → готовый промпт для ИИ (агент строит кухню из библиотеки Самолет).

import { WALL_BY_CODE, WALL_ORDER, wallLength, wallTitle, CORNERS } from './walls.js';
import { samoletIndex } from './samolet.js';
import { FIXTURE_CATALOG } from './fixtures.js';

const STORE = 'furniture-constructor-brief';

export function defaultBrief() {
  return {
    shape: 'corner',          // linear | corner | u
    mainWall: 'A',
    secondWall: 'D',
    corner: 'A-D',
    fill: 'full',             // full | base_only | wall_only
    tall: 'right',            // none | left | right
    sink: 'yes',
    hob: 'yes',
    oven: 'yes',
    dishwasher: 'no',
    hood: 'yes',
    decor: 'KF',
    depth: '560',
    freeText: '',
    replace: true,
  };
}

export function loadBrief() {
  try { return { ...defaultBrief(), ...JSON.parse(localStorage.getItem(STORE) || '{}') }; }
  catch { return defaultBrief(); }
}

export function saveBrief(b) {
  localStorage.setItem(STORE, JSON.stringify(b));
}

function shapeTitle(s) {
  return ({ linear: 'линейная', corner: 'угловая (L)', u: 'П-образная (U)' })[s] || s;
}

function roomBlock(prj) {
  const R = prj.room;
  const walls = WALL_ORDER.map((L) => {
    const w = WALL_BY_CODE[L];
    return `  - ${w.title}: длина ${wallLength(R, L)} мм`;
  }).join('\n');
  const ops = (R.openings || []).map((op, i) => {
    const W = WALL_BY_CODE[op.wall] ? op.wall : (Object.values(WALL_BY_CODE).find((x) => x.id === op.wall)?.letter || op.wall);
    return `  - ${i + 1}. ${op.type === 'door' ? 'дверь' : 'окно'} на стене ${W}: отступ ${op.offset}, ширина ${op.width}`
      + (op.type === 'window' ? `, подоконник ${op.sill}, высота ${op.height}` : `, высота ${op.height}`);
  }).join('\n') || '  - нет';
  const fix = (prj.fixtures || []).map((f) => {
    const t = FIXTURE_CATALOG[f.type]?.title || f.type;
    return `  - ${t}${f.moduleId ? ' (привязан к модулю)' : ` @ ${f.x},${f.z}`}`;
  }).join('\n') || '  - нет';
  return `## Комната (текущий проект «${prj.name}»)
- Размер: X=${R.length} × Z=${R.depth} × H=${R.height} мм
- Стены (буквы, вид сверху, по часовой A→B→C→D):
${walls}
- Проёмы:
${ops}
- Коммуникации / техника уже в проекте:
${fix}
- Модулей сейчас: ${(prj.modules || []).length}`;
}

function assortmentHint() {
  const idx = samoletIndex();
  if (!idx) return 'Каталог Самолет не загружен — сначала откройте вкладку «Самолет».';
  const byCat = {};
  for (const it of idx.items) {
    if (it.geom !== 'full' && it.nHw == null) continue;
    byCat[it.cat] = (byCat[it.cat] || 0) + 1;
  }
  return `Каталог Самолет: ${idx.count} позиций (полная геометрия: ${idx.full}). По категориям: `
    + Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', ')
    + `. Файлы: furniture_constructor/data/samolet/index.json и m/<n>.json. Правила: furniture_constructor/data/rules/kitchen_layout.md`;
}

/** Собирает промпт, который пользователь вставляет в чат ИИ */
export function buildAiPrompt(prj, brief) {
  const corner = CORNERS[brief.corner];
  const lines = [];
  lines.push('# Задача: построить кухню в конструкторе из библиотеки Самолет');
  lines.push('');
  lines.push('Работай в репозитории Project_OOZ, проект веб-конструктора: `furniture_constructor/`.');
  lines.push('Собери сцену **из модулей Самолет** (`type: "lib"`, `createLibModule` / каталог `data/samolet`), не из процедурных base/wall.');
  lines.push('Результат сохрани в localStorage ключ `furniture-constructor-project` **или** выдай JSON проекта / патч, который я применю; предпочтительно — через правку демо/экспорт и инструкцию «Открыть» в UI.');
  lines.push('Либо выполни сборку скриптом Node/Python, который пишет `.json` проекта в `furniture_constructor/work/`.');
  lines.push('');
  lines.push(roomBlock(prj));
  lines.push('');
  lines.push('## ТЗ из опросника');
  lines.push(`- Форма: **${shapeTitle(brief.shape)}**`);
  lines.push(`- Основная стена (длинный ряд): **${wallTitle(brief.mainWall)}**`);
  if (brief.shape !== 'linear') {
    lines.push(`- Вторая стена: **${wallTitle(brief.secondWall)}**`);
    lines.push(`- Угол: **${corner?.title || brief.corner}**`);
  }
  lines.push(`- Ряды: ${({ full: 'нижние и верхние', base_only: 'только нижние', wall_only: 'только верхние' })[brief.fill]}`);
  lines.push(`- Пенал: ${({ none: 'нет', left: 'слева от ряда (начало основной стены)', right: 'справа от ряда (конец основной стены)' })[brief.tall]}`);
  lines.push(`- Мойка: ${brief.sink === 'yes' ? 'да (модуль Н-КМ + объект sink)' : 'нет'}`);
  lines.push(`- Варочная: ${brief.hob === 'yes' ? 'да' : 'нет'}; духовка: ${brief.oven === 'yes' ? 'да' : 'нет'}; ПММ: ${brief.dishwasher === 'yes' ? 'да' : 'нет'}; вытяжка: ${brief.hood === 'yes' ? 'да' : 'нет'}`);
  lines.push(`- Декор фасадов: **${brief.decor || 'KF'}**; глубина нижних: **${brief.depth}** мм (предпочтительно полная геометрия)`);
  lines.push(`- Существующие модули: ${brief.replace ? '**заменить** гарнитур (фикстуры коммуникаций сохранить, если возможно)' : 'дополнить к текущим'}`);
  if (brief.freeText.trim()) {
    lines.push('');
    lines.push('## Свободные пожелания');
    lines.push(brief.freeText.trim());
  }
  lines.push('');
  lines.push('## Ассортимент');
  lines.push(assortmentHint());
  lines.push('');
  lines.push('## Обязательные правила');
  lines.push('1. Стены только буквами A/B/C/D (см. `js/walls.js`). Offset вдоль стены — от начала стены по направлению «from» в WALL_BY_CODE.');
  lines.push('2. Читай и следуй `furniture_constructor/data/rules/kitchen_layout.md`.');
  lines.push('3. Подбирай артикулы из Самолет по ширине ряда; остаток добивай узкими модулями 150/200/300/400.');
  lines.push('4. В ответе кратко: список поставленных артикулов по стенам с offset; что проверить в UI.');
  lines.push('5. Не выдумывай артикулы — только из index.json (предпочтительно geom=full и нужный decor).');
  lines.push('');
  lines.push('## Пример формулировки пользователя (ориентир)');
  lines.push('«Построй кухню угловую с пеналом справа. Угол левый вдоль всей стены A. Модули и верхние, и нижние.»');
  return lines.join('\n');
}

