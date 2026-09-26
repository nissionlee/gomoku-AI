/**
 * 大模型 API 适配器 (Multi-LLM API Integration)
 * 支持 OpenAI 兼容格式 (DeepSeek, OpenAI, Gemini, 阿里通义千问, Kimi, Ollama, 自定义等)
 */

import { coordToNotation, notationToCoord } from './engine.js';
import { inBoard, EMPTY } from './rules.js';

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
 * 调用大模型 API 进行对弈落子
 * @param {Object} config API 配置 { provider, baseUrl, apiKey, model, persona }
 * @param {number[][]} board 棋盘状态
 * @param {number} myColor AI 棋子颜色
 * @param {Array} history 落子历史
 * @param {Array} candidates 本地引擎预选点
 * @returns {Promise<{ r: number, c: number, notation: string, comment: string, isFallback: boolean }>}
 */
export async function getLLMMove(config, board, myColor, history, candidates) {
  const fallbackMove = candidates[0] || { r: 7, c: 7, notation: 'H8' };
  
  if (!config.apiKey || config.apiKey.trim() === '') {
    return {
      ...fallbackMove,
      comment: '（未配置 API Key，已切换为本地智能落子）',
      isFallback: true
    };
  }

  const { systemPrompt, userPrompt } = buildPrompt(board, myColor, history, candidates, config.persona);

  let cleanBaseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBaseUrl) {
    cleanBaseUrl = PROVIDER_PRESETS.deepseek.baseUrl;
  }
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 250
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('LLM API request failed:', response.status, errText);
      return {
        ...fallbackMove,
        comment: `（API 响应异常 ${response.status}，已由本地引擎执棋）`,
        isFallback: true
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // 解析 JSON
    let parsed = null;
    try {
      // 清理可能包含的 markdown 标签
      const jsonStr = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // 正则尝试匹配 coord 和 comment
      const coordMatch = content.match(/"coord"\s*:\s*"([A-O](?:[1-9]|1[0-5]))"/i);
      const commentMatch = content.match(/"comment"\s*:\s*"([^"]+)"/i);
      if (coordMatch) {
        parsed = {
          coord: coordMatch[1].toUpperCase(),
          comment: commentMatch ? commentMatch[1] : '看我这一手！'
        };
      }
    }

    if (parsed && parsed.coord) {
      const coord = notationToCoord(parsed.coord);
      // 验证坐标有效性及是否已有棋子
      if (coord && inBoard(coord[0], coord[1]) && board[coord[0]][coord[1]] === EMPTY) {
        return {
          r: coord[0],
          c: coord[1],
          notation: parsed.coord.toUpperCase(),
          comment: parsed.comment || '看我这一手！',
          isFallback: false
        };
      }
    }

    // 若大模型给出的坐标已被占据或非法，优雅使用候选第 1 点，并保留其精彩评论
    return {
      ...fallbackMove,
      comment: parsed?.comment || '（大模型推荐点已被占用，智能校准为最优手）',
      isFallback: false
    };

  } catch (error) {
    console.error('LLM Fetch Error:', error);
    return {
      ...fallbackMove,
      comment: '（网络连接异常，已由本地智能引擎落子）',
      isFallback: true
    };
  }
}

/**
 * 测试大模型 API 连接状态
 */
export async function testLLMConnection(config) {
  if (!config.apiKey || !config.apiKey.trim()) {
    return { success: false, message: '请先填写 API Key' };
  }

  let cleanBaseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  try {
    const start = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [
          { role: 'user', content: '请回复一个字：好' }
        ],
        max_tokens: 10
      })
    });

    const elapsed = Date.now() - start;

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, message: `连接失败 [${response.status}]: ${errText.slice(0, 120)}` };
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'ok';
    return {
      success: true,
      message: `连接成功！响应耗时 ${elapsed}ms，模型回复：“${reply.trim()}”`
    };
  } catch (err) {
    return { success: false, message: `网络错误：${err.message || '跨域限制或无法访问该地址'}` };
  }
}
