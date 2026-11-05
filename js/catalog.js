// Условный каталог. Поле bazis — наименование материала так, как оно заведено в базе материалов Базиса
// (наименование и артикул разделяются символом \r). Заменить на реальные значения производства.

export const MATERIALS = {
  ldsp16_white:      { name: 'ЛДСП Белый 16',              bazis: 'ЛДСП Белый 16',              t: 16, price: 1150, color: 0xf1f1ee, kind: 'ldsp', kw: ['бел'] },
  ldsp16_sonoma:     { name: 'ЛДСП Дуб Сонома 16',         bazis: 'ЛДСП Дуб Сонома 16',         t: 16, price: 1250, color: 0xc8a578, kind: 'ldsp', kw: ['дуб', 'сонома'] },
  ldsp16_graphite:   { name: 'ЛДСП Графит 16',             bazis: 'ЛДСП Графит 16',             t: 16, price: 1250, color: 0x4b4e53, kind: 'ldsp', kw: ['граф', 'сер', 'антрац', 'темн'] },
  ldsp16_walnut:     { name: 'ЛДСП Орех 16',               bazis: 'ЛДСП Орех 16',               t: 16, price: 1300, color: 0x7a5236, kind: 'ldsp', kw: ['орех'] },
  mdf18_white_gloss: { name: 'МДФ Белый глянец 18',        bazis: 'МДФ Белый глянец 18',        t: 18, price: 5200, color: 0xffffff, kind: 'mdf', gloss: true, kw: ['мдф', 'глянец', 'бел'] },
  mdf18_sage:        { name: 'МДФ Шалфей матовый 18',      bazis: 'МДФ Шалфей матовый 18',      t: 18, price: 5200, color: 0x9caf9a, kind: 'mdf', kw: ['мдф', 'шалф', 'зелен', 'олив'] },
  mdf18_cashmere:    { name: 'МДФ Кашемир матовый 18',     bazis: 'МДФ Кашемир матовый 18',     t: 18, price: 5200, color: 0xd8cbb8, kind: 'mdf', kw: ['мдф', 'кашем', 'беж'] },
  hdf3_white:        { name: 'ХДФ Белый 3',                bazis: 'ХДФ Белый 3',                t: 3,  price: 320,  color: 0xeeeeee, kind: 'hdf', kw: ['хдф'] },
  top38_oak:         { name: 'Столешница Дуб 38',          bazis: 'Столешница Дуб 38',          t: 38, price: 3800, color: 0xa47b4f, kind: 'top', kw: ['дуб'] },
  top38_stone:       { name: 'Столешница Камень серый 38', bazis: 'Столешница Камень серый 38', t: 38, price: 4200, color: 0x8e9093, kind: 'top', kw: ['камен', 'мрамор', 'сер'] },
};

// price — руб/м.п.
export const EDGES = {
  e04: { name: 'Кромка ПВХ 0.4', bazis: 'Кромка ПВХ 0.4', sign: '0.4', t: 0.4, w: 19, price: 12 },
  e2:  { name: 'Кромка ПВХ 2',   bazis: 'Кромка ПВХ 2',   sign: '2',   t: 2,   w: 19, price: 32 },
};

// price — руб/шт. Полный каталог с артикулами Самолета: data/hardware_catalog.json
export const HARDWARE = {
  hinge:     { name: 'Петля Sensys 110°', price: 280 },
  slide:     { name: 'Направляющие шариковые (пара)', price: 900 },
  handle:    { name: 'Ручка-скоба 128', price: 300 },
  leg:       { name: 'Цокольная ножка', price: 60 },
  hanger:    { name: 'Навеска SCARPI-4', price: 180 },
  confirmat: { name: 'Конфирмат 6.4×50', price: 4 },
  shelfPin:  { name: 'Полкодержатель с фиксатором', price: 15 },
  rod:       { name: 'Штанга овальная', price: 350 },
  rodHolder: { name: 'Штангодержатель', price: 40 },
  tipon:     { name: 'Комплект TIP-ON-1', price: 450 },
};

export const PRICING = {
  boardWaste: 0.2,  // запас на раскрой
  edgeWaste: 0.1,
  labor: 0.35,      // работа и накладные, доля от материалов
};

export const matsByKind = (...kinds) =>
  Object.entries(MATERIALS).filter(([, m]) => kinds.includes(m.kind)).map(([id, m]) => ({ id, ...m }));
