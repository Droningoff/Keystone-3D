// Общий гейт входа для index / module / admin страниц.
import { requireAuth, bindAuthChrome, currentUser, isAdmin } from './auth.js?v=20261127h';
import { loadSiteSettings, applySiteSettingsToDom } from './siteSettings.js?v=20261127h';

const OVERLAY_HTML = `
<div id="authOverlay" class="auth-overlay" hidden>
  <div class="auth-bg" aria-hidden="true">
    <span class="auth-bg-blob b1"></span>
    <span class="auth-bg-blob b2"></span>
    <span class="auth-bg-blob b3"></span>
  </div>
  <div class="auth-bg-veil" aria-hidden="true"></div>
  <form id="authForm" class="auth-card" autocomplete="on">
    <span class="auth-brand">Кухонный двор</span>
    <h1>Keystone-3D</h1>
    <p class="muted">Вход для сотрудников организации</p>
    <label>Логин <input id="authLogin" name="username" autocomplete="username" required></label>
    <label>Пароль <input id="authPassword" type="password" name="password" autocomplete="current-password" required></label>
    <p id="authError" class="auth-error" role="alert"></p>
    <button type="submit" class="primary" style="width:100%">Войти</button>
    <p class="muted" style="font-size:11px;margin-top:12px">Мягкая авторизация: без сервера. Смените пароль admin после первого входа.</p>
  </form>
</div>`;

export function ensureAuthOverlay() {
  if (document.getElementById('authOverlay')) return;
  document.body.insertAdjacentHTML('afterbegin', OVERLAY_HTML);
}

export async function gatePage({ requireAdmin = false, redirectIfNotAdmin = 'index.html' } = {}) {
  ensureAuthOverlay();
  await loadSiteSettings();
  applySiteSettingsToDom();
  const user = await requireAuth();
  bindAuthChrome();
  if (requireAdmin && !isAdmin()) {
    location.href = redirectIfNotAdmin;
    return null;
  }
  return user || currentUser();
}
