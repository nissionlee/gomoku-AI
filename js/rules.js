/**
 * 五子棋规则引擎与禁手判定 (Renju Rules & Forbidden Moves Engine)
 * 包含：胜负判定、五连检测、先手黑棋三三禁手、四四禁手、长连禁手
 */

export const EMPTY = 0;
export const BLACK = 1; // 先手
export const WHITE = 2; // 后手
export const BOARD_SIZE = 15;

export const DIRECTIONS = [
  [0, 1],   // 水平 (左右)
  [1, 0],   // 垂直 (上下)
  [1, 1],   // 正对角线 (左上-右下)
  [1, -1],  // 反对角线 (右上-左下)
];

/**
 * 检查坐标是否在棋盘内
 */
export function inBoard(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

/**
 * 检查当前落子是否获胜
 * @param {number[][]} board 棋盘状态 15x15
 * @param {number} r 行
 * @param {number} c 列
 * @param {number} color 棋子颜色 (1:黑, 2:白)
 * @returns {{ win: boolean, winLine?: Array<[number, number]> }}
 */
export function checkWin(board, r, c, color) {
  for (const [dr, dc] of DIRECTIONS) {
    let line = [[r, c]];
    
    // 正向延伸
    let nr = r + dr;
    let nc = c + dc;
    while (inBoard(nr, nc) && board[nr][nc] === color) {
      line.push([nr, nc]);
      nr += dr;
      nc += dc;
    }

    // 反向延伸
    nr = r - dr;
    nc = c - dc;
    while (inBoard(nr, nc) && board[nr][nc] === color) {
      line.unshift([nr, nc]);
      nr -= dr;
      nc -= dc;
    }

    // 黑棋要求恰好5连（长连属禁手，由禁手逻辑单独或配合判定），白棋>=5连即胜
    if (color === BLACK) {
      if (line.length === 5) {
        return { win: true, winLine: line };
      }
    } else {
      if (line.length >= 5) {
        return { win: true, winLine: line };
      }
    }
  }

  return { win: false };
}

/**
 * 获取一条直线上以 (r, c) 为中心的连续视野数组
 * 返回在指定方向上的点和其颜色
 */
function getLineArray(board, r, c, dr, dc, range = 5) {
  const line = [];
  for (let k = -range; k <= range; k++) {
    const nr = r + k * dr;
    const nc = c + k * dc;
    if (inBoard(nr, nc)) {
      line.push({ r: nr, c: nc, color: board[nr][nc], dist: k });
    } else {
      line.push({ r: nr, c: nc, color: -1, dist: k }); // -1 表示出界
    }
  }
  return line;
}

/**
 * 判断黑棋在指定方向经过 (r, c) 是否形成了“活三”
 * 活三的严格定义：该三子可以通过一步落子形成双方均未受封堵的“活四”。
 * 活四形态必为：空-黑-黑-黑-黑-空 (0 1 1 1 1 0)
 */
export function isOpenThree(board, r, c, dr, dc) {
  // 必须假设 (r, c) 已经临时下了黑子
  const line = getLineArray(board, r, c, dr, dc, 4);
  const centerIdx = 4; // dist = 0 的下标

  // 提取从 centerIdx-4 到 centerIdx+4 的颜色数组 (长度 9)
  const colors = line.map(item => item.color);

  // 检查在 line 中是否存在一个空位，黑棋落子后能形成活四 (0 1 1 1 1 0)
  // 且此活四必须包含 (r, c)
  let openFourPossibilityCount = 0;

  for (let offset = -4; offset <= 4; offset++) {
    const targetIdx = centerIdx + offset;
    if (targetIdx < 0 || targetIdx >= colors.length) continue;
    if (offset === 0) continue; // (r, c) 本身已下子

    // 如果该位置为空，测试下子后是否构成 0 1 1 1 1 0
    if (colors[targetIdx] === EMPTY) {
      colors[targetIdx] = BLACK;

      // 检查是否出现 0 1 1 1 1 0 且包含 centerIdx 和 targetIdx
      // 活四长度为 6：0 1 1 1 1 0
      for (let start = 0; start <= colors.length - 6; start++) {
        if (
          colors[start] === EMPTY &&
          colors[start + 1] === BLACK &&
          colors[start + 2] === BLACK &&
          colors[start + 3] === BLACK &&
          colors[start + 4] === BLACK &&
          colors[start + 5] === EMPTY
        ) {
          // 确认 centerIdx 在这 4 个 1 之中
          if (centerIdx >= start + 1 && centerIdx <= start + 4) {
            openFourPossibilityCount++;
          }
        }
      }

      // 还原
      colors[targetIdx] = EMPTY;
    }
  }

  return openFourPossibilityCount > 0;
}

/**
 * 判断黑棋在指定方向是否形成了四（活四或冲四）
 */
export function isFour(board, r, c, dr, dc) {
  const line = getLineArray(board, r, c, dr, dc, 5);
  const centerIdx = 5;
  const colors = line.map(item => item.color);

  // 检查是否有一步能成五连
  let fiveCount = 0;
  for (let offset = -4; offset <= 4; offset++) {
    const targetIdx = centerIdx + offset;
    if (targetIdx < 0 || targetIdx >= colors.length) continue;
    if (offset === 0) continue;

    if (colors[targetIdx] === EMPTY) {
      colors[targetIdx] = BLACK;
      // 检查是否有 5 连
      let consecutive = 0;
      let hasFive = false;
      for (let i = 0; i < colors.length; i++) {
        if (colors[i] === BLACK) {
          consecutive++;
          if (consecutive === 5) {
            // 确认包含 centerIdx
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
      if (hasFive) {
        fiveCount++;
      }
    }
  }

  return fiveCount > 0;
}

/**
 * 检查黑棋的长连（6个及以上连续）
 */
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
    if (count > 5) {
      return true;
    }
  }
  return false;
}

/**
 * 禁手判定的默认配置：完整标准连珠（三三 + 四四 + 长连全部启用）
 */
export const DEFAULT_FORBIDDEN_OPTIONS = {
  checkDoubleThree: true,
  checkDoubleFour: true,
  checkOverline: true
};

/**
 * 全面判定黑棋落子在 (r, c) 是否触犯禁手规则
 * @param {number[][]} board 棋盘状态 (此时 (r, c) 尚为空)
 * @param {number} r 行
 * @param {number} c 列
 * @param {Object} options 禁手配置项 { checkDoubleThree: true, checkDoubleFour: true, checkOverline: true }
 * @returns {{ isForbidden: boolean, reason?: string, type?: 'double_three' | 'double_four' | 'overline' }}
 */
export function checkForbidden(board, r, c, options = {}) {
  const opts = { ...DEFAULT_FORBIDDEN_OPTIONS, ...options };

  if (board[r][c] !== EMPTY) {
    return { isForbidden: false };
  }

  // 临时落黑子
  board[r][c] = BLACK;

  // 1. 五连优先：五子成连则判定获胜，不是禁手
  const winCheck = checkWin(board, r, c, BLACK);
  if (winCheck.win) {
    board[r][c] = EMPTY;
    return { isForbidden: false };
  }

  // 2. 长连禁手检测 (超过5连)
  if (opts.checkOverline && isOverline(board, r, c)) {
    board[r][c] = EMPTY;
    return {
      isForbidden: true,
      type: 'overline',
      reason: '先手长连禁手：黑棋连子超过5颗'
    };
  }

  // 3. 三三 / 四四禁手检测
  //
  // 【关键】方向分类必须遵循优先级：五 > 四 > 三。
  // 一个方向一旦构成「四」（活四或冲四），就不能再把它计入活三，
  // 否则经典的四三取胜棋形会被误判成三三禁手。
  // 反例：水平形成 ●●●·●（跳四，补空档即五连）+ 垂直形成跳活三 ——
  //       这是「四三」杀，黑棋合法取胜手段，绝不能判三三禁手。
  if (opts.checkDoubleThree || opts.checkDoubleFour) {
    let openThreeCount = 0;
    let fourCount = 0;

    for (const [dr, dc] of DIRECTIONS) {
      if (isFour(board, r, c, dr, dc)) {
        fourCount++;
        continue; // 该方向按「四」计，不再计入活三
      }
      if (opts.checkDoubleThree && isOpenThree(board, r, c, dr, dc)) {
        openThreeCount++;
      }
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

  // 还原棋盘
  board[r][c] = EMPTY;
  return { isForbidden: false };
}

/**
 * 检查棋盘是否已下满（和棋）
 */
export function isBoardFull(board) {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === EMPTY) return false;
    }
  }
  return true;
}
