/**
 * 棋局复盘分析引擎 (Game Review & Analysis)
 *
 * 全部基于本地战术引擎（engine.js）的评分体系，离线可用、毫秒级响应：
 *  1. analyzeMove()      —— 评价某一手的质量（是否最优、棋形收益、防守价值、定级）
 *  2. analyzePosition()  —— 评价某一局面的行棋方该怎么办（推荐点、双方威胁）
 *  3. analyzeContinuation() —— 推演接下来 3 手最可能的变化分支（下一步/下下一步/下下下一步）
 *
 * 说明：所有函数都会自行构造棋盘副本，绝不会改动传入的棋谱数组或对局棋盘。
 */

import { EMPTY, BLACK, WHITE, BOARD_SIZE, inBoard, checkWin, checkForbidden } from './rules.js';
import {
  SCORES,
  coordToNotation,
  evaluatePoint,
  getCandidateMoves,
  describePoint,
  shapeName
} from './engine.js';

export const COLOR_NAMES = { [BLACK]: '黑', [WHITE]: '白' };

function other(color) {
  return color === BLACK ? WHITE : BLACK;
}

function notationOf(move) {
  return move.notation || coordToNotation(move.r, move.c);
}

/**
 * 用棋谱前 count 手重建局面
 * @param {Array<{r:number,c:number,color:number}>} moves
 * @param {number} count 应用前 count 手（0 表示空盘）
 */
export function buildBoardFromMoves(moves, count = moves.length) {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
  const n = Math.max(0, Math.min(count, moves.length));
  for (let i = 0; i < n; i++) {
    const m = moves[i];
    if (m && inBoard(m.r, m.c)) {
      board[m.r][m.c] = m.color;
    }
  }
  return board;
}

/**
 * 第 count 手之后轮到谁下（黑棋始终先行，故按落子总数奇偶推断）
 */
export function colorToMoveAt(moves, count) {
  const n = Math.max(0, Math.min(count, moves.length));
  return n % 2 === 0 ? BLACK : WHITE;
}

/**
 * 临时落子取得该点的棋形描述（自动还原棋盘）
 */
function shapesIfPlaced(board, r, c, color) {
  if (board[r][c] !== EMPTY) return [];
  board[r][c] = color;
  const shapes = describePoint(board, r, c, color);
  board[r][c] = EMPTY;
  return shapes;
}

/**
 * 把候选点得分翻译为威胁等级术语
 */
function threatLabel(score) {
  if (score >= SCORES.WIN * 2) return '一步致胜';
  if (score >= SCORES.WIN * 1.5) return '必堵杀点';
  if (score >= SCORES.LIVE_FOUR * 2) return '必胜活四';
  if (score >= SCORES.LIVE_FOUR * 1.8) return '对方活四';
  if (score >= SCORES.RUSH_FOUR) return '冲四';
  if (score >= SCORES.LIVE_THREE) return '活三';
  return null;
}

/**
 * 取得某局面下某一方的候选点（附带棋形与威胁标签）
 */
function scanCandidates(board, color, limit, forbidOn) {
  const list = getCandidateMoves(board, color, limit, forbidOn && color === BLACK);
  return list.map(c => ({
    r: c.r,
    c: c.c,
    notation: c.notation,
    score: c.score,
    shapes: shapesIfPlaced(board, c.r, c.c, color),
    threat: threatLabel(c.score)
  }));
}

/* ==========================================================================
   一、单手棋质量分析
   ========================================================================== */

/**
 * 分析第 index 手（0 起始）落子的质量
 * @param {Array} moves 完整棋谱
 * @param {number} index 待评价的落子下标
 * @param {Object} opts { checkBlackForbidden:boolean, project:boolean }
 */
export function analyzeMove(moves, index, opts = {}) {
  const forbidOn = opts.checkBlackForbidden !== false;
  const mv = moves && moves[index];
  if (!mv || !inBoard(mv.r, mv.c)) return null;

  const color = mv.color === WHITE ? WHITE : BLACK;
  const opp = other(color);
  const board = buildBoardFromMoves(moves, index); // 本手落下【之前】的局面
  const notes = [];

  // 1. 本手落子前：该点的综合价值 + 己方最佳候选
  const myScore = evaluatePoint(board, mv.r, mv.c, color, forbidOn && color === BLACK);
  const rawCandidates = getCandidateMoves(board, color, 10, forbidOn && color === BLACK);
  const best = rawCandidates.length ? rawCandidates[0] : null;
  const isBestPoint = !!(best && best.r === mv.r && best.c === mv.c);
  const myShapes = shapesIfPlaced(board, mv.r, mv.c, color);
  const bestShapes = best ? shapesIfPlaced(board, best.r, best.c, color) : [];

  // 2. 禁手判定（仅黑棋且开启规则时）
  const forbidden = (color === BLACK && forbidOn)
    ? checkForbidden(board, mv.r, mv.c, { checkDoubleThree: true, checkDoubleFour: false, checkOverline: true })
    : { isForbidden: false };

  // 3. 本手的防守分量：若让对方抢到此点，对方能成什么
  const oppScoreHere = evaluatePoint(board, mv.r, mv.c, opp, forbidOn && opp === BLACK);
  const oppShapesHere = shapesIfPlaced(board, mv.r, mv.c, opp);

  // 4. 本手落下【之后】：是否连五、对方最佳回应
  board[mv.r][mv.c] = color;
  const winRes = checkWin(board, mv.r, mv.c, color);
  const oppReplyAll = scanCandidates(board, opp, 6, forbidOn);
  const oppReply = oppReplyAll.length ? oppReplyAll[0] : null;
  const oppWinReply = oppReplyAll.find(c => c.score >= SCORES.WIN * 2) || null;
  const oppBigReply = oppReplyAll.find(c => c.score >= SCORES.RUSH_FOUR) || null;
  const afterShapes = winRes.win ? [] : describePoint(board, mv.r, mv.c, color);
  const myWinNext = winRes.win ? null : scanCandidates(board, color, 6, forbidOn).find(c => c.score >= SCORES.WIN * 2) || null;
  board[mv.r][mv.c] = EMPTY;

  // 5. 落子前是否存在「不走就输」的必堵点 / 「不走就赢」的杀点
  const iCouldWin = best && best.score >= SCORES.WIN * 2 ? best : null;
  const mustBlock = best && best.score >= SCORES.WIN * 1.5 && best.score < SCORES.WIN * 2 ? best : null;

  // 6. 定级
  let grade, gradeLabel, tone;
  if (forbidden.isForbidden) {
    grade = 'forbidden'; gradeLabel = '禁手违规'; tone = 'bad';
    notes.push(forbidden.reason || '先手禁手点，规则不允许落子');
  } else if (winRes.win) {
    grade = 'win'; gradeLabel = '一手致胜'; tone = 'best';
    notes.push('五连成线，本手直接终结棋局');
  } else if (iCouldWin && !isBestPoint) {
    grade = 'blunder'; gradeLabel = '错失杀招'; tone = 'bad';
    notes.push(`本可在 ${iCouldWin.notation} 一步连五取胜，却落于 ${notationOf(mv)}`);
  } else if (mustBlock && !isBestPoint) {
    grade = 'blunder'; gradeLabel = '关键漏防'; tone = 'bad';
    notes.push(`${mustBlock.notation} 是对方一步成五的杀点，必须抢占或堵截，本手未处理`);
  } else if (oppWinReply) {
    grade = 'blunder'; gradeLabel = '反送杀机'; tone = 'bad';
    notes.push(`本手落下后，对方下一手在 ${oppWinReply.notation} 即可连五取胜`);
  } else if (isBestPoint) {
    grade = 'best'; gradeLabel = '引擎首选'; tone = 'best';
  } else if (myScore >= SCORES.LIVE_FOUR * 1.8) {
    grade = 'great'; gradeLabel = '强手'; tone = 'good';
  } else if (oppScoreHere >= SCORES.WIN * 1.5) {
    grade = 'defend'; gradeLabel = '救命防守'; tone = 'good';
  } else if (myScore >= SCORES.RUSH_FOUR) {
    grade = 'good'; gradeLabel = '好手'; tone = 'good';
  } else if (best && myScore >= best.score * 0.85) {
    grade = 'solid'; gradeLabel = '稳健'; tone = 'good';
  } else if (!best || myScore >= best.score * 0.45) {
    grade = 'slow'; gradeLabel = '缓手'; tone = 'warn';
  } else {
    grade = 'dubious'; gradeLabel = '疑问手'; tone = 'warn';
  }

  // 7. 补充解说要点
  if (grade !== 'forbidden') {
    notes.push(`本手形成：${myShapes.length ? myShapes.join('、') : '孤子（未构成有效棋形）'}`);
  }
  if (oppScoreHere >= SCORES.WIN * 1.5) {
    notes.unshift(`本手堵住了对方 ${mv.notation || notationOf(mv)} 一步连五的杀点，属关键防守`);
  } else if (oppScoreHere >= SCORES.LIVE_THREE) {
    notes.push(`顺带封堵对方该点的「${oppShapesHere.join('、') || shapeName(oppScoreHere)}」潜力（防守评分 +${Math.round(oppScoreHere)}）`);
  }
  if (best && !isBestPoint && grade !== 'win' && grade !== 'forbidden') {
    notes.push(
      `引擎更推荐 ${best.notation}${bestShapes.length ? `（${bestShapes.join('、')}）` : ''}，` +
      `评分 ${Math.round(best.score)}，本手 ${Math.round(myScore)}`
    );
  }
  if (myWinNext) {
    notes.push(`落子后我方已埋伏笔：下一手 ${myWinNext.notation} 可连五制胜`);
  } else if (oppBigReply && !oppWinReply) {
    notes.push(`注意：对方下一手最优是 ${oppBigReply.notation}${oppBigReply.threat ? `（${oppBigReply.threat}）` : ''}`);
  }
  if (mv.comment && grade !== 'forbidden') {
    notes.push(`当时棋手自述：「${mv.comment}」`);
  }

  // 8. 更优替代点（剔除本手自身）
  const alternatives = rawCandidates
    .filter(c => !(c.r === mv.r && c.c === mv.c))
    .slice(0, 3)
    .map(c => ({
      notation: c.notation,
      r: c.r,
      c: c.c,
      score: c.score,
      shapes: shapesIfPlaced(board, c.r, c.c, color),
      threat: threatLabel(c.score)
    }));

  // 9. 本手之后的三步推演
  const lines = opts.project === false
    ? []
    : analyzeContinuation(moves, index + 1, { forbidOn, depth: 3, branch: 2, max: 4 });

  const bestScore = best ? best.score : myScore;
  const matchRate = bestScore > 0 ? Math.max(0, Math.min(140, Math.round((myScore / bestScore) * 100))) : 100;

  return {
    kind: 'move',
    index,
    moveNo: index + 1,
    notation: notationOf(mv),
    color,
    grade,
    gradeLabel,
    tone,
    myScore: Math.round(myScore === -Infinity ? 0 : myScore),
    bestScore: Math.round(bestScore),
    matchRate,
    isBestPoint,
    shapes: myShapes,
    notes,
    alternatives,
    lines,
    opponentThreat: oppWinReply
      ? { kind: 'win', notation: oppWinReply.notation }
      : (oppBigReply ? { kind: oppBigReply.threat, notation: oppBigReply.notation } : null),
    thinkSec: (index > 0 && mv.t && moves[index - 1].t) ? Math.max(0, Math.round((mv.t - moves[index - 1].t) / 1000)) : null
  };
}

/* ==========================================================================
   二、当前局面分析
   ========================================================================== */

/**
 * 分析第 count 手落子之后、行棋方该如何进行
 */
export function analyzePosition(moves, count, opts = {}) {
  const forbidOn = opts.checkBlackForbidden !== false;
  const n = Math.max(0, Math.min(count, moves.length));
  const board = buildBoardFromMoves(moves, n);
  const color = opts.color || colorToMoveAt(moves, n);
  const opp = other(color);
  const notes = [];

  const mine = scanCandidates(board, color, 8, forbidOn);
  const theirs = scanCandidates(board, opp, 8, forbidOn);
  const myWinPoint = mine.find(c => c.score >= SCORES.WIN * 2) || null;
  const theirWinPoint = theirs.find(c => c.score >= SCORES.WIN * 2) || null;

  if (mine.length === 0) {
    notes.push('棋盘已无合法空位，本局结束');
  }
  if (myWinPoint) {
    notes.push(`轮${COLOR_NAMES[color]}方：${myWinPoint.notation} 即可连五取胜，本手就是胜负手`);
  } else if (theirWinPoint) {
    notes.push(`危险：轮${COLOR_NAMES[color]}方落子，但 ${theirWinPoint.notation} 是对方一步致胜点，必须立刻抢占或封堵`);
  } else if (theirs[0] && theirs[0].score >= SCORES.RUSH_FOUR) {
    notes.push(`对方最强攻击点是 ${theirs[0].notation}（${theirs[0].threat || '冲四级威胁'}），需优先考虑防守`);
  } else if (mine[0]) {
    notes.push(`双方均无一步制胜点，${mine[0].notation} 是抢占先手效率最高的落点`);
  }
  if (mine[0] && theirs[0] && !myWinPoint && !theirWinPoint) {
    const diff = mine[0].score - theirs[0].score;
    if (diff > SCORES.LIVE_THREE) notes.push('局面主动权在我方手中');
    else if (diff < -SCORES.LIVE_THREE) notes.push('局面主动权在对方手中，宜先稳固防守');
    else notes.push('双方态势接近，属于争夺先手的胶着阶段');
  }

  const lines = opts.project === false
    ? []
    : analyzeContinuation(moves, n, { forbidOn, depth: 3, branch: 2, max: 4 });

  return {
    kind: 'position',
    moveNo: n,
    totalMoves: moves.length,
    toMove: color,
    candidates: mine.slice(0, 5),
    opponentCandidates: theirs.slice(0, 3),
    myWinPoint,
    theirWinPoint,
    notes,
    lines
  };
}

/* ==========================================================================
   三、后续变化推演（下一步 / 下下一步 / 下下下一步）
   ========================================================================== */

/**
 * 局面静态评价：己方最优点与对方最优点分差
 */
function staticEval(board, rootColor, forbidOn) {
  const opp = other(rootColor);
  const mine = getCandidateMoves(board, rootColor, 3, forbidOn && rootColor === BLACK);
  const theirs = getCandidateMoves(board, opp, 3, forbidOn && opp === BLACK);
  const a = mine.length ? mine[0].score : 0;
  const b = theirs.length ? theirs[0].score : 0;
  return a - b;
}

function walkVariation(board, color, depth, branch, line, out, rootColor, forbidOn, deadline) {
  const candidates = getCandidateMoves(board, color, branch * 3, forbidOn && color === BLACK);
  if (!candidates.length) {
    out.push({ moves: line.slice(), score: 0, result: '无合法落点' });
    return;
  }

  for (const cand of candidates.slice(0, branch)) {
    board[cand.r][cand.c] = color;
    const win = checkWin(board, cand.r, cand.c, color);
    const nextLine = line.concat([{ color, notation: cand.notation, r: cand.r, c: cand.c }]);

    if (win.win) {
      out.push({
        moves: nextLine,
        score: (color === rootColor ? 1 : -1) * SCORES.WIN * (10 + depth),
        result: `${COLOR_NAMES[color]}方第 ${nextLine.length} 手连五致胜`
      });
    } else if (depth <= 1 || Date.now() > deadline) {
      out.push({
        moves: nextLine,
        score: staticEval(board, rootColor, forbidOn),
        result: depth <= 1 ? '' : '（已达推演上限）'
      });
    } else {
      walkVariation(board, other(color), depth - 1, branch, nextLine, out, rootColor, forbidOn, deadline);
    }

    board[cand.r][cand.c] = EMPTY;
  }
}

/**
 * 从前 count 手之后开始，双方轮流按最优候选做分支推演
 * @param {Array} moves 棋谱
 * @param {number} count 已应用手数
 * @param {Object} opts { depth:3, branch:2, max:4, color, forbidOn }
 * @returns {Array<{moves:Array, score:number, result:string}>} 按有利程度排序的变化线
 */
export function analyzeContinuation(moves, count, opts = {}) {
  const n = Math.max(0, Math.min(count, moves.length));
  const forbidOn = opts.forbidOn !== false && opts.checkBlackForbidden !== false;
  const board = buildBoardFromMoves(moves, n);
  const rootColor = opts.color || colorToMoveAt(moves, n);
  const depth = opts.depth || 3;
  const branch = opts.branch || 2;
  const out = [];

  const deadline = Date.now() + 900; // 推演时间预算，防止低端设备卡顿
  walkVariation(board, rootColor, depth, branch, [], out, rootColor, forbidOn, deadline);

  // 按「第一手」分组，每组保留对手抵抗最强（对根方最不利）的那条变化；
  // 再按各组保底分从高到低排序 → 每条输出都是不同的第一手选择，且已考虑对手最佳应对
  const groups = new Map();
  for (const line of out) {
    if (!line.moves.length) continue;
    const key = line.moves[0].notation;
    const cur = groups.get(key);
    if (!cur || line.score < cur.score) {
      groups.set(key, line);
    }
  }

  const ranked = [...groups.values()].sort((x, y) => y.score - x.score);
  const max = opts.max || 3;

  return ranked.slice(0, max).map(line => ({
    ...line,
    rootColor,
    firstMove: line.moves[0].notation,
    worstCase: true,
    refScore: Math.round(line.score),
    text: line.moves.map(m => `${COLOR_NAMES[m.color]} ${m.notation}`).join(' → ')
  }));
}

/**
 * 生成一段可直接交给大模型的本地分析摘要（纯文本）
 */
export function formatAnalysisForLLM(result) {
  if (!result) return '（无本地分析结果）';
  const lines = [];
  if (result.kind === 'move') {
    lines.push(`评价对象：第 ${result.moveNo} 手，${COLOR_NAMES[result.color]}方落子 ${result.notation}`);
    lines.push(`本地引擎定级：${result.gradeLabel}（本手评分 ${result.myScore}，引擎最佳评分 ${result.bestScore}，匹配度 ${result.matchRate}%）`);
    lines.push(`本手棋形：${result.shapes.join('、') || '无'}`);
    if (result.alternatives && result.alternatives.length) {
      lines.push(`引擎备选：${result.alternatives.map(a => `${a.notation}(${Math.round(a.score)}${a.shapes.length ? '/' + a.shapes.join('、') : ''})`).join('，')}`);
    }
    (result.notes || []).forEach(n => lines.push(`· ${n}`));
    (result.lines || []).forEach((l, i) => lines.push(`变化${i + 1}：${l.text}${l.result ? `【${l.result}】` : ''}`));
  } else {
    lines.push(`评价对象：第 ${result.moveNo} 手之后，轮到${COLOR_NAMES[result.toMove]}方行棋`);
    if (result.candidates && result.candidates.length) {
      lines.push(`引擎推荐：${result.candidates.slice(0, 3).map(c => `${c.notation}(${Math.round(c.score)}${c.shapes.length ? '/' + c.shapes.join('、') : ''})`).join('，')}`);
    }
    (result.notes || []).forEach(n => lines.push(`· ${n}`));
    (result.lines || []).forEach((l, i) => lines.push(`变化${i + 1}：${l.text}${l.result ? `【${l.result}】` : ''}`));
  }
  return lines.join('\n');
}
