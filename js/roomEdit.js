// UI редактора помещения: свойства стены, план SVG, каталог конструкций.
import { cornerAngleDeg } from './roomGeom.js?v=20261110a';

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

/** Иконки превью конструкций (SVG). */
export const CTOR_ICONS = {
  win_std: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="8" width="36" height="32" rx="1" fill="#e8f1ff" stroke="#1f6feb" stroke-width="2"/><line x1="24" y1="8" x2="24" y2="40" stroke="#1f6feb" stroke-width="2"/><line x1="6" y1="24" x2="42" y2="24" stroke="#1f6feb" stroke-width="2"/><rect x="10" y="12" width="10" height="8" fill="#b8d4ff" opacity=".7"/><rect x="28" y="12" width="10" height="8" fill="#b8d4ff" opacity=".7"/></svg>`,
  door_std: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="4" width="24" height="40" rx="1" fill="#f5efe6" stroke="#8b6914" stroke-width="2"/><circle cx="30" cy="24" r="2" fill="#8b6914"/><path d="M12 4h24v4H12z" fill="#c4a574"/></svg>`,
  shaft: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="6" width="28" height="36" fill="#d4d0c8" stroke="#6b6560" stroke-width="2"/><path d="M14 14h20M14 24h20M14 34h20" stroke="#9a9590" stroke-width="2"/><circle cx="24" cy="24" r="5" fill="none" stroke="#6b6560" stroke-width="1.5"/></svg>`,
  column: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="8" width="16" height="32" fill="#c8c2b6" stroke="#5c574f" stroke-width="2"/><rect x="12" y="6" width="24" height="5" fill="#a89f90" stroke="#5c574f" stroke-width="1.5"/><rect x="12" y="37" width="24" height="5" fill="#a89f90" stroke="#5c574f" stroke-width="1.5"/></svg>`,
  beam: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="18" width="40" height="10" rx="1" fill="#b0a090" stroke="#6b5e4e" stroke-width="2"/><rect x="6" y="14" width="6" height="6" fill="#8a7a68"/><rect x="36" y="14" width="6" height="6" fill="#8a7a68"/></svg>`,
};

/** Простой modal-prompt внутри страницы. */
export function showRoomPrompt({ title, fields, okLabel = 'Применить' }) {
  return new Promise((resolve) => {
    const overlay = el(`<div class="room-prompt-overlay"></div>`);
    const box = el(`<div class="room-prompt"><h4>${title}</h4><div class="room-prompt-fields"></div><div class="btnrow"><button type="button" class="primary" data-ok>${okLabel}</button><button type="button" data-cancel>Отмена</button></div></div>`);
    const fieldsEl = box.querySelector('.room-prompt-fields');
    (fields || []).forEach((f) => {
      const row = el(`<label>${f.label}<input type="${f.type || 'number'}" data-k="${f.key}" value="${f.value ?? ''}" step="${f.step ?? 1}"></label>`);
      fieldsEl.appendChild(row);
    });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const finish = (val) => {
      overlay.remove();
      resolve(val);
    };
    box.querySelector('[data-cancel]').onclick = () => finish(null);
    box.querySelector('[data-ok]').onclick = () => {
      const out = {};
      fieldsEl.querySelectorAll('[data-k]').forEach((inp) => {
        out[inp.dataset.k] = inp.type === 'number' ? +inp.value : inp.value;
      });
      finish(out);
    };
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null);
    });
  });
}

// Ключи полей длины, которые подсвечивает viewer.setPropFocus; у прочих уровней — len:<id>
const LEN_KEY = { floor: 'lengthFloor', ref: 'lengthRef', ceil: 'lengthCeil' };
const fmtAng = (a) => (a == null ? '—' : `${a}°`);

export function renderWallPropsHtml(survey) {
  if (!survey) {
    return '<p class="muted">Выберите стену на плане (клик по ребру).</p>';
  }
  return `
    <div class="wall-props">
      <div class="muted" style="font-weight:600;margin-bottom:6px">Стена ${survey.letter}</div>
      <details class="room-block nested" open>
        <summary>Длины по уровням</summary>
        ${(survey.levels || []).map((l) => `<label>${l.name} (${l.h} мм)
          <input type="number" data-wp="${LEN_KEY[l.id] || `len:${l.id}`}" value="${l.len}" step="1">
        </label>`).join('')}
      </details>
      <details class="room-block nested" open>
        <summary>Углы (авто)</summary>
        <p class="muted" style="margin:4px 0">
          ${(survey.levels || []).map((l) => `${l.name}: начало ${fmtAng(l.angStart)} · конец ${fmtAng(l.angEnd)}`).join('<br>')}
        </p>
      </details>
      <details class="room-block nested">
        <summary>Цвет</summary>
        <label>Цвет этой стены
          <input type="color" data-wp="wallColor" value="${survey.colorHex || '#f6f4f0'}">
        </label>
      </details>
      <p class="muted">Углы на плане обновляются сами при сдвиге вершин.</p>
    </div>`;
}

/** Каталог конструкций как в BPlanner. */
export const CONSTRUCTION_CATALOG = [
  { id: 'win_std', title: 'Окно', kind: 'opening', type: 'window', width: 1200, height: 1400, sill: 900 },
  { id: 'door_std', title: 'Дверь', kind: 'opening', type: 'door', width: 900, height: 2100, sill: 0 },
  { id: 'shaft', title: 'Вентшахта', kind: 'obstacle', w: 600, d: 400, y0: 0, y1: 2700, name: 'Вентшахта' },
  { id: 'column', title: 'Колонна', kind: 'obstacle', w: 400, d: 400, y0: 0, y1: 2700, name: 'Колонна' },
  { id: 'beam', title: 'Балка / ригель', kind: 'obstacle', w: 2000, d: 300, y0: 2400, y1: 2700, name: 'Балка' },
];

/**
 * SVG-план сверху. opts.verts — контур активного слоя; углы — авто.
 */
export function renderPlanSvg(container, room, opts = {}) {
  if (!container) return;
  const verts = (opts.verts?.length >= 3)
    ? opts.verts
    : (room.planFloor?.length >= 3)
      ? room.planFloor
      : [
        { x: 0, z: 0 }, { x: +room.length || 4000, z: 0 },
        { x: +room.length || 4000, z: +room.depth || 3500 }, { x: 0, z: +room.depth || 3500 },
      ];
  // отступ под подписи длин / углов / тег слоя
  const padX = 28;
  const padY = 26;
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  for (const p of verts) {
    x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x);
    z1 = Math.min(z1, p.z); z2 = Math.max(z2, p.z);
  }
  const bw = Math.max(100, x2 - x1), bd = Math.max(100, z2 - z1);
  // ширина — от контейнера; высота — под пропорции плана, чтобы комната заполняла поле
  const W = Math.max(120, container.clientWidth || 280);
  const aspectH = Math.round((W - padX * 2) * (bd / bw) + padY * 2);
  const H = Math.max(150, Math.min(320, aspectH));
  if (container.style.height !== `${H}px`) container.style.height = `${H}px`;
  const sx = (W - padX * 2) / bw;
  const sz = (H - padY * 2) / bd;
  const s = Math.min(sx, sz);
  const ox = padX + (W - padX * 2 - bw * s) / 2;
  const oz = padY + (H - padY * 2 - bd * s) / 2;
  const tx = (x) => ox + (x - x1) * s;
  const tz = (z) => oz + (z - z1) * s;
  const n = verts.length;
  const pts = verts.map((p) => `${tx(p.x).toFixed(1)},${tz(p.z).toFixed(1)}`).join(' ');
  let edges = '';
  let labels = '';
  let handles = '';
  let angles = '';
  const nWalls = +room.wallCount > 0 && +room.wallCount < n ? +room.wallCount : n;
  const labelOffPx = 14;
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    if (i >= nWalls) {
      edges += `<line x1="${tx(a.x)}" y1="${tz(a.z)}" x2="${tx(b.x)}" y2="${tz(b.z)}" class="plan-edge virt"/>`;
      continue;
    }
    const len = Math.round(Math.hypot(b.x - a.x, b.z - a.z));
    const letter = String.fromCharCode(65 + (i % 26));
    const ax = tx(a.x), az = tz(a.z), bx = tx(b.x), bz = tz(b.z);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const sdx = bx - ax, sdz = bz - az;
    const sl = Math.hypot(sdx, sdz) || 1;
    // наружная нормаль в экранных координатах (CCW → наружу)
    const snx = sdz / sl, snz = -sdx / sl;
    let lx = mx + snx * labelOffPx;
    let lz = mz + snz * labelOffPx;
    // если подпись уезжает за край — зеркалим внутрь
    if (lx < 10 || lx > W - 10 || lz < 14 || lz > H - 10) {
      lx = mx - snx * labelOffPx;
      lz = mz - snz * labelOffPx;
    }
    lx = Math.max(10, Math.min(W - 10, lx));
    lz = Math.max(14, Math.min(H - 10, lz));
    const sel = opts.selectedEdge === i;
    const focLen = sel && opts.propFocus && String(opts.propFocus).startsWith('length');
    edges += `<line data-edge="${i}" x1="${ax}" y1="${az}" x2="${bx}" y2="${bz}" class="plan-edge${sel ? ' sel' : ''}${focLen ? ' focus' : ''}"/>`;
    labels += `<text data-edge-label="${i}" x="${lx.toFixed(1)}" y="${lz.toFixed(1)}" class="plan-len${focLen ? ' focus' : ''}">${letter} ${len}</text>`;
  }
  const angOffPx = 18;
  for (let i = 0; i < n; i++) {
    handles += `<circle data-vert="${i}" cx="${tx(verts[i].x)}" cy="${tz(verts[i].z)}" r="6" class="plan-vert"/>`;
    if (nWalls < n && !(i >= 1 && i < nWalls)) continue;
    const ang = cornerAngleDeg(verts, i);
    const prev = verts[(i - 1 + n) % n];
    const cur = verts[i];
    const next = verts[(i + 1) % n];
    const ix = (prev.x + next.x) / 2 - cur.x;
    const iz = (prev.z + next.z) / 2 - cur.z;
    const il = Math.hypot(ix, iz) || 1;
    let angX = tx(cur.x) + (ix / il) * angOffPx;
    let angZ = tz(cur.z) + (iz / il) * angOffPx;
    angX = Math.max(10, Math.min(W - 10, angX));
    angZ = Math.max(14, Math.min(H - 10, angZ));
    angles += `<text class="plan-ang" x="${angX.toFixed(1)}" y="${angZ.toFixed(1)}">${ang}°</text>`;
  }
  // Базовое состояние при drag: пунктир исходных рёбер у вершины
  let baseline = '';
  const base = opts.baseline;
  if (base?.verts?.length === n && base.i != null) {
    const bi = base.i;
    const bv = base.verts;
    const prev = (bi - 1 + n) % n;
    const next = (bi + 1) % n;
    const mkDash = (a, b) =>
      `<line x1="${tx(a.x)}" y1="${tz(a.z)}" x2="${tx(b.x)}" y2="${tz(b.z)}" class="plan-baseline"/>`;
    baseline += mkDash(bv[prev], bv[bi]);
    baseline += mkDash(bv[bi], bv[next]);
    baseline += `<circle cx="${tx(bv[bi].x)}" cy="${tz(bv[bi].z)}" r="5" class="plan-baseline-vert"/>`;
  }
  const layerTag = opts.layerLabel
    ? `<text class="plan-layer-tag" x="${padX}" y="14">${opts.layerLabel}</text>`
    : '';
  container.innerHTML = `<svg class="plan-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <polygon points="${pts}" class="plan-fill"/>
    ${baseline}${edges}${labels}${angles}${handles}${layerTag}
  </svg>`;
  container.querySelectorAll('[data-edge]').forEach((ln) => {
    ln.onclick = (e) => { e.stopPropagation(); opts.onEdgeClick?.(+ln.dataset.edge); };
  });
  container.querySelectorAll('[data-vert]').forEach((c) => {
    c.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const i = +c.dataset.vert;
      opts.onVertexDown?.(i);
      const move = (ev) => {
        const rect = container.querySelector('svg').getBoundingClientRect();
        const px = (ev.clientX - rect.left - ox) / s + x1;
        const pz = (ev.clientY - rect.top - oz) / s + z1;
        opts.onVertexDrag?.(i, Math.round(px / 10) * 10, Math.round(pz / 10) * 10);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        opts.onVertexUp?.(i);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  });
}
