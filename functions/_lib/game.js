/**
 * 对局数据层：加载、序列化、落子合法性校验
 */
import { BLACK, WHITE, EMPTY, boardFromMoves, checkWin, checkForbidden, isBoardFull, coordToNotation, inBoard } from './renju.js';

const GAME_SELECT = `
  SELECT g.*,
         COALESCE(b.display_name, b.username) AS black_name,
         COALESCE(w.display_name, w.username) AS white_name
    FROM games g
    LEFT JOIN users b ON b.id = g.black_user_id
    LEFT JOIN users w ON w.id = g.white_user_id
`;

export function parseMoves(row) {
  try {
    const arr = JSON.parse(row.moves || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function serializeGame(row, viewerId) {
  const moves = parseMoves(row);
  let myColor = null;
  if (row.black_user_id === viewerId) myColor = 'black';
  else if (row.white_user_id === viewerId) myColor = 'white';

  let winner = null;
  if (row.winner === 1) winner = 'black';
  else if (row.winner === 2) winner = 'white';
  else if (row.winner === 0) winner = 'draw';

  return {
    id: row.id,
    roomCode: row.room_code,
    status: row.status, // waiting | playing | finished
    turn: row.turn === 2 ? 'white' : 'black',
    winner,
    winReason: row.win_reason || null,
    moves,
    moveCount: moves.length,
    blackUserId: row.black_user_id,
    whiteUserId: row.white_user_id,
    blackName: row.black_name || null,
    whiteName: row.white_name || null,
    myColor,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function loadGame(env, id) {
  return env.DB.prepare(`${GAME_SELECT} WHERE g.id = ?`).bind(id).first();
}

export async function loadGameByCode(env, code) {
  return env.DB.prepare(`${GAME_SELECT} WHERE g.room_code = ?`).bind(code).first();
}

/** 该用户在这局里执什么颜色；不参与返回 null */
export function colorOf(row, userId) {
  if (row.black_user_id === userId) return BLACK;
  if (row.white_user_id === userId) return WHITE;
  return null;
}

/**
 * 校验一手棋是否合法（不改库）
 * @returns {{ ok: boolean, error?: string, win?: boolean, draw?: boolean }}
 */
export function validateMove(row, board, userId, r, c) {
  if (row.status !== 'playing') return { ok: false, error: '对局尚未开始或已结束' };

  const color = colorOf(row, userId);
  if (color === null) return { ok: false, error: '你不是本局对弈方' };

  if (row.turn !== color) return { ok: false, error: '还没轮到你落子' };

  if (!Number.isInteger(r) || !Number.isInteger(c) || !inBoard(r, c)) {
    return { ok: false, error: '落子坐标超出棋盘范围' };
  }

  if (board[r][c] !== EMPTY) return { ok: false, error: '该位置已有棋子' };

  // 黑棋禁手（白棋无禁手）
  if (color === BLACK) {
    const fb = checkForbidden(board, r, c);
    if (fb.isForbidden) return { ok: false, error: fb.reason || '黑棋禁手' };
  }

  board[r][c] = color;

  const win = checkWin(board, r, c, color).win;
  const draw = !win && isBoardFull(board);

  board[r][c] = EMPTY;

  return { ok: true, win, draw };
}

export { BLACK, WHITE, EMPTY, boardFromMoves, coordToNotation, checkWin, checkForbidden, isBoardFull, inBoard };
