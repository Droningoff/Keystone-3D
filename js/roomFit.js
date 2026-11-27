// Отчёт пригодности кухни: влезает ли гарнитур в помещение.
import { moduleBox, moduleLocalSize, moduleRow } from './model.js?v=20261110a';
import {
  isAdvanced, ensureAdvancedFields, ceilingHeightAt, footprintInsideRoom,
  cornerAngleDeg, planAtHeight, roomBounds, isWallCorner,
} from './roomGeom.js?v=20261127n';

/**
 * @returns {{ status: 'ok'|'warn'|'block', summary: string, items: Array<{level, code, text, moduleId?}> }}
 */
export function validateFit(prj) {
  const items = [];
  const room = prj.room || {};
  const fit = room.fit || {};
  const minPassage = +(fit.minPassage ?? 1000);
  const wallClear = +(fit.wallCabClearance ?? 40);
  const angleTol = +(fit.angleTolDeg ?? 1);
  const yRef = +(room.yRef ?? 900);
  const mods = prj.modules || [];

  if (isAdvanced(room)) ensureAdvancedFields(room);

  // 1. Габарит модулей vs контур + потолок
  mods.forEach((m, i) => {
    const b = moduleBox(m);
    const n = i + 1;
    const corners = [
      { x: b.x1, z: b.z1 }, { x: b.x2, z: b.z1 },
      { x: b.x1, z: b.z2 }, { x: b.x2, z: b.z2 },
    ];
    if (!footprintInsideRoom(room, corners, 5)) {
      items.push({ level: 'block', code: 'footprint', moduleId: m.id, text: `Модуль ${n} не помещается в контур комнаты` });
    }
    const hMin = Math.min(...corners.map((c) => ceilingHeightAt(room, c.x, c.z)));
    if (b.y2 > hMin + 0.5) {
      items.push({ level: 'block', code: 'ceiling', moduleId: m.id, text: `Модуль ${n} упирается в потолок (${Math.round(b.y2)} > ${Math.round(hMin)} мм)` });
    } else if (b.y2 > hMin - wallClear) {
      items.push({ level: 'warn', code: 'ceiling_gap', moduleId: m.id, text: `Модуль ${n}: зазор до потолка ${Math.round(hMin - b.y2)} мм < ${wallClear}` });
    }
  });

  // 2. Углы на yRef (столешница)
  if (isAdvanced(room) && room.planAtRef?.length >= 3) {
    const verts = planAtHeight(room, yRef);
    verts.forEach((v, i) => {
      if (!isWallCorner(room, i)) return;
      const ang = cornerAngleDeg(verts, i);
      if (Math.abs(ang - 90) > angleTol) {
        items.push({
          level: 'warn',
          code: 'corner_angle',
          text: `Угол у вершины ${i + 1} на ${yRef} мм: ${ang}° (нужен запил столешницы / нестандартный угол)`,
        });
      }
    });
    // сужение: площадь / глубина у стены
    const floorAng = room.planFloor.map((_, i) => cornerAngleDeg(room.planFloor, i));
    verts.forEach((_, i) => {
      if (!isWallCorner(room, i)) return;
      const a0 = floorAng[i];
      const a1 = cornerAngleDeg(verts, i);
      if (Math.abs(a1 - a0) > angleTol) {
        items.push({
          level: 'warn',
          code: 'wall_twist',
          text: `Стены у вершины ${i + 1}: угол на полу ${a0}°, на ${yRef} мм ${a1}° — проверить глубину ряда и свес`,
        });
      }
    });
  }

  // 3. Навесные / высокие модули vs потолок
  mods.forEach((m, i) => {
    const row = moduleRow(m);
    const { elev, h } = moduleLocalSize(m);
    const isHigh = row === 'wall' || elev >= 1000 || h >= 1800;
    if (!isHigh) return;
    const b = moduleBox(m);
    const cx = (b.x1 + b.x2) / 2, cz = (b.z1 + b.z2) / 2;
    const ch = ceilingHeightAt(room, cx, cz);
    const top = elev + h;
    if (top > ch - wallClear) {
      items.push({
        level: top > ch ? 'block' : 'warn',
        code: 'wall_cab',
        moduleId: m.id,
        text: `Модуль ${i + 1} (верхний/высокий): верх ${Math.round(top)} мм, потолок ${Math.round(ch)} мм`,
      });
    }
  });

  // 4. Проход перед фасадами (оценка по AABB комнаты / bounds)
  const bounds = roomBounds(room);
  const roomW = bounds.width || +room.length || 4000;
  const roomD = bounds.depth || +room.depth || 3500;
  const byRot = new Map();
  for (const m of mods) {
    const r = ((+m.rot % 360) + 360) % 360;
    const key = Math.round(r / 90) * 90;
    if (!byRot.has(key)) byRot.set(key, []);
    byRot.get(key).push(m);
  }
  for (const [rot, list] of byRot) {
    let maxDepth = 0;
    for (const m of list) {
      const { d } = moduleLocalSize(m);
      if (d > maxDepth) maxDepth = d;
    }
    // ряд у стены: доступный проход ≈ поперечный размер комнаты − глубина ряда
    const across = (rot === 0 || rot === 180) ? roomD : roomW;
    const passage = across - maxDepth;
    if (list.length && passage < minPassage) {
      items.push({
        level: passage < minPassage * 0.7 ? 'block' : 'warn',
        code: 'passage',
        text: `Проход перед рядом (rot ${rot}°): ~${Math.round(passage)} мм (норма ≥ ${minPassage})`,
      });
    }
  }

  // 5. Obstacles
  for (const ob of room.obstacles || []) {
    for (let i = 0; i < mods.length; i++) {
      const b = moduleBox(mods[i]);
      const ox2 = +ob.x + +ob.w, oz2 = +ob.z + +ob.d;
      const hit = Math.min(b.x2, ox2) > Math.max(b.x1, +ob.x)
        && Math.min(b.z2, oz2) > Math.max(b.z1, +ob.z)
        && Math.min(b.y2, +ob.y1) > Math.max(b.y1, +ob.y0);
      if (hit) {
        items.push({
          level: 'block',
          code: 'obstacle',
          moduleId: mods[i].id,
          text: `Модуль ${i + 1} пересекается с препятствием «${ob.name || 'короб'}»`,
        });
      }
    }
  }

  // 6. Режим advanced без модулей — всё равно показать углы/потолок
  if (!mods.length && isAdvanced(room)) {
    items.push({ level: 'ok', code: 'empty', text: 'Модулей нет — проверьте углы и потолок в расширенном режиме' });
  }

  const hasBlock = items.some((it) => it.level === 'block');
  const hasWarn = items.some((it) => it.level === 'warn');
  let status = 'ok';
  let summary = 'Кухня влезает';
  if (hasBlock) {
    status = 'block';
    summary = 'Кухня не влезает — есть блокирующие ошибки';
  } else if (hasWarn) {
    status = 'warn';
    summary = 'Кухня влезает с замечаниями';
  }

  const reportItems = items.filter((it) => it.level !== 'ok');
  return { status, summary, items: reportItems, yRef, minPassage };
}
