/**
 * 首次初始化
 *   GET  /api/auth/bootstrap  -> { needBootstrap: boolean }  是否需要创建首个管理员
 *   POST /api/auth/bootstrap  -> 创建首个管理员（仅当 users 表为空时允许，之后永久关闭）
 */
import {
  json,
  requireDb,
  readJsonBody,
  hashPassword,
  randomHex,
  createSession,
  sessionCookie,
  validUsername,
  validPassword,
  hitLimit,
  SESSION_TTL_MS
} from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ ok: true, needBootstrap: !row || row.n === 0 });
  } catch (err) {
    return json({ ok: false, error: `查询失败：${err.message || err}` }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  if (hitLimit(request, 'bootstrap', 10, 60 * 60 * 1000)) {
    return json({ ok: false, error: '操作过于频繁，请稍后再试' }, 429);
  }

  const body = await readJsonBody(request, 4096);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  const u = validUsername(body.data.username);
  if (!u.ok) return json({ ok: false, error: u.error }, 400);
  const p = validPassword(body.data.password);
  if (!p.ok) return json({ ok: false, error: p.error }, 400);

  try {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (count && count.n > 0) {
      return json({ ok: false, error: '系统已初始化，请直接登录' }, 409);
    }

    const salt = randomHex(16);
    const hash = await hashPassword(p.value, salt);
    const now = Date.now();

    const res = await env.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, salt, role, created_at, last_login_at)
       VALUES (?, ?, ?, ?, 'admin', ?, ?)`
    )
      .bind(u.value, u.value, hash, salt, now, now)
      .run();

    const userId = res.meta && res.meta.last_row_id;
    const token = await createSession(env, userId);

    return json(
      {
        ok: true,
        user: { id: userId, username: u.value, displayName: u.value, role: 'admin' }
      },
      201,
      { 'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) }
    );
  } catch (err) {
    return json({ ok: false, error: `初始化失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
