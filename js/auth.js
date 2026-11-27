// Мягкая авторизация: таблица логин/пароль + sessionStorage.
// Не замена серверной проверки — обходится через DevTools.

const USERS_URL = 'data/users.json';
const OVERRIDE_KEY = 'ks3d-users-override';
const SESSION_KEY = 'ks3d-session';
const DEFAULT_SALT = 'ks3d-v1';

let _bundle = null; // { salt, users: [...] }
let _loaded = false;

function cloneBundle(b) {
  return {
    salt: b?.salt || DEFAULT_SALT,
    users: Array.isArray(b?.users) ? b.users.map((u) => ({ ...u })) : [],
  };
}

export async function hashPassword(login, password, salt = DEFAULT_SALT) {
  const raw = `${salt}:${String(login || '').trim().toLowerCase()}:${String(password || '')}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readOverride() {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null');
    if (raw && Array.isArray(raw.users)) return cloneBundle(raw);
  } catch { /* */ }
  return null;
}

export function saveUsersOverride(bundle) {
  const b = cloneBundle(bundle);
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(b));
  _bundle = b;
  return b;
}

export function clearUsersOverride() {
  localStorage.removeItem(OVERRIDE_KEY);
  _bundle = null;
  _loaded = false;
}

export function exportUsersJson(bundle = _bundle) {
  const b = cloneBundle(bundle || { salt: DEFAULT_SALT, users: [] });
  return JSON.stringify(b, null, 2);
}

export async function loadUsers({ force = false } = {}) {
  if (_loaded && _bundle && !force) return _bundle;
  const ov = readOverride();
  if (ov) {
    _bundle = ov;
    _loaded = true;
    return _bundle;
  }
  try {
    const res = await fetch(`${USERS_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _bundle = cloneBundle(data);
  } catch {
    _bundle = {
      salt: DEFAULT_SALT,
      users: [{
        login: 'admin',
        name: 'Администратор',
        role: 'admin',
        active: true,
        passHash: '983cbbdddca8f79161400fb24d521e82d6d177538993010cedb50a3796b0fbfe',
      }],
    };
  }
  _loaded = true;
  return _bundle;
}

export function listUsers() {
  return cloneBundle(_bundle || { users: [] }).users;
}

export function getUsersBundle() {
  return cloneBundle(_bundle || { salt: DEFAULT_SALT, users: [] });
}

export function currentUser() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (s?.login && s?.role) return s;
  } catch { /* */ }
  return null;
}

export function isAdmin() {
  return currentUser()?.role === 'admin';
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

function setSession(user) {
  const s = {
    login: user.login,
    name: user.name || user.login,
    role: user.role === 'admin' ? 'admin' : 'user',
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

export async function login(login, password) {
  await loadUsers();
  const key = String(login || '').trim().toLowerCase();
  const user = (_bundle.users || []).find((u) => String(u.login || '').toLowerCase() === key);
  if (!user || user.active === false) {
    return { ok: false, error: 'Неверный логин или пароль' };
  }
  const hash = await hashPassword(user.login, password, _bundle.salt || DEFAULT_SALT);
  if (hash !== user.passHash) {
    return { ok: false, error: 'Неверный логин или пароль' };
  }
  const session = setSession(user);
  return { ok: true, user: session };
}

/** Сколько активных admin останется после изменения. */
export function activeAdminCount(users = listUsers()) {
  return users.filter((u) => u.role === 'admin' && u.active !== false).length;
}

export async function upsertUser(patch) {
  await loadUsers();
  const b = getUsersBundle();
  const login = String(patch.login || '').trim().toLowerCase();
  if (!login) throw new Error('Укажите логин');
  let u = b.users.find((x) => String(x.login).toLowerCase() === login);
  const isNew = !u;
  if (isNew) {
    u = { login, name: patch.name || login, role: 'user', active: true, passHash: '' };
    b.users.push(u);
  }
  if (patch.name != null) u.name = String(patch.name).trim() || u.login;
  if (patch.role === 'admin' || patch.role === 'user') u.role = patch.role;
  if (patch.active != null) {
    const nextActive = !!patch.active;
    if (!nextActive && u.role === 'admin' && u.active !== false) {
      const others = b.users.filter((x) => x.login !== u.login && x.role === 'admin' && x.active !== false);
      if (!others.length) throw new Error('Нельзя отключить последнего администратора');
    }
    u.active = nextActive;
  }
  if (patch.password != null && String(patch.password).length) {
    u.passHash = await hashPassword(u.login, patch.password, b.salt || DEFAULT_SALT);
  } else if (isNew) {
    throw new Error('Задайте пароль для нового пользователя');
  }
  if (u.role !== 'admin' && activeAdminCount(b.users) < 1) {
    throw new Error('Должен остаться хотя бы один администратор');
  }
  saveUsersOverride(b);
  return u;
}

export async function removeUser(login) {
  await loadUsers();
  const b = getUsersBundle();
  const key = String(login || '').trim().toLowerCase();
  const u = b.users.find((x) => String(x.login).toLowerCase() === key);
  if (!u) return false;
  if (u.role === 'admin' && u.active !== false && activeAdminCount(b.users) <= 1) {
    throw new Error('Нельзя удалить последнего администратора');
  }
  b.users = b.users.filter((x) => String(x.login).toLowerCase() !== key);
  saveUsersOverride(b);
  return true;
}

/**
 * Показать оверлей входа, если нет сессии.
 * @returns {Promise<object>} current user
 */
export async function requireAuth({ overlayId = 'authOverlay' } = {}) {
  await loadUsers();
  const unlock = () => {
    const overlay = document.getElementById(overlayId);
    if (overlay) overlay.hidden = true;
    document.body.classList.remove('auth-locked');
  };
  let user = currentUser();
  if (user) {
    unlock();
    return user;
  }

  const overlay = document.getElementById(overlayId);
  if (!overlay) {
    throw new Error('Нет экрана входа (#authOverlay)');
  }
  overlay.hidden = false;
  document.body.classList.add('auth-locked');

  return new Promise((resolve) => {
    const form = overlay.querySelector('#authForm');
    const errEl = overlay.querySelector('#authError');
    const loginEl = overlay.querySelector('#authLogin');
    const passEl = overlay.querySelector('#authPassword');
    const submit = async (e) => {
      e?.preventDefault?.();
      if (errEl) errEl.textContent = '';
      const res = await login(loginEl?.value, passEl?.value);
      if (!res.ok) {
        if (errEl) errEl.textContent = res.error || 'Ошибка входа';
        return;
      }
      unlock();
      form?.removeEventListener('submit', submit);
      resolve(res.user);
    };
    form?.addEventListener('submit', submit);
    loginEl?.focus();
  });
}

/** Обновить блок пользователя в шапке. */
export function bindAuthChrome({
  userEl = '#authUserLabel',
  logoutBtn = '#authLogout',
  adminLink = '#authAdminLink',
} = {}) {
  const u = currentUser();
  const label = document.querySelector(userEl);
  const out = document.querySelector(logoutBtn);
  const adm = document.querySelector(adminLink);
  if (label) label.textContent = u ? `${u.name || u.login} (${u.role === 'admin' ? 'админ' : 'пользователь'})` : '';
  if (out) {
    out.hidden = !u;
    out.onclick = () => {
      logout();
      location.reload();
    };
  }
  if (adm) {
    adm.hidden = !(u && u.role === 'admin');
  }
}
