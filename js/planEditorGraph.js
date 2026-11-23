// Гибкий редактор помещения: UX как у planEditor (длина/угол/Enter/таблица стен),
// модель — граф, чтобы после первой стены рисовать от любого её конца.

import {
  emptyGraph, addVertex, addEdge, edgesAtVertex, edgeDirection, angleBetweenEdges,
  graphBBox, getVertex, undoLastEdge, chainToGraph, norm360,
  edgeOutwardNormal, setEdgeLength, setEdgeHeading, angBetween, edgeLength,
  graphToOrderedPoints, isGraphClosed, graphCentroid,
} from './roomGraph.js?v=20261123g';

const RAD = Math.PI / 180;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r10 = (v) => Math.round(v / 10) * 10;
const r1 = (v) => Math.round(v * 10) / 10;
const fmtA = (a) => String(r1(a)).replace('.', ',');

const snapToAxis = (deg, threshold = 8) => {
  const axes = [0, 90, 180, 270, 360];
  const d = norm360(deg);
  for (const a of axes) {
    const diff = Math.abs(d - a);
    const diffWrap = Math.abs(d - a + 360);
    if (diff <= threshold || diffWrap <= threshold) return norm360(a);
  }
  return deg;
};

const HTML = `
<div class="pe-dlg" tabindex="-1">
  <div class="pe-head">
    <b>Помещение — гибкий план</b>
    <span class="pe-hint" data-r="hint"></span>
    <button data-a="cancel" title="Закрыть без изменений">×</button>
  </div>
  <div class="pe-body">
    <div class="pe-stage">
      <svg data-r="svg"></svg>
      <div class="pe-live" data-r="live">
        <label>Длина, мм <input type="number" data-r="liveLen" step="10" min="10"></label>
        <label><span data-r="liveAngT">Угол, °</span> <input type="number" data-r="liveAng" step="1"></label>
        <span class="muted">Enter — поставить стену</span>
      </div>
      <div class="pe-tools"><button data-a="fit" title="Вписать план в окно">Вписать</button></div>
    </div>
    <div class="pe-side">
      <div class="btnrow">
        <button data-a="draw" class="primary">Рисовать</button>
        <button data-a="undo" title="Backspace">Удалить последнюю</button>
        <button data-a="clear" class="danger">Начать заново</button>
      </div>
      <div class="btnrow">
        <button data-a="flip" title="Комната окажется по другую сторону стен">Сторона комнаты ⇄</button>
      </div>
      <h4 data-r="wallsTitle">Стены</h4>
      <div data-r="walls"></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Клик по вершине — рисовать от неё. Замыкать контур не обязательно.</p>
      <label class="pe-thick">Толщина стен, мм <input type="number" data-r="thick" step="10" min="10"></label>
    </div>
  </div>
  <div class="pe-foot">
    <span class="muted" data-r="sum"></span>
    <div class="spacer"></div>
    <button data-a="cancel">Отмена</button>
    <button class="primary" data-a="apply">Применить</button>
  </div>
</div>`;

/**
 * @param {{
 *   levels?: Array<{id,name,h,chain?}>,
 *   chain?: object,
 *   wallThick?: number,
 *   onApply: Function,
 *   onCancel?: Function
 * }} opts
 *   levels — как у openPlanEditor (для совместимости с applyDrawnRoom);
 *   onApply({ closed, levels: [{ id, name, h, pts }], wallThick })
 */
export function openPlanEditorGraph({
  levels = null,
  chain = null,
  wallThick = 100,
  onApply,
  onCancel,
} = {}) {
  const lv0 = (levels?.length
    ? levels.map((l) => ({ id: l.id, name: l.name, h: +l.h || 0, chain: l.chain || null }))
    : [
      { id: 'floor', name: 'Пол', h: 0, chain: null },
      { id: 'ceil', name: 'Потолок', h: 2700, chain: null },
    ]);
  if (!lv0.some((l) => l.id === 'floor')) lv0.unshift({ id: 'floor', name: 'Пол', h: 0, chain: null });
  if (!lv0.some((l) => l.id === 'ceil')) lv0.push({ id: 'ceil', name: 'Потолок', h: 2700, chain: null });

  const floorChain = lv0.find((l) => l.id === 'floor')?.chain || chain;
  let g = floorChain?.walls?.length ? chainToGraph(floorChain) : { vertices: [], edges: [] };

  const st = {
    mode: g.edges.length ? 'edit' : 'start',
    thick: +wallThick || 100,
    cur: null,
    alt: false,
    typed: { len: null, ang: null },
    sel: null,
    activeVertex: null,
    refEdge: null, // ребро, относительно которого задаём угол при рисовании
    view: null,
    press: null,
    flip: 1,
    lastAng: 90,
  };

  const back = document.createElement('div');
  back.className = 'pe-back';
  back.innerHTML = HTML;
  document.body.appendChild(back);
  const R = (n) => back.querySelector(`[data-r="${n}"]`);
  const svg = R('svg');
  const liveLen = R('liveLen'), liveAng = R('liveAng');

  const size = () => ({ w: svg.clientWidth || 800, h: svg.clientHeight || 600 });
  const mmPx = () => st.view.w / size().w;
  const letter = (i) => String.fromCharCode(65 + (i % 26));
  const edgeIndex = (id) => g.edges.findIndex((e) => e.id === id);

  function fit() {
    const { w, h } = size();
    const b = g.vertices.length ? graphBBox(g) : { x1: 0, z1: 0, x2: 6000, z2: 4500 };
    const m = 900;
    const bw = b.x2 - b.x1 + 2 * m, bh = b.z2 - b.z1 + 2 * m;
    const vw = Math.max(bw, (bh * w) / h);
    const vh = (vw * h) / w;
    st.view = { x: (b.x1 + b.x2) / 2 - vw / 2, y: (b.z1 + b.z2) / 2 - vh / 2, w: vw, h: vh };
  }

  function toWorld(e) {
    if (!st.view) fit();
    const r = svg.getBoundingClientRect();
    return {
      x: st.view.x + ((e.clientX - r.left) / r.width) * st.view.w,
      z: st.view.y + ((e.clientY - r.top) / r.height) * st.view.h,
    };
  }

  /** Опорное ребро у активной вершины для угла «к стене» */
  function refEdgeAtActive() {
    if (!st.activeVertex) return null;
    if (st.refEdge) {
      const e = g.edges.find((x) => x.id === st.refEdge);
      if (e && (e.from === st.activeVertex || e.to === st.activeVertex)) return e;
    }
    const at = edgesAtVertex(g, st.activeVertex);
    return at.length ? at[at.length - 1] : null;
  }

  /** Направление ребра from→to (как у стены в таблице), одно и то же с обоих концов */
  function edgeHeading(edge) {
    const from = getVertex(g, edge.from);
    const to = getVertex(g, edge.to);
    if (!from || !to) return 0;
    return norm360(Math.atan2(to.z - from.z, to.x - from.x) / RAD);
  }

  // ---------- резиновая стена (логика угла как в planEditor) ----------
  function rubber() {
    if (st.mode !== 'draw' || !st.activeVertex) return null;
    const P = getVertex(g, st.activeVertex);
    if (!P) return null;

    const ref = refEdgeAtActive();
    // Важно: берём направление самой стены, а не «из вершины вдоль ребра» —
    // тогда 90° с левого и с правого конца первой стены дают одну сторону (вниз/вверх).
    const prevH = ref ? edgeHeading(ref) : null;
    const hasPrev = prevH != null;

    const c = st.cur;
    let h = hasPrev ? prevH + 90 : (st.lastAng || 0);
    let len = 1000;
    const raw = c ? Math.hypot(c.x - P.x, c.z - P.z) : Infinity;
    if (c && raw > 1) {
      h = Math.atan2(c.z - P.z, c.x - P.x) / RAD;
      len = raw;
    }

    let ang = hasPrev ? angBetween(prevH, h) : norm360(h);
    if (!st.alt) {
      if (!hasPrev) {
        const axis = snapToAxis(ang, 8);
        ang = axis !== ang ? axis : norm360(Math.round(ang / 15) * 15);
      } else {
        ang = norm360(Math.round(ang / 15) * 15);
      }
    } else {
      ang = r1(ang);
    }

    len = Math.max(10, r10(len));
    if (st.typed.len != null) len = st.typed.len;
    if (st.typed.ang != null) ang = st.typed.ang;
    if (hasPrev) ang = Math.min(359, Math.max(1, ang));

    const hh = (hasPrev ? prevH + 180 - ang : ang) * RAD;
    st.lastAng = hasPrev ? (prevH + 180 - ang) : ang;
    const Q = { x: P.x + Math.cos(hh) * len, z: P.z + Math.sin(hh) * len };
    return { P, Q, len, ang, raw, hasPrev, ref };
  }

  let committing = false;
  function commitWall() {
    if (committing) return;
    committing = true;
    try {
      // подхватить значения из полей, если курсор ушёл с холста
      if (st.typed.len == null) {
        const s = liveLen.value.trim().replace(',', '.');
        if (s !== '' && Number.isFinite(+s)) st.typed.len = +s;
      }
      if (st.typed.ang == null) {
        const s = liveAng.value.trim().replace(',', '.');
        if (s !== '' && Number.isFinite(+s)) st.typed.ang = +s;
      }

      const r = rubber();
      if (!r) return;
      if (r.len < 10 || (st.typed.len == null && Number.isFinite(r.raw) && r.raw < 6 * mmPx())) return;

      const newVId = addVertex(g, r10(r.Q.x), r10(r.Q.z));
      const edge = addEdge(g, st.activeVertex, newVId, false);
      st.typed = { len: null, ang: null };
      st.refEdge = edge?.id || null;
      st.activeVertex = newVId;
      sideSig = '';
      render();
    } finally {
      committing = false;
    }
  }

  function finishDraw() {
    st.mode = g.edges.length ? 'edit' : (g.vertices.length ? 'draw' : 'start');
    st.activeVertex = null;
    st.refEdge = null;
    st.typed = { len: null, ang: null };
    document.activeElement?.blur?.();
    sideSig = '';
    render();
  }

  function undoEdge() {
    if (!g.edges.length) return;
    const last = g.edges[g.edges.length - 1];
    if (last.lock) return hint('Последняя стена зафиксирована — снимите «Фикс.»');
    const keep = last.from;
    undoLastEdge(g);
    if (st.mode === 'draw') {
      st.activeVertex = getVertex(g, keep) ? keep : (g.vertices[g.vertices.length - 1]?.id || null);
      st.refEdge = edgesAtVertex(g, st.activeVertex).slice(-1)[0]?.id || null;
    }
    if (!g.edges.length && st.mode === 'edit') st.mode = g.vertices.length ? 'draw' : 'start';
    sideSig = '';
    render();
  }

  let hintTimer = null;
  function hint(text) {
    const el = R('hint');
    el.textContent = text;
    el.classList.add('warn');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.classList.remove('warn'); renderHint(); }, 2500);
  }

  function renderHint() {
    if (R('hint').classList.contains('warn')) return;
    R('hint').textContent = {
      start: 'Кликните точку, от которой пойдёт первая стена.',
      draw: st.activeVertex
        ? 'Клик — поставить стену. Угол шагом 15° (Alt — свободно). Цифры + Enter — точная длина. Клик по другой вершине — рисовать от неё. Esc — закончить.'
        : 'Выберите вершину, от которой продолжить стену.',
      edit: 'Клик по вершине — рисовать от неё. Длины и углы — в таблице справа. «Фикс.» защищает стену. Колесо — масштаб, фон — сдвиг.',
    }[st.mode];
  }

  // ---------- правая панель ----------
  let sideSig = '';
  function renderSide() {
    const sig = JSON.stringify([g.vertices, g.edges, st.sel, st.thick, st.flip]);
    if (sig === sideSig) return;
    sideSig = sig;
    const focusKey = document.activeElement?.dataset?.key;

    const rows = g.edges.map((e, i) => {
      const from = getVertex(g, e.from);
      const to = getVertex(g, e.to);
      const heading = from && to ? r1(norm360(Math.atan2(to.z - from.z, to.x - from.x) / RAD)) : 0;
      const dis = e.lock ? 'disabled' : '';
      return `<tr class="${e.id === st.sel ? 'sel' : ''}${e.lock ? ' locked' : ''}" data-row="${e.id}">
        <td>${letter(i)}</td>
        <td><input type="number" step="10" min="10" data-key="w${e.id}len" data-e="${e.id}" data-f="len" value="${Math.round(e.len)}" ${dis}></td>
        <td><input type="number" step="1" data-key="w${e.id}ang" data-e="${e.id}" data-f="ang" value="${heading}" ${dis}
          title="Направление стены: 0 — вправо, 90 — вниз"></td>
        <td><input type="checkbox" data-e="${e.id}" data-f="lock" ${e.lock ? 'checked' : ''} title="Зафиксировать стену"></td>
      </tr>`;
    });

    R('walls').innerHTML = rows.length
      ? `<table class="pe-table"><tr><th>Стена</th><th>Длина, мм</th><th>Напр., °</th><th>Фикс.</th></tr>${rows.join('')}</table>`
      : '<p class="muted">Стен пока нет. Нарисуйте первую стену, затем кликните её левый или правый конец, чтобы продолжить.</p>';
    R('thick').value = st.thick;
    R('sum').textContent = g.edges.length
      ? `Вершин: ${g.vertices.length} · Стен: ${g.edges.length}`
      : '';
    if (focusKey) back.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  function render() {
    if (!st.view) fit();
    const { w, h } = size();
    st.view.h = (st.view.w * h) / w;
    const v = st.view, k = mmPx();
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const fs = 12 * k, sw = k;
    const out = [];

    const minorOn = 100 / k > 6;
    out.push(`<defs>
      <pattern id="peG1" width="100" height="100" patternUnits="userSpaceOnUse">
        <path d="M100 0H0V100" fill="none" stroke="#e3e0da" stroke-width="${sw}"/></pattern>
      <pattern id="peG5" width="1000" height="1000" patternUnits="userSpaceOnUse">
        ${minorOn ? '<rect width="1000" height="1000" fill="url(#peG1)"/>' : ''}
        <path d="M1000 0H0V1000" fill="none" stroke="#c9c3b8" stroke-width="${sw * 1.2}"/></pattern>
    </defs>`);
    out.push(`<rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" fill="#fbfaf7"/>`);
    out.push(`<rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" fill="url(#peG5)"/>`);

    const T = st.thick;
    g.edges.forEach((edge, i) => {
      const from = getVertex(g, edge.from);
      const to = getVertex(g, edge.to);
      if (!from || !to) return;
      const { nx, nz } = edgeOutwardNormal(g, edge, st.flip);
      const dx = to.x - from.x, dz = to.z - from.z;
      const locked = edge.lock;
      const selC = st.sel === edge.id;
      const quad = [
        [from.x, from.z], [to.x, to.z],
        [to.x + nx * T, to.z + nz * T], [from.x + nx * T, from.z + nz * T],
      ];
      out.push(`<polygon data-e="${edge.id}" class="pe-wall" points="${quad.map((q) => q.join(',')).join(' ')}"
        fill="${selC ? '#5b8def' : locked ? '#59616b' : '#8d96a1'}"
        stroke="#2f343a" stroke-width="${sw}"/>`);
      const o = T + 16 * k;
      const mx = (from.x + to.x) / 2, mz = (from.z + to.z) / 2;
      let a = Math.atan2(dz, dx) / RAD;
      if (a > 90 || a < -90) a += 180;
      const lx = mx + nx * o, lz = mz + nz * o;
      out.push(`<text x="${lx}" y="${lz}" font-size="${fs}" text-anchor="middle" dominant-baseline="middle"
        transform="rotate(${a} ${lx} ${lz})" class="pe-len">${letter(i)} ${edge.len}${locked ? ' (фикс.)' : ''}</text>`);
    });

    g.vertices.forEach((vertex) => {
      const at = edgesAtVertex(g, vertex.id);
      if (at.length < 2) return;
      for (let i = 0; i < at.length; i++) {
        for (let j = i + 1; j < at.length; j++) {
          const ang = angleBetweenEdges(g, at[i], at[j], vertex.id);
          const h1 = edgeDirection(g, at[i], vertex.id);
          const h2 = edgeDirection(g, at[j], vertex.id);
          const midH = ((h1 + h2) / 2) * RAD;
          const dist = 30 * k;
          out.push(`<text x="${vertex.x + Math.cos(midH) * dist}" y="${vertex.z + Math.sin(midH) * dist}"
            font-size="${fs}" text-anchor="middle" dominant-baseline="central" class="pe-ang">${fmtA(ang)}°</text>`);
        }
      }
    });

    const rb = rubber();
    if (rb) {
      out.push(`<line x1="${rb.P.x}" y1="${rb.P.z}" x2="${rb.Q.x}" y2="${rb.Q.z}" stroke="#1f6feb"
        stroke-width="${3 * sw}" stroke-dasharray="${8 * k} ${5 * k}"/>`);
      const mx = (rb.P.x + rb.Q.x) / 2, mz = (rb.P.z + rb.Q.z) / 2;
      out.push(`<text x="${mx}" y="${mz - 12 * k}" font-size="${fs * 1.1}" text-anchor="middle" class="pe-rb">${rb.len} мм · ${fmtA(rb.ang)}°</text>`);
    }

    g.vertices.forEach((vertex, i) => {
      const isActive = st.activeVertex === vertex.id;
      const color = i === 0 ? '#2e9d4f' : isActive ? '#ff9500' : '#fff';
      const radius = isActive ? 8 : (i === 0 ? 7 : 5);
      out.push(`<circle data-v="${vertex.id}" class="pe-vtx" cx="${vertex.x}" cy="${vertex.z}" r="${radius * k}"
        fill="${color}" stroke="#1f2328" stroke-width="${1.5 * sw}"/>`);
    });
    if (!g.vertices.length && st.mode === 'start' && st.cur) {
      out.push(`<circle cx="${r10(st.cur.x)}" cy="${r10(st.cur.z)}" r="${6 * k}" fill="#2e9d4f" opacity="0.6"/>`);
    }

    svg.innerHTML = out.join('');

    R('live').style.display = st.mode === 'draw' && st.activeVertex ? '' : 'none';
    const ref = refEdgeAtActive();
    R('liveAngT').textContent = ref
      ? `Угол к ${letter(edgeIndex(ref.id))}, °`
      : 'Направление, °';
    if (rb) {
      for (const [inp, key, val] of [[liveLen, 'len', rb.len], [liveAng, 'ang', r1(rb.ang)]]) {
        if (st.typed[key] != null) continue;
        if (document.activeElement === inp) continue;
        inp.value = val;
      }
    }

    const btnDraw = back.querySelector('[data-a="draw"]');
    btnDraw.textContent = st.mode === 'draw' ? 'Готово' : g.edges.length ? 'Продолжить стены' : 'Рисовать';
    back.querySelector('[data-a="undo"]').disabled = !g.edges.length;
    back.querySelector('[data-a="flip"]').disabled = !g.edges.length;
    renderHint();
    renderSide();
  }

  const side = back.querySelector('.pe-side');
  side.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.e != null) {
      const edge = g.edges.find((x) => x.id === t.dataset.e);
      if (!edge) return;
      if (t.dataset.f === 'lock') {
        edge.lock = t.checked;
      } else if (!edge.lock) {
        const val = +t.value;
        if (t.dataset.f === 'len' && val >= 10) setEdgeLength(g, edge.id, val);
        else if (t.dataset.f === 'ang' && Number.isFinite(val)) setEdgeHeading(g, edge.id, val);
      }
      sideSig = '';
      render();
    } else if (t === R('thick')) {
      st.thick = Math.max(10, Math.round(+t.value || 100));
      sideSig = '';
      render();
    }
  });
  side.addEventListener('click', (e) => {
    const row = e.target.closest('[data-row]');
    if (row && e.target.tagName !== 'INPUT') {
      st.sel = row.dataset.row;
      sideSig = '';
      render();
    }
  });

  for (const [inp, key] of [[liveLen, 'len'], [liveAng, 'ang']]) {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      const s = inp.value.trim().replace(',', '.');
      st.typed[key] = s === '' || !Number.isFinite(+s) ? null : +s;
      render();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitWall();
        inp.select();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        st.typed[key] = null;
        inp.blur();
        render();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (inp === liveLen ? liveAng : liveLen).focus();
      }
    });
  }

  svg.addEventListener('pointermove', (e) => {
    st.alt = e.altKey;
    st.cur = toWorld(e);
    const pr = st.press;
    if (pr?.pan) {
      const k = mmPx();
      st.view.x = pr.vx - (e.clientX - pr.sx) * k;
      st.view.y = pr.vy - (e.clientY - pr.sy) * k;
      if (Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) > 3) pr.moved = true;
    }
    render();
  });

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture?.(e.pointerId);
    st.cur = toWorld(e);
    if (e.button !== 0 && e.button !== 1) return;

    // Старт: клик ставит первую точку сразу (как ожидает пользователь)
    if (e.button === 0 && st.mode === 'start') {
      g = emptyGraph(r10(st.cur.x), r10(st.cur.z));
      st.mode = 'draw';
      st.activeVertex = g.vertices[0].id;
      st.refEdge = null;
      st.typed = { len: null, ang: null };
      sideSig = '';
      render();
      return;
    }

    if (e.button === 1 || (e.button === 0 && st.mode !== 'draw' && !e.target.closest?.('.pe-vtx, .pe-wall'))) {
      st.press = { pan: true, sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false };
      return;
    }
    if (e.button !== 0) return;

    const vt = e.target.closest?.('.pe-vtx');
    if (vt) {
      const vId = vt.dataset.v;
      st.activeVertex = vId;
      st.refEdge = edgesAtVertex(g, vId).slice(-1)[0]?.id || null;
      st.mode = 'draw';
      st.typed = { len: null, ang: null };
      sideSig = '';
      render();
      return;
    }

    const wl = e.target.closest?.('.pe-wall');
    if (wl && st.mode !== 'draw') {
      st.sel = wl.dataset.e;
      sideSig = '';
      render();
      return;
    }

    if (st.mode === 'draw' && st.activeVertex) {
      if (document.activeElement === liveLen || document.activeElement === liveAng) document.activeElement.blur();
      commitWall();
    }
  });

  svg.addEventListener('pointerup', (e) => {
    const pr = st.press;
    st.press = null;
    try { svg.releasePointerCapture?.(e.pointerId); } catch (_) { /* */ }
    if (!pr?.pan || pr.moved || e.button !== 0) return;
    if (st.mode === 'edit') {
      st.sel = null;
      sideSig = '';
      render();
    }
  });

  svg.addEventListener('contextmenu', (e) => { e.preventDefault(); if (st.mode === 'draw') finishDraw(); });
  svg.addEventListener('dblclick', (e) => { e.preventDefault(); if (st.mode === 'draw' && g.edges.length) finishDraw(); });
  svg.addEventListener('pointerleave', () => {
    if (!st.press) {
      // не сбрасываем cur в null — иначе Enter в полях длины/угла не ставит стену
      render();
    }
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = toWorld(e);
    const nw = Math.min(200000, Math.max(300, st.view.w * Math.exp(e.deltaY * 0.0015)));
    const s = nw / st.view.w;
    st.view.x = c.x - (c.x - st.view.x) * s;
    st.view.y = c.z - (c.z - st.view.y) * s;
    st.view.w = nw;
    render();
  }, { passive: false });

  const actions = {
    cancel: () => { close(); onCancel?.(); },
    apply: () => {
      if (!g.edges.length) return hint('Нарисуйте хотя бы одну стену');
      g.edges.forEach((e) => { e.len = edgeLength(g, e); });

      let pts = graphToOrderedPoints(g).map((p) => ({ x: Math.round(p.x), z: Math.round(p.z) }));
      if (pts.length < 2) return hint('Нарисуйте хотя бы одну стену');

      // Сторона комнаты: обход так, чтобы центроид был справа по ходу (как в roomPlan)
      if (pts.length >= 3) {
        const c = graphCentroid(g);
        let rightVotes = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
          const len = Math.hypot(dx, dz) || 1;
          // «вправо» от направления = (dz, -dx) в наших осях? roomPlan: комната справа → inward = (tz, -tx) wait
          // В roomPlan nx,nz наружу = (dz,-dx)/len при CCW; внутрь = -n = (-dz, dx)
          // «Справа по ходу» (tx,tz)=(dx,dz)/len → right = (tz, -tx) = (dz, -dx)/len = наружу при CCW
          // Значит при обходе CCW наружу справа. Центроид должен быть СЛЕВА (= внутрь).
          const cross = dx * (c.z - pts[i].z) - dz * (c.x - pts[i].x);
          if (cross > 0) rightVotes++; // центроид слева от направленного ребра
          else rightVotes--;
        }
        if (rightVotes < 0) pts = pts.slice().reverse();
      }
      if (st.flip < 0) pts = pts.slice().reverse();

      const closed = isGraphClosed(g)
        || (pts.length >= 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 30);
      if (closed && pts.length >= 3
        && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 30) {
        pts = pts.slice(0, -1);
      }

      const outLevels = lv0.map((l) => ({
        id: l.id,
        name: l.name,
        h: Math.round(+l.h || 0),
        pts: pts.map((p) => ({ x: p.x, z: p.z })),
      }));

      close();
      onApply?.({ closed: !!closed, levels: outLevels, wallThick: st.thick });
    },
    fit: () => { fit(); render(); },
    draw: () => {
      if (st.mode === 'draw') return finishDraw();
      if (!g.vertices.length) { st.mode = 'start'; sideSig = ''; render(); return; }
      st.mode = 'draw';
      if (!st.activeVertex) {
        // удобный старт: конец с одной стеной (свободный угол) или первая вершина
        const leaf = g.vertices.find((v) => edgesAtVertex(g, v.id).length === 1);
        st.activeVertex = leaf?.id || g.vertices[0].id;
        st.refEdge = edgesAtVertex(g, st.activeVertex).slice(-1)[0]?.id || null;
      }
      sideSig = '';
      render();
    },
    undo: undoEdge,
    flip: () => { st.flip *= -1; sideSig = ''; render(); },
    clear: () => {
      if (g.edges.length && !confirm('Удалить все стены и начать с новой точки?')) return;
      g = { vertices: [], edges: [] };
      st.mode = 'start';
      st.activeVertex = null;
      st.refEdge = null;
      st.sel = null;
      st.flip = 1;
      fit();
      sideSig = '';
      render();
    },
  };

  back.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (b && !b.disabled && actions[b.dataset.a]) actions[b.dataset.a]();
  });

  function onKey(e) {
    // e.target надёжнее activeElement в capture-фазе (иначе Enter может сработать дважды)
    const tag = e.target?.tagName || document.activeElement?.tagName || '';
    const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);
    st.alt = e.altKey;
    if (inInput) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (st.mode === 'draw') finishDraw(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoEdge(); return; }
    if (e.key === 'Enter' && st.mode === 'draw') { e.preventDefault(); commitWall(); return; }
    if (st.mode === 'draw' && st.activeVertex && /^[0-9]$/.test(e.key)) {
      liveLen.focus();
      liveLen.value = '';
      st.typed.len = null;
    }
  }
  function onKeyUp(e) { st.alt = e.altKey; }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  const ro = new ResizeObserver(() => render());
  ro.observe(svg);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKeyUp, true);
    ro.disconnect();
    back.remove();
  }

  requestAnimationFrame(() => { fit(); render(); back.querySelector('.pe-dlg').focus(); });
  return { close };
}
