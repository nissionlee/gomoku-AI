/**
 * GET /api/game/:id?since=N   拉取对局状态（增量）
 *   since 为已收到的步数，只返回其后的新落子，降低轮询开销
 */
import { json, requireDb, requireUser } from '../../../_lib/auth.js';
import { serializeGame, loadGame, colorOf, parseMoves } from '../../../_lib/game.js';

export async function onRequestGet(context) {
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

    if (colorOf(row, user.id) === null) {
      return json({ ok: false, error: '你不是本局对弈方' }, 403);
    }

    const all = parseMoves(row);
    const sinceRaw = Number.parseInt(String(new URL(request.url).searchParams.get('since') || '0'), 10);
    const since = Number.isInteger(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

    const game = serializeGame(row, user.id);
    game.moves = since > 0 ? all.slice(since) : all;
    game.movesBase = since;
    game.totalMoves = all.length;

    return json({ ok: true, game });
  } catch (err) {
    return json({ ok: false, error: `读取失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
