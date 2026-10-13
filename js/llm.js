/**
 * 大模型 API 适配器 (Multi-LLM API Integration)
 * 支持 OpenAI 兼容格式 (DeepSeek, OpenAI, Gemini, 阿里通义千问, Kimi, Ollama, 自定义等)
 */

import { coordToNotation, notationToCoord, getCandidateMoves } from './engine.js';
import { inBoard, EMPTY, BLACK, WHITE } from './rules.js';

export const PROVIDER_PRESETS = {
  deepseek: {
    name: 'DeepSeek (深度求索)',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    docUrl: 'https://platform.deepseek.com'
  },
  gemini: {
    name: 'Google Gemini (OpenAI兼容接口)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    docUrl: 'https://aistudio.google.com'
  },
  openai: {
    name: 'OpenAI (ChatGPT)',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    defaultModel: 'gpt-4o-mini',
    docUrl: 'https://platform.openai.com'
  },
  qwen: {
    name: '阿里通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    defaultModel: 'qwen-plus',
    docUrl: 'https://dashscope.console.aliyun.com'
  },
  moonshot: {
    name: '月之暗面 (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    defaultModel: 'moonshot-v1-8k',
    docUrl: 'https://platform.moonshot.cn'
  },
  custom: {
    name: '自定义 / 本地 Ollama / OneAPI',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3', 'qwen2.5', 'custom-model'],
    defaultModel: 'custom-model',
    docUrl: ''
  }
};

export const AI_PERSONAS = {
  humorous: {
    name: '幽默话痨',
    desc: '风趣幽默，爱吐槽和开玩笑，下棋节奏轻松愉快',
    prompt: '你是一位风趣幽默、爱唠叨吐槽的棋友。每走一步棋都会调侃对手或者为自己的妙手自吹自擂。'
  },
  master: {
    name: '世外高人',
    desc: '高深莫测，谈吐儒雅，富有东方禅意与棋道哲理',
    prompt: '你是一位隐居山林的当代棋圣，谈吐儒雅、蕴含禅意。你视棋局为天地阴阳变化，点评沉稳而有哲理。'
  },
  tsundere: {
    name: '傲娇对手',
    desc: '表面嫌弃嘴硬，内心其实很重视这盘棋',
    prompt: '你是一个傲娇又好胜的天才棋手。嘴上总是不饶人（“哼，这步棋本大人随手就能破”），但对对手的精妙招式会暗暗警惕。'
  },
  analytical: {
    name: '严谨冷静',
    desc: '冷静理智，精密计算，专业解说棋局态势',
    prompt: '你是一个冷静精密的人工智能战术引擎，专注于计算胜率、棋形布局与威胁推演。言简意赅，专业度极高。'
  }
};

/**
 * 格式化棋盘最近走法记录为可读文本
 */
function formatMoveHistory(history) {
  if (!history || history.length === 0) return '尚未落子';
  return history
    .slice(-10) // 取最近 10 手
    .map((item, idx) => `${idx + 1}. ${item.color === 1 ? '黑' : '白'}方落子于 [${item.notation}]`)
    .join('，');
}

/**
 * 构建大模型提示词
 */
function buildPrompt(board, myColor, history, candidates, personaKey = 'humorous') {
  const colorName = myColor === 1 ? '黑棋 (先手)' : '白棋 (后手)';
  const persona = AI_PERSONAS[personaKey] || AI_PERSONAS.humorous;

  const candidateListStr = candidates
    .slice(0, 5)
    .map(c => `${c.notation} (综合威胁评分: ${Math.round(c.score)})`)
    .join(', ');

  const systemPrompt = `${persona.prompt}
你正在与人类棋手在一张 15x15 的五子棋盘上对弈。
你执【${colorName}】。
棋盘坐标说明：横轴 A 到 O (列0到14)，纵轴 1 到 15 (行14到0)。中心天元为 H8。
游戏规则：连成五子即获胜；若执黑先手，则有三三禁手限制。

重要决策要求：
由于纯语言模型对棋盘空间坐标感知有限，本地战术引擎已经为你预先计算了当前最合规且最具威胁的几个候选落子点：
【${candidateListStr}】。
请你仔细权衡，并从中选出一个你认为最佳的坐标（例如 "H8" 或 "G9" 等）。
同时输出一句符合你人设口吻的下棋对话（20~50字以内）。

你必须且仅能以严格的 JSON 格式回复，不要携带任何 Markdown 代码块标记（如 \`\`\`json），格式如下：
{"coord": "H8", "comment": "落子对话内容"}`;

  const userPrompt = `当前对局局势：
- 最近步数回顾：${formatMoveHistory(history)}
- 推荐候选落子点：${candidateListStr}
请综合选择你的落子点，并说一句话。请只输出 JSON 对象：`;

  return { systemPrompt, userPrompt };
}

/**
 * 消费 OpenAI 兼容的 SSE 流式响应
 * 逐块解析 delta.reasoning_content（推理型模型的思考链）与 delta.content（最终答案）
 * @param {Response} response fetch 返回的流式响应
 * @param {{ onIdle?: Function, onDelta?: Function }} handlers
 *   onIdle() 每收到一个数据块调用一次（用于重置空闲超时）
 *   onDelta({ content, reasoning, phase }) 内容有更新时调用；返回 false 表示要求中止
 * @returns {Promise<{ content: string, reasoning: string, cancelled: boolean }>}
 */
export async function consumeChatStream(response, handlers = {}) {
  const { onIdle, onDelta } = handlers;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let cancelled = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (onIdle) onIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 末行可能被截断，留到下一轮再拼

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.indexOf('data:') !== 0) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch (e) {
          continue; // 心跳包或半截数据，直接跳过
        }

        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;

        let changed = false;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          changed = true;
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          changed = true;
        }

        if (changed && onDelta) {
          const keepGoing = onDelta({ content, reasoning, phase: content ? 'answer' : 'reasoning' });
          if (keepGoing === false) {
            cancelled = true;
            break;
          }
        }
      }

      if (cancelled) break;
    }
  } finally {
    if (cancelled) {
      try { await reader.cancel(); } catch (e) { /* 流已关闭，忽略 */ }
    }
  }

  return { content, reasoning, cancelled };
}

/**
 * 调用大模型 API 进行对弈落子（流式 + 双超时）
 * @param {Object} config API 配置 { provider, baseUrl, apiKey, model, persona }
 * @param {number[][]} board 棋盘状态
 * @param {number} myColor AI 棋子颜色
 * @param {Array} history 落子历史
 * @param {Array} candidates 本地引擎预选点
 * @param {Object} [options]
 *   onProgress({ phase, text, contentChars, reasoningChars, elapsedMs }) 流式进度回调，返回 false 可中止
 *   idleTimeoutMs  空闲超时：多久收不到数据算卡死（默认 45000）
 *   totalTimeoutMs 总超时：整轮硬上限（默认 180000）
 * @returns {Promise<{ r: number, c: number, notation: string, comment: string, isFallback: boolean,
 *                     timedOut?: boolean, cancelled?: boolean, elapsedMs: number, reasoning?: string }>}
 */
export async function getLLMMove(config, board, myColor, history, candidates, options = {}) {
  const fallbackMove = candidates[0] || { r: 7, c: 7, notation: 'H8' };
  const startedAt = Date.now();

  if (!config.apiKey || config.apiKey.trim() === '') {
    return {
      ...fallbackMove,
      comment: '（未配置 API Key，已切换为本地智能落子）',
      isFallback: true,
      elapsedMs: 0
    };
  }

  const { systemPrompt, userPrompt } = buildPrompt(board, myColor, history, candidates, config.persona);

  let cleanBaseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBaseUrl) {
    cleanBaseUrl = PROVIDER_PRESETS.deepseek.baseUrl;
  }
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  const modelName = config.model || 'deepseek-chat';
  // 推理型模型的思考链不受 max_tokens 约束，且部分服务商要求 temperature 必须为 1.0
  const isReasoningModel = /reasoner|thinking|qwq|\br1\b|\bo1\b|\bo3\b/i.test(modelName);

  // 双超时：空闲超时（多久收不到数据算卡死）+ 总超时（整轮硬上限）
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 45000;
  const totalTimeoutMs = Number.isFinite(options.totalTimeoutMs) ? options.totalTimeoutMs : 180000;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const controller = new AbortController();
  let abortCause = null; // 'idle' | 'total'
  let idleTimer = null;
  let totalTimer = null;

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    idleTimer = null;
    totalTimer = null;
  };
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortCause = 'idle';
      controller.abort();
    }, idleTimeoutMs);
  };
  const emit = (snapshot) => {
    if (!onProgress) return true;
    return onProgress({ ...snapshot, elapsedMs: Date.now() - startedAt });
  };

  try {
    armIdleTimer();
    totalTimer = setTimeout(() => {
      abortCause = 'total';
      controller.abort();
    }, totalTimeoutMs);

    const requestBody = {
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 250,
      stream: true
    };
    if (!isReasoningModel) {
      requestBody.temperature = 0.7;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('LLM API request failed:', response.status, errText);
      clearTimers();
      return {
        ...fallbackMove,
        comment: `（API 响应异常 ${response.status}，已由本地引擎执棋）`,
        isFallback: true,
        elapsedMs: Date.now() - startedAt
      };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    let content = '';
    let reasoning = '';
    let cancelled = false;

    if (contentType.indexOf('text/event-stream') !== -1 && response.body) {
      const streamed = await consumeChatStream(response, {
        onIdle: armIdleTimer,
        onDelta: (snapshot) => emit({
          phase: snapshot.phase,
          text: snapshot.content || snapshot.reasoning,
          contentChars: snapshot.content.length,
          reasoningChars: snapshot.reasoning.length
        })
      });
      content = streamed.content;
      reasoning = streamed.reasoning;
      cancelled = streamed.cancelled;
    } else {
      // 兜底：服务端忽略了 stream 参数，按一次性 JSON 响应处理
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      content = message.content || '';
      reasoning = message.reasoning_content || '';
      emit({
        phase: 'answer',
        text: content,
        contentChars: content.length,
        reasoningChars: reasoning.length
      });
    }

    clearTimers();
    const elapsedMs = Date.now() - startedAt;

    if (cancelled) {
      return {
        ...fallbackMove,
        comment: '（本局已结束，大模型请求已中止）',
        isFallback: true,
        cancelled: true,
        elapsedMs
      };
    }

    // 解析 JSON（与体检探测共用同一套容错解析）
    const parsed = parseMoveJson(content);

    if (parsed && parsed.coord) {
      const coord = notationToCoord(parsed.coord);
      // 验证坐标有效性及是否已有棋子
      if (coord && inBoard(coord[0], coord[1]) && board[coord[0]][coord[1]] === EMPTY) {
        return {
          r: coord[0],
          c: coord[1],
          notation: parsed.coord.toUpperCase(),
          comment: parsed.comment || '看我这一手！',
          isFallback: false,
          elapsedMs,
          reasoning
        };
      }
    }

    // 若大模型给出的坐标已被占据或非法，优雅使用候选第 1 点，并保留其精彩评论
    return {
      ...fallbackMove,
      comment: parsed?.comment || '（大模型推荐点已被占用，智能校准为最优手）',
      isFallback: false,
      elapsedMs,
      reasoning
    };

  } catch (error) {
    clearTimers();
    const elapsedMs = Date.now() - startedAt;

    if (abortCause === 'idle' || abortCause === 'total') {
      const waitSec = Math.round((abortCause === 'idle' ? idleTimeoutMs : totalTimeoutMs) / 1000);
      return {
        ...fallbackMove,
        comment: `（大模型 ${waitSec} 秒无响应已超时，改由本地引擎落子）`,
        isFallback: true,
        timedOut: true,
        timeoutKind: abortCause,
        elapsedMs
      };
    }

    if (error && error.name === 'AbortError') {
      return {
        ...fallbackMove,
        comment: '（大模型请求已中止）',
        isFallback: true,
        cancelled: true,
        elapsedMs
      };
    }

    console.error('LLM Fetch Error:', error);
    return {
      ...fallbackMove,
      comment: '（网络连接异常，已由本地智能引擎落子）',
      isFallback: true,
      elapsedMs
    };
  }
}

/**
 * 从模型输出中解析落子 JSON（容忍 markdown 包裹与格式瑕疵）
 * @returns {{coord?: string, comment?: string}|null}
 */
function parseMoveJson(content) {
  if (!content) return null;
  try {
    const jsonStr = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.coord) return parsed;
  } catch (e) {
    /* 落到下面的正则兜底 */
  }
  const coordMatch = content.match(/"coord"\s*:\s*"([A-O](?:[1-9]|1[0-5]))"/i);
  if (!coordMatch) return null;
  const commentMatch = content.match(/"comment"\s*:\s*"([^"]+)"/i);
  return {
    coord: coordMatch[1].toUpperCase(),
    comment: commentMatch ? commentMatch[1] : ''
  };
}

/**
 * 统计盘面棋子数
 */
function countStones(board) {
  let total = 0;
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (board[r][c] !== EMPTY) total++;
    }
  }
  return total;
}

/**
 * 内置中盘基准局面：空盘或开局阶段也能做一次有代表性的真实负载探测
 */
function buildProbeBoard() {
  const board = Array.from({ length: 15 }, () => Array(15).fill(EMPTY));
  const stones = [
    ['H8', BLACK], ['I9', WHITE], ['H9', BLACK], ['I8', WHITE],
    ['G9', BLACK], ['G8', WHITE], ['F9', BLACK], ['J8', WHITE]
  ];
  for (const [notation, color] of stones) {
    const coord = notationToCoord(notation);
    if (coord) board[coord[0]][coord[1]] = color;
  }
  return board;
}

/**
 * 按 HTTP 状态码归类错误，给出可操作的提示
 */
function describeHttpError(status, errText) {
  const snippet = String(errText || '').replace(/\s+/g, ' ').slice(0, 100);
  if (status === 401 || status === 403) {
    return { level: 'fail', text: `鉴权失败 [${status}]：API Key 无效、已过期或无该模型权限` };
  }
  if (status === 404) {
    return { level: 'fail', text: `接口或模型不存在 [404]：请核对 Base URL 与模型名称` };
  }
  if (status === 429) {
    return { level: 'fail', text: `触发限流 [429]：请求过于频繁或额度耗尽，稍后重试` };
  }
  if (status === 400) {
    return { level: 'fail', text: `请求被拒 [400]：多为模型名不存在或参数不受支持 —— ${snippet}` };
  }
  if (status >= 500) {
    return { level: 'fail', text: `服务端错误 [${status}]：${snippet}` };
  }
  return { level: 'fail', text: `请求失败 [${status}]：${snippet}` };
}

/**
 * 依据实测数据给出对弈性能结论
 */
function buildVerdict(meta) {
  const totalSec = (meta.totalMs || 0) / 1000;
  if (meta.isReasoningModel && totalSec > 20) {
    return {
      kind: 'reasoning-slow',
      level: 'warn',
      text: `结论：推理型模型，单步实测 ${totalSec.toFixed(1)} 秒，对弈会有明显等待（已有超时保护，45 秒无响应会自动改由本地引擎代下）`
    };
  }
  if (totalSec > 15) {
    return {
      kind: 'slow',
      level: 'warn',
      text: `结论：单步实测 ${totalSec.toFixed(1)} 秒，偏慢，建议改用更快的对话型模型`
    };
  }
  return {
    kind: 'fast',
    level: 'ok',
    text: `结论：预估单步约 ${totalSec.toFixed(1)} 秒，对弈流畅`
  };
}

/**
 * 大模型连接与对弈性能体检
 * 阶段一：极简握手，快速判定网络 / 鉴权 / 模型名
 * 阶段二：复用真实对弈路径（buildPrompt + 流式 + 双超时）实测落子性能
 * @param {Object} config { baseUrl, apiKey, model, persona }
 * @param {Object} [options]
 *   board               探测用棋盘（默认取当前盘面，不足 3 手则用内置基准局面）
 *   onProgress          阶段二进度回调 ({ elapsedMs, chars, phase })
 *   handshakeTimeoutMs  阶段一超时（默认 12000）
 *   idleTimeoutMs       阶段二空闲超时（默认 45000，与对弈一致）
 *   totalTimeoutMs      阶段二总超时（默认 180000，与对弈一致）
 * @returns {Promise<{ success: boolean, message: string, lines: Array<{level:string,text:string}>, meta: Object }>}
 */
export async function testLLMConnection(config, options = {}) {
  const lines = [];
  const meta = {
    model: config.model || 'deepseek-chat',
    handshakeMs: null,
    firstByteMs: null,
    totalMs: null,
    streamSupported: null,
    isReasoningModel: false,
    usedCurrentBoard: false,
    coord: null
  };

  if (!config.apiKey || !config.apiKey.trim()) {
    lines.push({ level: 'fail', text: '尚未填写 API Key' });
    return { success: false, message: '请先填写 API Key', lines, meta };
  }

  let cleanBaseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBaseUrl) cleanBaseUrl = PROVIDER_PRESETS.deepseek.baseUrl;
  const endpoint = `${cleanBaseUrl}/chat/completions`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey.trim()}`
  };

  /* ================= 阶段一：极简握手 ================= */
  const handshakeTimeoutMs = Number.isFinite(options.handshakeTimeoutMs) ? options.handshakeTimeoutMs : 12000;
  const handshakeStart = Date.now();
  let handshakeResponse;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), handshakeTimeoutMs);
    handshakeResponse = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders,
      signal: controller.signal,
      body: JSON.stringify({
        model: meta.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      })
    });
    clearTimeout(timer);
  } catch (err) {
    const isTimeout = !!(err && err.name === 'AbortError');
    lines.push({
      level: 'fail',
      text: isTimeout
        ? `握手超时（${Math.round(handshakeTimeoutMs / 1000)} 秒无响应）：请检查 Base URL 与本机网络`
        : `网络不可达：${(err && err.message) || '跨域限制或无法访问该地址'}`
    });
    return { success: false, message: lines[0].text, lines, meta };
  }

  meta.handshakeMs = Date.now() - handshakeStart;

  if (!handshakeResponse.ok) {
    const errText = await handshakeResponse.text().catch(() => '');
    lines.push(describeHttpError(handshakeResponse.status, errText));
    return { success: false, message: lines[0].text, lines, meta };
  }

  try {
    const data = await handshakeResponse.json();
    const echo = data.choices?.[0]?.message?.content;
    if (echo) meta.modelEcho = String(echo).trim().slice(0, 20);
  } catch (e) {
    /* 少数服务端握手返回体不规范，不阻塞后续探测 */
  }

  lines.push({
    level: 'ok',
    text: `连通正常 · 鉴权通过 · 模型 ${meta.model} 可用（握手 ${meta.handshakeMs}ms）`
  });

  /* ================= 阶段二：真实负载探测 ================= */
  const useCurrentBoard = !!(options.board && countStones(options.board) >= 3);
  const probeBoard = useCurrentBoard ? options.board : buildProbeBoard();
  meta.usedCurrentBoard = useCurrentBoard;

  const candidates = getCandidateMoves(probeBoard, BLACK, 5, false);
  const { systemPrompt, userPrompt } = buildPrompt(probeBoard, BLACK, [], candidates, config.persona);

  lines.push({
    level: 'ok',
    text: `探测棋局：${useCurrentBoard ? '当前盘面' : '内置基准局面'}（候选点 ${candidates.length} 个）`
  });

  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 45000;
  const totalTimeoutMs = Number.isFinite(options.totalTimeoutMs) ? options.totalTimeoutMs : 180000;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const probeStart = Date.now();
  const controller = new AbortController();
  let abortCause = null;
  let idleTimer = null;
  let totalTimer = null;
  let firstByteMs = null;
  let sawStream = false;
  let content = '';
  let reasoning = '';

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    idleTimer = null;
    totalTimer = null;
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortCause = 'idle';
      controller.abort();
    }, idleTimeoutMs);
  };

  try {
    armIdle();
    totalTimer = setTimeout(() => {
      abortCause = 'total';
      controller.abort();
    }, totalTimeoutMs);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders,
      signal: controller.signal,
      body: JSON.stringify({
        model: meta.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 250,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      clearTimers();
      const desc = describeHttpError(response.status, errText);
      lines.push({ level: 'warn', text: `对弈路径请求失败 —— ${desc.text}` });
      return { success: false, message: desc.text, lines, meta };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (contentType.indexOf('text/event-stream') !== -1 && response.body) {
      sawStream = true;
      const streamed = await consumeChatStream(response, {
        onIdle: () => {
          if (firstByteMs === null) firstByteMs = Date.now() - probeStart;
          armIdle();
        },
        onDelta: (snapshot) => {
          if (firstByteMs === null) firstByteMs = Date.now() - probeStart;
          if (onProgress) {
            onProgress({
              elapsedMs: Date.now() - probeStart,
              chars: snapshot.content.length + snapshot.reasoning.length,
              phase: snapshot.phase
            });
          }
          return true;
        }
      });
      content = streamed.content;
      reasoning = streamed.reasoning;
    } else {
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      content = message.content || '';
      reasoning = message.reasoning_content || '';
      firstByteMs = Date.now() - probeStart;
    }

    clearTimers();
  } catch (err) {
    clearTimers();
    if (abortCause === 'idle' || abortCause === 'total') {
      const waitSec = Math.round((abortCause === 'idle' ? idleTimeoutMs : totalTimeoutMs) / 1000);
      lines.push({
        level: 'warn',
        text: `真实落子探测超时（${waitSec} 秒无响应）—— 对弈时同样会触发超时并改由本地引擎代下`
      });
      return { success: false, message: lines[lines.length - 1].text, lines, meta };
    }
    lines.push({ level: 'fail', text: `探测中断：${(err && err.message) || '未知错误'}` });
    return { success: false, message: lines[lines.length - 1].text, lines, meta };
  }

  meta.firstByteMs = firstByteMs;
  meta.totalMs = Date.now() - probeStart;
  meta.streamSupported = sawStream;
  meta.isReasoningModel = reasoning.length > 0;

  lines.push(sawStream
    ? { level: 'ok', text: '流式输出可用（SSE）' }
    : { level: 'warn', text: '服务端未返回 SSE，已自动按非流式解析（对弈仍可用，但看不到思考进度）' });

  if (meta.isReasoningModel) {
    lines.push({
      level: 'warn',
      text: `检测到思维链（${reasoning.length} 字），属推理型模型 —— 简单请求很快，棋局越复杂思考越久`
    });
  }

  const firstByteText = firstByteMs === null ? '—' : `${(firstByteMs / 1000).toFixed(1)}s`;
  lines.push({
    level: 'ok',
    text: `首字节 ${firstByteText} · 完整落子 ${(meta.totalMs / 1000).toFixed(1)}s`
  });

  const parsed = parseMoveJson(content);
  if (parsed && parsed.coord) {
    const coord = notationToCoord(parsed.coord);
    if (coord && inBoard(coord[0], coord[1])) {
      meta.coord = parsed.coord.toUpperCase();
      lines.push({ level: 'ok', text: `返回格式合法，落子建议 ${meta.coord}` });
    } else {
      lines.push({ level: 'warn', text: `模型返回坐标 ${parsed.coord} 越界，对弈时会自动校准为本地候选点` });
    }
  } else {
    lines.push({ level: 'warn', text: '模型未按要求返回 JSON 坐标，对弈时将改由本地引擎候选点兜底' });
  }

  const verdict = buildVerdict(meta);
  meta.verdict = verdict.kind;
  lines.push({ level: verdict.level, text: verdict.text });

  return {
    success: true,
    message: verdict.text,
    lines,
    meta
  };
}

/**
 * 将 15x15 局面渲染为 ASCII 文本（大模型对棋盘坐标感知弱，需文字化棋谱）
 * @param {number[][]} board
 * @param {{r:number,c:number}|null} lastMove 最近一手，用 ★/☆ 突出显示
 */
export function renderBoardAscii(board, lastMove = null) {
  const header = '     A B C D E F G H I J K L M N O';
  const rows = [header];

  for (let r = 0; r < 15; r++) {
    const cells = [];
    for (let c = 0; c < 15; c++) {
      const v = board[r][c];
      const isLast = !!(lastMove && lastMove.r === r && lastMove.c === c);
      if (isLast) {
        cells.push(v === 1 ? '★' : '☆');
      } else {
        cells.push(v === 1 ? '●' : (v === 2 ? '○' : '.'));
      }
    }
    rows.push(`${String(15 - r).padStart(2)}  ${cells.join(' ')}`);
  }

  return ['图例：● = 黑子，○ = 白子，. = 空点，★/☆ = 本次评价焦点的那一手', '']
    .concat(rows)
    .join('\n');
}

/**
 * 大模型深度棋评
 * @param {Object} config { baseUrl, apiKey, model, persona }
 * @param {Object} context
 *   { boardAscii, historyText, focusText, localReport, colorName, ruleText }
 * @returns {Promise<{ok:boolean, text?:string, model?:string, error?:string}>}
 */
export async function requestDeepAnalysis(config, context) {
  if (!config.apiKey || !config.apiKey.trim()) {
    return { ok: false, error: '尚未配置大模型 API Key，请先在「设置」中填写 DeepSeek / Gemini 等密钥' };
  }

  let cleanBaseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBaseUrl) cleanBaseUrl = PROVIDER_PRESETS.deepseek.baseUrl;
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  const systemPrompt = `你是一位职业五子棋（连珠）教练兼棋局分析引擎，负责为业余棋手做逐手复盘。
你会收到：文字棋盘图、棋谱、以及本地战术引擎预先算出的量化结论（评分、棋形、变化推演）。
请以引擎结论为依据作专业解读，不要自行编造坐标；引用坐标时必须使用棋盘图上真实存在的记法（例如 H8、I9）。
${context.ruleText || ''}

输出格式要求（严格遵守）：
- 使用中文纯文本，总字数 180~320 字；
- 分成三到四个小节，每节以方括号标题开头，依次为：【本手定性】、【局势判断】、【后续变化】、【改进建议】；
- 【后续变化】里逐条列出接下来三手（下一步、下下一步、下下下一步）最可能的应对顺序；
- 不要输出 JSON，不要使用 Markdown 代码块标记（如 \`\`\`），不要重复罗列评分数字。`;

  const userPrompt = `【当前棋盘】
${context.boardAscii}

【棋谱（最近若干手）】
${context.historyText}

【本次评价对象】
${context.focusText}

【本地引擎量化结论】
${context.localReport}

请按要求的四个小节输出棋评。`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
        max_tokens: 700
      })
    });

    if (!response.ok) {
      const errText = (await response.text()).slice(0, 160);
      return { ok: false, error: `接口返回 ${response.status}：${errText}` };
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content || '';
    text = text.replace(/```(?:\w+)?/gi, '').replace(/```/g, '').trim();

    if (!text) {
      return { ok: false, error: '模型返回内容为空，请稍后重试或更换模型' };
    }

    return { ok: true, text, model: config.model || 'deepseek-chat' };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '请求超时（30 秒），请稍后重试' : (err.message || '网络错误或跨域受限');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
