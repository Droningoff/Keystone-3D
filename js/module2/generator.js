/**
 * Генерация корпуса по типологии + правилам.
 * Поддержка: секции (стойки), антресоль, штанги по секциям, ящики+двери.
 */
import {
  RULES, hingeYs, shelfPositions, drawerFrontHeights,
  validateModuleParams, dividerXs,
} from './rules.js?v=20261028v2b';

const r1 = (v) => Math.round(v);

function Vp(key, name, role, z1, y1, z2, y2, x, mat, t, extra = {}) {
  return {
    key, name, role, orient: 'V',
    a1: z1, b1: y1, a2: z2, b2: y2, pos: x,
    mat, t: t ?? RULES.carcassT, butts: [null, null, null, null], grain: 'v', ...extra,
  };
}
function Hp(key, name, role, x1, z1, x2, z2, y, mat, t, extra = {}) {
  return {
    key, name, role, orient: 'H',
    a1: x1, b1: z1, a2: x2, b2: z2, pos: y,
    mat, t: t ?? RULES.carcassT, butts: [null, null, null, null], grain: 'u', ...extra,
  };
}
function Fp(key, name, role, x1, y1, x2, y2, z, mat, t, extra = {}) {
  return {
    key, name, role, orient: 'F',
    a1: x1, b1: y1, a2: x2, b2: y2, pos: z,
    mat, t, butts: [null, null, null, null], grain: 'v', ...extra,
  };
}

function addShelfPins(fittings, key, y, x1, x2, z0, zF, T) {
  const mid = (x1 + x2) / 2;
  for (const [sx, sz] of [
    [x1 + 2, z0 + 40], [x1 + 2, zF - 60],
    [x2 - 2, z0 + 40], [x2 - 2, zF - 60],
    [mid, z0 + 40], [mid, zF - 60],
  ].slice(0, 4)) {
    fittings.push({
      key: `psf_${key}_${Math.round(sx)}_${Math.round(sz)}`,
      catalogId: 'shelf_psf', name: 'Полкодержатель', mesh: 'shelfPin',
      x1: sx - 4, x2: sx + 4, y1: y + T / 2 - 4, y2: y + T / 2 + 4, z1: sz - 4, z2: sz + 4,
      panelKey: key,
    });
  }
}

/**
 * @param {object} spec { typology, p, mat, rules? }
 */
export function generateModule(spec) {
  const rules = spec.rules || RULES;
  const p = { ...spec.p };
  const mat = {
    carcass: spec.mat?.carcass || 'ldsp16_white',
    front: spec.mat?.front || 'mdf18_white_gloss',
    back: spec.mat?.back || 'hdf3_white',
  };
  const issues = validateModuleParams(p, rules);
  const panels = [];
  const fittings = [];
  const extras = [];

  const W = +p.width, H = +p.height, D = +p.depth;
  const pl = Math.max(0, +p.plinth || 0);
  const elev = +p.elev || 0;
  const T = rules.carcassT;
  const TF = rules.frontT;
  const TB = rules.backT;
  const g = rules.frontGap;
  const C = mat.carcass, F = mat.front, B = mat.back;
  const sections = Math.max(1, Math.min(4, +p.sections || 1));
  const antresol = Math.max(0, +p.antresol || 0);

  const y0 = elev;
  const yPlinth = y0 + pl;
  const yTop = y0 + H;
  const z0 = 0;
  const zF = D;
  const sideY1 = yPlinth;
  const isTallLike = spec.typology === 'wardrobe' || spec.typology === 'tall';

  // --- каркас ---
  panels.push(Vp('side_l', 'Боковина левая', 'carcass', z0, sideY1, zF, yTop, 0, C, T));
  panels.push(Vp('side_r', 'Боковина правая', 'carcass', z0, sideY1, zF, yTop, W - T, C, T));
  panels.push(Hp('bottom', 'Дно', 'carcass', T, z0, W - T, zF, yPlinth, C, T));

  if (isTallLike) {
    panels.push(Hp('top', 'Крыша', 'carcass', T, z0, W - T, zF, yTop - T, C, T));
  } else {
    const rh = 80;
    panels.push(Hp('rail_f', 'Царга передняя', 'carcass', T, zF - 100, W - T, zF, yTop - rh, C, T));
    panels.push(Hp('rail_b', 'Царга задняя', 'carcass', T, z0, W - T, z0 + 100, yTop - rh, C, T));
  }

  // стойки секций
  const divXs = dividerXs(W, sections, T);
  divXs.forEach((x, i) => {
    panels.push(Vp(`div_${i + 1}`, `Стойка ${i + 1}`, 'carcass', z0, sideY1, zF, yTop, x, C, T));
  });

  // границы секций для полок/штанг (внутренняя ниша между боками/стойками)
  const bays = [];
  for (let i = 0; i < sections; i++) {
    const xL = i === 0 ? T : divXs[i - 1] + T;
    const xR = i === sections - 1 ? W - T : divXs[i];
    bays.push({ i, x1: xL, x2: xR });
  }

  if (pl > 0) {
    panels.push(Fp('plinth', 'Цоколь', 'carcass', 0, y0, W, yPlinth, 40, C, T));
    for (let i = 0; i < 4; i++) {
      const x = i % 2 === 0 ? 50 : W - 50;
      const zz = i < 2 ? 50 : D - 50;
      fittings.push({
        key: `leg_${i + 1}`, catalogId: 'leg_plinth', name: 'Цокольная ножка', mesh: 'leg',
        x1: x - 20, x2: x + 20, y1: y0, y2: yPlinth, z1: zz - 20, z2: zz + 20,
      });
    }
  }

  if (p.back !== false) {
    panels.push(Fp('back', 'Задняя стенка', 'back', 0, sideY1, W, yTop, z0, B, TB));
  }

  // антресоль: горизонталь на yTop - antresol
  let fillTop = isTallLike ? yTop - T : yTop - 80;
  let fillBot = yPlinth + T;
  if (antresol > 0 && antresol < H - pl - 100) {
    const yAnt = yTop - antresol;
    panels.push(Hp('antresol', 'Антресоль', 'shelf', T, z0 + 10, W - T, zF - rules.shelfInset, yAnt, C, T));
    addShelfPins(fittings, 'antresol', yAnt, T, W - T, z0, zF, T);
    fillTop = yAnt;
    // двери антресоли отдельно? упрощённо — основные двери во всю высоту; антресоль внутри
  }

  // полки по секциям
  const shelfN = Math.max(0, +p.shelves || 0);
  for (const bay of bays) {
    const ys = shelfPositions(fillBot, fillTop, shelfN, T);
    ys.forEach((y, si) => {
      const key = `shelf_s${bay.i + 1}_${si + 1}`;
      panels.push(Hp(
        key, sections > 1 ? `Полка с${bay.i + 1}.${si + 1}` : 'Полка', 'shelf',
        bay.x1, z0 + 10, bay.x2, zF - rules.shelfInset, y, C, T,
      ));
      addShelfPins(fittings, key, y, bay.x1, bay.x2, z0, zF, T);
    });
  }

  // штанги
  if (p.rod) {
    const rodY = Math.min(fillTop - 40, Math.max(fillBot + 200, fillBot + (fillTop - fillBot) * 0.72));
    for (const bay of bays) {
      if (bay.x2 - bay.x1 < 280) continue;
      extras.push({
        type: 'rod',
        y: rodY,
        z: D * 0.45,
        x1: bay.x1 + 15,
        x2: bay.x2 - 15,
        bay: bay.i + 1,
      });
    }
  }

  // ящики (на всю ширину)
  const drawers = Math.max(0, +p.drawers || 0);
  let doorY1 = yPlinth + g;
  let doorY2 = yTop - g;

  if (drawers > 0) {
    const usable = Math.min(H - pl, doorY2 - doorY1);
    // если есть двери — ящики занимают нижнюю долю (~0.45)
    let drawersH = usable;
    let doors = +p.doors || 0;
    if (doors > 0) drawersH = Math.round(usable * 0.42);
    const heights = drawerFrontHeights(drawersH, drawers, rules);
    let y = yPlinth + g;
    heights.forEach((fh, i) => {
      const y1 = y, y2 = y + fh;
      const key = `drw${i + 1}_front`;
      panels.push(Fp(key, `Фасад ящика ${i + 1}`, 'front', g, y1, W - g, y2, zF, F, TF, {
        openable: 'drawer', openTravel: Math.min(450, D - 80),
      }));
      const midY = (y1 + y2) / 2;
      const travel = Math.min(450, D - 80);
      fittings.push({
        key: `slide_l_${i}`, catalogId: 'slide_ball', name: 'Направляющие', mesh: 'slide', side: 'left',
        x1: 8, x2: 20, y1: midY - 10, y2: midY + 10, z1: 40, z2: 40 + travel, panelKey: key,
      });
      fittings.push({
        key: `slide_r_${i}`, catalogId: 'slide_ball', name: 'Направляющие', mesh: 'slide', side: 'right',
        x1: W - 20, x2: W - 8, y1: midY - 10, y2: midY + 10, z1: 40, z2: 40 + travel, panelKey: key,
      });
      fittings.push({
        key: `h_drw_${i}`, catalogId: 'handle_128', name: 'Ручка', mesh: 'handle',
        x1: W / 2 - 64, x2: W / 2 + 64, y1: y2 - 50, y2: y2 - 30,
        z1: zF + TF, z2: zF + TF + 20, panelKey: key, vertical: false,
      });
      y = y2 + g;
    });
    doorY1 = y;
  }

  // двери
  let doors = +p.doors;
  if (doors === 'auto' || doors == null) doors = W > 600 ? 2 : 1;
  doors = Math.max(0, +doors || 0);
  if (spec.typology === 'base_drawers') doors = 0;

  if (doors > 0 && doorY2 > doorY1 + 80) {
    const hingeSide = p.hinge === 'right' ? 'right' : 'left';
    // если секций столько же сколько дверей — двери по секциям
    for (let j = 0; j < doors; j++) {
      const dw = (W - g * (doors + 1)) / doors;
      const x1 = r1(g + j * (dw + g));
      const x2 = r1(x1 + dw);
      const side = doors === 1 ? hingeSide : (j < doors / 2 ? 'left' : 'right');
      const key = `door_${j + 1}`;
      panels.push(Fp(key, doors > 1 ? `Дверь ${j + 1}` : 'Дверь', 'front', x1, doorY1, x2, doorY2, zF, F, TF, {
        openable: 'door', hinge: side,
      }));
      for (const y of hingeYs(doorY1, doorY2, rules)) {
        const hx = side === 'right' ? x2 - rules.hingeCupFromEdge : x1 + rules.hingeCupFromEdge;
        const cupInto = Math.min(rules.hingeCupInto, TF - 2);
        const hz2 = zF + cupInto;
        fittings.push({
          key: `hinge_${j}_${Math.round(y)}`, catalogId: 'hinge_sensys_110',
          name: 'Петля Sensys 110°', mesh: 'hinge', side,
          bazisFile: 'Петля Sensys 110.f3d', mount: 'pair',
          x1: hx - 21, x2: hx + 21, y1: y - 35, y2: y + 35, z1: hz2 - 60, z2: hz2,
          panelKey: key,
        });
      }
      const hy = spec.typology === 'wall' ? doorY1 + 90 : doorY2 - 90;
      const hxx = side === 'left' ? x2 - 40 : x1 + 40;
      fittings.push({
        key: `handle_${j}`, catalogId: 'handle_128', name: 'Ручка', mesh: 'handle',
        x1: hxx - 10, x2: hxx + 10, y1: hy - 64, y2: hy + 64,
        z1: zF + TF, z2: zF + TF + 20, panelKey: key, vertical: true, side,
      });
    }
  }

  return {
    panels,
    fittings,
    extras,
    issues,
    meta: {
      typology: spec.typology,
      title: spec.title || spec.typology,
      W, H, D, pl, elev, sections, antresol,
      rulesVersion: 2,
    },
  };
}
