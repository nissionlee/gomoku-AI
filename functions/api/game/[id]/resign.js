/**
 * POST /api/game/:id/resign   认输
 */
import { json, requireDb, requireUser } from '../../../_lib/auth.js';
import { serializeGame, loadGame, colorOf, BLACK, WHITE } from '../../../_lib/game.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { user, error } = await requireUser(request, env);
  if (error) return error;

  const id = Number.parseInt(String(params.id || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: '对局 ID 不合法' }, 400);

  try {
    const row = await loadGame(env, id);
    if (!row) return json({ ok: false, error: '对局不存在' }, 404);

    const color = colorOf(row, user.id);
    if (color === null) return json({ ok: false, error: '你不是本局对弈方' }, 403);
    if (row.status === 'finished') return json({ ok: false, error: '对局已经结束' }, 400);

    const now = Date.now();
    const winner = color === BLACK ? WHITE : BLACK;

    const res = await env.DB.prepare(
      `UPDATE games
          SET status = 'finished', winner = ?, win_reason = '对方认输', updated_at = ?
        WHERE id = ? AND status != 'finished'`
    )
      .bind(winner, now, id)
      .run();

    if (!res.meta || res.meta.changes === 0) {
      return json({ ok: false, error: '对局已经结束' }, 409);
    }

    const fresh = await loadGame(env, id);
    return json({ ok: true, game: serializeGame(fresh, user.id) });
  } catch (err) {
    return json({ ok: false, error: `认输失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
