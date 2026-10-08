/**
 * 职业级棋形评估与搜索 (Pro-level Evaluation & Search)
 *
 * 与 engine.js 的关系：本模块完全独立，不改动 low/medium/high 三档的任何行为，
 * 只为新增的「职业级」提供更强算force：
 *
 *  1. 棋形识别升级：改用「5 格窗口 + 成五点计数」的方法判定棋形，因此能正确识别
 *     跳三 (X_XX / XX_X)、跳四 (XX_XX / X_XXX) 这类旧版连续计数漏掉的形状；
 *     活三/眠三 按「落子后能否成活四」的递归定义判定，与 rules.js 的禁手口径一致。
 *  2. VCF 强制杀搜索：穷举己方连续冲四/活四的分支，对手只能按唯一解防守，
 *     因此能算出「连续冲四三步胜」这类旧版深度 3 看不到的杀招。
 *  3. 迭代加深 Alpha-Beta + 置换表 + 时间预算：在给定毫秒数内尽量算得更深。
 *
 * 所有函数都会自行处理棋盘副本，绝不修改传入的 board。
 */

import { EMPTY, BLACK, WHITE, BOARD_SIZE, DIRECTIONS, inBoard, checkWin, checkForbidden } from './rules.js';
import { SCORES, coordToNotation } from './engine.js';

const OTHER = 2; // 编码里表示「对方或出界」的阻挡格

/* ==========================================================================
   一、棋形评估 V2
   ========================================================================== */

/**
 * 取 (r,c) 沿 (dr,dc) 方向 ±4 的编码串：'1'=己方, '0'=空, '2'=对方或出界
 * 中心棋子本身记为 '1'（调用前须已落子）
 */
function encodeLine(board, r, c, dr, dc, color) {
  const codes = [];
  for (let k = -4; k <= 4; k++) {
    if (k === 0) {
      codes.push('1');
      continue;
    }
    const nr = r + k * dr;
    const nc = c + k * dc;
    if (!inBoard(nr, nc)) {
      codes.push('2');
    } else {
      const v = board[nr][nc];
      codes.push(v === color ? '1' : (v === EMPTY ? '0' : '2'));
    }
  }
  return codes;
}

/**
 * 在给定编码串上，统计「落一手即可连五」的空位集合（窗口内无阻挡且已有 4 子）
 * @returns {{five:boolean, completions:Set<number>}} completions 为窗口内空位的下标
 */
function analyzeLine(codes) {
  const completions = new Set();
  const CENTER = 4;

  for (let start = 0; start + 5 <= codes.length; start++) {
    // 窗口必须包含中心棋子
    if (start > CENTER || start + 4 < CENTER) continue;

    let mine = 0;
    let blocked = false;
    let emptyIdx = -1;
    let emptyCount = 0;

    for (let i = start; i < start + 5; i++) {
      const ch = codes[i];
      if (ch === '1') mine++;
      else if (ch === '0') {
        emptyCount++;
        emptyIdx = i;
      } else {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    if (mine === 5) return { five: true, completions };
    if (mine === 4 && emptyCount === 1) completions.add(emptyIdx);
  }

  return { five: false, completions };
}

/**
 * 把「成五点数量」与「能否再进一步」折算成棋形得分
 * 活四 = 有两个不同成五点；冲四 = 只有一个
 * 活三 = 存在一手能形成活四；眠三 = 存在一手只能形成冲四
 * 活二 = 存在一手能形成活三；眠二 = 存在一手能形成眠三
 */
function lineScore(codes) {
  const direct = analyzeLine(codes);
  if (direct.five) return SCORES.WIN;
  if (direct.completions.size >= 2) return SCORES.LIVE_FOUR;
  if (direct.completions.size === 1) return SCORES.RUSH_FOUR;

  // 尝试在窗口附近的每个空位再落一子，看能升级成什么
  let bestNext = 0;
  const seen = new Set();
  for (let i = 1; i < codes.length - 1; i++) {
    if (codes[i] !== '0' || seen.has(i)) continue;
    seen.add(i);
    const next = codes.slice();
    next[i] = '1';
    const key = next.join('');
    const after = analyzeLine(next);
    let score = 0;
    if (after.five) score = SCORES.WIN;                       // 一步成五（理论上上面已捕获）
    else if (after.completions.size >= 2) score = SCORES.LIVE_FOUR;
    else if (after.completions.size === 1) score = SCORES.RUSH_FOUR;

    if (score > bestNext) bestNext = score;
    if (bestNext === SCORES.LIVE_FOUR) break;                 // 已确认是活三，无需再看

    // 再深一层：判断是否活二（能落成活三）
    if (score === 0) {
      for (let j = 1; j < next.length - 1; j++) {
        if (next[j] !== '0') continue;
        const deeper = next.slice();
        deeper[j] = '1';
        const d = analyzeLine(deeper);
        let s2 = 0;
        if (d.five) s2 = SCORES.WIN;
        else if (d.completions.size >= 2) s2 = SCORES.LIVE_FOUR;
        else if (d.completions.size === 1) s2 = SCORES.RUSH_FOUR;
        if (s2 === SCORES.LIVE_FOUR) { bestNext = Math.max(bestNext, SCORES.LIVE_THREE); break; }
        if (s2 === SCORES.RUSH_FOUR) bestNext = Math.max(bestNext, SCORES.SLEEP_THREE);
      }
    }
  }

  // bestNext 表示「下一手能达到的最好棋形」，据此反推当前棋形
  if (bestNext === SCORES.LIVE_FOUR) return SCORES.LIVE_THREE;   // 能成活四 → 活三
  if (bestNext === SCORES.RUSH_FOUR) return SCORES.SLEEP_THREE;  // 只能成冲四 → 眠三
  if (bestNext >= SCORES.LIVE_THREE) return SCORES.LIVE_TWO;
  if (bestNext > 0) return SCORES.SLEEP_TWO;
  return 0;
}

const lineScoreCache = new Map();

function lineScoreCached(codes) {
  const key = codes.join('');
  let hit = lineScoreCache.get(key);
  if (hit === undefined) {
    hit = lineScore(codes);
    if (lineScoreCache.size > 60000) lineScoreCache.clear();
    lineScoreCache.set(key, hit);
  }
  return hit;
}

/**
 * 单方向棋形得分（(r,c) 须已落下 color 的棋子）
 */
export function directionScore(board, r, c, dr, dc, color) {
  return lineScoreCached(encodeLine(board, r, c, dr, dc, color));
}

/**
 * 评估在 (r,c) 落子的综合价值（攻守兼看），口径与 engine.evaluatePoint 保持一致
 */
export function evaluatePointPro(board, r, c, myColor, forbidOptions = true) {
  if (board[r][c] !== EMPTY) return -Infinity;

  const opponent = myColor === BLACK ? WHITE : BLACK;

  if (myColor === BLACK && forbidOptions) {
    const forbidden = checkForbidden(board, r, c, normalizeForbid(forbidOptions));
    if (forbidden.isForbidden) return -Infinity;
  }

  board[r][c] = myColor;
  let attack = 0;
  for (const [dr, dc] of DIRECTIONS) attack += directionScore(board, r, c, dr, dc, myColor);
  board[r][c] = EMPTY;

  board[r][c] = opponent;
  let defense = 0;
  for (const [dr, dc] of DIRECTIONS) defense += directionScore(board, r, c, dr, dc, opponent);
  board[r][c] = EMPTY;

  const distFromCenter = Math.abs(r - 7) + Math.abs(c - 7);
  const position = (14 - distFromCenter) * 2;

  if (attack >= SCORES.WIN) return SCORES.WIN * 2;
  if (defense >= SCORES.WIN) return SCORES.WIN * 1.5;
  if (attack >= SCORES.LIVE_FOUR) return SCORES.LIVE_FOUR * 2;
  if (defense >= SCORES.LIVE_FOUR) return SCORES.LIVE_FOUR * 1.8;

  return attack * 1.1 + defense + position;
}

function normalizeForbid(forbidOptions) {
  if (forbidOptions === true) {
    return { checkDoubleThree: true, checkDoubleFour: true, checkOverline: true };
  }
  if (forbidOptions && typeof forbidOptions === 'object') {
    return {
      checkDoubleThree: forbidOptions.checkDoubleThree !== false,
      checkDoubleFour: forbidOptions.checkDoubleFour !== false,
      checkOverline: true
    };
  }
  return { checkDoubleThree: false, checkDoubleFour: false, checkOverline: false };
}

/**
 * 候选点生成：只看在已有棋子邻域内的空位，按 V2 评分排序
 * @param {number} range 邻域半径（搜索内层用 1 更省时间）
 */
export function getCandidateMovesPro(board, myColor, maxCandidates = 12, forbidOptions = true, range = 2) {
  const nearby = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));
  let hasStone = false;

  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === EMPTY) continue;
      hasStone = true;
      for (let dr = -range; dr <= range; dr++) {
        for (let dc = -range; dc <= range; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (inBoard(nr, nc) && board[nr][nc] === EMPTY) nearby[nr][nc] = true;
        }
      }
    }
  }

  if (!hasStone) return [{ r: 7, c: 7, score: 1000, notation: 'H8' }];

  const list = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (!nearby[r][c]) continue;
      const score = evaluatePointPro(board, r, c, myColor, forbidOptions);
      if (score === -Infinity) continue;
      list.push({ r, c, score, notation: coordToNotation(r, c) });
    }
  }
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, maxCandidates);
}

/**
 * 轻量增量评估：只看最后一手落子点附近 3 格内的空点，取双方最优
 * （全盘扫描太慢，无法在 1.5 秒内完成 4 层以上搜索）
 */
function quickBestScore(board, r, c, color, forbidOptions) {
  let best = 0;
  for (let dr = -3; dr <= 3; dr++) {
    for (let dc = -3; dc <= 3; dc++) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBoard(nr, nc) || board[nr][nc] !== EMPTY) continue;
      const s = evaluatePointPro(board, nr, nc, color, forbidOptions);
      if (s !== -Infinity && s > best) best = s;
    }
  }
  return best;
}

/* ==========================================================================
   二、VCF 连续冲四强制杀搜索
   ========================================================================== */

/**
 * 找出所有「己方落子即成活四/冲四/连五」的点（用于强制手分支）
 */
function forcingMoves(board, color, forbidOptions) {
  const opp = color === BLACK ? WHITE : BLACK;
  const moves = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) continue;
      if (!nearStone(board, r, c, 1)) continue;
      board[r][c] = color;
      let attack = 0;
      let five = false;
      for (const [dr, dc] of DIRECTIONS) {
        const s = directionScore(board, r, c, dr, dc, color);
        if (s >= SCORES.WIN) five = true;
        attack = Math.max(attack, s);
      }
      const isFour = five || attack >= SCORES.RUSH_FOUR;
      board[r][c] = EMPTY;
      if (!isFour) continue;
      if (color === BLACK && forbidOptions) {
        const fb = checkForbidden(board, r, c, normalizeForbid(forbidOptions));
        if (fb.isForbidden) continue;
      }
      moves.push({ r, c, five, notation: coordToNotation(r, c) });
      if (moves.length > 24) return moves;
    }
  }
  void opp;
  return moves;
}

function nearStone(board, r, c, range = 1) {
  for (let dr = -range; dr <= range; dr++) {
    for (let dc = -range; dc <= range; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (inBoard(nr, nc) && board[nr][nc] !== EMPTY) return true;
    }
  }
  return false;
}

/**
 * 对手面对我方冲四时的唯一防守点（能成五的点）
 */
function opponentMustPoints(board, oppColor) {
  const points = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) continue;
      board[r][c] = oppColor;
      let five = false;
      for (const [dr, dc] of DIRECTIONS) {
        if (directionScore(board, r, c, dr, dc, oppColor) >= SCORES.WIN) { five = true; break; }
      }
      board[r][c] = EMPTY;
      if (five) points.push({ r, c });
      if (points.length > 6) return points;
    }
  }
  return points;
}

/**
 * 深度优先 VCF：己方连续冲四，对手只能挡成五点，直到己方连五
 * @returns {Array|null} 取胜着法序列（己方着法），无解返回 null
 */
export function findVcf(board, color, options = {}) {
  const forbidOptions = options.forbidOptions ?? true;
  const maxDepth = options.maxDepth || 8;
  const deadline = (options.deadline || (performance.now() + (options.timeLimit || 600)));
  const opp = color === BLACK ? WHITE : BLACK;

  function dfs(depth, line) {
    if (performance.now() > deadline || depth > maxDepth) return null;

    const mine = forcingMoves(board, color, forbidOptions);
    for (const mv of mine) {
      board[mv.r][mv.c] = color;
      if (mv.five) {
        board[mv.r][mv.c] = EMPTY;
        return line.concat([{ r: mv.r, c: mv.c, notation: mv.notation }]);
      }
      // 对手必须堵住我方成五点，否则下一步就输
      const blocks = opponentMustPoints(board, color);
      if (blocks.length === 0) {
        // 我方落下冲四后对手无处可挡 = 我方已成五（上面已判），此处按取胜处理
        board[mv.r][mv.c] = EMPTY;
        return line.concat([{ r: mv.r, c: mv.c, notation: mv.notation }]);
      }
      if (blocks.length === 1) {
        board[blocks[0].r][blocks[0].c] = opp;
        const found = dfs(depth + 1, line.concat([{ r: mv.r, c: mv.c, notation: mv.notation }]));
        board[blocks[0].r][blocks[0].c] = EMPTY;
        board[mv.r][mv.c] = EMPTY;
        if (found) return found;
        continue;
      }
      // 多个防守点（活四）→ 直接取胜
      board[mv.r][mv.c] = EMPTY;
      return line.concat([{ r: mv.r, c: mv.c, notation: mv.notation }]);
    }
    return null;
  }

  return dfs(1, []);
}

/* ==========================================================================
   三、迭代加深 Alpha-Beta + 置换表
   ========================================================================== */

function boardKey(board, color, depth) {
  let h = color === BLACK ? 1 : 2;
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = board[r];
    for (let c = 0; c < BOARD_SIZE; c++) {
      const v = row[c];
      if (v === EMPTY) continue;
      h = (h * 31 + (v === BLACK ? 3 : 7) + r * 17 + c * 13) >>> 0;
    }
  }
  return `${h}:${depth}:${color}`;
}

function leafEvaluate(board, lastR, lastC, rootColor, forbidOptions) {
  const opp = rootColor === BLACK ? WHITE : BLACK;
  const mine = quickBestScore(board, lastR, lastC, rootColor, forbidOptions);
  const theirs = quickBestScore(board, lastR, lastC, opp, false);
  return mine - theirs;
}

// 搜索宽度按剩余深度递减，把时间花在关键分支上
function widthFor(depth) {
  if (depth >= 5) return 8;
  if (depth >= 3) return 6;
  return 4;
}

function alphaBetaPro(ctx, board, depth, alpha, beta, maximizing, rootColor, forbidOptions, tt, lastR, lastC) {
  const color = maximizing ? rootColor : (rootColor === BLACK ? WHITE : BLACK);

  if ((ctx.nodes++ & 255) === 0 && performance.now() > ctx.deadline) {
    throw new SearchAborted();
  }

  const key = boardKey(board, color, depth);
  const cached = tt.get(key);
  if (cached && cached.depth >= depth) {
    if (cached.flag === 'exact') return cached.value;
    if (cached.flag === 'lower' && cached.value > alpha) alpha = cached.value;
    if (cached.flag === 'upper' && cached.value < beta) beta = cached.value;
    if (alpha >= beta) return cached.value;
  }

  const moves = getCandidateMovesPro(board, color, widthFor(depth), forbidOptions, 1);
  if (!moves.length) return 0;

  // 极小化极大：我方节点取最大，对手节点取最小（此前统一取最大等于把对手当成配合方）
  let best = maximizing ? -Infinity : Infinity;
  let bestMove = null;
  let flag = maximizing ? 'upper' : 'lower';

  for (const mv of moves) {
    board[mv.r][mv.c] = color;
    let value;
    try {
      const win = checkWin(board, mv.r, mv.c, color);
      if (win.win) {
        value = color === rootColor ? SCORES.WIN * (depth + 1) : -SCORES.WIN * (depth + 1);
      } else if (depth <= 1) {
        value = leafEvaluate(board, mv.r, mv.c, rootColor, forbidOptions);
      } else {
        value = alphaBetaPro(ctx, board, depth - 1, alpha, beta, !maximizing, rootColor, forbidOptions, tt, mv.r, mv.c);
      }
    } finally {
      board[mv.r][mv.c] = EMPTY;   // 即使超时中断也必须还原
    }

    if (maximizing) {
      if (value > best) { best = value; bestMove = mv; }
      if (best > alpha) { alpha = best; flag = 'exact'; }
      if (alpha >= beta) { flag = 'lower'; break; }
    } else {
      if (value < best) { best = value; bestMove = mv; }
      if (best < beta) { beta = best; flag = 'exact'; }
      if (alpha >= beta) { flag = 'upper'; break; }
    }
  }

  if (tt.size < 200000) {
    tt.set(key, { depth, value: best, flag: bestMove ? flag : (maximizing ? 'upper' : 'lower') });
  }
  return best;
}

class SearchAborted extends Error {}

/**
 * 职业级主搜索：先查即杀与 VCF，再做限时迭代加深
 * @param {number[][]} board 当前局面（会被临时修改后还原）
 * @param {number} color 行棋方
 * @param {Object} options { timeLimit=1400, forbidOptions=true, maxDepth=8, vcf=true }
 * @returns {{r:number,c:number,notation:string,score:number,depth:number,reason:string,candidates:Array}}
 */
export function searchPro(board, color, options = {}) {
  const startedAt = performance.now();
  const timeLimit = options.timeLimit || 1400;
  const deadline = startedAt + timeLimit;
  const forbidOptions = options.forbidOptions ?? true;

  const quick = getCandidateMovesPro(board, color, 12, forbidOptions, 2);
  if (!quick.length) return { r: 7, c: 7, notation: 'H8', score: 0, depth: 0, reason: 'empty', candidates: [] };

  // 1. 一步制胜 / 必堵点，直接走
  if (quick[0].score >= SCORES.WIN * 1.5) {
    return { ...quick[0], depth: 1, reason: 'forced', candidates: quick.slice(0, 5) };
  }

  // 2. VCF 连续冲四取胜
  if (options.vcf !== false) {
    const line = findVcf(board, color, {
      forbidOptions,
      maxDepth: options.vcfDepth || 8,
      deadline: startedAt + Math.min(600, timeLimit * 0.45)
    });
    if (line && line.length) {
      const first = quick.find(q => q.r === line[0].r && q.c === line[0].c) || line[0];
      return {
        r: line[0].r,
        c: line[0].c,
        notation: line[0].notation,
        score: SCORES.WIN,
        depth: line.length,
        reason: `vcf:${line.length}`,
        candidates: quick.slice(0, 5),
        vcfLine: line
      };
    }
  }

  // 3. 迭代加深（只采纳完整跑完的轮次，超时轮次丢弃）
  const ctx = { deadline, nodes: 0 };
  const tt = new Map();
  let best = { ...quick[0], score: quick[0].score };
  let reachedDepth = 0;
  let lastBestMove = null;

  for (let depth = 2; depth <= (options.maxDepth || 8); depth += 2) {
    let roots = quick.slice(0, 8);
    if (lastBestMove) {
      // 上一轮的最佳着法优先搜索，显著提升 Alpha-Beta 剪枝效率
      roots = [lastBestMove].concat(roots.filter(m => !(m.r === lastBestMove.r && m.c === lastBestMove.c)));
    }

    let localBest = null;
    let localScore = -Infinity;
    let completed = true;

    try {
      for (const mv of roots) {
        board[mv.r][mv.c] = color;
        let value;
        try {
          const win = checkWin(board, mv.r, mv.c, color);
          value = win.win
            ? SCORES.WIN * 10
            : alphaBetaPro(ctx, board, depth - 1, -Infinity, Infinity, false, color, forbidOptions, tt, mv.r, mv.c);
        } finally {
          board[mv.r][mv.c] = EMPTY;
        }

        if (value > localScore) { localScore = value; localBest = mv; }
        if (performance.now() > deadline) throw new SearchAborted();
      }
    } catch (err) {
      if (err instanceof SearchAborted) completed = false;
      else throw err;
    }

    // 至少完成第一个着法才有参考价值；整轮被打断时保留上一轮结论
    if (localBest && (completed || depth === 2)) {
      best = { ...localBest, score: localScore };
      lastBestMove = localBest;
      if (completed) reachedDepth = depth;
    }
    if (!completed) break;
    if (performance.now() > deadline) break;
  }

  return {
    ...best,
    depth: reachedDepth || 1,
    reason: 'search',
    candidates: quick.slice(0, 5),
    elapsedMs: Math.round(performance.now() - startedAt)
  };
}

/**
 * 从扁平数组还原棋盘（Worker 传输用）
 */
export function boardFromFlat(flat) {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      board[r][c] = flat[r * BOARD_SIZE + c];
    }
  }
  return board;
}

export function boardToFlat(board) {
  const flat = new Int8Array(BOARD_SIZE * BOARD_SIZE);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      flat[r * BOARD_SIZE + c] = board[r][c];
    }
  }
  return flat;
}
