// Интерактив конструктора: AABB-коллизии, сдвиг панелей/фурнитуры, хелперы петель.
import * as THREE from 'three';
import { panelBox } from './model.js?v=20261028n';

export function aabbOverlap(a, b, eps = 0.5) {
  return a.x1 < b.x2 - eps && a.x2 > b.x1 + eps
    && a.y1 < b.y2 - eps && a.y2 > b.y1 + eps
    && a.z1 < b.z2 - eps && a.z2 > b.z1 + eps;
}

export function movePanelBy(p, dx, dy, dz) {
  const next = { ...p, butts: Array.isArray(p.butts) ? [...p.butts] : p.butts };
  if (p.orient === 'H') {
    next.a1 = p.a1 + dx; next.a2 = p.a2 + dx;
    next.b1 = p.b1 + dz; next.b2 = p.b2 + dz;
    next.pos = p.pos + dy;
  } else if (p.orient === 'V') {
    next.pos = p.pos + dx;
    next.b1 = p.b1 + dy; next.b2 = p.b2 + dy;
    next.a1 = p.a1 + dz; next.a2 = p.a2 + dz;
  } else {
    // F
    next.a1 = p.a1 + dx; next.a2 = p.a2 + dx;
    next.b1 = p.b1 + dy; next.b2 = p.b2 + dy;
    next.pos = p.pos + dz;
  }
  if (next.a1 > next.a2) [next.a1, next.a2] = [next.a2, next.a1];
  if (next.b1 > next.b2) [next.b1, next.b2] = [next.b2, next.b1];
  return next;
}

export function moveFittingBy(f, dx, dy, dz) {
  return {
    ...f,
    x1: f.x1 + dx, x2: f.x2 + dx,
    y1: f.y1 + dy, y2: f.y2 + dy,
    z1: f.z1 + dz, z2: f.z2 + dz,
  };
}

/** Уменьшить delta, пока AABB панели не пересекается с соседями. */
export function resolvePanelDelta(panel, panels, dx, dy, dz) {
  let d = { dx, dy, dz };
  if (!dx && !dy && !dz) return d;
  const others = panels.filter((q) => q.key !== panel.key);
  for (let step = 0; step < 8; step++) {
    const trial = movePanelBy(panel, d.dx, d.dy, d.dz);
    const box = panelBox(trial);
    let hit = false;
    for (const o of others) {
      if (aabbOverlap(box, panelBox(o))) { hit = true; break; }
    }
    if (!hit) return d;
    d = { dx: d.dx * 0.5, dy: d.dy * 0.5, dz: d.dz * 0.5 };
    if (Math.abs(d.dx) < 0.05 && Math.abs(d.dy) < 0.05 && Math.abs(d.dz) < 0.05) {
      return { dx: 0, dy: 0, dz: 0 };
    }
  }
  return { dx: 0, dy: 0, dz: 0 };
}

/** Стыковка к ближайшей плоскости соседа (1 мм допуск). */
export function snapPanelDelta(panel, panels, dx, dy, dz, snap = 2) {
  const trial = movePanelBy(panel, dx, dy, dz);
  const a = panelBox(trial);
  let sdx = dx, sdy = dy, sdz = dz;
  for (const o of panels) {
    if (o.key === panel.key) continue;
    const b = panelBox(o);
    const pairs = [
      ['x', a.x1, b.x2], ['x', a.x2, b.x1], ['x', a.x1, b.x1], ['x', a.x2, b.x2],
      ['y', a.y1, b.y2], ['y', a.y2, b.y1], ['y', a.y1, b.y1], ['y', a.y2, b.y2],
      ['z', a.z1, b.z2], ['z', a.z2, b.z1], ['z', a.z1, b.z1], ['z', a.z2, b.z2],
    ];
    for (const [axis, u, v] of pairs) {
      const d = v - u;
      if (Math.abs(d) <= snap) {
        if (axis === 'x') sdx += d;
        if (axis === 'y') sdy += d;
        if (axis === 'z') sdz += d;
      }
    }
  }
  return resolvePanelDelta(panel, panels, sdx, sdy, sdz);
}

/** Привязать фурнитуру-петлю к ближайшему слоту (если ближе threshold мм). */
export function nearestHingeSlot(f, slots, threshold = 40) {
  if (!slots?.length) return null;
  const cx = (f.x1 + f.x2) / 2, cy = (f.y1 + f.y2) / 2, cz = (f.z1 + f.z2) / 2;
  let best = null, bestD = threshold;
  for (const s of slots) {
    const sx = (s.x1 + s.x2) / 2, sy = (s.y1 + s.y2) / 2, sz = (s.z1 + s.z2) / 2;
    const d = Math.hypot(cx - sx, cy - sy, cz - sz);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export function makeDragPlane(point, camera) {
  const n = new THREE.Vector3();
  camera.getWorldDirection(n);
  n.negate();
  return new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
}

export function rayPlaneHit(raycaster, plane) {
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hit)) return hit;
  return null;
}
