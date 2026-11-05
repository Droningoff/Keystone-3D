// Процедурная фурнитура для сцены (пока нет TriData из Базиса).
// AABB из каталога = gab в СК .b3d; меш обязан оставаться внутри AABB,
// иначе петли «вылезают» за фасад, а ножки — внутрь корпуса.

import * as THREE from 'three';

const _geoCache = new Map();

function cachedGeo(key, factory) {
  if (!_geoCache.has(key)) _geoCache.set(key, factory());
  return _geoCache.get(key);
}

/**
 * Чашечная петля Sensys-like (мм).
 * Локально: планка на −X (боковина), чашка Ø35 смотрит в +Z (в фасад).
 * Правая — зеркало по X (scale.x = -1), его нельзя сбрасывать в fitIntoBox.
 */
function cupHingeGroup(mat, side /* 'left'|'right' */) {
  const g = new THREE.Group();
  const chrome = mat.clone();
  chrome.color = new THREE.Color(0xd8dde3);
  chrome.metalness = 0.92;
  chrome.roughness = 0.18;
  const dark = mat.clone();
  dark.color = new THREE.Color(0x5c636c);
  dark.metalness = 0.75;
  dark.roughness = 0.35;

  // ответная планка на боковине
  const plate = new THREE.Mesh(cachedGeo('h_plate3', () => new THREE.BoxGeometry(2.2, 52, 48)), chrome);
  plate.position.set(-1.1, 0, 2);
  g.add(plate);
  const wing = new THREE.Mesh(cachedGeo('h_wing3', () => new THREE.BoxGeometry(8, 18, 46)), chrome);
  wing.position.set(3, 0, 2);
  g.add(wing);

  // рычаг / корпус
  const arm = new THREE.Mesh(cachedGeo('h_arm3', () => new THREE.BoxGeometry(28, 14, 22)), chrome);
  arm.position.set(16, 0, 6);
  g.add(arm);
  const neck = new THREE.Mesh(cachedGeo('h_neck3', () => new THREE.BoxGeometry(16, 12, 16)), chrome);
  neck.position.set(24, 0, 18);
  g.add(neck);

  const joint = new THREE.Mesh(cachedGeo('h_joint3', () => new THREE.CylinderGeometry(5.5, 5.5, 12, 20)), dark);
  joint.rotation.z = Math.PI / 2;
  joint.position.set(22, 0, 16);
  g.add(joint);

  // чашка Ø35
  const cup = new THREE.Mesh(
    cachedGeo('h_cup3', () => new THREE.CylinderGeometry(17.5, 17.5, 12, 40)),
    chrome,
  );
  cup.rotation.x = Math.PI / 2;
  cup.position.set(20, 0, 36);
  g.add(cup);
  const cupHole = new THREE.Mesh(
    cachedGeo('h_cuphole3', () => new THREE.CylinderGeometry(13.5, 13.5, 3, 40)),
    dark,
  );
  cupHole.rotation.x = Math.PI / 2;
  cupHole.position.set(20, 0, 31);
  g.add(cupHole);
  const rim = new THREE.Mesh(
    cachedGeo('h_rim3', () => new THREE.TorusGeometry(17.5, 1.4, 10, 40)),
    chrome,
  );
  rim.position.set(20, 0, 42);
  g.add(rim);
  // винты чашки
  for (const dy of [-10, 10]) {
    const sc = new THREE.Mesh(cachedGeo('h_screw3', () => new THREE.CylinderGeometry(2.2, 2.2, 4, 10)), dark);
    sc.rotation.x = Math.PI / 2;
    sc.position.set(20, dy, 42.5);
    g.add(sc);
  }

  g.userData.hingeSide = side === 'right' ? 'right' : 'left';
  if (side === 'right') g.scale.x = -1;
  return g;
}

/**
 * Посадка петли в gab .b3d: натуральный размер (мм), без «сплющивания» в куб.
 * Планка к боковине (min/max X), чашка к фасаду (max Z), по центру по Y.
 */
function placeHingeInGab(obj, box, side, boost = 1) {
  const sx = side === 'right' ? -1 : 1;
  obj.position.set(0, 0, 0);
  obj.scale.set(sx, 1, 1);
  obj.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(obj);
  const size = bb.getSize(new THREE.Vector3());
  const roomX = Math.max(8, box.x2 - box.x1);
  const roomY = Math.max(8, box.y2 - box.y1);
  const roomZ = Math.max(8, box.z2 - box.z1);
  // вписать в gab; boost ≤ 1.15 и не больше fit (иначе превью «раздувает» петлю за габарит)
  const fit = Math.min(1, roomX / Math.max(size.x, 1), roomY / Math.max(size.y, 1), roomZ / Math.max(size.z, 1)) * 0.92;
  const k = fit * Math.min(1.15, Math.max(1, +boost || 1));
  obj.scale.set(sx * k, k, k);
  obj.updateMatrixWorld(true);
  bb = new THREE.Box3().setFromObject(obj);
  // планка к боковине, чашка к max Z (внутренняя глубина фасада — задаётся gab снаружи)
  if (side === 'right') obj.position.x += box.x2 - bb.max.x;
  else obj.position.x += box.x1 - bb.min.x;
  obj.position.y += (box.y1 + box.y2) / 2 - (bb.min.y + bb.max.y) / 2;
  obj.position.z += box.z2 - bb.max.z;
  // жёстко удержать внутри AABB по всем осям
  obj.updateMatrixWorld(true);
  bb = new THREE.Box3().setFromObject(obj);
  if (bb.max.z > box.z2) obj.position.z -= (bb.max.z - box.z2);
  if (bb.min.z < box.z1) obj.position.z += (box.z1 - bb.min.z);
  if (bb.max.x > box.x2) obj.position.x -= (bb.max.x - box.x2);
  if (bb.min.x < box.x1) obj.position.x += (box.x1 - bb.min.x);
  if (bb.max.y > box.y2) obj.position.y -= (bb.max.y - box.y2);
  if (bb.min.y < box.y1) obj.position.y += (box.y1 - bb.min.y);
}

/** Цокольная ножка: стойка + пятка. Локально пятка у y≈0, верх у y≈82. */
function legGroup(mat) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(cachedGeo('leg_post', () => new THREE.CylinderGeometry(12, 14, 80, 12)), mat);
  post.position.y = 40;
  g.add(post);
  const foot = new THREE.Mesh(cachedGeo('leg_foot', () => new THREE.CylinderGeometry(18, 18, 6, 16)), mat);
  foot.position.y = 3;
  g.add(foot);
  const mount = new THREE.Mesh(cachedGeo('leg_mount', () => new THREE.BoxGeometry(40, 4, 40)), mat);
  mount.position.y = 82;
  g.add(mount);
  return g;
}

/** Навеска: корпус + регулировочный винт. */
function hangerGroup(mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(cachedGeo('hg_body', () => new THREE.BoxGeometry(12, 40, 55)), mat);
  g.add(body);
  const flange = new THREE.Mesh(cachedGeo('hg_flange', () => new THREE.BoxGeometry(3, 44, 70)), mat);
  flange.position.x = -7;
  g.add(flange);
  const screw = new THREE.Mesh(cachedGeo('hg_screw', () => new THREE.CylinderGeometry(3, 3, 30, 10)), mat);
  screw.rotation.z = Math.PI / 2;
  screw.position.set(10, 0, 0);
  g.add(screw);
  return g;
}

/** Вписать объект в AABB (масштаб + центр). */
function fitIntoBox(obj, box) {
  obj.position.set(0, 0, 0);
  obj.scale.set(1, 1, 1);
  obj.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  bb.getSize(size);
  if (size.x < 1e-3 || size.y < 1e-3 || size.z < 1e-3) return;
  const sx = box.x2 - box.x1, sy = box.y2 - box.y1, sz = box.z2 - box.z1;
  const k = Math.min(sx / size.x, sy / size.y, sz / size.z) * 0.92;
  obj.scale.setScalar(k);
  obj.updateMatrixWorld(true);
  const bb2 = new THREE.Box3().setFromObject(obj);
  const c = new THREE.Vector3();
  bb2.getCenter(c);
  obj.position.set(
    (box.x1 + box.x2) / 2 - c.x,
    (box.y1 + box.y2) / 2 - c.y,
    (box.z1 + box.z2) / 2 - c.z,
  );
}

/**
 * Ножка: пятка на box.y1, верх на box.y2 (не выше низа корпуса).
 * Не центрируем по высоте — иначе стойка уезжает внутрь тумбы.
 */
function placeLegOnFloor(obj, box) {
  obj.position.set(0, 0, 0);
  obj.scale.set(1, 1, 1);
  obj.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  bb.getSize(size);
  const th = Math.max(50, box.y2 - box.y1);
  const kH = th / Math.max(size.y, 1);
  const kXZ = Math.min(
    (box.x2 - box.x1) / Math.max(size.x, 1),
    (box.z2 - box.z1) / Math.max(size.z, 1),
    1.2,
  ) * 0.9;
  obj.scale.set(kXZ, kH, kXZ);
  obj.updateMatrixWorld(true);
  bb = new THREE.Box3().setFromObject(obj);
  obj.position.set(
    (box.x1 + box.x2) / 2 - (bb.min.x + bb.max.x) / 2,
    box.y1 - bb.min.y,
    (box.z1 + box.z2) / 2 - (bb.min.z + bb.max.z) / 2,
  );
}

function hingeSideFromBox(box, moduleWidth) {
  const cx = (box.x1 + box.x2) / 2;
  if (moduleWidth > 0) return cx < moduleWidth / 2 ? 'left' : 'right';
  return cx < 200 ? 'left' : 'right';
}

function handleGroup(mat, vertical = true) {
  const g = new THREE.Group();
  const chrome = mat.clone();
  chrome.color = new THREE.Color(0xc8ced6);
  chrome.metalness = 0.85;
  chrome.roughness = 0.25;
  const bar = new THREE.Mesh(
    cachedGeo(vertical ? 'hndl_v' : 'hndl_h', () => new THREE.BoxGeometry(vertical ? 12 : 128, vertical ? 128 : 12, 10)),
    chrome,
  );
  bar.position.z = 8;
  g.add(bar);
  const st1 = new THREE.Mesh(cachedGeo('hndl_st', () => new THREE.CylinderGeometry(4, 4, 18, 12)), chrome);
  st1.rotation.x = Math.PI / 2;
  st1.position.set(vertical ? 0 : -50, vertical ? -40 : 0, 0);
  g.add(st1);
  const st2 = st1.clone();
  st2.position.set(vertical ? 0 : 50, vertical ? 40 : 0, 0);
  g.add(st2);
  return g;
}

function slideGroup(mat) {
  const g = new THREE.Group();
  const rail = new THREE.Mesh(cachedGeo('slide_rail', () => new THREE.BoxGeometry(12, 18, 400)), mat);
  g.add(rail);
  const runner = new THREE.Mesh(cachedGeo('slide_run', () => new THREE.BoxGeometry(8, 12, 200)), mat);
  runner.position.set(0, 4, 40);
  g.add(runner);
  return g;
}

function tipOnGroup(mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(cachedGeo('tipon_body', () => new THREE.CylinderGeometry(8, 8, 50, 16)), mat);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const tip = new THREE.Mesh(cachedGeo('tipon_tip', () => new THREE.SphereGeometry(6, 12, 12)), mat);
  tip.position.x = 28;
  g.add(tip);
  return g;
}

function shelfPinGroup(mat) {
  const g = new THREE.Group();
  const pin = new THREE.Mesh(cachedGeo('shelf_pin', () => new THREE.CylinderGeometry(2.5, 2.5, 12, 10)), mat);
  pin.rotation.z = Math.PI / 2;
  g.add(pin);
  return g;
}

function fastenerGroup(mat) {
  const g = new THREE.Group();
  const bolt = new THREE.Mesh(cachedGeo('fast_bolt', () => new THREE.CylinderGeometry(3, 3, 20, 10)), mat);
  g.add(bolt);
  const head = new THREE.Mesh(cachedGeo('fast_head', () => new THREE.CylinderGeometry(5, 5, 3, 10)), mat);
  head.position.y = 10;
  g.add(head);
  return g;
}

function trayGroup(mat) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(cachedGeo('tray_base', () => new THREE.BoxGeometry(480, 8, 280)), mat);
  g.add(base);
  return g;
}

/** Собрать меш по типу каталога (mesh id). */
export function buildFittingMesh(kind, mat, opts = {}) {
  const side = opts.side || 'left';
  switch (kind) {
    case 'hinge': return cupHingeGroup(mat, side);
    case 'leg': return legGroup(mat);
    case 'hanger': return hangerGroup(mat);
    case 'handle': return handleGroup(mat, opts.vertical !== false);
    case 'slide': return slideGroup(mat);
    case 'tipon': return tipOnGroup(mat);
    case 'shelfPin': return shelfPinGroup(mat);
    case 'fastener': return fastenerGroup(mat);
    case 'tray': return trayGroup(mat);
    default: return null;
  }
}

/**
 * @param {object} p панель из genModule/libPanels
 * @param {object} box {x1,y1,z1,x2,y2,z2} уже в СК модуля (с elev)
 * @param {THREE.Material} mat
 * @param {{width?: number, carcassBottom?: number}} ctx
 *        carcassBottom — Y низа корпуса (elev), ножки не должны быть выше
 */
export function buildHardwareMesh(p, box, mat, ctx = {}) {
  const name = (p.name || '').toLowerCase().replace(/\r/g, ' ');
  let g = null;
  if (/петл/.test(name)) {
    const side = hingeSideFromBox(box, ctx.width || 0);
    g = cupHingeGroup(mat, side);
    placeHingeInGab(g, box, side, ctx.hingeBoost || 1);
  } else if (/ножк|цокол/.test(name) && !/креплен|заглуш/.test(name)) {
    g = legGroup(mat);
    let b = { x1: box.x1, y1: box.y1, z1: box.z1, x2: box.x2, y2: box.y2, z2: box.z2 };
    const floor = ctx.carcassBottom;
    if (floor != null && Number.isFinite(floor) && b.y2 > floor) b.y2 = floor;
    if (b.y2 - b.y1 < 40) {
      const top = floor != null && Number.isFinite(floor) ? floor : b.y2;
      b.y1 = top - 100;
      b.y2 = top;
    }
    placeLegOnFloor(g, b);
  } else if (/навес|scarpi|аметист/.test(name) && !/заглуш|крышк/.test(name)) {
    g = hangerGroup(mat);
    fitIntoBox(g, box);
  } else if (/ручк|скоб/.test(name)) {
    g = handleGroup(mat, true);
    fitIntoBox(g, box);
  } else if (/направл|шарик/.test(name)) {
    g = slideGroup(mat);
    fitIntoBox(g, box);
  } else if (/tip-?on|типон/.test(name)) {
    g = tipOnGroup(mat);
    fitIntoBox(g, box);
  } else if (/полкодерж/.test(name)) {
    g = shelfPinGroup(mat);
    fitIntoBox(g, box);
  }
  if (!g) return null;
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.userData = { ...(o.userData || {}), moduleId: p.moduleId, panelKey: p.key, pick: true };
    }
  });
  return g;
}

/**
 * Фурнитура из каталога конструктора: позиция по центру gab + fit.
 * @param {object} f {mesh, side, vertical, x1..z2}
 */
export function buildCatalogFitting(f, mat, ctx = {}) {
  const box = {
    x1: +f.x1, y1: +f.y1, z1: +f.z1,
    x2: +f.x2, y2: +f.y2, z2: +f.z2,
  };
  const side = f.side || 'left';
  const g = buildFittingMesh(f.mesh || 'hinge', mat, {
    side,
    vertical: f.vertical !== false && f.vertical !== 'h',
  });
  if (!g) return null;
  if (f.mesh === 'leg') placeLegOnFloor(g, box);
  else if (f.mesh === 'hinge') placeHingeInGab(g, box, side);
  else fitIntoBox(g, box);
  g.userData = { ...(g.userData || {}), fittingKey: f.key, pick: true, kind: 'fitting' };
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.userData = { ...(o.userData || {}), fittingKey: f.key, pick: true, kind: 'fitting' };
    }
  });
  return g;
}

/** Собрать BufferGeometry из TriData { positions:Float32[], indices?:Uint32[] }. */
export function geometryFromTriData(tri) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tri.positions, 3));
  if (tri.indices?.length) geo.setIndex(tri.indices);
  geo.computeVertexNormals();
  return geo;
}
