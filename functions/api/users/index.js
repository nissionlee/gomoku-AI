/**
 * 用户管理（仅管理员）
 *   GET  /api/users  列出全部用户
 *   POST /api/users  新建用户 { username, password, role?, displayName? }
 */
import {
  json,
  requireDb,
  readJsonBody,
  requireAdmin,
  hashPassword,
  randomHex,
  validUsername,
  validPassword
} from '../../_lib/auth.js';

const MAX_USERS = 50;

export async function onRequestGet(context) {
  const { request, env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { error } = await requireAdmin(request, env);
  if (error) return error;

  try {
    const rows = await env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM games g
                WHERE g.black_user_id = u.id OR g.white_user_id = u.id) AS games_count
         FROM users u
        ORDER BY u.id ASC`
    ).all();

    return json({
      ok: true,
      users: (rows.results || []).map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name || r.username,
        role: r.role,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
        gamesCount: r.games_count || 0
      }))
    });
  } catch (err) {
    return json({ ok: false, error: `查询失败：${err.message || err}` }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { error } = await requireAdmin(request, env);
  if (error) return error;

  const body = await readJsonBody(request, 4096);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  const u = validUsername(body.data.username);
  if (!u.ok) return json({ ok: false, error: u.error }, 400);
  const p = validPassword(body.data.password);
  if (!p.ok) return json({ ok: false, error: p.error }, 400);

  const role = body.data.role === 'admin' ? 'admin' : 'user';
  const displayName = String(body.data.displayName || u.value).trim().slice(0, 30) || u.value;

  try {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (count && count.n >= MAX_USERS) {
      return json({ ok: false, error: `用户数已达上限 ${MAX_USERS}` }, 400);
    }

    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(u.value)
      .first();
    if (exists) return json({ ok: false, error: '该用户名已被占用' }, 409);

    const salt = randomHex(16);
    const hash = await hashPassword(p.value, salt);
    const now = Date.now();

    const res = await env.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, salt, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(u.value, displayName, hash, salt, role, now)
      .run();

    return json(
      {
        ok: true,
        user: {
          id: res.meta && res.meta.last_row_id,
          username: u.value,
          displayName,
          role,
          createdAt: now,
          lastLoginAt: null,
          gamesCount: 0
        }
      },
      201
    );
  } catch (err) {
    return json({ ok: false, error: `创建失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
