/**
 * POST /api/game/:id/move   落子 { r, c }
 * 服务端做全部合法性校验：轮次、空位、黑棋禁手、胜负判定
 */
import { json, requireDb, readJsonBody, requireUser, hitLimit } from '../../../_lib/auth.js';
import {
  serializeGame,
  loadGame,
  colorOf,
  parseMoves,
  validateMove,
  boardFromMoves,
  coordToNotation,
  BLACK,
  WHITE
} from '../../../_lib/game.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { user, error } = await requireUser(request, env);
  if (error) return error;

  if (hitLimit(request, 'move', 600, 60 * 60 * 1000)) {
    return json({ ok: false, error: '落子过于频繁' }, 429);
  }

  const id = Number.parseInt(String(params.id || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: '对局 ID 不合法' }, 400);

  const body = await readJsonBody(request, 1024);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  const r = Number.parseInt(body.data.r, 10);
  const c = Number.parseInt(body.data.c, 10);

  try {
    const row = await loadGame(env, id);
    if (!row) return json({ ok: false, error: '对局不存在' }, 404);

    const color = colorOf(row, user.id);
    if (color === null) return json({ ok: false, error: '你不是本局对弈方' }, 403);

    const moves = parseMoves(row);
    const board = boardFromMoves(moves);

    const check = validateMove(row, board, user.id, r, c);
    if (!check.ok) return json({ ok: false, error: check.error }, 400);

    // 应用这一手
    const now = Date.now();
    // color 存数字（1/2），与棋盘取值一致，避免还原时类型不匹配
    moves.push({ r, c, color, notation: coordToNotation(r, c), at: now });

    let status = row.status;
    let winner = null;
    let winReason = null;
    let nextTurn = row.turn;

    if (check.win) {
      status = 'finished';
      winner = color;
      winReason = '五连';
    } else if (check.draw) {
      status = 'finished';
      winner = 0;
      winReason = '棋盘已满，和棋';
    } else {
      nextTurn = color === BLACK ? 2 : 1;
    }

    // 条件更新：status 与 turn 必须仍是读取时的值，避免并发重复落子
    const res = await env.DB.prepare(
      `UPDATE games
          SET moves = ?, turn = ?, status = ?, winner = ?, win_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'playing' AND turn = ?`
    )
      .bind(JSON.stringify(moves), nextTurn, status, winner, winReason, now, id, color)
      .run();

    if (!res.meta || res.meta.changes === 0) {
      return json({ ok: false, error: '落子失败：局面已被更新，请刷新后重试' }, 409);
    }

    const fresh = await loadGame(env, id);
    return json({ ok: true, game: serializeGame(fresh, user.id) });
  } catch (err) {
    return json({ ok: false, error: `落子失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
