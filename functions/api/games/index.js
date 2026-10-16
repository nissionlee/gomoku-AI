/**
 * 对局集合
 *   GET  /api/games   我参与的对局列表（最近 50 条）
 *   POST /api/games   创建对局 { myColor: 'black' | 'white' | 'random' }
 */
import { json, requireDb, readJsonBody, requireUser, genRoomCode, hitLimit } from '../../_lib/auth.js';
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
      `${LIST_SELECT}
        WHERE g.black_user_id = ? OR g.white_user_id = ?
        ORDER BY g.updated_at DESC
        LIMIT 50`
    )
      .bind(user.id, user.id)
      .all();

    return json({ ok: true, games: (rows.results || []).map((r) => serializeGame(r, user.id)) });
  } catch (err) {
    return json({ ok: false, error: `查询失败：${err.message || err}` }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { user, error } = await requireUser(request, env);
  if (error) return error;

  if (hitLimit(request, 'create-game', 30, 60 * 60 * 1000)) {
    return json({ ok: false, error: '创建对局过于频繁，请稍后再试' }, 429);
  }

  const body = await readJsonBody(request, 2048);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  let want = String(body.data.myColor || 'black');
  if (want !== 'black' && want !== 'white') {
    want = Math.random() < 0.5 ? 'black' : 'white';
  }

  try {
    const now = Date.now();
    let roomCode = genRoomCode();

    // 极小概率撞码，重试几次
    for (let i = 0; i < 5; i++) {
      const dup = await env.DB.prepare('SELECT id FROM games WHERE room_code = ?')
        .bind(roomCode)
        .first();
      if (!dup) break;
      roomCode = genRoomCode();
    }

    const blackId = want === 'black' ? user.id : null;
    const whiteId = want === 'white' ? user.id : null;

    const res = await env.DB.prepare(
      `INSERT INTO games (room_code, black_user_id, white_user_id, status, turn, moves, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'waiting', 1, '[]', ?, ?, ?)`
    )
      .bind(roomCode, blackId, whiteId, user.id, now, now)
      .run();

    const id = res.meta && res.meta.last_row_id;

    const row = await env.DB.prepare(`${LIST_SELECT} WHERE g.id = ?`).bind(id).first();
    return json({ ok: true, game: serializeGame(row, user.id) }, 201);
  } catch (err) {
    return json({ ok: false, error: `创建失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
