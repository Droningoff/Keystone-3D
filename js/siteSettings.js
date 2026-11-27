// Настройки сайта: data/site-settings.json + localStorage override.

const SETTINGS_URL = 'data/site-settings.json';
const OVERRIDE_KEY = 'ks3d-site-settings-override';

const DEFAULTS = {
  samoletPath: '',
  userCatalogPath: '',
  furniturePath: '',
  lighting: {
    ambient: 0.55,
    sun: 1.2,
    sunAzimuth: 35,
    sunElevation: 55,
    fill: 0.35,
    ceiling: false,
  },
  tabs: {
    room: true,
    sam: true,
    fix: true,
    lib: true,
    brief: true,
  },
  headerLinks: {
    module1: true,
    module2: true,
    module3: true,
  },
};

let _settings = null;
let _loaded = false;

function deepMerge(base, patch) {
  const out = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k]) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readOverride() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null');
  } catch {
    return null;
  }
}

export function getSiteSettings() {
  return _settings ? structuredClone(_settings) : structuredClone(DEFAULTS);
}

export function exportSiteSettingsJson(s = _settings) {
  return JSON.stringify(s || DEFAULTS, null, 2);
}

export function saveSiteSettingsOverride(patch) {
  const next = deepMerge(DEFAULTS, deepMerge(_settings || DEFAULTS, patch || {}));
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
  _settings = next;
  return getSiteSettings();
}

export function clearSiteSettingsOverride() {
  localStorage.removeItem(OVERRIDE_KEY);
  _settings = null;
  _loaded = false;
}

export async function loadSiteSettings({ force = false } = {}) {
  if (_loaded && _settings && !force) return getSiteSettings();
  let file = DEFAULTS;
  try {
    const res = await fetch(`${SETTINGS_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) file = deepMerge(DEFAULTS, await res.json());
  } catch { /* */ }
  const ov = readOverride();
  _settings = ov ? deepMerge(file, ov) : file;
  _loaded = true;
  return getSiteSettings();
}

/** Скрыть вкладки / ссылки модулей по настройкам. */
export function applySiteSettingsToDom(settings = _settings) {
  const s = settings || DEFAULTS;
  const tabs = s.tabs || {};
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const id = btn.getAttribute('data-tab');
    if (!id || !(id in tabs)) return;
    const on = tabs[id] !== false;
    btn.hidden = !on;
    btn.style.display = on ? '' : 'none';
    if (!on) {
      const pane = document.getElementById(`tab-${id}`);
      if (pane) {
        pane.hidden = true;
        pane.classList.remove('active');
      }
    }
  });
  // если активная вкладка скрыта — переключить на первую видимую
  const active = document.querySelector('.tab.active');
  if (active?.hidden || active?.style.display === 'none') {
    const first = [...document.querySelectorAll('.tab')].find((t) => !t.hidden && t.style.display !== 'none');
    if (first) first.click();
  }

  const links = s.headerLinks || {};
  const map = [
    ['[data-site-link="module1"]', links.module1 !== false],
    ['[data-site-link="module2"]', links.module2 !== false],
    ['[data-site-link="module3"]', links.module3 !== false],
  ];
  for (const [sel, on] of map) {
    document.querySelectorAll(sel).forEach((el) => {
      el.hidden = !on;
      el.style.display = on ? '' : 'none';
    });
  }
}

/** Подставить пути и свет в проект (если поля пустые / при новом проекте). */
export function applySiteSettingsToProject(project, { forceLighting = false, forcePaths = false } = {}) {
  if (!project) return project;
  const s = _settings || DEFAULTS;
  project.settings = project.settings || {};
  if (forcePaths || !project.settings.samoletPath) {
    if (s.samoletPath) project.settings.samoletPath = s.samoletPath;
  }
  if (forcePaths || !project.settings.userCatalogPath) {
    if (s.userCatalogPath) project.settings.userCatalogPath = s.userCatalogPath;
  }
  if (forcePaths || !project.settings.furniturePath) {
    if (s.furniturePath) project.settings.furniturePath = s.furniturePath;
  }
  if (forceLighting) {
    project.lighting = { ...DEFAULTS.lighting, ...(s.lighting || {}) };
  } else if (!project.lighting) {
    project.lighting = { ...DEFAULTS.lighting, ...(s.lighting || {}) };
  } else if (s.lighting) {
    for (const [k, v] of Object.entries(s.lighting)) {
      if (project.lighting[k] == null) project.lighting[k] = v;
    }
  }
  return project;
}

export { DEFAULTS as SITE_SETTINGS_DEFAULTS };
