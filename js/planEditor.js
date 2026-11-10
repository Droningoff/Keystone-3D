// Редактор помещения «план сверху»: стены от стартовой точки, длины и углы, фиксация стен,
// уровни замера (пол, потолок, столешница, …) — у каждого уровня свой контур тех же стен.
// Координаты в мм, ось Z на экране вниз. Новые стены рисуются на уровне «Пол», остальные уровни
// получают их копией и правятся отдельно (наклон стен по высоте).

import {
  emptyChain, chainPoints, chainHeadings, chainSegments, chainFloor, chainFromPoints,
  reverseChain, isChainReversed, angBetween, norm360, bboxOf,
} from './roomPlan.js?v=20261110a';

const RAD = Math.PI / 180;
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r10 = (v) => Math.round(v / 10) * 10;
const r1 = (v) => Math.round(v * 10) / 10;
const fmtA = (a) => String(r1(a)).replace('.', ',');
const LEVEL_COLORS = ['#1f6feb', '#b4530a', '#2e9d4f', '#8e44ad', '#c0392b', '#16a085'];
const FIXED = new Set(['floor', 'ceil']);

const HTML = `
<div class="pe-dlg" tabindex="-1">
  <div class="pe-head">
    <b>Помещение — план сверху</b>
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
        <button data-a="draw" class="primary"></button>
        <button data-a="close" title="Достроить стену от последней точки к стартовой">Замкнуть</button>
        <button data-a="undo" title="Backspace">Удалить последнюю</button>
      </div>
      <div class="btnrow">
        <button data-a="flip" title="Комната окажется по другую сторону стен">Сторона комнаты ⇄</button>
        <button data-a="clear" class="danger">Начать заново</button>
      </div>
      <h4>Уровни замера</h4>
      <div data-r="levels"></div>
      <button data-a="addLevel">+ Уровень</button>
      <h4 data-r="wallsTitle">Стены</h4>
      <div data-r="walls"></div>
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
 * @param {{levels?: Array<{id,name,h,chain?}>, wallThick?: number, onApply: Function, onCancel?: Function}} opts
 *   levels — уровни с цепочками стен (у всех одинаковое число стен); без цепочек — рисование с нуля.
 *   onApply({ closed, levels: [{ id, name, h, pts }], wallThick })
 */
export function openPlanEditor({ levels = null, wallThick = 100, onApply, onCancel } = {}) {
  const lv0 = clone(levels?.length ? levels : [{ id: 'floor', name: 'Пол', h: 0 }, { id: 'ceil', name: 'Потолок', h: 2700 }]);
  if (!lv0.some((l) => l.id === 'floor')) lv0.unshift({ id: 'floor', name: 'Пол', h: 0 });
  if (!lv0.some((l) => l.id === 'ceil')) lv0.push({ id: 'ceil', name: 'Потолок', h: 2700 });
  const has = !!lv0.find((l) => l.id === 'floor').chain?.walls?.length;
  if (!has) lv0.forEach((l) => { l.chain = null; });
  const st = {
    levels: lv0,
    lv: 'floor',
    mode: has ? 'edit' : 'start', // start → draw → edit
    thick: +wallThick || 100,
    cur: null,
    alt: false,
    typed: { len: null, ang: null },
    sel: -1,
    view: null,
    press: null,
    userFlipped: false,
  };
  const L = (id) => st.levels.find((l) => l.id === id);
  const F = () => L('floor').chain;
  const C = () => L(st.lv)?.chain;
  const lvColor = (id) => LEVEL_COLORS[Math.max(0, st.levels.findIndex((l) => l.id === id)) % LEVEL_COLORS.length];

  const back = document.createElement('div');
  back.className = 'pe-back';
  back.innerHTML = HTML;
  document.body.appendChild(back);
  const R = (n) => back.querySelector(`[data-r="${n}"]`);
  const svg = R('svg');
  const liveLen = R('liveLen'), liveAng = R('liveAng');

  // ---------- уровни: топология стен как у пола ----------
  function syncLevels() {
    const f = F();
    const fp = f ? chainPoints(f) : null;
    for (const l of st.levels) {
      if (l.id === 'floor') continue;
      if (!f) { l.chain = null; continue; }
      if (!l.chain) {
        l.chain = clone(f);
        l.chain.walls.forEach((w) => { w.lock = false; });
        continue;
      }
      const cp = chainPoints(l.chain);
      if (cp.length !== fp.length) {
        const k = Math.min(cp.length, fp.length);
        const pts = cp.slice(0, k);
        const off = { x: cp[k - 1].x - fp[k - 1].x, z: cp[k - 1].z - fp[k - 1].z };
        for (let i = k; i < fp.length; i++) pts.push({ x: fp[i].x + off.x, z: fp[i].z + off.z });
        l.chain = chainFromPoints(pts, f.closed, l.chain.walls.map((w) => w.lock));
      }
      l.chain.closed = f.closed;
    }
  }
  const reverseAll = () => st.levels.forEach((l) => { if (l.chain?.walls.length) l.chain = reverseChain(l.chain); });

  // ---------- вид ----------
  const size = () => ({ w: svg.clientWidth || 800, h: svg.clientHeight || 600 });
  const mmPx = () => st.view.w / size().w;

  function fit() {
    const { w, h } = size();
    const pts = st.levels.flatMap((l) => (l.chain?.walls.length ? [...chainPoints(l.chain), ...chainFloor(l.chain)] : []));
    let b;
    if (pts.length) b = bboxOf(pts);
    else if (F()) b = { x1: F().x0 - 2000, z1: F().z0 - 2000, x2: F().x0 + 2000, z2: F().z0 + 2000 };
    else b = { x1: 0, z1: 0, x2: 6000, z2: 4500 };
    const m = 900;
    const bw = b.x2 - b.x1 + 2 * m, bh = b.z2 - b.z1 + 2 * m;
    const vw = Math.max(bw, (bh * w) / h);
    const vh = (vw * h) / w;
    st.view = { x: (b.x1 + b.x2) / 2 - vw / 2, y: (b.z1 + b.z2) / 2 - vh / 2, w: vw, h: vh };
  }

  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return {
      x: st.view.x + ((e.clientX - r.left) / r.width) * st.view.w,
      z: st.view.y + ((e.clientY - r.top) / r.height) * st.view.h,
    };
  }

  // ---------- резиновая стена ----------
  function rubber() {
    const f = F();
    if (st.mode !== 'draw' || !f) return null;
    const pts = chainPoints(f);
    const P = pts[pts.length - 1];
    const n = f.walls.length;
    const prevH = n ? chainHeadings(f)[n - 1] : 0;
    const c = st.cur;
    if (n >= 2 && c && st.typed.len == null && st.typed.ang == null
      && Math.hypot(c.x - pts[0].x, c.z - pts[0].z) < 14 * mmPx()) {
      return { closing: true, P, Q: pts[0], len: Math.round(Math.hypot(pts[0].x - P.x, pts[0].z - P.z)), ang: null, raw: Infinity };
    }
    let h = n ? prevH + 90 : 0, len = 1000;
    const raw = c ? Math.hypot(c.x - P.x, c.z - P.z) : Infinity;
    if (c && raw > 1) {
      h = Math.atan2(c.z - P.z, c.x - P.x) / RAD;
      len = raw;
    }
    let ang = n ? angBetween(prevH, h) : norm360(h);
    ang = st.alt ? r1(ang) : norm360(Math.round(ang / 15) * 15);
    len = Math.max(10, r10(len));
    if (st.typed.len != null) len = st.typed.len;
    if (st.typed.ang != null) ang = st.typed.ang;
    if (n) ang = Math.min(359, Math.max(1, ang));
    const hh = (n ? prevH + 180 - ang : ang) * RAD;
    return { closing: false, P, Q: { x: P.x + Math.cos(hh) * len, z: P.z + Math.sin(hh) * len }, len, ang, raw };
  }

  function commitWall() {
    const r = rubber();
    if (!r) return;
    const f = F();
    if (r.closing) {
      f.closed = true;
      finishDraw();
      return;
    }
    // второй клик двойного клика — курсор на только что поставленной точке
    if (r.len < 10 || (st.typed.len == null && r.raw < 6 * mmPx())) return;
    const n = f.walls.length;
    if (!n) f.dir = r1(norm360(r.ang));
    f.walls.push({ len: Math.round(r.len), ang: n ? r1(r.ang) : 180, lock: false });
    st.typed = { len: null, ang: null };
    syncLevels();
    render();
  }

  function finishDraw() {
    const f = F();
    st.mode = f?.walls.length ? 'edit' : (f ? 'draw' : 'start');
    if (st.mode === 'edit' && !st.userFlipped && isChainReversed(f)) reverseAll();
    syncLevels();
    st.typed = { len: null, ang: null };
    document.activeElement?.blur?.();
    render();
  }

  function undoWall() {
    const f = F();
    if (!f || st.lv !== 'floor') return;
    if (f.closed) { f.closed = false; syncLevels(); render(); return; }
    const last = f.walls[f.walls.length - 1];
    if (last?.lock) return hint('Последняя стена зафиксирована — снимите «Фикс.»');
    f.walls.pop();
    if (!f.walls.length) st.mode = 'draw';
    syncLevels();
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

  // ---------- отрисовка ----------
  function renderHint() {
    if (R('hint').classList.contains('warn')) return;
    const lv = L(st.lv);
    R('hint').textContent = st.lv !== 'floor'
      ? `Контур уровня «${lv.name}» (${Math.round(+lv.h)} мм): длины и углы стен на этой высоте. Новые стены рисуются на уровне «Пол».`
      : {
        start: 'Кликните точку, от которой пойдёт первая стена.',
        draw: 'Клик — поставить стену. Угол шагом 15° (Alt — свободно). Цифры с клавиатуры + Enter — точная длина. '
          + 'Клик по стартовой точке — замкнуть. Правая кнопка, двойной клик или Esc — закончить.',
        edit: 'Длины и углы — в таблице справа или перетаскиванием точек. «Фикс.» защищает стену от изменений. '
          + 'Колесо — масштаб, перетаскивание фона — сдвиг.',
      }[st.mode];
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

    const f = F();
    const c = C();
    const T = st.thick;
    if (f && f.walls.length) {
      const fl = chainFloor(f);
      out.push(`<polygon points="${fl.map((q) => `${q.x},${q.z}`).join(' ')}" fill="#efe6d6" stroke="#cdbfa6"
        stroke-width="${sw}" stroke-dasharray="${5 * k} ${4 * k}"/>`);
      // остальные уровни — пунктиром своим цветом
      for (const l of st.levels) {
        if (l.id === st.lv || !l.chain?.walls.length) continue;
        const pts = chainPoints(l.chain);
        if (l.chain.closed) pts.push(pts[0]);
        out.push(`<polyline points="${pts.map((q) => `${q.x},${q.z}`).join(' ')}" fill="none" stroke="${lvColor(l.id)}"
          stroke-width="${1.5 * sw}" stroke-dasharray="${7 * k} ${5 * k}" opacity="0.8"/>`);
        out.push(`<text x="${pts[0].x + 10 * k}" y="${pts[0].z - 10 * k}" font-size="${fs * 0.85}" style="fill:${lvColor(l.id)}">${esc(l.name)}</text>`);
      }
    }
    if (c && c.walls.length) {
      const segs = chainSegments(c);
      segs.forEach((s) => {
        const locked = !s.closing && c.walls[s.index]?.lock;
        const selC = s.index === st.sel;
        const quad = [
          [s.x1, s.z1], [s.x2, s.z2],
          [s.x2 + s.nx * T, s.z2 + s.nz * T], [s.x1 + s.nx * T, s.z1 + s.nz * T],
        ];
        out.push(`<polygon data-w="${s.index}" class="pe-wall" points="${quad.map((q) => q.join(',')).join(' ')}"
          fill="${selC ? '#5b8def' : locked ? '#59616b' : s.closing ? '#b9c0c8' : '#8d96a1'}"
          stroke="#2f343a" stroke-width="${sw}" ${s.closing ? `stroke-dasharray="${6 * k} ${4 * k}"` : ''}/>`);
        const o = T + 16 * k;
        let a = Math.atan2(s.tz, s.tx) / RAD;
        if (a > 90 || a < -90) a += 180;
        const lx = s.midX + s.nx * o, lz = s.midZ + s.nz * o;
        out.push(`<text x="${lx}" y="${lz}" font-size="${fs}" text-anchor="middle" dominant-baseline="middle"
          transform="rotate(${a} ${lx} ${lz})" class="pe-len">${s.letter} ${Math.round(s.len)}${locked ? ' (фикс.)' : ''}</text>`);
      });
      const nSeg = segs.length;
      for (let i = 0; i < nSeg; i++) {
        if (i === nSeg - 1 && !c.closed) break;
        const a = segs[i], b = segs[(i + 1) % nSeg];
        const ang = angBetween(Math.atan2(a.tz, a.tx) / RAD, Math.atan2(b.tz, b.tx) / RAD);
        let bx = -a.nx - b.nx, bz = -a.nz - b.nz;
        const bl = Math.hypot(bx, bz);
        if (bl < 1e-6) { bx = -b.nx; bz = -b.nz; } else { bx /= bl; bz /= bl; }
        out.push(`<text x="${a.x2 + bx * 30 * k}" y="${a.z2 + bz * 30 * k}" font-size="${fs}" text-anchor="middle"
          dominant-baseline="central" class="pe-ang">${fmtA(ang)}°</text>`);
      }
    }

    const rb = rubber();
    if (rb) {
      out.push(`<line x1="${rb.P.x}" y1="${rb.P.z}" x2="${rb.Q.x}" y2="${rb.Q.z}" stroke="${rb.closing ? '#2e9d4f' : '#1f6feb'}"
        stroke-width="${3 * sw}" stroke-dasharray="${8 * k} ${5 * k}"/>`);
      const mx = (rb.P.x + rb.Q.x) / 2, mz = (rb.P.z + rb.Q.z) / 2;
      const label = rb.closing ? `замкнуть · ${rb.len}` : `${rb.len} мм · ${fmtA(rb.ang)}°`;
      out.push(`<text x="${mx}" y="${mz - 12 * k}" font-size="${fs * 1.1}" text-anchor="middle" class="pe-rb">${esc(label)}</text>`);
    }

    if (c) {
      chainPoints(c).forEach((q, i) => {
        out.push(`<circle data-v="${i}" class="pe-vtx" cx="${q.x}" cy="${q.z}" r="${(i === 0 ? 7 : 5) * k}"
          fill="${i === 0 ? '#2e9d4f' : '#fff'}" stroke="#1f2328" stroke-width="${1.5 * sw}"/>`);
      });
    } else if (st.cur) {
      out.push(`<circle cx="${r10(st.cur.x)}" cy="${r10(st.cur.z)}" r="${6 * k}" fill="#2e9d4f" opacity="0.6"/>`);
    }
    svg.innerHTML = out.join('');

    R('live').style.display = st.mode === 'draw' && f ? '' : 'none';
    R('liveAngT').textContent = f?.walls.length ? 'Угол к пред., °' : 'Направление, °';
    if (rb && !rb.closing) {
      for (const [inp, key, val] of [[liveLen, 'len', rb.len], [liveAng, 'ang', r1(rb.ang)]]) {
        if (st.typed[key] != null) continue;
        inp.value = val;
        if (document.activeElement === inp) inp.select();
      }
    }

    const onFloor = st.lv === 'floor';
    const btnDraw = back.querySelector('[data-a="draw"]');
    btnDraw.textContent = st.mode === 'draw' ? 'Готово' : f?.walls.length ? 'Продолжить стены' : 'Рисовать';
    btnDraw.disabled = !onFloor;
    back.querySelector('[data-a="close"]').disabled = !(onFloor && f && f.walls.length >= 2 && !f.closed);
    back.querySelector('[data-a="undo"]').disabled = !(onFloor && f && f.walls.length);
    back.querySelector('[data-a="flip"]').disabled = !(f && f.walls.length);
    renderHint();
    renderSide();
  }

  // ---------- правая панель ----------
  let sideSig = '';
  function renderSide() {
    const c = C();
    const sig = JSON.stringify([st.levels, st.lv, st.sel, st.thick]);
    if (sig === sideSig) return;
    sideSig = sig;
    const focusKey = document.activeElement?.dataset?.key;

    R('levels').innerHTML = `<table class="pe-table">${[...st.levels].sort((a, b) => +a.h - +b.h).map((l) => `
      <tr class="${l.id === st.lv ? 'sel' : ''}">
        <td><button class="pe-lvbtn" data-lvsel="${l.id}" title="Править контур этого уровня"
          style="border-color:${lvColor(l.id)}">${l.id === st.lv ? '●' : '○'}</button></td>
        <td><input data-key="l${l.id}n" data-lv="${l.id}" data-f="name" value="${esc(l.name)}"></td>
        <td><input type="number" step="10" data-key="l${l.id}h" data-lv="${l.id}" data-f="h" value="${Math.round(+l.h)}"
          ${l.id === 'floor' ? 'disabled' : ''} title="Высота уровня от пола, мм"></td>
        <td>${FIXED.has(l.id) ? '' : `<button class="danger" data-del-lv="${l.id}" title="Удалить уровень">×</button>`}</td>
      </tr>`).join('')}</table>`;

    const lv = L(st.lv);
    R('wallsTitle').textContent = `Стены — уровень «${lv.name}»`;
    const rows = [];
    if (c && c.walls.length) {
      c.walls.forEach((w, i) => {
        const dis = w.lock ? 'disabled' : '';
        const letter = String.fromCharCode(65 + (i % 26));
        rows.push(`<tr class="${i === st.sel ? 'sel' : ''}${w.lock ? ' locked' : ''}" data-row="${i}">
          <td>${letter}</td>
          <td><input type="number" step="10" min="10" data-key="w${i}len" data-w="${i}" data-f="len" value="${Math.round(w.len)}" ${dis}></td>
          <td><input type="number" step="1" data-key="w${i}ang" data-w="${i}" data-f="ang" value="${i === 0 ? r1(c.dir) : r1(w.ang)}" ${dis}
            title="${i === 0 ? 'Направление первой стены: 0 — вправо, 90 — вниз' : `Угол между стенами ${String.fromCharCode(64 + i)} и ${letter} со стороны комнаты`}"></td>
          <td><input type="checkbox" data-w="${i}" data-f="lock" ${w.lock ? 'checked' : ''} title="Зафиксировать длину и угол стены"></td>
        </tr>`);
      });
      const segs = chainSegments(c);
      const cl = segs.find((s) => s.closing);
      if (cl) {
        const hs = segs.map((s) => Math.atan2(s.tz, s.tx) / RAD);
        const n = segs.length;
        rows.push(`<tr class="closing"><td>${cl.letter}</td><td>${Math.round(cl.len)}</td>
          <td title="Углы у замыкающей стены: с предыдущей / со стартовой">${fmtA(angBetween(hs[n - 2], hs[n - 1]))} / ${fmtA(angBetween(hs[n - 1], hs[0]))}</td>
          <td class="muted">замык.</td></tr>`);
      }
    }
    R('walls').innerHTML = rows.length
      ? `<table class="pe-table"><tr><th>Стена</th><th>Длина, мм</th><th>Угол, °</th><th>Фикс.</th></tr>${rows.join('')}</table>`
      : '<p class="muted">Стен пока нет.</p>';
    R('thick').value = st.thick;

    const f = F();
    const segs = f ? chainSegments(f) : [];
    R('sum').textContent = f && f.walls.length
      ? `Стен: ${segs.length} · ${f.closed ? 'контур замкнут' : 'контур открыт'} · уровней: ${st.levels.length}`
      : '';
    if (focusKey) back.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  const side = back.querySelector('.pe-side');
  side.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.w != null) {
      const c = C();
      const i = +t.dataset.w, w = c.walls[i];
      if (t.dataset.f === 'lock') w.lock = t.checked;
      else if (!w.lock) {
        const val = +t.value;
        if (t.dataset.f === 'len') {
          if (val >= 10) w.len = Math.round(val);
        } else if (i === 0) c.dir = r1(norm360(val));
        else if (val > 0 && val < 360) w.ang = r1(val);
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
      render();
    }
  });
  side.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-lv]');
    if (del) {
      st.levels = st.levels.filter((l) => l.id !== del.dataset.delLv);
      if (!L(st.lv)) st.lv = 'floor';
      render();
      return;
    }
    const pick = e.target.closest('[data-lvsel]');
    if (pick) {
      st.lv = pick.dataset.lvsel;
      if (st.lv !== 'floor' && st.mode === 'draw') finishDraw();
      st.sel = -1;
      render();
      return;
    }
    const row = e.target.closest('[data-row]');
    if (row && e.target.tagName !== 'INPUT') { st.sel = +row.dataset.row; render(); }
  });
  side.addEventListener('focusin', (e) => {
    const i = e.target.dataset?.w;
    if (i != null && +i !== st.sel) { st.sel = +i; render(); }
  });

  // ---------- живой ввод ----------
  for (const [inp, key] of [[liveLen, 'len'], [liveAng, 'ang']]) {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      const s = inp.value.trim().replace(',', '.');
      st.typed[key] = s === '' || !Number.isFinite(+s) ? null : +s;
      render();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitWall(); inp.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); st.typed[key] = null; inp.blur(); render(); }
      else if (e.key === 'Tab') { e.preventDefault(); (inp === liveLen ? liveAng : liveLen).focus(); }
    });
  }

  // ---------- мышь ----------
  svg.addEventListener('pointermove', (e) => {
    st.alt = e.altKey;
    st.cur = toWorld(e);
    const pr = st.press;
    if (pr?.pan) {
      const k = mmPx();
      st.view.x = pr.vx - (e.clientX - pr.sx) * k;
      st.view.y = pr.vy - (e.clientY - pr.sy) * k;
      if (Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) > 3) pr.moved = true;
    } else if (pr?.vtx != null) {
      dragVertex(pr.vtx, st.cur, e.altKey);
    }
    render();
  });

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture?.(e.pointerId);
    st.cur = toWorld(e);
    if (e.button === 1 || (e.button === 0 && st.mode !== 'draw' && !e.target.closest?.('.pe-vtx, .pe-wall'))) {
      st.press = { pan: true, sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false };
      return;
    }
    if (e.button !== 0) return;
    if (st.mode === 'draw') {
      if (document.activeElement === liveLen || document.activeElement === liveAng) document.activeElement.blur();
      commitWall();
      return;
    }
    const vt = e.target.closest?.('.pe-vtx');
    if (vt) { st.press = { vtx: +vt.dataset.v }; return; }
    const wl = e.target.closest?.('.pe-wall');
    if (wl) {
      st.sel = +wl.dataset.w;
      render();
      back.querySelector(`[data-key="w${st.sel}len"]`)?.focus();
    }
  });

  svg.addEventListener('pointerup', (e) => {
    const pr = st.press;
    st.press = null;
    try { svg.releasePointerCapture?.(e.pointerId); } catch (_) { /* */ }
    if (!pr?.pan || pr.moved || e.button !== 0) return;
    if (st.mode === 'start') {
      const c = toWorld(e);
      L('floor').chain = emptyChain(r10(c.x), r10(c.z));
      st.lv = 'floor';
      st.mode = 'draw';
      syncLevels();
      render();
    } else if (st.mode === 'edit') {
      st.sel = -1;
      render();
    }
  });

  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (st.mode === 'draw') finishDraw();
  });
  svg.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (st.mode === 'draw' && F()?.walls.length) finishDraw();
  });
  svg.addEventListener('pointerleave', () => { if (!st.press) { st.cur = null; render(); } });

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

  /** Вершина 0 сдвигает все уровни; вершина k — длину и угол стены k-1 текущего уровня (хвост поворачивается за ней). */
  function dragVertex(k, cur, free) {
    const c = C();
    if (!c) return;
    if (k === 0) {
      const dx = r10(cur.x) - c.x0, dz = r10(cur.z) - c.z0;
      for (const l of st.levels) if (l.chain) { l.chain.x0 += dx; l.chain.z0 += dz; }
      return;
    }
    const i = k - 1, w = c.walls[i];
    if (!w || w.lock) { hint(`Стена ${String.fromCharCode(65 + i)} зафиксирована — снимите «Фикс.», чтобы менять`); return; }
    const P = chainPoints(c)[i];
    const h = Math.atan2(cur.z - P.z, cur.x - P.x) / RAD;
    const step = free ? 0.1 : 5;
    const snap = (a) => Math.round(a / step) * step;
    w.len = Math.max(10, r10(Math.hypot(cur.x - P.x, cur.z - P.z)));
    if (i === 0) c.dir = r1(norm360(snap(h)));
    else w.ang = Math.min(359, Math.max(1, r1(snap(angBetween(chainHeadings(c)[i - 1], h)))));
  }

  // ---------- кнопки ----------
  const actions = {
    cancel: () => { close(); onCancel?.(); },
    apply: () => {
      if (!F()?.walls.length) return hint('Нарисуйте хотя бы одну стену');
      syncLevels();
      const res = {
        closed: !!F().closed,
        wallThick: st.thick,
        levels: [...st.levels].sort((a, b) => +a.h - +b.h)
          .map((l) => ({ id: l.id, name: l.name, h: Math.round(+l.h), pts: chainPoints(l.chain) })),
      };
      close();
      onApply?.(res);
    },
    fit: () => { fit(); render(); },
    draw: () => {
      if (st.lv !== 'floor') return;
      if (st.mode === 'draw') return finishDraw();
      const f = F();
      if (!f) { st.mode = 'start'; render(); return; }
      if (f.closed) { f.closed = false; syncLevels(); }
      st.mode = 'draw';
      render();
    },
    close: () => {
      const f = F();
      if (st.lv !== 'floor' || !(f?.walls.length >= 2)) return;
      f.closed = true;
      if (st.mode === 'draw') finishDraw(); else { syncLevels(); render(); }
    },
    undo: undoWall,
    flip: () => {
      if (!F()?.walls.length) return;
      reverseAll(); st.userFlipped = true; st.sel = -1; render();
    },
    clear: () => {
      if (F()?.walls.length && !confirm('Удалить все стены на всех уровнях и начать с новой точки?')) return;
      st.levels.forEach((l) => { l.chain = null; });
      st.lv = 'floor'; st.mode = 'start'; st.sel = -1; st.userFlipped = false; fit(); render();
    },
    addLevel: () => {
      const id = st.levels.some((l) => l.id === 'ref') ? 'lv' + Date.now().toString(36) : 'ref';
      const name = id === 'ref' ? 'Столешница' : `Уровень ${st.levels.length - 1}`;
      const h = id === 'ref' ? 900 : 1500;
      st.levels.push({ id, name, h, chain: null });
      syncLevels();
      render();
    },
  };
  back.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (b && !b.disabled && actions[b.dataset.a]) actions[b.dataset.a]();
  });

  function onKey(e) {
    const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    st.alt = e.altKey;
    if (inInput) return;
    // горячие клавиши сцены под диалогом не срабатывают
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (st.mode === 'draw') finishDraw();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoWall(); return; }
    if (e.key === 'Enter' && st.mode === 'draw') { e.preventDefault(); commitWall(); return; }
    if (st.mode === 'draw' && F() && /^[0-9]$/.test(e.key)) {
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

  syncLevels();
  requestAnimationFrame(() => { fit(); render(); back.querySelector('.pe-dlg').focus(); });
  return { close };
}
