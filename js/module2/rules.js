/**
 * Мебельные правила конструирования (европейский корпусной стандарт).
 * Источники: Cubinets/FreeCAD Woodworking, KWAL/Blum, Базис / Бинарум.
 */

export const RULES_DEFAULT = {
  carcassT: 16,
  frontT: 18,
  backT: 3,
  frontGap: 2,
  shelfInset: 20,
  backRecess: 0,
  plinthH: 100,
  shelfMinClear: 180,
  shelfMaxSpan: 800,
  hingeFromEdge: 100,
  hingeCupFromEdge: 22,
  hingeCupInto: 12,
  drawerFrontGap: 2,
  drawerMinH: 100,
  drawerMaxH: 320,
  drawerSlideClear: 13,
  doorMaxW: 600,
  widthMin: 300, widthMax: 2400,
  heightMin: 350, heightMax: 2700,
  depthMin: 250, depthMax: 700,
  antresolMin: 300,
  rodDiam: 25,
};

/** @deprecated alias — мутабельная копия для сессии */
export let RULES = { ...RULES_DEFAULT };

export function cloneRules(src = RULES_DEFAULT) {
  return { ...src };
}

export function applyRules(patch) {
  RULES = { ...RULES, ...patch };
  return RULES;
}

export function resetRules() {
  RULES = { ...RULES_DEFAULT };
  return RULES;
}

export function hingeCount(h, rules = RULES) {
  if (h <= 900) return 2;
  if (h <= 1600) return 3;
  if (h <= 2000) return 4;
  return 5;
}

export const TYPOLOGIES = {
  base: {
    id: 'base', title: 'Тумба нижняя',
    defaults: { width: 600, height: 870, depth: 560, plinth: 100, elev: 0, shelves: 1, doors: 1, drawers: 0, sections: 1, antresol: 0, rod: false },
    row: 'floor',
  },
  base_drawers: {
    id: 'base_drawers', title: 'Тумба с ящиками',
    defaults: { width: 600, height: 870, depth: 560, plinth: 100, elev: 0, shelves: 0, doors: 0, drawers: 3, sections: 1, antresol: 0, rod: false },
    row: 'floor',
  },
  sink: {
    id: 'sink', title: 'Тумба под мойку',
    defaults: { width: 800, height: 870, depth: 560, plinth: 100, elev: 0, shelves: 0, doors: 2, drawers: 0, sections: 1, antresol: 0, rod: false, back: false },
    row: 'floor',
  },
  wall: {
    id: 'wall', title: 'Навесной шкаф',
    defaults: { width: 600, height: 720, depth: 300, plinth: 0, elev: 1450, shelves: 2, doors: 1, drawers: 0, sections: 1, antresol: 0, rod: false },
    row: 'wall',
  },
  tall: {
    id: 'tall', title: 'Пенал',
    defaults: { width: 600, height: 2100, depth: 560, plinth: 100, elev: 0, shelves: 4, doors: 1, drawers: 0, sections: 1, antresol: 0, rod: true },
    row: 'floor',
  },
  wardrobe: {
    id: 'wardrobe', title: 'Шкаф распашной',
    defaults: { width: 1200, height: 2400, depth: 600, plinth: 70, elev: 0, shelves: 3, doors: 2, drawers: 0, sections: 2, antresol: 400, rod: true },
    row: 'floor',
  },
};

export function validateModuleParams(p, rules = RULES) {
  const issues = [];
  const push = (level, code, msg) => issues.push({ level, code, msg });
  if (p.width < rules.widthMin || p.width > rules.widthMax) {
    push('error', 'width', `Ширина ${p.width} вне ${rules.widthMin}–${rules.widthMax} мм`);
  }
  if (p.height < rules.heightMin || p.height > rules.heightMax) {
    push('error', 'height', `Высота ${p.height} вне ${rules.heightMin}–${rules.heightMax} мм`);
  }
  if (p.depth < rules.depthMin || p.depth > rules.depthMax) {
    push('error', 'depth', `Глубина ${p.depth} вне ${rules.depthMin}–${rules.depthMax} мм`);
  }
  const doors = +p.doors || 0;
  const drawers = +p.drawers || 0;
  const sections = Math.max(1, Math.min(4, +p.sections || 1));
  const T = rules.carcassT;
  if (doors && drawers) {
    push('warn', 'mix', 'Двери и ящики вместе — фасады ящиков снизу, двери сверху');
  }
  if (doors > 0) {
    const dw = (p.width - rules.frontGap * (doors + 1)) / doors;
    if (dw > rules.doorMaxW) {
      push('warn', 'doorW', `Фасад ~${Math.round(dw)} мм шире ${rules.doorMaxW} мм — лучше больше створок`);
    }
  }
  if (drawers > 0) {
    const usable = p.height - (p.plinth || 0) - rules.frontGap * (drawers + 1);
    const fh = usable / drawers;
    if (fh < rules.drawerMinH) push('error', 'drawerH', `Высота ящика ~${Math.round(fh)} < ${rules.drawerMinH} мм`);
    if (fh > rules.drawerMaxH) push('warn', 'drawerH', `Высота ящика ~${Math.round(fh)} > ${rules.drawerMaxH} мм`);
  }
  const bayW = (p.width - T * (sections + 1)) / sections;
  if ((p.shelves || 0) > 0 && bayW > rules.shelfMaxSpan) {
    push('warn', 'shelfSpan', `Пролёт секции ~${Math.round(bayW)} > ${rules.shelfMaxSpan} мм — добавьте стойку`);
  }
  if (sections > 1 && bayW < 250) {
    push('warn', 'bay', `Секция ~${Math.round(bayW)} мм узкая (< 250)`);
  }
  const ant = +p.antresol || 0;
  if (ant > 0 && ant < rules.antresolMin) {
    push('warn', 'antresol', `Антресоль ${ant} мм < ${rules.antresolMin} мм`);
  }
  if (ant > 0 && ant > p.height * 0.45) {
    push('warn', 'antresol', 'Антресоль занимает > 45% высоты');
  }
  return issues;
}

export function hingeYs(y1, y2, rules = RULES) {
  const h = y2 - y1;
  const n = hingeCount(h, rules);
  const m = Math.min(rules.hingeFromEdge, h / 2 - 20);
  if (n <= 1) return [(y1 + y2) / 2];
  const a = y1 + m, b = y2 - m;
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

export function shelfPositions(yBot, yTop, count, t) {
  if (count <= 0 || yTop <= yBot + t) return [];
  const step = (yTop - yBot) / (count + 1);
  const out = [];
  for (let i = 1; i <= count; i++) out.push(yBot + step * i - t / 2);
  return out;
}

export function drawerFrontHeights(usableH, n, rules = RULES) {
  if (n <= 0) return [];
  const gaps = rules.frontGap * (n + 1);
  const free = usableH - gaps;
  const weights = Array.from({ length: n }, (_, i) => (i === 0 ? 1.25 : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((free * w) / sum));
}

/** Внутренние X-границы секций: [{x1,x2}, ...] в координатах модуля. */
export function sectionBays(W, sections, T) {
  const n = Math.max(1, Math.min(4, sections | 0));
  const inner = W - 2 * T;
  const bay = inner / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      i,
      x1: T + i * bay,
      x2: T + (i + 1) * bay,
      // стойка справа от секции (кроме последней) занимает T внутри стыка — полки до стойки
      shelfX1: T + i * bay + (i === 0 ? 0 : 0),
      shelfX2: T + (i + 1) * bay,
    });
  }
  // уточнение: между секциями стойка шириной T, полки не заходят на стойку
  if (n > 1) {
    for (let i = 0; i < n; i++) {
      const leftDiv = i > 0;
      const rightDiv = i < n - 1;
      out[i].shelfX1 = T + i * bay + (leftDiv ? T / 2 : 0);
      out[i].shelfX2 = T + (i + 1) * bay - (rightDiv ? T / 2 : 0);
      // проще: стойки на границах
      out[i].shelfX1 = i === 0 ? T : out[i].x1;
      out[i].shelfX2 = i === n - 1 ? W - T : out[i].x2;
    }
    // позиции стоек (центр стыка)
    for (let i = 1; i < n; i++) {
      out[i].divX = T + i * bay - T / 2;
    }
  }
  return out;
}

export function dividerXs(W, sections, T) {
  const n = Math.max(1, Math.min(4, sections | 0));
  if (n <= 1) return [];
  const inner = W - 2 * T;
  const bay = inner / n;
  const xs = [];
  for (let i = 1; i < n; i++) xs.push(Math.round(T + i * bay - T / 2));
  return xs;
}
