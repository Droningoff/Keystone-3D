// Клиент LLM из браузера. По умолчанию — LM Studio на localhost:1234.
// Облачный OpenAI из браузера обычно блокируется CORS — нужен прокси или локальная модель.

const STORE = 'furniture-constructor-llm';

export function defaultLlmSettings() {
  return {
    baseUrl: 'http://127.0.0.1:1234',
    model: '',           // пусто = первая загруженная / первая из каталога
    apiKey: '',          // для OpenAI-совместимых с ключом
    mode: 'lmstudio',    // lmstudio | openai
    temperature: 0.2,
    maxTokens: 4096,
  };
}

export function loadLlmSettings() {
  try { return { ...defaultLlmSettings(), ...JSON.parse(localStorage.getItem(STORE) || '{}') }; }
  catch { return defaultLlmSettings(); }
}

export function saveLlmSettings(s) {
  localStorage.setItem(STORE, JSON.stringify(s));
}

const base = (url) => String(url || '').replace(/\/+$/, '');

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || data?.raw || text || r.statusText;
    throw new Error(`HTTP ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/** Список моделей (LM Studio native или OpenAI /v1/models) */
export async function listModels(settings = loadLlmSettings()) {
  const b = base(settings.baseUrl);
  const headers = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  // Сначала родной LM Studio — видно, что загружено
  try {
    const d = await fetchJson(`${b}/api/v1/models`, { headers });
    const models = (d.models || []).map((m) => ({
      id: m.key || m.id,
      loaded: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0,
      label: `${m.key || m.id}${m.loaded_instances?.length ? ' ●' : ''}`,
    }));
    if (models.length) return models;
  } catch { /* не LM Studio */ }
  const d = await fetchJson(`${b}/v1/models`, { headers });
  return (d.data || []).map((m) => ({ id: m.id, loaded: true, label: m.id }));
}

/**
 * Chat completion.
 * @param {{role:string, content:string}[]} messages
 * @returns {Promise<string>} текст ответа
 */
export async function chat(messages, settings = loadLlmSettings(), onStatus) {
  const b = base(settings.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  let model = settings.model;
  if (!model) {
    onStatus?.('Список моделей…');
    const models = await listModels(settings);
    const loaded = models.find((m) => m.loaded);
    model = (loaded || models[0])?.id;
    if (!model) throw new Error('Нет доступных моделей. Загрузите модель в LM Studio.');
  }

  if (settings.mode === 'lmstudio') {
    onStatus?.(`LM Studio: ${model}…`);
    // Родной API: reasoning: off — иначе у thinking-моделей пустой content
    try {
      const input = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
      const d = await fetchJson(`${b}/api/v1/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          input,
          reasoning: 'off',
          temperature: settings.temperature,
          max_output_tokens: settings.maxTokens,
        }),
      });
      const parts = (d.output || []).filter((o) => o.type === 'message' || o.content);
      const text = parts.map((o) => o.content || '').join('\n').trim();
      if (text) return text;
      // пустой ответ — fallback
    } catch (e) {
      onStatus?.(`Родной API недоступен (${e.message}), пробую OpenAI…`);
    }
  }

  onStatus?.(`OpenAI API: ${model}…`);
  const d = await fetchJson(`${b}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
    }),
  });
  const msg = d.choices?.[0]?.message;
  const text = (msg?.content || msg?.reasoning_content || '').trim();
  if (!text) throw new Error('Пустой ответ модели. Для thinking-моделей нужен LM Studio mode + reasoning off.');
  return text;
}

/** Вырезать JSON из ответа (с ```json или без) */
export function extractJson(text) {
  if (!text) throw new Error('Пустой текст');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('В ответе нет JSON-объекта');
  return JSON.parse(raw.slice(start, end + 1));
}
