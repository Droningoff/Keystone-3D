import { MATERIALS, EDGES, HARDWARE, PRICING } from './catalog.js';
import { panelSize, buttLength, isLib } from './model.js';
import { libSpec } from './samolet.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// Материал детали Самолета → ценовой аналог из каталога (цены у исходных моделей нет)
function libMatPrice(name, front) {
  const n = (name || '').toLowerCase();
  if (front) return MATERIALS.mdf18_white_gloss?.price ?? 0;
  if (/двп|хдф|hdf/.test(n)) return MATERIALS.hdf3_white?.price ?? 0;
  return MATERIALS.ldsp16_white?.price ?? 0;
}

function itemCost(it) {
  let mat = 0, edge = 0, hw = 0;
  if (isLib(it.module)) {
    for (const p of libSpec(it.module).panels) mat += (p.l * p.w) / 1e6 * libMatPrice(p.mat, p.front) * (1 + PRICING.boardWaste);
  } else {
    for (const p of it.panels) {
      const { L, W } = panelSize(p);
      mat += (L * W) / 1e6 * MATERIALS[p.mat].price * (1 + PRICING.boardWaste);
      p.butts.forEach((e, i) => { if (e) edge += buttLength(p, i) / 1000 * EDGES[e].price * (1 + PRICING.edgeWaste); });
    }
    for (const [k, q] of Object.entries(it.hw)) hw += q * HARDWARE[k].price;
  }
  const base = mat + edge + hw;
  return { mat, edge, hw, labor: base * PRICING.labor, total: base * (1 + PRICING.labor) };
}

export function computeSpec(prj, build) {
  const details = [], mats = {}, edges = {}, hw = {}, modules = [];
  const libMats = {}, libHw = {};
  for (const it of build.items) {
    const groups = new Map();
    if (isLib(it.module)) {
      const sp = libSpec(it.module);
      for (const p of sp.panels) {
        const edgeMarks = p.butts ? `${p.butts} кр.` : '—';
        const key = [p.name, p.l, p.w, p.t, p.mat, edgeMarks].join('|');
        const g = groups.get(key);
        if (g) g.qty++; else groups.set(key, { module: it.index, name: p.name, art: p.art || '', L: r2(p.l), W: r2(p.w), T: r2(p.t), mat: p.mat, edges: edgeMarks, qty: 1 });
        const lm = libMats[p.mat] || (libMats[p.mat] = { area: 0, price: libMatPrice(p.mat, p.front) });
        lm.area += (p.l * p.w) / 1e6;
      }
      for (const h of sp.hw) {
        const k = h.art ? `${h.name}|${h.art}` : h.name;
        const r = libHw[k] || (libHw[k] = { name: h.name, art: h.art, qty: 0 });
        r.qty += h.qty;
      }
    } else {
      for (const p of it.panels) {
        const { L, W, T } = panelSize(p);
        const edgeMarks = p.butts.map((e) => (e ? EDGES[e].sign : '—')).join(' / ');
        const key = [p.name, L, W, T, p.mat, edgeMarks].join('|');
        const g = groups.get(key);
        if (g) g.qty++; else groups.set(key, { module: it.index, name: p.name, art: '', L: r2(L), W: r2(W), T, mat: MATERIALS[p.mat].name, edges: edgeMarks, qty: 1 });
        mats[p.mat] = (mats[p.mat] || 0) + (L * W) / 1e6;
        p.butts.forEach((e, i) => { if (e) edges[e] = (edges[e] || 0) + buttLength(p, i) / 1000; });
      }
      for (const [k, q] of Object.entries(it.hw)) hw[k] = (hw[k] || 0) + q;
    }
    details.push(...groups.values());
    const c = itemCost(it);
    const m = it.module;
    modules.push({
      index: it.index, title: it.title, code: m?.lib?.code || '', art: m?.lib?.art || '',
      size: m ? `${m.p.width}×${m.p.height}×${m.p.depth}` : `${it.panels[0].a2 - it.panels[0].a1}×${it.panels[0].t}`,
      panels: isLib(m) ? libSpec(m).panels.length : it.panels.length, cost: Math.round(c.total),
    });
  }
  const matRows = Object.entries(mats).map(([id, a]) => ({ id, name: MATERIALS[id].name, unit: 'м²', qty: r3(a), qtyWaste: r3(a * (1 + PRICING.boardWaste)), price: MATERIALS[id].price, sum: Math.round(a * (1 + PRICING.boardWaste) * MATERIALS[id].price) }));
  for (const [name, v] of Object.entries(libMats)) {
    matRows.push({ id: name, name, unit: 'м²', qty: r3(v.area), qtyWaste: r3(v.area * (1 + PRICING.boardWaste)), price: v.price, sum: Math.round(v.area * (1 + PRICING.boardWaste) * v.price) });
  }
  const edgeRows = Object.entries(edges).map(([id, l]) => ({ id, name: EDGES[id].name, unit: 'м', qty: r2(l), qtyWaste: r2(l * (1 + PRICING.edgeWaste)), price: EDGES[id].price, sum: Math.round(l * (1 + PRICING.edgeWaste) * EDGES[id].price) }));
  const hwRows = Object.entries(hw).map(([id, q]) => ({ id, art: '', name: HARDWARE[id].name, unit: 'шт', qty: q, qtyWaste: q, price: HARDWARE[id].price, sum: q * HARDWARE[id].price }));
  for (const r of Object.values(libHw)) {
    hwRows.push({ id: r.art || r.name, art: r.art || '', name: r.name, unit: 'шт', qty: r.qty, qtyWaste: r.qty, price: 0, sum: 0 });
  }
  const sumMat = [...matRows, ...edgeRows, ...hwRows].reduce((s, r) => s + r.sum, 0);
  const labor = Math.round(sumMat * PRICING.labor);
  return { details, matRows, edgeRows, hwRows, modules, sumMat, labor, total: sumMat + labor, panelCount: build.items.reduce((s, it) => s + it.panels.length, 0) };
}

export function specToCSV(spec) {
  const esc = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['Модуль', 'Деталь', 'Поз.', 'Длина', 'Ширина', 'Толщина', 'Материал', 'Кромка (эл.0/1/2/3)', 'Кол-во']];
  for (const d of spec.details) rows.push([d.module, d.name, d.art, d.L, d.W, d.T, d.mat, d.edges, d.qty]);
  rows.push([]);
  rows.push(['Материал', 'Артикул', 'Ед.', 'Кол-во', 'С запасом', 'Цена', 'Сумма']);
  for (const r of [...spec.matRows, ...spec.edgeRows, ...spec.hwRows]) rows.push([r.name, r.art || '', r.unit, r.qty, r.qtyWaste, r.price, r.sum]);
  rows.push(['Итого материалы', '', '', '', '', '', spec.sumMat]);
  rows.push(['Работа', '', '', '', '', '', spec.labor]);
  rows.push(['Всего', '', '', '', '', '', spec.total]);
  return rows.map((r) => r.map(esc).join(';')).join('\r\n');
}

// Структура для загрузки заказа в 1С (HTTP-сервис или обработка загрузки)
export function specTo1C(prj, spec) {
  return {
    Формат: 'FurnitureConstructor/1',
    ДатаВыгрузки: new Date().toISOString(),
    Проект: prj.name,
    Помещение: { ШиринаСтены: prj.room.width, Высота: prj.room.height },
    Изделия: spec.modules.map((m) => ({ Номер: m.index, Наименование: m.title, Артикул: m.art, Код: m.code, Габариты: m.size, КоличествоДеталей: m.panels, Цена: m.cost })),
    Материалы: spec.matRows.map((r) => ({ Код: r.id, Наименование: r.name, ЕдиницаИзмерения: r.unit, Количество: r.qtyWaste, Цена: r.price, Сумма: r.sum })),
    Кромка: spec.edgeRows.map((r) => ({ Код: r.id, Наименование: r.name, ЕдиницаИзмерения: r.unit, Количество: r.qtyWaste, Цена: r.price, Сумма: r.sum })),
    Фурнитура: spec.hwRows.map((r) => ({ Код: r.id, Артикул: r.art || '', Наименование: r.name, ЕдиницаИзмерения: r.unit, Количество: r.qty, Цена: r.price, Сумма: r.sum })),
    Детали: spec.details.map((d) => ({ Изделие: d.module, Наименование: d.name, Позиция: d.art, Длина: d.L, Ширина: d.W, Толщина: d.T, Материал: d.mat, Кромка: d.edges, Количество: d.qty })),
    СуммаМатериалов: spec.sumMat,
    СуммаРабот: spec.labor,
    СуммаВсего: spec.total,
  };
}
