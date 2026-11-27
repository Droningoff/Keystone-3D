// Гибкий редактор помещения: UX как у planEditor (длина/угол/Enter/таблица стен),
// модель — граф, чтобы после первой стены рисовать от любого её конца.

import {
  emptyGraph, addVertex, addEdge, edgesAtVertex, edgeDirection,
  graphBBox, getVertex, undoLastEdge, chainToGraph, norm360,
  edgeOutwardNormal, setEdgeLength, setEdgeHeading, angBetween, edgeLength,
  graphToOrderedPoints, graphToOrderedVertices, isGraphClosed, graphCentroid,
  roomCornerAngle, moveVertex, setEdgeInteriorAngle,
  cloneGraph, syncGraphTopology, adoptGraphIds, rotateEdgeAround,
} from './roomGraph.js?v=20261127s';
import { wallCornerFillPts, openChainFloorExtra, newWallId } from './roomGeom.js?v=20261127n';

const RAD = Math.PI / 180;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r10 = (v) => Math.round(v / 10) * 10;
const r1 = (v) => Math.round(v * 10) / 10;
const fmtA = (a) => String(r1(a)).replace('.', ',');
const LEVEL_COLORS = ['#1f6feb', '#b4530a', '#2e9d4f', '#8e44ad', '#c0392b', '#16a085'];
const FIXED = new Set(['floor', 'ceil']);

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
      <div class="pe-pop" data-r="pop" hidden></div>
    </div>
    <div class="pe-side">
      <div class="btnrow">
        <button data-a="draw" class="primary">Рисовать</button>
        <button data-a="undo" title="Backspace">Удалить последнюю</button>
        <button data-a="clear" class="danger">Начать заново</button>
        <button class="primary" data-a="apply" title="Записать план в проект">Применить</button>
      </div>
      <div class="btnrow">
        <button data-a="flip" title="Комната окажется по другую сторону стен">Сторона комнаты ⇄</button>
        <button type="button" data-a="importEkkd" title="Загрузить помещение из бланка eKitchen (.ekkd)">Из eKKD…</button>
      </div>
      <h4>Уровни замера</h4>
      <div data-r="levels"></div>
      <button data-a="addLevel">+ Уровень</button>
      <p class="muted" style="font-size:12px;margin:4px 0 8px">На каждом уровне свои длины/углы — для наклона и кривизны стен.</p>
      <h4 data-r="wallsTitle">Стены</h4>
      <label class="pe-lenmode">При смене длины двигать
        <select data-r="lenMode">
          <option value="end">конец стены</option>
          <option value="start">начало стены</option>
          <option value="both">оба конца</option>
        </select>
      </label>
      <div data-r="walls"></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Новые стены — на уровне «Пол». Правка пола сдвигает и другие уровни, их наклон сохраняется; свои отклонения правьте, выбрав уровень. Замыкать не обязательно.</p>
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
  wallIds = null,
  wallNames = null,
  onApply,
  onCancel,
  onImportEkkd,
} = {}) {
  const mkLevel = (l) => {
    const ch = l.chain || null;
    const graph = ch?.walls?.length ? chainToGraph(ch) : { vertices: [], edges: [] };
    return { id: l.id, name: l.name, h: +l.h || 0, graph };
  };
  const lv0 = (levels?.length
    ? levels.map(mkLevel)
    : [
      { id: 'floor', name: 'Пол', h: 0, graph: { vertices: [], edges: [] } },
      { id: 'ceil', name: 'Потолок', h: 2700, graph: { vertices: [], edges: [] } },
    ]);
  if (!lv0.some((l) => l.id === 'floor')) lv0.unshift({ id: 'floor', name: 'Пол', h: 0, graph: { vertices: [], edges: [] } });
  if (!lv0.some((l) => l.id === 'ceil')) lv0.push({ id: 'ceil', name: 'Потолок', h: 2700, graph: { vertices: [], edges: [] } });

  // Если передали только chain без levels[].chain — положить на пол
  if (chain?.walls?.length && !lv0.find((l) => l.id === 'floor').graph.edges.length) {
    lv0.find((l) => l.id === 'floor').graph = chainToGraph(chain);
  }
  // Стенам пола — постоянные id; остальные уровни — те же id вершин/рёбер, что у пола
  {
    const fg = lv0.find((l) => l.id === 'floor').graph;
    fg.edges.forEach((e, i) => {
      e.wid = wallIds?.[i] || newWallId();
      e.wstart = e.from;
    });
    lv0.forEach((l) => {
      if (l.id === 'floor') return;
      if (!l.graph?.edges?.length && fg.edges.length) l.graph = cloneGraph(fg);
      else adoptGraphIds(l.graph, fg);
    });
  }

  let g = lv0.find((l) => l.id === 'floor').graph;

  const st = {
    levels: lv0,
    lv: 'floor',
    mode: g.edges.length ? 'edit' : 'start',
    thick: +wallThick || 100,
    cur: null,
    alt: false,
    typed: { len: null, ang: null },
    sel: null,
    activeVertex: null,
    refEdge: null,
    view: null,
    press: null,
    flip: 1,
    dirRef: g.edges.length && g.vertices.length >= 2 ? { a: g.vertices[0].id, b: g.vertices[1].id } : null,
    lastAng: 90,
    lenMode: 'end',
    names: { ...(wallNames || {}) },
    order: null,
  };
  const L = (id) => st.levels.find((l) => l.id === id);
  const lvColor = (id) => LEVEL_COLORS[Math.max(0, st.levels.findIndex((l) => l.id === id)) % LEVEL_COLORS.length];
  const onFloor = () => st.lv === 'floor';

  function saveActiveGraph() {
    const lv = L(st.lv);
    if (lv) lv.graph = g;
  }

  /** Топология других уровней как у пола; координаты сохраняются где возможно */
  function syncLevelsTopology() {
    saveActiveGraph();
    const floor = L('floor');
    if (!floor) return;
    const fg = st.lv === 'floor' ? g : floor.graph;
    floor.graph = fg;
    st.levels.forEach((l) => {
      if (l.id === 'floor') return;
      l.graph = syncGraphTopology(l.graph, fg);
    });
    if (st.lv !== 'floor') g = L(st.lv).graph;
  }

  function selectLevel(id) {
    if (!L(id) || id === st.lv) return;
    if (popOpen()) closePop();
    saveActiveGraph();
    if (st.mode === 'draw') finishDraw();
    st.lv = id;
    g = L(id).graph;
    st.sel = null;
    st.activeVertex = null;
    st.refEdge = null;
    st.typed = { len: null, ang: null };
    if (id === 'floor' && !g.edges.length && !g.vertices.length) st.mode = 'start';
    else st.mode = g.edges.length || g.vertices.length ? 'edit' : 'start';
    sideSig = '';
    render();
  }

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

  /**
   * Стены пола в порядке обхода — тот же порядок, что попадёт в проект при «Применить».
   * items: [{ e, a, b }] — стена идёт из вершины a в b; corners: vertexId → { inE, outE }.
   */
  function computeOrder() {
    const fg = st.lv === 'floor' ? g : L('floor').graph;
    const items = [];
    const idx = new Map();
    const corners = new Map();
    let orderIds = [];
    if (fg?.edges?.length) {
      const ids = orientVertexOrder(fg, graphToOrderedVertices(fg)).map((v) => v.id);
      orderIds = ids;
      const cyc = isGraphClosed(fg);
      const m = cyc ? ids.length : ids.length - 1;
      const used = new Set();
      for (let i = 0; i < m; i++) {
        const a = ids[i], b = ids[(i + 1) % ids.length];
        const e = fg.edges.find((x) => !used.has(x.id)
          && ((x.from === a && x.to === b) || (x.from === b && x.to === a)));
        if (!e) continue;
        used.add(e.id);
        items.push({ e, a, b });
      }
      fg.edges.forEach((e) => { if (!used.has(e.id)) items.push({ e, a: e.from, b: e.to, branch: true }); });
      items.forEach((it, i) => {
        idx.set(it.e.id, i);
        if (it.branch) return;
        (corners.get(it.b) || corners.set(it.b, {}).get(it.b)).inE = it.e.id;
        (corners.get(it.a) || corners.set(it.a, {}).get(it.a)).outE = it.e.id;
      });
    }
    st.order = { items, idx, corners, ids: orderIds };
    return st.order;
  }
  const order = () => st.order || computeOrder();
  const orderItem = (edgeId) => order().items[order().idx.get(edgeId)] || null;
  const wallName = (edgeId) => {
    const e = L('floor').graph.edges.find((x) => x.id === edgeId) || g.edges.find((x) => x.id === edgeId);
    return (e?.wid && st.names[e.wid]) || '';
  };
  const wallLabel = (edgeId) => {
    const i = order().idx.get(edgeId);
    return wallName(edgeId) || (i == null ? '?' : letter(i));
  };
  /** Какой конец двигать при смене длины (режим + порядок обхода). */
  const lenMove = (edgeId) => {
    const it = orderItem(edgeId);
    if (st.lenMode === 'both') return 'both';
    if (!it) return null;
    return st.lenMode === 'start' ? it.a : it.b;
  };
  /** Правка пола: вершины других уровней сдвигаются на то же смещение (их отклонения сохраняются). */
  function withFollow(fn) {
    if (!onFloor()) return fn();
    const before = new Map(g.vertices.map((v) => [v.id, { x: v.x, z: v.z }]));
    const res = fn();
    if (res === false) return res;
    for (const l of st.levels) {
      if (l.id === 'floor' || !l.graph?.vertices?.length) continue;
      for (const v of l.graph.vertices) {
        const b = before.get(v.id), n = getVertex(g, v.id);
        if (b && n) { v.x += n.x - b.x; v.z += n.z - b.z; }
      }
      l.graph.edges.forEach((e) => { e.len = edgeLength(l.graph, e); });
    }
    return res;
  }
  function applyLength(edge, val) {
    if (edge.lock) { hint('Стена зафиксирована — снимите «Фикс.»'); return false; }
    const ok = withFollow(() => setEdgeLength(g, edge.id, val, lenMove(edge.id)));
    if (!ok) hint('Не получилось: соседняя стена зафиксирована. Снимите «Фикс.» или смените режим «двигать».');
    return ok;
  }
  /** Угол комнаты у вершины vid; поворачивается стена, выходящая из угла (по обходу). */
  function cornerEdges(vid) {
    const c = order().corners.get(vid);
    if (!c?.inE || !c?.outE) return null;
    const inE = g.edges.find((e) => e.id === c.inE);
    const outE = g.edges.find((e) => e.id === c.outE);
    return inE && outE ? { inE, outE } : null;
  }
  /** Направление стены по ходу обхода (a → b), °. */
  const travelHeading = (edgeId) => {
    const it = orderItem(edgeId);
    const e = g.edges.find((x) => x.id === edgeId);
    if (!e) return 0;
    const a = getVertex(g, it ? it.a : e.from), b = getVertex(g, it ? it.b : e.to);
    return a && b ? norm360(Math.atan2(b.z - a.z, b.x - a.x) / RAD) : 0;
  };
  /**
   * Угол комнаты у вершины: { ang, bis, inE, outE }.
   * Замкнутый контур — сектор внутри полигона; открытый — со стороны комнаты (слева по ходу обхода).
   */
  function cornerAngle(vid) {
    const ce = cornerEdges(vid);
    if (!ce) return null;
    if (isGraphClosed(g)) return { ...roomCornerAngle(g, ce.inE, ce.outE, vid), ...ce };
    const h1 = travelHeading(ce.inE.id), h2 = travelHeading(ce.outE.id);
    let turn = norm360(h2 - h1);
    if (turn > 180) turn -= 360;
    const ang = r1(180 - turn);
    return { ang, bis: norm360(h2 + ang / 2), ...ce };
  }
  function applyCornerAngle(vid, val) {
    const ce = cornerEdges(vid);
    if (!ce) return false;
    if (ce.outE.lock) { hint(`Стена ${wallLabel(ce.outE.id)} зафиксирована — снимите «Фикс.»`); return false; }
    const a = Math.min(359, Math.max(1, +val || 90));
    const ok = withFollow(() => (isGraphClosed(g)
      ? setEdgeInteriorAngle(g, ce.outE.id, ce.inE.id, vid, a)
      : rotateEdgeAround(g, ce.outE, vid, travelHeading(ce.inE.id) + 180 - a)));
    if (!ok) hint('Не получилось: соседняя стена зафиксирована');
    return ok;
  }
  const edgeHeadingOf = (e, it) => {
    const a = getVertex(g, it ? it.a : e.from), b = getVertex(g, it ? it.b : e.to);
    return a && b ? norm360(Math.atan2(b.z - a.z, b.x - a.x) / RAD) : 0;
  };
  function setWallName(edgeId, name) {
    const e = L('floor').graph.edges.find((x) => x.id === edgeId) || g.edges.find((x) => x.id === edgeId);
    if (!e) return;
    if (!e.wid) e.wid = newWallId();
    const s = String(name || '').trim().slice(0, 24);
    const i = order().idx.get(edgeId);
    if (!s || (i != null && s === letter(i))) delete st.names[e.wid];
    else st.names[e.wid] = s;
  }
  /** Направление стены (для первой стены открытой цепочки), ° от оси X по часовой. */
  function applyHeading(edge, val) {
    const it = orderItem(edge.id);
    const pivot = it ? it.a : edge.from;
    return withFollow(() => rotateEdgeAround(g, edge, pivot, val));
  }

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
      if (edge) { edge.wid = newWallId(); edge.wstart = edge.from; }
    st.typed = { len: null, ang: null };
    st.refEdge = edge?.id || null;
    st.activeVertex = newVId;
    if (onFloor()) syncLevelsTopology();
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
    if (!onFloor()) return hint('Удалять стены можно только на уровне «Пол»');
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
    syncLevelsTopology();
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
    const lv = L(st.lv);
    if (!onFloor()) {
      R('hint').textContent = `Уровень «${lv.name}» (${Math.round(+lv.h)} мм): правьте длины и углы для наклона стен. Новые стены рисуются на «Пол».`;
      return;
    }
    R('hint').textContent = {
      start: 'Кликните точку, от которой пойдёт первая стена.',
      draw: st.activeVertex
        ? 'Клик — поставить стену. Угол шагом 15° (Alt — свободно). Цифры + Enter — точная длина. Esc — закончить.'
        : 'Выберите вершину, от которой продолжить стену.',
      edit: 'Двойной клик по размеру стены — длина и название, по углу — точный угол; дугу угла можно тянуть. Вершину — тянуть, клик по концу цепочки — рисовать дальше.',
    }[st.mode];
  }

  // ---------- всплывающая правка на плане ----------
  const pop = R('pop');
  const popOpen = () => !pop.hidden;
  function closePop() {
    if (pop.hidden) return;
    pop.hidden = true;
    pop.innerHTML = '';
    st.popWall = null;
    render();
  }
  function showPop(ev, focusSel) {
    pop.hidden = false;
    const stage = svg.parentElement.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = ev.clientX - stage.left + 14, y = ev.clientY - stage.top + 14;
    if (x + pw > stage.width - 6) x = Math.max(6, ev.clientX - stage.left - pw - 14);
    if (y + ph > stage.height - 6) y = Math.max(6, stage.height - ph - 6);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    const f = pop.querySelector(focusSel);
    if (f && !f.disabled) { f.focus(); f.select?.(); }
  }
  const lenModeBtns = () => [['start', '◂ начало'], ['both', '◂ оба ▸'], ['end', 'конец ▸']]
    .map(([m, t]) => `<button type="button" data-m="${m}" class="${st.lenMode === m ? 'on' : ''}">${t}</button>`).join('');
  const popBtns = '<div class="pe-pop-btns"><button type="button" data-pa="cancel">Отмена</button><button type="button" class="primary" data-pa="ok">OK</button></div>';

  function openWallPop(edgeId, ev) {
    const edge = g.edges.find((x) => x.id === edgeId);
    if (!edge) return;
    const i = order().idx.get(edgeId);
    st.sel = edgeId;
    st.popWall = edgeId;
    pop.dataset.kind = 'wall';
    pop.dataset.id = edgeId;
    pop.innerHTML = `
      <div class="pe-pop-h">Стена ${esc(wallLabel(edgeId))}${onFloor() ? '' : ` · ${esc(L(st.lv).name)}`}</div>
      <label>Название <input data-p="name" maxlength="24" placeholder="${i == null ? '?' : letter(i)}" value="${esc(wallName(edgeId))}"></label>
      <label>Длина, мм <input data-p="len" type="number" step="10" min="10" value="${edgeLength(g, edge)}" ${edge.lock ? 'disabled' : ''}></label>
      <div class="pe-pop-sub">Сдвинуть</div>
      <div class="pe-seg">${lenModeBtns()}</div>
      ${edge.lock ? '<p class="muted">Стена зафиксирована — длина не меняется</p>' : ''}
      ${popBtns}`;
    sideSig = '';
    render();
    showPop(ev, edge.lock ? '[data-p="name"]' : '[data-p="len"]');
  }

  function openAnglePop(vid, ev) {
    const ce = cornerEdges(vid);
    if (!ce) return;
    const { ang } = cornerAngle(vid);
    const closedNow = isGraphClosed(g);
    pop.dataset.kind = 'ang';
    pop.dataset.id = vid;
    pop.innerHTML = `
      <div class="pe-pop-h">Угол между ${esc(wallLabel(ce.inE.id))} и ${esc(wallLabel(ce.outE.id))}</div>
      <label>Угол, ° <input data-p="ang" type="number" step="0.5" min="1" max="359" value="${r1(ang)}" ${ce.outE.lock ? 'disabled' : ''}></label>
      <div class="pe-seg pe-seg-q">${[45, 90, 135, 180, 225, 270].map((a) => `<button type="button" data-qa="${a}">${a}</button>`).join('')}</div>
      <p class="muted">Поворачивается стена ${esc(wallLabel(ce.outE.id))}${closedNow ? ', следующая за ней подстраивается' : ' вместе со стенами после неё'}.</p>
      ${popBtns}`;
    showPop(ev, '[data-p="ang"]');
  }

  function popOk() {
    const kind = pop.dataset.kind, id = pop.dataset.id;
    const num = (sel) => {
      const s = pop.querySelector(sel)?.value?.trim().replace(',', '.');
      return s === '' || s == null || !Number.isFinite(+s) ? null : +s;
    };
    if (kind === 'wall') {
      const edge = g.edges.find((x) => x.id === id);
      if (edge) {
        setWallName(id, pop.querySelector('[data-p="name"]').value);
        const v = num('[data-p="len"]');
        if (v != null && v >= 10 && !edge.lock && Math.abs(v - edgeLength(g, edge)) >= 1) applyLength(edge, v);
      }
    } else if (kind === 'ang') {
      const ce = cornerEdges(id);
      const v = num('[data-p="ang"]');
      if (ce && v != null && Math.abs(v - cornerAngle(id).ang) >= 0.05) applyCornerAngle(id, v);
    }
    sideSig = '';
    closePop();
  }

  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]');
    if (m) {
      st.lenMode = m.dataset.m;
      pop.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b === m));
      sideSig = '';
      render();
      return;
    }
    const q = e.target.closest('[data-qa]');
    if (q) {
      const inp = pop.querySelector('[data-p="ang"]');
      if (inp && !inp.disabled) { inp.value = q.dataset.qa; popOk(); }
      return;
    }
    const a = e.target.closest('[data-pa]');
    if (a) { if (a.dataset.pa === 'ok') popOk(); else closePop(); }
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); popOk(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); }
  });

  /** Что под курсором для двойного клика: угол или стена. */
  function hitOf(target) {
    const a = target.closest?.('.pe-arc, .pe-ang[data-v]');
    if (a) return { key: 'a:' + a.dataset.v, kind: 'ang', id: a.dataset.v };
    const w = target.closest?.('.pe-len, .pe-wall');
    if (w?.dataset.e) return { key: 'w:' + w.dataset.e, kind: 'wall', id: w.dataset.e };
    return null;
  }

  /** Тянуть дугу угла: выходящая стена смотрит на курсор, шаг 15° (Alt — 1°). */
  function dragArc(vid, c, free) {
    const ce = cornerEdges(vid);
    const v = getVertex(g, vid);
    if (!ce || !v) return false;
    if (ce.outE.lock) return false;
    const leaveRef = edgeDirection(g, ce.inE, vid);
    const hp = norm360(Math.atan2(c.z - v.z, c.x - v.x) / RAD);
    let rel = norm360(hp - leaveRef);
    rel = free ? Math.round(rel) : Math.round(rel / 15) * 15;
    rel = Math.min(359, Math.max(1, rel));
    return withFollow(() => rotateEdgeAround(g, ce.outE, vid, leaveRef + rel));
  }

  // ---------- правая панель ----------
  let sideSig = '';
  function renderSide() {
    // Не пересобирать таблицу, пока пользователь печатает в поле — иначе «89» + старое «90» → «8990»
    const active = document.activeElement;
    if (active?.closest?.('[data-r="walls"], [data-r="levels"]') && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName || '')) {
      return;
    }
    const sig = JSON.stringify([st.levels.map((l) => [l.id, l.name, l.h, l.graph]), st.lv, st.sel, st.thick, st.flip, st.names, st.lenMode]);
    if (sig === sideSig) return;
    sideSig = sig;
    const focusKey = active?.dataset?.key;

    R('levels').innerHTML = `<table class="pe-table">${[...st.levels].sort((a, b) => +a.h - +b.h).map((l) => `
      <tr class="${l.id === st.lv ? 'sel' : ''}">
        <td><button type="button" class="pe-lvbtn" data-lvsel="${l.id}" title="Править контур этого уровня"
          style="border-color:${lvColor(l.id)}">${l.id === st.lv ? '●' : '○'}</button></td>
        <td><input data-key="l${l.id}n" data-lv="${l.id}" data-f="name" value="${esc(l.name)}"></td>
        <td><input type="number" step="10" data-key="l${l.id}h" data-lv="${l.id}" data-f="h" value="${Math.round(+l.h)}"
          ${l.id === 'floor' ? 'disabled' : ''} title="Высота уровня от пола, мм"></td>
        <td>${FIXED.has(l.id) ? '' : `<button type="button" class="danger" data-del-lv="${l.id}" title="Удалить уровень">×</button>`}</td>
      </tr>`).join('')}</table>`;

    const lv = L(st.lv);
    R('wallsTitle').textContent = `Стены — «${lv.name}»`;

    const ord = order();
    const sorted = g.edges.slice().sort((a, b) => (ord.idx.get(a.id) ?? 1e9) - (ord.idx.get(b.id) ?? 1e9));
    const rows = sorted.map((e) => {
      const it = orderItem(e.id);
      const ce = it && !it.branch ? cornerEdges(it.a) : null;
      const dis = e.lock ? 'disabled' : '';
      const angVal = ce && ce.outE.id === e.id
        ? cornerAngle(it.a).ang
        : edgeHeadingOf(e, it);
      const angTitle = ce
        ? `Угол комнаты в начале стены (между ${wallLabel(ce.inE.id)} и ${wallLabel(e.id)}); при правке поворачивается эта стена`
        : 'Направление стены: 0 — вправо, 90 — вниз';
      const i = ord.idx.get(e.id);
      return `<tr class="${e.id === st.sel ? 'sel' : ''}${e.lock ? ' locked' : ''}" data-row="${e.id}">
        <td><input class="pe-wname" data-key="w${e.id}name" data-e="${e.id}" data-f="name" maxlength="24"
          value="${esc(wallName(e.id))}" placeholder="${i == null ? '?' : letter(i)}" title="Название стены"></td>
        <td><input type="number" step="10" min="10" data-key="w${e.id}len" data-e="${e.id}" data-f="len" value="${Math.round(e.len)}" ${dis}></td>
        <td><input type="number" step="1" data-key="w${e.id}ang" data-e="${e.id}" data-f="ang"
          data-ang-kind="${ce ? 'int' : 'dir'}" data-pivot="${ce ? it.a : ''}"
          value="${r1(angVal)}" ${dis} title="${angTitle}"></td>
        <td><input type="checkbox" data-e="${e.id}" data-f="lock" ${e.lock ? 'checked' : ''} title="Зафиксировать стену"></td>
      </tr>`;
    });
    R('lenMode').value = st.lenMode;

    R('walls').innerHTML = rows.length
      ? `<table class="pe-table"><tr><th>Стена</th><th>Длина, мм</th><th>Угол, °</th><th>Фикс.</th></tr>${rows.join('')}</table>`
      : '<p class="muted">Стен пока нет. Нарисуйте на уровне «Пол», затем настройте другие уровни.</p>';
    R('thick').value = st.thick;
    R('sum').textContent = g.edges.length
      ? `Вершин: ${g.vertices.length} · Стен: ${g.edges.length} · Уровней: ${st.levels.length}`
      : '';
    if (focusKey) back.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  function render() {
    st.order = null;
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

    // Контуры других уровней — пунктиром
    saveActiveGraph();
    for (const l of st.levels) {
      if (l.id === st.lv || !l.graph?.edges?.length) continue;
      const pts = graphToOrderedPoints(l.graph);
      if (pts.length < 2) continue;
      if (isGraphClosed(l.graph)) pts.push(pts[0]);
      out.push(`<polyline points="${pts.map((q) => `${q.x},${q.z}`).join(' ')}" fill="none" stroke="${lvColor(l.id)}"
        stroke-width="${1.5 * sw}" stroke-dasharray="${7 * k} ${5 * k}" opacity="0.75"/>`);
      out.push(`<text x="${pts[0].x + 10 * k}" y="${pts[0].z - 10 * k}" font-size="${fs * 0.85}"
        style="fill:${lvColor(l.id)}">${esc(l.name)}</text>`);
    }

    const T = st.thick;

    // Открытый контур: заливка + пунктир достройки пола (как virt на вкладке «Помещение»)
    let virtSegs = null;
    if (g.edges.length && !isGraphClosed(g)) {
      let chain = graphToOrderedPoints(g);
      if (chain.length >= 2) {
        if (st.flip < 0) chain = chain.slice().reverse();
        const extra = openChainFloorExtra(chain);
        if (extra.length) {
          out.push(`<polygon points="${[...chain, ...extra].map((q) => `${q.x},${q.z}`).join(' ')}"
            fill="#e8f0fe" fill-opacity="0.35" stroke="none" pointer-events="none"/>`);
          virtSegs = [chain[chain.length - 1], ...extra, chain[0]];
        }
      }
    }

    g.edges.forEach((edge) => {
      const from = getVertex(g, edge.from);
      const to = getVertex(g, edge.to);
      if (!from || !to) return;
      const { nx, nz } = outward(edge);
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
        transform="rotate(${a} ${lx} ${lz})" class="pe-len" data-e="${edge.id}"><tspan class="pe-lbl">${esc(wallLabel(edge.id))}</tspan> ${edge.len}${locked ? ' (фикс.)' : ''}</text>`);
    });

    if (virtSegs) {
      for (let i = 0; i < virtSegs.length - 1; i++) {
        const a = virtSegs[i], b = virtSegs[i + 1];
        out.push(`<line class="pe-virt" x1="${a.x}" y1="${a.z}" x2="${b.x}" y2="${b.z}"
          stroke="#b8b0a2" stroke-width="${1.8 * sw}" stroke-dasharray="${7 * k} ${5 * k}"
          fill="none" pointer-events="none"/>`);
      }
    }

    // заливка наружных углов (miter) — габарит комнаты не меняется
    g.vertices.forEach((vertex) => {
      const at = edgesAtVertex(g, vertex.id);
      if (at.length < 2) return;
      for (let i = 0; i < at.length; i++) {
        for (let j = i + 1; j < at.length; j++) {
          const e1 = at[i], e2 = at[j];
          const n1 = outward(e1);
          const n2 = outward(e2);
          const fill = wallCornerFillPts(vertex.x, vertex.z, n1, n2, T);
          if (!fill) continue;
          const poly = [
            [vertex.x, vertex.z],
            [fill[0].x, fill[0].z],
            [fill[1].x, fill[1].z],
            [fill[2].x, fill[2].z],
          ];
          out.push(`<polygon class="pe-wall-corner" points="${poly.map((q) => q.join(',')).join(' ')}"
            fill="#8d96a1" stroke="#2f343a" stroke-width="${sw * 0.8}"/>`);
        }
      }
    });

    g.vertices.forEach((vertex) => {
      const at = edgesAtVertex(g, vertex.id);
      if (at.length < 2) return;
      const ce = cornerEdges(vertex.id);
      if (ce) {
        const { ang, bis } = cornerAngle(vertex.id);
        const rA = 22 * k;
        const a0 = (bis - ang / 2) * RAD, a1 = (bis + ang / 2) * RAD;
        const p0 = [vertex.x + Math.cos(a0) * rA, vertex.z + Math.sin(a0) * rA];
        const p1 = [vertex.x + Math.cos(a1) * rA, vertex.z + Math.sin(a1) * rA];
        const d = `M${p0[0]} ${p0[1]} A${rA} ${rA} 0 ${ang > 180 ? 1 : 0} 1 ${p1[0]} ${p1[1]}`;
        const hot = st.press?.arc === vertex.id;
        out.push(`<path d="${d}" fill="none" stroke="${hot ? '#ff9500' : '#1f6feb'}" stroke-width="${(hot ? 2.5 : 1.5) * sw}" pointer-events="none"/>`);
        if (st.mode !== 'draw') {
          out.push(`<path d="${d}" class="pe-arc" data-v="${vertex.id}" fill="none" stroke="transparent"
            stroke-width="${12 * sw}"><title>Тяните — угол (шаг 15°, Alt — 1°). Двойной клик — ввести</title></path>`);
        }
        const midH = bis * RAD;
        const dist = 38 * k;
        out.push(`<text x="${vertex.x + Math.cos(midH) * dist}" y="${vertex.z + Math.sin(midH) * dist}"
          font-size="${fs}" text-anchor="middle" dominant-baseline="central" class="pe-ang" data-v="${vertex.id}">${fmtA(ang)}°</text>`);
        return;
      }
      for (let i = 0; i < at.length; i++) {
        for (let j = i + 1; j < at.length; j++) {
          const { ang, bis } = roomCornerAngle(g, at[i], at[j], vertex.id);
          const midH = bis * RAD;
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

    const popIt = st.popWall ? orderItem(st.popWall) : null;
    if (popIt) {
      const mv = st.lenMode === 'both' ? [popIt.a, popIt.b] : [st.lenMode === 'start' ? popIt.a : popIt.b];
      for (const id of mv) {
        const p = getVertex(g, id);
        if (p) {
          out.push(`<circle cx="${p.x}" cy="${p.z}" r="${14 * k}" fill="none" stroke="#ff9500"
            stroke-width="${2.5 * sw}" stroke-dasharray="${4 * k} ${3 * k}" pointer-events="none"/>`);
        }
      }
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
      ? `Угол к ${wallLabel(ref.id)}, °`
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
    btnDraw.disabled = !onFloor();
    back.querySelector('[data-a="undo"]').disabled = !(onFloor() && g.edges.length);
    back.querySelector('[data-a="flip"]').disabled = !g.edges.length || isGraphClosed(L('floor').graph);
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
      } else if (t.dataset.f === 'name') {
        setWallName(edge.id, t.value);
      } else if (!edge.lock) {
        const raw = t.value.trim().replace(',', '.');
        if (raw === '' || !Number.isFinite(+raw)) return; // пустое при наборе — не трогаем модель
        const val = +raw;
        if (t.dataset.f === 'len' && val >= 10) applyLength(edge, val);
        else if (t.dataset.f === 'ang') {
          if (t.dataset.angKind === 'int' && t.dataset.pivot) applyCornerAngle(t.dataset.pivot, val);
          else applyHeading(edge, val);
        }
      }
      sideSig = '';
      render();
    } else if (t.dataset.lv != null) {
      const l = L(t.dataset.lv);
      if (!l) return;
      if (t.dataset.f === 'name') l.name = t.value.trim() || l.name;
      else if (l.id !== 'floor') l.h = Math.max(1, Math.round(+t.value || 0));
      sideSig = '';
      render();
    } else if (t === R('thick')) {
      st.thick = Math.max(10, Math.round(+t.value || 100));
      sideSig = '';
      render();
    } else if (t === R('lenMode')) {
      st.lenMode = t.value;
      sideSig = '';
      render();
    }
  });
  // После ухода с поля — можно обновить таблицу актуальными значениями
  side.addEventListener('focusout', (e) => {
    if (!e.target?.closest?.('[data-r="walls"], [data-r="levels"]')) return;
    if (e.relatedTarget?.closest?.('[data-r="walls"], [data-r="levels"]')) return;
    sideSig = '';
    renderSide();
  });
  side.addEventListener('focusin', (e) => {
    if (e.target.matches?.('input[type="number"]')) e.target.select();
  });
  side.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-lv]');
    if (del) {
      const was = st.lv === del.dataset.delLv;
      st.levels = st.levels.filter((l) => l.id !== del.dataset.delLv);
      if (was || !L(st.lv)) {
        saveActiveGraph();
        st.lv = 'floor';
        g = L('floor').graph;
        st.sel = null;
        st.activeVertex = null;
        st.refEdge = null;
        st.mode = g.edges.length || g.vertices.length ? 'edit' : 'start';
      }
      sideSig = '';
      render();
      return;
    }
    const pick = e.target.closest('[data-lvsel]');
    if (pick) {
      selectLevel(pick.dataset.lvsel);
      return;
    }
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
    } else if (pr?.vtx) {
      if (Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) > 3) pr.moved = true;
      if (pr.moved) {
        const c = toWorld(e);
        const ok = withFollow(() => moveVertex(g, pr.vtx, r10(c.x), r10(c.z)));
        if (!ok && !pr.warned) {
          pr.warned = true;
          hint('Стена зафиксирована — снимите «Фикс.»');
        }
        sideSig = '';
      }
    } else if (pr?.arc) {
      if (Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) > 3) pr.moved = true;
      if (pr.moved) {
        if (!dragArc(pr.arc, toWorld(e), e.altKey) && !pr.warned) {
          pr.warned = true;
          hint('Стена зафиксирована — снимите «Фикс.»');
        }
        sideSig = '';
      }
    }
    render();
  });

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture?.(e.pointerId);
    st.cur = toWorld(e);
    if (e.button !== 0 && e.button !== 1) return;

    // Старт: клик ставит первую точку сразу (как ожидает пользователь)
    if (e.button === 0 && st.mode === 'start') {
      if (!onFloor()) return hint('Рисовать можно только на уровне «Пол»');
      g = emptyGraph(r10(st.cur.x), r10(st.cur.z));
      L('floor').graph = g;
      st.mode = 'draw';
      st.activeVertex = g.vertices[0].id;
      st.refEdge = null;
      st.typed = { len: null, ang: null };
      sideSig = '';
      render();
      return;
    }

    if (popOpen()) closePop();

    if (e.button === 0 && st.mode !== 'draw') {
      const hit = hitOf(e.target);
      const now = performance.now();
      const lc = st.lastClick;
      if (hit && lc && lc.key === hit.key && now - lc.t < 450 && Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < 8) {
        st.lastClick = null;
        st.press = null;
        if (hit.kind === 'ang') openAnglePop(hit.id, e);
        else openWallPop(hit.id, e);
        return;
      }
      st.lastClick = hit ? { key: hit.key, t: now, x: e.clientX, y: e.clientY } : null;
      const arc = e.target.closest?.('.pe-arc');
      if (arc) {
        st.press = { arc: arc.dataset.v, sx: e.clientX, sy: e.clientY, moved: false };
        return;
      }
    }

    if (e.button === 1 || (e.button === 0 && st.mode !== 'draw' && !e.target.closest?.('.pe-vtx, .pe-wall'))) {
      st.press = { pan: true, sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false };
      return;
    }
    if (e.button !== 0) return;

    const vt = e.target.closest?.('.pe-vtx');
    if (vt) {
      // Зажимаем вершину: сдвиг — тянуть угол; короткий клик — рисовать от неё
      st.press = {
        vtx: vt.dataset.v,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
      };
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
    if (e.button !== 0) return;

    if (pr?.vtx && !pr.moved) {
      // Короткий клик по вершине — начать/продолжить рисование от неё (только пол)
      if (!onFloor()) {
        st.sel = null;
        sideSig = '';
        render();
        return;
      }
      if (edgesAtVertex(g, pr.vtx).length >= 2) {
        hint('Из угла между двумя стенами нельзя вывести третью — продолжайте от конца цепочки');
        return;
      }
      st.activeVertex = pr.vtx;
      st.refEdge = edgesAtVertex(g, pr.vtx).slice(-1)[0]?.id || null;
      st.mode = 'draw';
      st.typed = { len: null, ang: null };
      sideSig = '';
      render();
      return;
    }

    if (pr?.arc) {
      sideSig = '';
      render();
      return;
    }

    if (pr?.vtx && pr.moved) {
      // Длина рёбер могла измениться — обновить; топологию других уровней не трогаем
      g.edges.forEach((edge) => { edge.len = edgeLength(g, edge); });
      sideSig = '';
      render();
      return;
    }

    if (!pr?.pan || pr.moved) return;
    if (st.mode === 'edit') {
      st.sel = null;
      sideSig = '';
      render();
    }
  });

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.detail < 2 || st.mode === 'draw' || popOpen()) return;
    const hit = hitOf(e.target);
    if (!hit) return;
    st.press = null;
    st.lastClick = null;
    if (hit.kind === 'ang') openAnglePop(hit.id, e);
    else openWallPop(hit.id, e);
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

  /**
   * Ориентация контура. Пока рисуем — центроид слева по ходу (с учётом «Сторона комнаты»);
   * после этого направление обхода закреплено в st.dirRef и от правок длин/углов не меняется.
   */
  function orientVertexOrder(graph, verts) {
    let ordered = verts.map((v) => ({ id: v.id, x: Math.round(v.x), z: Math.round(v.z) }));
    if (st.mode === 'draw' || st.mode === 'start') st.dirRef = null;
    const dr = st.dirRef;
    if (dr && ordered.length >= 2) {
      const ids = ordered.map((v) => v.id);
      const cyc = isGraphClosed(graph);
      const n = ids.length;
      const i = ids.indexOf(dr.a), j = ids.indexOf(dr.b);
      if (i >= 0 && j >= 0) {
        const fwd = cyc ? j === (i + 1) % n : j === i + 1;
        const back = cyc ? i === (j + 1) % n : i === j + 1;
        if (fwd || back) {
          if (back) ordered.reverse();
          if (cyc) {
            const k = ordered.findIndex((v) => v.id === dr.a);
            ordered = [...ordered.slice(k), ...ordered.slice(0, k)];
          }
          return ordered;
        }
      }
    }
    if (ordered.length >= 3) {
      const c = graphCentroid(graph);
      let leftVotes = 0;
      for (let i = 0; i < ordered.length - 1; i++) {
        const dx = ordered[i + 1].x - ordered[i].x, dz = ordered[i + 1].z - ordered[i].z;
        const cross = dx * (c.z - ordered[i].z) - dz * (c.x - ordered[i].x);
        if (cross > 0) leftVotes++;
        else leftVotes--;
      }
      if (leftVotes < 0) ordered = ordered.slice().reverse();
    }
    if (st.flip < 0) ordered = ordered.slice().reverse();
    if (st.mode === 'edit' && ordered.length >= 2) st.dirRef = { a: ordered[0].id, b: ordered[1].id };
    return ordered;
  }

  /** Наружная нормаль стены: замкнутый контур — по полигону, открытый — справа по ходу обхода. */
  function outward(edge) {
    if (isGraphClosed(g)) return edgeOutwardNormal(g, edge, 1);
    const it = orderItem(edge.id);
    const a = getVertex(g, it ? it.a : edge.from), b = getVertex(g, it ? it.b : edge.to);
    if (!a || !b) return { nx: 0, nz: -1 };
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    return { nx: dz / len, nz: -dx / len };
  }

  const actions = {
    cancel: () => { close(); onCancel?.(); },
    importEkkd: () => {
      close();
      onImportEkkd?.();
    },
    apply: () => {
      saveActiveGraph();
      const floor = L('floor');
      const fg = floor?.graph;
      if (!fg?.edges?.length) return hint('Нарисуйте хотя бы одну стену на уровне «Пол»');
      if (fg.vertices.some((v) => edgesAtVertex(fg, v.id).length > 2)) {
        return hint('Есть развилка: из одного угла выходят три стены. Удалите лишнюю стену — контур должен быть одной цепочкой.');
      }
      if (fg.vertices.some((v) => !edgesAtVertex(fg, v.id).length)) {
        fg.vertices = fg.vertices.filter((v) => edgesAtVertex(fg, v.id).length);
      }
      syncLevelsTopology();

      st.levels.forEach((l) => {
        (l.graph?.edges || []).forEach((e) => { e.len = edgeLength(l.graph, e); });
      });

      const floorVerts = graphToOrderedVertices(fg);
      if (floorVerts.length < 2) return hint('Нарисуйте хотя бы одну стену');
      const floorOrder = orientVertexOrder(fg, floorVerts);
      let floorPts = floorOrder.map((v) => ({ x: v.x, z: v.z }));

      const closed = isGraphClosed(fg)
        || (floorPts.length >= 3
          && Math.hypot(floorPts[0].x - floorPts[floorPts.length - 1].x, floorPts[0].z - floorPts[floorPts.length - 1].z) < 30);
      if (closed && floorPts.length >= 3
        && Math.hypot(floorPts[0].x - floorPts[floorPts.length - 1].x, floorPts[0].z - floorPts[floorPts.length - 1].z) < 30) {
        floorPts = floorPts.slice(0, -1);
      }
      const orderIds = floorOrder.map((v) => v.id);
      if (closed && orderIds.length > floorPts.length) orderIds.pop();

      const outLevels = [...st.levels].sort((a, b) => +a.h - +b.h).map((l) => {
        if (l.id === 'floor') {
          return { id: l.id, name: l.name, h: Math.round(+l.h || 0), pts: floorPts.map((p) => ({ ...p })) };
        }
        const byId = new Map((l.graph?.vertices || []).map((v) => [v.id, v]));
        let pts = orderIds.map((id) => {
          const v = byId.get(id);
          return v ? { x: Math.round(v.x), z: Math.round(v.z) } : null;
        }).filter(Boolean);
        if (pts.length < 2) {
          pts = orientVertexOrder(l.graph || fg, graphToOrderedVertices(l.graph || fg))
            .map((v) => ({ x: v.x, z: v.z }));
        }
        return { id: l.id, name: l.name, h: Math.round(+l.h || 0), pts };
      });

      st.order = null;
      const items = computeOrder().items;
      const nWalls = closed ? floorPts.length : floorPts.length - 1;
      const walls = items.slice(0, nWalls).map((it) => ({
        id: it.e.wid || newWallId(),
        reversed: !!it.e.wstart && it.e.wstart !== it.a,
      }));
      const live = new Set(walls.map((w) => w.id));
      const names = Object.fromEntries(Object.entries(st.names).filter(([id, n]) => live.has(id) && n));

      close();
      onApply?.({ closed: !!closed, levels: outLevels, wallThick: st.thick, walls, wallNames: names });
    },
    fit: () => { fit(); render(); },
    draw: () => {
      if (!onFloor()) return hint('Новые стены рисуются только на уровне «Пол»');
      if (st.mode === 'draw') return finishDraw();
      if (!g.vertices.length) { st.mode = 'start'; sideSig = ''; render(); return; }
      st.mode = 'draw';
      if (!st.activeVertex) {
        const leaf = g.vertices.find((v) => edgesAtVertex(g, v.id).length === 1);
        st.activeVertex = leaf?.id || g.vertices[0].id;
        st.refEdge = edgesAtVertex(g, st.activeVertex).slice(-1)[0]?.id || null;
      }
      sideSig = '';
      render();
    },
    undo: undoEdge,
    flip: () => {
      if (isGraphClosed(L('floor').graph)) return hint('У замкнутого контура комната всегда внутри');
      st.flip *= -1;
      const ids = order().ids || [];
      if (st.mode === 'edit' && ids.length >= 2) st.dirRef = { a: ids[ids.length - 1], b: ids[ids.length - 2] };
      sideSig = '';
      render();
    },
    clear: () => {
      if (!onFloor()) return hint('Очистка — на уровне «Пол»');
      const any = st.levels.some((l) => l.graph?.edges?.length);
      if (any && !confirm('Удалить все стены на всех уровнях и начать с новой точки?')) return;
      st.levels.forEach((l) => { l.graph = { vertices: [], edges: [] }; });
      g = L('floor').graph;
      st.lv = 'floor';
      st.mode = 'start';
      st.activeVertex = null;
      st.refEdge = null;
      st.sel = null;
      st.flip = 1;
      fit();
      sideSig = '';
      render();
    },
    addLevel: () => {
      const id = st.levels.some((l) => l.id === 'ref') ? 'lv' + Date.now().toString(36) : 'ref';
      const name = id === 'ref' ? 'Столешница' : `Уровень ${st.levels.length - 1}`;
      const h = id === 'ref' ? 900 : 1500;
      saveActiveGraph();
      const floor = L('floor');
      const graph = floor?.graph?.edges?.length ? cloneGraph(floor.graph) : { vertices: [], edges: [] };
      st.levels.push({ id, name, h, graph });
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
    if (popOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closePop(); }
      return;
    }
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
