/**
 * POST /api/auth/login  用户名 + 密码登录
 */
import {
  json,
  requireDb,
  readJsonBody,
  hashPassword,
  safeEqual,
  createSession,
  sessionCookie,
  hitLimit,
  SESSION_TTL_MS
} from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const dbError = requireDb(env);
  if (dbError) return dbError;

  if (hitLimit(request, 'login', 20, 15 * 60 * 1000)) {
    return json({ ok: false, error: '登录尝试过于频繁，请 15 分钟后再试' }, 429);
  }

  const body = await readJsonBody(request, 4096);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  const username = String(body.data.username || '').trim();
  const password = String(body.data.password || '');
  if (!username || !password) {
    return json({ ok: false, error: '请输入用户名和密码' }, 400);
  }

  try {
    const row = await env.DB.prepare(
      'SELECT id, username, display_name, role, password_hash, salt FROM users WHERE username = ?'
    )
      .bind(username)
      .first();

    // 用户不存在也走一次哈希，避免通过响应时间枚举用户名
    const salt = row ? row.salt : 'nonexistent-user-salt';
    const hash = await hashPassword(password, salt);

    if (!row || !safeEqual(hash, row.password_hash)) {
      return json({ ok: false, error: '用户名或密码错误' }, 401);
    }

    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(Date.now(), row.id)
      .run();

    const token = await createSession(env, row.id);

    return json(
      {
        ok: true,
        user: {
          id: row.id,
          username: row.username,
          displayName: row.display_name || row.username,
          role: row.role
        }
      },
      200,
      { 'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) }
    );
  } catch (err) {
    return json({ ok: false, error: `登录失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
