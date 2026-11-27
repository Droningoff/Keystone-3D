import { gatePage } from './authGate.js?v=20261127g';
import {
  loadUsers, listUsers, upsertUser, removeUser,
  exportUsersJson, clearUsersOverride, getUsersBundle,
} from './auth.js?v=20261127g';
import {
  loadSiteSettings, getSiteSettings, saveSiteSettingsOverride,
  exportSiteSettingsJson, clearSiteSettingsOverride,
} from './siteSettings.js?v=20261127g';

const $ = (s) => document.querySelector(s);

function status(msg, ok = true) {
  const el = $('#admStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? '#0b5' : '#c62828';
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function renderUsers() {
  const tbody = $('#admUsersTable tbody');
  if (!tbody) return;
  const users = listUsers();
  tbody.innerHTML = users.map((u) => `
    <tr data-login="${esc(u.login)}">
      <td><code>${esc(u.login)}</code></td>
      <td><input data-f="name" value="${esc(u.name || '')}"></td>
      <td>
        <select data-f="role">
          <option value="user"${u.role !== 'admin' ? ' selected' : ''}>user</option>
          <option value="admin"${u.role === 'admin' ? ' selected' : ''}>admin</option>
        </select>
      </td>
      <td><input data-f="active" type="checkbox"${u.active !== false ? ' checked' : ''}></td>
      <td><input data-f="password" type="password" placeholder="не менять" autocomplete="new-password"></td>
      <td class="btnrow">
        <button type="button" data-act="save">Сохранить</button>
        <button type="button" data-act="del" class="danger">Удалить</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const login = tr.getAttribute('data-login');
    tr.querySelector('[data-act="save"]').onclick = async () => {
      try {
        const patch = {
          login,
          name: tr.querySelector('[data-f="name"]').value,
          role: tr.querySelector('[data-f="role"]').value,
          active: tr.querySelector('[data-f="active"]').checked,
        };
        const pw = tr.querySelector('[data-f="password"]').value;
        if (pw) patch.password = pw;
        await upsertUser(patch);
        status(`Сохранён: ${login}`);
        renderUsers();
      } catch (e) {
        status(String(e.message || e), false);
      }
    };
    tr.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`Удалить пользователя «${login}»?`)) return;
      try {
        await removeUser(login);
        status(`Удалён: ${login}`);
        renderUsers();
      } catch (e) {
        status(String(e.message || e), false);
      }
    };
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fillSettingsForm() {
  const s = getSiteSettings();
  $('#admSamoletPath').value = s.samoletPath || '';
  $('#admUserCatalogPath').value = s.userCatalogPath || '';
  $('#admFurniturePath').value = s.furniturePath || '';
  const L = s.lighting || {};
  $('#admLtAmbient').value = L.ambient ?? 0.55;
  $('#admLtSun').value = L.sun ?? 1.2;
  $('#admLtAz').value = L.sunAzimuth ?? 35;
  $('#admLtEl').value = L.sunElevation ?? 55;
  $('#admLtFill').value = L.fill ?? 0.35;
  $('#admLtCeil').checked = !!L.ceiling;
  const T = s.tabs || {};
  $('#admTabRoom').checked = T.room !== false;
  $('#admTabSam').checked = T.sam !== false;
  $('#admTabFix').checked = T.fix !== false;
  $('#admTabLib').checked = T.lib !== false;
  $('#admTabBrief').checked = T.brief !== false;
  const H = s.headerLinks || {};
  $('#admLinkM1').checked = H.module1 !== false;
  $('#admLinkM2').checked = H.module2 !== false;
  $('#admLinkM3').checked = H.module3 !== false;
}

function readSettingsForm() {
  return {
    samoletPath: $('#admSamoletPath').value.trim(),
    userCatalogPath: $('#admUserCatalogPath').value.trim(),
    furniturePath: $('#admFurniturePath').value.trim(),
    lighting: {
      ambient: +$('#admLtAmbient').value,
      sun: +$('#admLtSun').value,
      sunAzimuth: +$('#admLtAz').value,
      sunElevation: +$('#admLtEl').value,
      fill: +$('#admLtFill').value,
      ceiling: $('#admLtCeil').checked,
    },
    tabs: {
      room: $('#admTabRoom').checked,
      sam: $('#admTabSam').checked,
      fix: $('#admTabFix').checked,
      lib: $('#admTabLib').checked,
      brief: $('#admTabBrief').checked,
    },
    headerLinks: {
      module1: $('#admLinkM1').checked,
      module2: $('#admLinkM2').checked,
      module3: $('#admLinkM3').checked,
    },
  };
}

function wire() {
  $('#admUserAdd').onclick = async () => {
    const login = prompt('Логин нового пользователя:');
    if (!login) return;
    const password = prompt('Пароль:');
    if (!password) { status('Нужен пароль', false); return; }
    const name = prompt('Отображаемое имя:', login) || login;
    try {
      await upsertUser({ login, password, name, role: 'user', active: true });
      status(`Создан: ${login}`);
      renderUsers();
    } catch (e) {
      status(String(e.message || e), false);
    }
  };

  $('#admUsersExport').onclick = () => {
    download('users.json', exportUsersJson(getUsersBundle()));
    status('users.json скачан — положите в data/ на сервере');
  };

  $('#admUsersReset').onclick = async () => {
    if (!confirm('Сбросить локальных пользователей к data/users.json?')) return;
    clearUsersOverride();
    await loadUsers({ force: true });
    renderUsers();
    status('Пользователи сброшены к файлу');
  };

  $('#admSettingsSave').onclick = () => {
    saveSiteSettingsOverride(readSettingsForm());
    status('Настройки сохранены локально');
  };

  $('#admSettingsExport').onclick = () => {
    // экспорт текущей формы (даже если не жали «Сохранить»)
    const merged = saveSiteSettingsOverride(readSettingsForm());
    download('site-settings.json', exportSiteSettingsJson(merged));
    status('site-settings.json скачан — положите в data/ на сервере');
  };

  $('#admSettingsReset').onclick = async () => {
    if (!confirm('Сбросить локальные настройки к data/site-settings.json?')) return;
    clearSiteSettingsOverride();
    await loadSiteSettings({ force: true });
    fillSettingsForm();
    status('Настройки сброшены к файлу');
  };
}

(async () => {
  await gatePage({ requireAdmin: true, redirectIfNotAdmin: 'index.html?v=20261127g' });
  await loadUsers();
  await loadSiteSettings();
  wire();
  renderUsers();
  fillSettingsForm();
  status('Готово');
})();
