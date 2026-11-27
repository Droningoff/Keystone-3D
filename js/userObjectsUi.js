// Окно загрузки / замены модели в личном каталоге объектов.

import {
  normalizeSource, guessUnits, renderUserObjectThumb, userObjectCategories,
  UNIT_LABELS, DEFAULT_OBJECT_COLOR,
} from './userObjects.js?v=20261127k';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Диалог выбора файлов; resolve(File[]) или [] при отмене. */
export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files || [])]);
    input.click();
  });
}

/**
 * Карточка объекта перед сохранением в каталог.
 * @param source результат readObjSources (один OBJ)
 * @param existing запись каталога при замене модели
 * @returns Promise<null | { meta, meshRec }>
 */
export function openUserObjectDialog(source, existing = null) {
  return new Promise((resolve) => {
    const stem = String(source.fileName || 'Объект').replace(/\.obj$/i, '');
    const st = {
      title: existing?.title || stem,
      category: existing?.category || '',
      units: existing?.source?.units || guessUnits(source),
      upAxis: existing?.source?.upAxis || 'y',
      place: existing?.place || 'floor',
      color: existing?.color || DEFAULT_OBJECT_COLOR,
      useMaterials: source.hasMaterials ? (existing?.useMaterials ?? true) : false,
    };
    let meshRec = null;
    let thumb = '';
    let seq = 0;

    const wrap = document.createElement('div');
    wrap.className = 'uo-modal';
    wrap.innerHTML = `
      <div class="uo-dialog" role="dialog" aria-modal="true">
        <h3>${existing ? `Заменить модель «${esc(existing.title)}»` : 'Новый объект в мой каталог'}</h3>
        <div class="uo-body">
          <div class="uo-preview"><img id="uoThumb" alt=""><div class="muted" id="uoDims"></div></div>
          <div class="uo-form">
            <label>Название<input type="text" id="uoTitle" value="${esc(st.title)}"></label>
            <label>Категория<input type="text" id="uoCat" list="uoCatList" value="${esc(st.category)}" placeholder="например, Корзины">
              <datalist id="uoCatList">${userObjectCategories().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
            </label>
            <div class="uo-row">
              <label>Единицы в файле
                <select id="uoUnits">${Object.entries(UNIT_LABELS).map(([k, v]) => `<option value="${k}" ${k === st.units ? 'selected' : ''}>${v}</option>`).join('')}</select>
              </label>
              <label>Ось «вверх»
                <select id="uoUp">
                  <option value="y" ${st.upAxis === 'y' ? 'selected' : ''}>Y (Базис, большинство программ)</option>
                  <option value="z" ${st.upAxis === 'z' ? 'selected' : ''}>Z (3ds Max, SketchUp)</option>
                </select>
              </label>
            </div>
            <label>Посадка
              <select id="uoPlace">
                <option value="floor" ${st.place === 'floor' ? 'selected' : ''}>На пол / на поверхность</option>
                <option value="wall" ${st.place === 'wall' ? 'selected' : ''}>На стену</option>
              </select>
            </label>
            <div class="uo-row">
              <label class="uo-check"><input type="checkbox" id="uoUseMat" ${st.useMaterials ? 'checked' : ''} ${source.hasMaterials ? '' : 'disabled'}> Цвета и текстуры из файла</label>
              <label>Цвет<input type="color" id="uoColor" value="${esc(st.color)}"></label>
            </div>
            <p class="muted" id="uoStats"></p>
            ${source.warnings.length ? `<ul class="uo-warn">${source.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
          </div>
        </div>
        <div class="btnrow uo-actions">
          <button type="button" id="uoCancel">Отмена</button>
          <button type="button" id="uoSave" class="primary">${existing ? 'Заменить модель' : 'Сохранить в каталог'}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const $ = (id) => wrap.querySelector('#' + id);

    const recompute = async () => {
      const my = ++seq;
      meshRec = normalizeSource(source, { units: st.units, upAxis: st.upAxis });
      $('uoDims').textContent = `Ш ${Math.round(meshRec.w)} × В ${Math.round(meshRec.h)} × Г ${Math.round(meshRec.d)} мм`;
      $('uoStats').textContent = `${source.fileName} · вершин ${meshRec.vertexCount.toLocaleString('ru-RU')}, треугольников ${meshRec.triCount.toLocaleString('ru-RU')}`;
      try {
        const url = await renderUserObjectThumb(meshRec, { useMaterials: st.useMaterials, baseColor: st.color });
        if (my !== seq) return;
        thumb = url;
        $('uoThumb').src = url;
      } catch (_) { /* превью не критично */ }
    };

    const close = (result) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', onKey, true);

    $('uoUnits').onchange = (e) => { st.units = e.target.value; recompute(); };
    $('uoUp').onchange = (e) => { st.upAxis = e.target.value; recompute(); };
    $('uoUseMat').onchange = (e) => { st.useMaterials = e.target.checked; recompute(); };
    $('uoColor').oninput = (e) => { st.color = e.target.value; if (!st.useMaterials) recompute(); };
    $('uoPlace').onchange = (e) => { st.place = e.target.value; };
    $('uoCancel').onclick = () => close(null);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
    $('uoSave').onclick = async () => {
      if (!meshRec) return;
      if (!thumb) await recompute();
      close({
        meta: {
          title: $('uoTitle').value.trim() || stem,
          category: $('uoCat').value.trim(),
          place: st.place,
          color: st.color,
          useMaterials: st.useMaterials,
          units: st.units,
          upAxis: st.upAxis,
          fileName: source.fileName,
          thumb,
        },
        meshRec,
      });
    };
    recompute();
    setTimeout(() => $('uoTitle')?.select(), 0);
  });
}
