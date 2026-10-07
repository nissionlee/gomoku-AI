/**
 * 五子棋本地AI引擎 (Local Gomoku AI Engine)
 * 支持：低难度(入门)、中难度(业余)、高难度(大师)
 * 采用评分评估、局部威胁检测、Alpha-Beta剪枝搜索
 */

import { EMPTY, BLACK, WHITE, BOARD_SIZE, DIRECTIONS, inBoard, checkWin, checkForbidden } from './rules.js';

// 棋形分数表（导出供棋局分析模块复用）
export const SCORES = {
  WIN: 100000,      // 连五
  LIVE_FOUR: 10000, // 活四 (两头通)
  RUSH_FOUR: 1200,  // 冲四 (一头通或跳四)
  LIVE_THREE: 1000, // 活三
  SLEEP_THREE: 150, // 眠三
  LIVE_TWO: 120,    // 活二
  SLEEP_TWO: 20,    // 眠二
};

// 四个方向的可读名称（与 DIRECTIONS 顺序一致）
export const DIRECTION_LABELS = ['横向', '竖向', '斜向↘', '斜向↗'];

// 坐标转国际棋盘代号 (例如 7, 7 -> H8)
export function coordToNotation(r, c) {
  const colLetter = String.fromCharCode(65 + c); // 0 -> A, 7 -> H
  const rowNumber = 15 - r;                     // 0 -> 15, 7 -> 8
  return `${colLetter}${rowNumber}`;
}

// 国际棋盘代号转坐标 (例如 H8 -> 7, 7)
export function notationToCoord(notation) {
  if (!notation || typeof notation !== 'string') return null;
  const match = notation.trim().toUpperCase().match(/^([A-O])([1-9]|1[0-5])$/);
  if (!match) return null;
  const c = match[1].charCodeAt(0) - 65;
  const r = 15 - parseInt(match[2], 10);
  if (inBoard(r, c)) return [r, c];
  return null;
}

/**
 * 评估某一方向上线段的棋形得分
 */
export function evaluateDirection(board, r, c, dr, dc, color) {
  const opponent = color === BLACK ? WHITE : BLACK;
  let count = 1;
  let openEnds = 0;

  // 正向检测
  let i = 1;
  while (inBoard(r + i * dr, c + i * dc) && board[r + i * dr][c + i * dc] === color) {
    count++;
    i++;
  }
  if (inBoard(r + i * dr, c + i * dc) && board[r + i * dr][c + i * dc] === EMPTY) {
    openEnds++;
  }

  // 反向检测
  let j = 1;
  while (inBoard(r - j * dr, c - j * dc) && board[r - j * dr][c - j * dc] === color) {
    count++;
    j++;
  }
  if (inBoard(r - j * dr, c - j * dc) && board[r - j * dr][c - j * dc] === EMPTY) {
    openEnds++;
  }

  // 结算分数
  if (count >= 5) {
    return SCORES.WIN;
  }
  if (count === 4) {
    if (openEnds === 2) return SCORES.LIVE_FOUR;
    if (openEnds === 1) return SCORES.RUSH_FOUR;
  }
  if (count === 3) {
    if (openEnds === 2) return SCORES.LIVE_THREE;
    if (openEnds === 1) return SCORES.SLEEP_THREE;
  }
  if (count === 2) {
    if (openEnds === 2) return SCORES.LIVE_TWO;
    if (openEnds === 1) return SCORES.SLEEP_TWO;
  }
  return 0;
}

/**
 * 将棋形得分翻译为中文术语（用于复盘解说）
 */
export function shapeName(score) {
  if (score >= SCORES.WIN) return '五连';
  if (score >= SCORES.LIVE_FOUR) return '活四';
  if (score >= SCORES.RUSH_FOUR) return '冲四';
  if (score >= SCORES.LIVE_THREE) return '活三';
  if (score >= SCORES.SLEEP_THREE) return '眠三';
  if (score >= SCORES.LIVE_TWO) return '活二';
  if (score >= SCORES.SLEEP_TWO) return '眠二';
  return '孤子';
}

/**
 * 逐方向描述某个已落子点形成的棋形
 * @param {number[][]} board 棋盘（(r,c) 处须已落下 color 的棋子）
 * @returns {string[]} 例如 ['横向活三', '斜向↘眠二']
 */
export function describePoint(board, r, c, color) {
  const shapes = [];
  for (let i = 0; i < DIRECTIONS.length; i++) {
    const score = evaluateDirection(board, r, c, DIRECTIONS[i][0], DIRECTIONS[i][1], color);
    if (score > 0) {
      shapes.push(`${DIRECTION_LABELS[i]}${shapeName(score)}`);
    }
  }
  return shapes;
}

/**
 * 评估在 (r, c) 落子的综合价值 (进攻分 + 防守分 + 中心位置分)
 */
export function evaluatePoint(board, r, c, myColor, checkBlackForbidden = true) {
  if (board[r][c] !== EMPTY) return -Infinity;

  const opponentColor = myColor === BLACK ? WHITE : BLACK;

  // 如果我方执黑且开启了禁手，违规点直接摒弃
  if (myColor === BLACK && checkBlackForbidden) {
    // 规避禁手时按完整标准连珠判定（三三 + 四四 + 长连）
    const forbidden = checkForbidden(board, r, c);
    if (forbidden.isForbidden) {
      return -Infinity;
    }
  }

  // 1. 进攻分 (如果下在这里，我方能获得什么棋形)
  board[r][c] = myColor;
  let attackScore = 0;
  for (const [dr, dc] of DIRECTIONS) {
    attackScore += evaluateDirection(board, r, c, dr, dc, myColor);
  }
  board[r][c] = EMPTY;

  // 2. 防守分 (如果对方下在这里，对方能获得什么棋形 - 破坏敌方)
  board[r][c] = opponentColor;
  let defenseScore = 0;
  for (const [dr, dc] of DIRECTIONS) {
    defenseScore += evaluateDirection(board, r, c, dr, dc, opponentColor);
  }
  board[r][c] = EMPTY;

  // 中心位置加权分 (棋盘中心 7, 7 更有控制力)
  const distFromCenter = Math.abs(r - 7) + Math.abs(c - 7);
  const positionScore = (14 - distFromCenter) * 2;

  // 防守加权：防守往往需要稍微高于进攻权重，以防被对方偷袭杀崩
  // 如果我方能一步致胜(>= WIN)，直接优先绝杀
  if (attackScore >= SCORES.WIN) return SCORES.WIN * 2;
  // 如果对方下一步能致胜，必须舍命堵截
  if (defenseScore >= SCORES.WIN) return SCORES.WIN * 1.5;
  // 如果我方有活四，必胜
  if (attackScore >= SCORES.LIVE_FOUR) return SCORES.LIVE_FOUR * 2;
  // 对方有活四，必堵
  if (defenseScore >= SCORES.LIVE_FOUR) return SCORES.LIVE_FOUR * 1.8;

  return attackScore * 1.1 + defenseScore * 1.0 + positionScore;
}

/**
 * 获取棋盘周围有子的有效候选搜索点 (周围 1~2 格内有子)
 */
export function getCandidateMoves(board, myColor, maxCandidates = 15, checkBlackForbidden = true) {
  const candidates = [];
  let hasPiece = false;

  // 标记哪些格子附近有棋子
  const nearby = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));

  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) {
        hasPiece = true;
        // 辐射周围 2 格
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const nr = r + dr;
            const nc = c + dc;
            if (inBoard(nr, nc) && board[nr][nc] === EMPTY) {
              nearby[nr][nc] = true;
            }
          }
        }
      }
    }
  }

  // 如果棋盘完全是空的，第一步下在天元 (7, 7)
  if (!hasPiece) {
    return [{ r: 7, c: 7, score: 1000, notation: 'H8' }];
  }

  // 评估所有附近空位
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (nearby[r][c] && board[r][c] === EMPTY) {
        const score = evaluatePoint(board, r, c, myColor, checkBlackForbidden);
        if (score > -Infinity) {
          candidates.push({
            r,
            c,
            score,
            notation: coordToNotation(r, c)
          });
        }
      }
    }
  }

  // 按得分由高到低排序
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxCandidates);
}

/**
 * Alpha-Beta 极小化极大搜索 (用于高难度)
 */
function alphaBeta(board, depth, alpha, beta, isMaximizing, myColor, checkForbiddenOption) {
  const opponentColor = myColor === BLACK ? WHITE : BLACK;
  const currentColor = isMaximizing ? myColor : opponentColor;

  if (depth === 0) {
    // 叶节点静态估值：计算我方全局态势得分减去对方全局态势得分
    let myScore = 0;
    let oppScore = 0;
    const candidates = getCandidateMoves(board, myColor, 6, checkForbiddenOption);
    if (candidates.length > 0) {
      myScore = candidates[0].score;
    }
    return myScore;
  }

  const moves = getCandidateMoves(board, currentColor, 8, checkForbiddenOption);
  if (moves.length === 0) return 0;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      // 模拟落子
      board[move.r][move.c] = currentColor;
      const win = checkWin(board, move.r, move.c, currentColor);
      let evalScore;
      if (win.win) {
        evalScore = SCORES.WIN * (depth + 1); // 越快获胜分越高
      } else {
        evalScore = alphaBeta(board, depth - 1, alpha, beta, false, myColor, checkForbiddenOption);
      }
      board[move.r][move.c] = EMPTY;

      maxEval = Math.max(maxEval, evalScore);
      alpha = Math.max(alpha, evalScore);
      if (beta <= alpha) break; // 剪枝
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      board[move.r][move.c] = currentColor;
      const win = checkWin(board, move.r, move.c, currentColor);
      let evalScore;
      if (win.win) {
        evalScore = -SCORES.WIN * (depth + 1); // 对方越快获胜惩罚越大
      } else {
        evalScore = alphaBeta(board, depth - 1, alpha, beta, true, myColor, checkForbiddenOption);
      }
      board[move.r][move.c] = EMPTY;

      minEval = Math.min(minEval, evalScore);
      beta = Math.min(beta, evalScore);
      if (beta <= alpha) break; // 剪枝
    }
    return minEval;
  }
}

/**
 * AI 主入口：根据难度等级选择最佳落子
 * @param {number[][]} board 棋盘状态
 * @param {number} myColor AI 棋子颜色 (1:黑, 2:白)
 * @param {'low'|'medium'|'high'} difficulty 难度等级
 * @param {Object} options 配置项 { checkBlackForbidden?: boolean, checkDoubleThree?: boolean(兼容旧写法) }
 * @returns {{ r: number, c: number, score: number, notation: string, candidates: Array<any> }}
 */
export function getBestMove(board, myColor, difficulty = 'medium', options = {}) {
  // checkBlackForbidden 为准；兼容旧调用方传入的 checkDoubleThree 布尔值
  const checkBlackForbidden = options.checkBlackForbidden ?? options.checkDoubleThree ?? true;
  const candidates = getCandidateMoves(board, myColor, 12, checkBlackForbidden);

  if (candidates.length === 0) {
    // 默认天元
    return { r: 7, c: 7, score: 0, notation: 'H8', candidates: [] };
  }

  // 1. 如果有直接获胜或必须防守的致命手 (连五/堵连五/活四)，各难度均直接处理
  if (candidates[0].score >= SCORES.WIN || candidates[0].score >= SCORES.LIVE_FOUR * 1.5) {
    return { ...candidates[0], candidates: candidates.slice(0, 5) };
  }

  // 2. 低难度：在评估较优的前 3~4 个候选点中加入适当随机性，偶有失误，更适合休闲
  if (difficulty === 'low') {
    const pool = candidates.slice(0, Math.min(4, candidates.length));
    // 65% 选择第一好手，35% 选次优手
    const chosen = Math.random() < 0.65 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
    return { ...chosen, candidates: candidates.slice(0, 5) };
  }

  // 3. 中难度：1~2步贪心威胁最优，极少犯错
  if (difficulty === 'medium') {
    return { ...candidates[0], candidates: candidates.slice(0, 5) };
  }

  // 4. 高难度：深度 Alpha-Beta 搜索 (深度 3~4)，多步深思熟虑
  if (difficulty === 'high') {
    let bestScore = -Infinity;
    let bestMove = candidates[0];

    // 针对排名前 6 个最有价值的候选点做深度探查
    const searchCandidates = candidates.slice(0, 6);
    for (const move of searchCandidates) {
      board[move.r][move.c] = myColor;
      const win = checkWin(board, move.r, move.c, myColor);
      let score;
      if (win.win) {
        score = SCORES.WIN * 10;
      } else {
        score = alphaBeta(board, 3, -Infinity, Infinity, false, myColor, checkBlackForbidden);
      }
      board[move.r][move.c] = EMPTY;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }

    return { ...bestMove, candidates: candidates.slice(0, 5) };
  }

  return { ...candidates[0], candidates: candidates.slice(0, 5) };
}
