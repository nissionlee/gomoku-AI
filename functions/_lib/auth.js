/**
 * 共享后端工具（Pages Functions）
 * 放在 _lib/ 下（下划线开头不会被当成路由）
 *
 * 安全要点：
 * - 口令用 PBKDF2-SHA256 + 每用户随机 salt。迭代次数压到 10k，
 *   因为 Workers 免费版单请求 CPU 时间只有 10ms，再高容易超限被掐。
 * - 会话 token 用 crypto.getRandomValues 生成 32 字节，只在 Cookie 里存，
 *   库里存的是原文（D1 是私有的，且 token 本身是随机串，不做二次哈希以省 CPU）。
 */

const ITERATIONS = 10000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const COOKIE_NAME = 'gk_sid';

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(bits);
}

/** 定时安全的字符串比较，避免按字符提前返回泄露信息 */
export function safeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/* ---------------- 会话 ---------------- */

export function parseCookies(request) {
  const raw = request.headers.get('Cookie') || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

export function sessionCookie(token, maxAgeSec) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${maxAgeSec}`
  ];
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export async function createSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(token, userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/**
 * 从请求里解析当前用户；未登录返回 null
 * 顺带清理已过期会话（概率触发，避免每次请求都写库）
 */
export async function currentUser(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.token, s.expires_at,
            u.id, u.username, u.display_name, u.role, u.created_at, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  )
    .bind(token)
    .first();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await destroySession(env, token);
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    token
  };
}

/** 需要登录；未登录时直接抛出一个 Response */
export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) {
    return { user: null, error: json({ ok: false, error: '未登录或会话已过期' }, 401) };
  }
  return { user, error: null };
}

export async function requireAdmin(request, env) {
  const { user, error } = await requireUser(request, env);
  if (error) return { user: null, error };
  if (user.role !== 'admin') {
    return { user: null, error: json({ ok: false, error: '需要管理员权限' }, 403) };
  }
  return { user, error: null };
}

/* ---------------- 输入校验 ---------------- */

export function validUsername(name) {
  const s = String(name || '').trim();
  if (s.length < 3 || s.length > 20) return { ok: false, error: '用户名需 3-20 个字符' };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]+$/.test(s)) {
    return { ok: false, error: '用户名只能包含字母、数字、下划线、连字符或中文' };
  }
  return { ok: true, value: s };
}

export function validPassword(pw) {
  const s = String(pw || '');
  if (s.length < 6 || s.length > 128) return { ok: false, error: '密码需 6-128 位' };
  return { ok: true, value: s };
}

export function genRoomCode() {
  // 去掉易混字符 0/O/1/I
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => alphabet[b % alphabet.length]).join('');
}

/* ---------------- 简易频控（单实例内存，尽力而为） ---------------- */

const buckets = new Map();

export function hitLimit(request, action, limit, windowMs = 3600 * 1000) {
  const ip =
    request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
  const key = `${ip}:${action}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    if (buckets.size > 4096) buckets.clear();
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

export function requireDb(env) {
  if (!env || !env.DB) {
    return json({ ok: false, error: '服务端未绑定 D1 数据库 DB' }, 500);
  }
  return null;
}

export async function readJsonBody(request, maxChars = 32 * 1024) {
  let text = '';
  try {
    text = await request.text();
  } catch (e) {
    return { ok: false, error: '无法读取请求体' };
  }
  if (text.length > maxChars) return { ok: false, error: '请求体过大' };
  if (!text) return { ok: true, data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: '请求体需为 JSON 对象' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: '请求体不是合法 JSON' };
  }
}

export { COOKIE_NAME, SESSION_TTL_MS };
