/**
 * POST /api/games/join  用房间码加入对局 { roomCode }
 */
import { json, requireDb, readJsonBody, requireUser, hitLimit } from '../../_lib/auth.js';
import { serializeGame, loadGameByCode } from '../../_lib/game.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { user, error } = await requireUser(request, env);
  if (error) return error;

  if (hitLimit(request, 'join-game', 60, 60 * 60 * 1000)) {
    return json({ ok: false, error: '操作过于频繁，请稍后再试' }, 429);
  }

  const body = await readJsonBody(request, 2048);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  const code = String(body.data.roomCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return json({ ok: false, error: '房间码为 6 位字母数字' }, 400);

  try {
    const row = await loadGameByCode(env, code);
    if (!row) return json({ ok: false, error: '房间不存在或已过期' }, 404);

    if (row.black_user_id === user.id || row.white_user_id === user.id) {
      return json({ ok: true, game: serializeGame(row, user.id) });
    }

    if (row.status !== 'waiting') {
      return json({ ok: false, error: '该房间已满或对局已结束' }, 409);
    }

    const now = Date.now();
    let sql = '';
    let bindId = null;

    if (row.black_user_id === null) {
      sql = "UPDATE games SET black_user_id = ?, status = 'playing', updated_at = ? WHERE id = ? AND black_user_id IS NULL";
      bindId = user.id;
    } else if (row.white_user_id === null) {
      sql = "UPDATE games SET white_user_id = ?, status = 'playing', updated_at = ? WHERE id = ? AND white_user_id IS NULL";
      bindId = user.id;
    } else {
      return json({ ok: false, error: '该房间已满' }, 409);
    }

    const res = await env.DB.prepare(sql).bind(bindId, now, row.id).run();
    if (!res.meta || res.meta.changes === 0) {
      // 并发下被别人抢先占位
      return json({ ok: false, error: '该房间已满，换一个吧' }, 409);
    }

    const fresh = await loadGameByCode(env, code);
    return json({ ok: true, game: serializeGame(fresh, user.id) });
  } catch (err) {
    return json({ ok: false, error: `加入失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
