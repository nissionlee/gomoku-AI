/**
 * 跨设备配置同步客户端 (Settings Sync)
 *
 * 场景：在 PC 上填好大模型 API Key 等设置 → 上传得到一个 10 位同步码 →
 *      手机浏览器输入同一码即可拉取套用；本机之后每次改完点「上传」刷新。
 *
 * 约定：
 *  - 仅同步「设置」（大模型接口 + 难度/先后手/禁手/音效），绝不同步棋谱与战绩；
 *  - 载荷走白名单裁剪，字段类型逐项校验，异常数据一律拒收；
 *  - 云端由 Pages Function + KV 承载，有效期 30 天，可随时覆盖上传或清除。
 */

const SYNC_ENDPOINT = '/api/sync/';
const CODE_STORAGE_KEY = 'gomoku_sync_code_v1';
const PAYLOAD_KIND = 'gomoku-settings';
const PAYLOAD_VERSION = 1;

// 去掉 I/O/0/1，避免手抄时看错
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_MIN = 8;
const CODE_MAX = 16;

const ENGINES = ['local', 'llm', 'pvp'];
const DIFFICULTIES = ['low', 'medium', 'high', 'pro'];
const PROVIDERS = ['deepseek', 'gemini', 'openai', 'qwen', 'moonshot', 'custom'];
const PERSONAS = ['humorous', 'master', 'tsundere', 'analytical'];
const REQUEST_TIMEOUT = 15000;

/* ---------------- 同步码 ---------------- */

export function generateSyncCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < CODE_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeSyncCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_MAX);
}

export function isValidSyncCode(code) {
  const c = normalizeSyncCode(code);
  return c.length >= CODE_MIN && c.length <= CODE_MAX && c === String(code || '');
}

/** 本机记住的同步码（用于开机自动拉取与一键更新） */
export function getSavedSyncCode() {
  try {
    return localStorage.getItem(CODE_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

export function saveSyncCode(code) {
  try {
    localStorage.setItem(CODE_STORAGE_KEY, normalizeSyncCode(code));
  } catch (e) { /* 隐私模式下忽略 */ }
}

export function forgetSyncCode() {
  try {
    localStorage.removeItem(CODE_STORAGE_KEY);
  } catch (e) { /* ignore */ }
}

// 是否开机自动拉取（设备本地偏好，刻意不参与同步，免得 PC 的选择覆盖手机的习惯）
const AUTO_SYNC_KEY = 'gomoku_sync_auto_v1';

export function isAutoSyncEnabled() {
  try {
    return localStorage.getItem(AUTO_SYNC_KEY) !== '0';
  } catch (e) {
    return true;
  }
}

export function setAutoSyncEnabled(on) {
  try {
    localStorage.setItem(AUTO_SYNC_KEY, on ? '1' : '0');
  } catch (e) { /* ignore */ }
}

/* ---------------- 载荷构造与校验 ---------------- */

function clampString(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

/**
 * 把本地设置裁剪成可上传的最小载荷（白名单外的一律不带）
 */
export function buildPayload(settings, updatedAt = Date.now()) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const llm = src.llmConfig && typeof src.llmConfig === 'object' ? src.llmConfig : {};

  const cleanSettings = {
    aiEngine: ENGINES.includes(src.aiEngine) ? src.aiEngine : 'local',
    difficulty: DIFFICULTIES.includes(src.difficulty) ? src.difficulty : 'medium',
    playerColor: Number(src.playerColor) === 2 ? 2 : 1,
    checkDoubleThree: toBool(src.checkDoubleThree, true),
    checkDoubleFour: toBool(src.checkDoubleFour, true),
    showForbiddenMarks: toBool(src.showForbiddenMarks, true),
    soundEnabled: toBool(src.soundEnabled, true),
    llmConfig: {
      provider: PROVIDERS.includes(llm.provider) ? llm.provider : 'deepseek',
      baseUrl: clampString(llm.baseUrl, 200),
      apiKey: clampString(llm.apiKey, 200),
      model: clampString(llm.model, 80),
      persona: PERSONAS.includes(llm.persona) ? llm.persona : 'humorous'
    }
  };

  return {
    kind: PAYLOAD_KIND,
    v: PAYLOAD_VERSION,
    updatedAt,
    settings: cleanSettings
  };
}

/**
 * 校验并还原远端载荷 → 可直接浅合并进本地 settings 的对象
 * @returns {{ok:boolean, settings?:Object, updatedAt?:number, error?:string}}
 */
export function parseRemotePayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: '云端返回内容异常' };
  if (payload.kind !== PAYLOAD_KIND) return { ok: false, error: '云端存的不是本游戏的配置' };
  if (payload.v !== PAYLOAD_VERSION) return { ok: false, error: `云端配置版本 ${payload.v} 暂不支持` };
  if (typeof payload.updatedAt !== 'number' || payload.updatedAt <= 0) {
    return { ok: false, error: '云端配置缺少更新时间' };
  }

  const s = payload.settings;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: '云端配置内容为空' };

  const llm = s.llmConfig && typeof s.llmConfig === 'object' ? s.llmConfig : {};
  const settings = {
    aiEngine: ENGINES.includes(s.aiEngine) ? s.aiEngine : 'local',
    difficulty: DIFFICULTIES.includes(s.difficulty) ? s.difficulty : 'medium',
    playerColor: Number(s.playerColor) === 2 ? 2 : 1,
    checkDoubleThree: toBool(s.checkDoubleThree, true),
    checkDoubleFour: toBool(s.checkDoubleFour, true),
    showForbiddenMarks: toBool(s.showForbiddenMarks, true),
    soundEnabled: toBool(s.soundEnabled, true),
    llmConfig: {
      provider: PROVIDERS.includes(llm.provider) ? llm.provider : 'deepseek',
      baseUrl: clampString(llm.baseUrl, 200),
      apiKey: clampString(llm.apiKey, 200),
      model: clampString(llm.model, 80),
      persona: PERSONAS.includes(llm.persona) ? llm.persona : 'humorous'
    }
  };

  return { ok: true, settings, updatedAt: payload.updatedAt };
}

/* ---------------- 网络请求 ---------------- */

async function request(code, method, body, timeout = REQUEST_TIMEOUT) {
  const url = SYNC_ENDPOINT + encodeURIComponent(code);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin'
    });

    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }

    if (!data || typeof data !== 'object') {
      return { ok: false, error: `服务端未返回有效结果（HTTP ${res.status}）`, status: res.status };
    }
    if (!res.ok && data.ok !== true) {
      return { ok: false, error: data.error || `请求失败（HTTP ${res.status}）`, status: res.status };
    }
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: '请求超时，请检查网络后重试' };
    }
    return { ok: false, error: `网络错误：${(err && err.message) || '无法连接同步服务'}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function pushSettings(code, settings) {
  const payload = buildPayload(settings, Date.now());
  const res = await request(code, 'PUT', payload);
  if (!res.ok) return res;
  return { ok: true, code: res.code || code, updatedAt: payload.updatedAt, expiresAt: res.expiresAt };
}

export async function pullSettings(code, options = {}) {
  const res = await request(code, 'GET', undefined, options.timeout || REQUEST_TIMEOUT);
  if (!res.ok) return res;
  const parsed = parseRemotePayload(res.data);
  if (!parsed.ok) return parsed;
  return { ok: true, code: res.code || code, settings: parsed.settings, updatedAt: parsed.updatedAt };
}

export async function deleteSettings(code) {
  return request(code, 'DELETE');
}

/**
 * 把远端设置合并进本地设置对象（保留 llmConfig 的嵌套结构）
 */
export function mergeSettings(local, incoming) {
  const base = local && typeof local === 'object' ? { ...local } : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  return {
    ...base,
    ...next,
    llmConfig: {
      ...(base.llmConfig || {}),
      ...(next.llmConfig || {})
    }
  };
}

/**
 * 同步码脱敏展示（前 4 位 + 星号），用于界面提示不外泄完整码
 */
export function maskSyncCode(code) {
  const c = String(code || '');
  if (c.length <= 4) return c;
  return `${c.slice(0, 4)}${'*'.repeat(c.length - 4)}`;
}
