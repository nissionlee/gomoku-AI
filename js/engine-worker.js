/**
 * 职业级搜索 Web Worker (Pro Search Worker)
 *
 * 目的：1.5 秒量级的深度搜索不能放在主线程，否则手机会整页卡住、无法翻看棋谱。
 * 协议：
 *   收：{ id, flat: Int8Array(225), color, options }
 *   发：{ id, ok: true, move: { r, c, notation, score, depth, reason } }
 *       { id, ok: false, error }
 */

import { searchPro, boardFromFlat } from './engine-pro.js';

self.onmessage = (event) => {
  const data = event.data || {};
  const id = data.id;

  try {
    const board = boardFromFlat(data.flat);
    const move = searchPro(board, data.color, data.options || {});
    self.postMessage({
      id,
      ok: true,
      move: {
        r: move.r,
        c: move.c,
        notation: move.notation,
        score: move.score,
        depth: move.depth,
        reason: move.reason,
        elapsedMs: move.elapsedMs || 0
      }
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
