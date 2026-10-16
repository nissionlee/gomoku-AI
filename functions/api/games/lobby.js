/**
 * GET /api/games/lobby  大厅：等待加入的对局 + 在线用户（供挑战）
 */
import { json, requireDb, requireUser } from '../../_lib/auth.js';
import { serializeGame } from '../../_lib/game.js';

const LIST_SELECT = `
  SELECT g.*,
         COALESCE(b.display_name, b.username) AS black_name,
         COALESCE(w.display_name, w.username) AS white_name
    FROM games g
    LEFT JOIN users b ON b.id = g.black_user_id
    LEFT JOIN users w ON w.id = g.white_user_id
`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { user, error } = await requireUser(request, env);
  if (error) return error;

  try {
    const rows = await env.DB.prepare(
      `${LIST_SELECT} WHERE g.status = 'waiting' ORDER BY g.created_at DESC LIMIT 30`
    ).all();

    // 近 5 分钟内有活动的用户，视为「在线」，可供发起挑战
    const since = Date.now() - 5 * 60 * 1000;
    const online = await env.DB.prepare(
      `SELECT u.id, COALESCE(u.display_name, u.username) AS name
         FROM users u JOIN sessions s ON s.user_id = u.id
        WHERE s.expires_at > ? AND s.created_at > ?
        GROUP BY u.id
        ORDER BY MAX(s.created_at) DESC
        LIMIT 50`
    )
      .bind(Date.now(), since)
      .all();

    return json({
      ok: true,
      waiting: (rows.results || []).map((r) => serializeGame(r, user.id)),
      online: (online.results || [])
        .filter((u) => u.id !== user.id)
        .map((u) => ({ id: u.id, name: u.name }))
    });
  } catch (err) {
    return json({ ok: false, error: `查询失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
