/**
 * 服务端禁手 / 胜负判定（联机对局必须服务端说了算，否则前端可被绕过）
 *
 * ⚠️ 本文件是 js/rules.js 的服务端镜像。两边的判定逻辑必须保持一致，
 *    改动任意一侧都要同步另一侧，否则会出现「本地能下、联机被拒」的诡异现象。
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const BOARD_SIZE = 15;

export const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1]
];

export function inBoard(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

export function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(EMPTY));
}

/**
 * 由落子历史还原棋盘
 * color 允许是数字 (1/2) 或字符串 ('black'/'white')，两种都归一化成数字。
 * ⚠️ 早期版本直接把字符串塞进棋盘，导致 checkWin 拿数字比较永远不成立，
 *    联机对局会「怎么下都判不出胜负」——这里必须归一化。
 */
export function boardFromMoves(moves) {
  const board = createBoard();
  for (const m of moves) {
    if (!inBoard(m.r, m.c)) continue;
    let v = m.color;
    if (v === 'black') v = BLACK;
    else if (v === 'white') v = WHITE;
    if (v === BLACK || v === WHITE) board[m.r][m.c] = v;
  }
  return board;
}

export function checkWin(board, r, c, color) {
  for (const [dr, dc] of DIRECTIONS) {
    const line = [[r, c]];

    let nr = r + dr;
    let nc = c + dc;
    while (inBoard(nr, nc) && board[nr][nc] === color) {
      line.push([nr, nc]);
      nr += dr;
      nc += dc;
    }

    nr = r - dr;
    nc = c - dc;
    while (inBoard(nr, nc) && board[nr][nc] === color) {
      line.unshift([nr, nc]);
      nr -= dr;
      nc -= dc;
    }

    // 黑棋恰好 5 连才胜；白棋 5 连及以上皆胜
    if (color === BLACK) {
      if (line.length === 5) return { win: true, winLine: line };
    } else if (line.length >= 5) {
      return { win: true, winLine: line };
    }
  }
  return { win: false };
}

function getLineArray(board, r, c, dr, dc, range = 5) {
  const line = [];
  for (let k = -range; k <= range; k++) {
    const nr = r + k * dr;
    const nc = c + k * dc;
    if (inBoard(nr, nc)) {
      line.push({ r: nr, c: nc, color: board[nr][nc], dist: k });
    } else {
      line.push({ r: nr, c: nc, color: -1, dist: k });
    }
  }
  return line;
}

export function isOpenThree(board, r, c, dr, dc) {
  const line = getLineArray(board, r, c, dr, dc, 4);
  const centerIdx = 4;
  const colors = line.map((item) => item.color);

  let openFourPossibilityCount = 0;

  for (let offset = -4; offset <= 4; offset++) {
    const targetIdx = centerIdx + offset;
    if (targetIdx < 0 || targetIdx >= colors.length) continue;
    if (offset === 0) continue;

    if (colors[targetIdx] === EMPTY) {
      colors[targetIdx] = BLACK;

      for (let start = 0; start <= colors.length - 6; start++) {
        if (
          colors[start] === EMPTY &&
          colors[start + 1] === BLACK &&
          colors[start + 2] === BLACK &&
          colors[start + 3] === BLACK &&
          colors[start + 4] === BLACK &&
          colors[start + 5] === EMPTY
        ) {
          if (centerIdx >= start + 1 && centerIdx <= start + 4) {
            openFourPossibilityCount++;
          }
        }
      }

      colors[targetIdx] = EMPTY;
    }
  }

  return openFourPossibilityCount > 0;
}

export function isFour(board, r, c, dr, dc) {
  const line = getLineArray(board, r, c, dr, dc, 5);
  const centerIdx = 5;
  const colors = line.map((item) => item.color);

  let fiveCount = 0;
  for (let offset = -4; offset <= 4; offset++) {
    const targetIdx = centerIdx + offset;
    if (targetIdx < 0 || targetIdx >= colors.length) continue;
    if (offset === 0) continue;

    if (colors[targetIdx] === EMPTY) {
      colors[targetIdx] = BLACK;
      let consecutive = 0;
      let hasFive = false;
      for (let i = 0; i < colors.length; i++) {
        if (colors[i] === BLACK) {
          consecutive++;
          if (consecutive === 5) {
            if (centerIdx >= i - 4 && centerIdx <= i) {
              hasFive = true;
              break;
            }
          }
        } else {
          consecutive = 0;
        }
      }
      colors[targetIdx] = EMPTY;
      if (hasFive) fiveCount++;
    }
  }

  return fiveCount > 0;
}

export function isOverline(board, r, c) {
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    let nr = r + dr;
    let nc = c + dc;
    while (inBoard(nr, nc) && board[nr][nc] === BLACK) {
      count++;
      nr += dr;
      nc += dc;
    }
    nr = r - dr;
    nc = c - dc;
    while (inBoard(nr, nc) && board[nr][nc] === BLACK) {
      count++;
      nr -= dr;
      nc -= dc;
    }
    if (count > 5) return true;
  }
  return false;
}

export const DEFAULT_FORBIDDEN_OPTIONS = {
  checkDoubleThree: true,
  checkDoubleFour: true,
  checkOverline: true
};

/**
 * 黑棋落子禁手判定（(r, c) 此时为空）
 * 方向分类优先级：五 > 四 > 三
 */
export function checkForbidden(board, r, c, options = {}) {
  const opts = { ...DEFAULT_FORBIDDEN_OPTIONS, ...options };

  if (!inBoard(r, c) || board[r][c] !== EMPTY) return { isForbidden: false };

  board[r][c] = BLACK;

  // 五连优先
  if (checkWin(board, r, c, BLACK).win) {
    board[r][c] = EMPTY;
    return { isForbidden: false };
  }

  if (opts.checkOverline && isOverline(board, r, c)) {
    board[r][c] = EMPTY;
    return { isForbidden: true, type: 'overline', reason: '先手长连禁手：黑棋连子超过5颗' };
  }

  if (opts.checkDoubleThree || opts.checkDoubleFour) {
    let openThreeCount = 0;
    let fourCount = 0;

    for (const [dr, dc] of DIRECTIONS) {
      if (isFour(board, r, c, dr, dc)) {
        fourCount++;
        continue; // 已成「四」的方向不再计入活三
      }
      if (opts.checkDoubleThree && isOpenThree(board, r, c, dr, dc)) openThreeCount++;
    }

    if (opts.checkDoubleThree && openThreeCount >= 2) {
      board[r][c] = EMPTY;
      return {
        isForbidden: true,
        type: 'double_three',
        reason: '先手三三禁手：黑棋不可同时形成两个及以上活三'
      };
    }

    if (opts.checkDoubleFour && fourCount >= 2) {
      board[r][c] = EMPTY;
      return {
        isForbidden: true,
        type: 'double_four',
        reason: '先手四四禁手：黑棋不可同时形成两个及以上四'
      };
    }
  }

  board[r][c] = EMPTY;
  return { isForbidden: false };
}

export function isBoardFull(board) {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === EMPTY) return false;
    }
  }
  return true;
}

export function coordToNotation(r, c) {
  const col = String.fromCharCode(65 + c);
  const row = BOARD_SIZE - r;
  return `${col}${row}`;
}
