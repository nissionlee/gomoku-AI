/**
 * 大模型 API 适配器 (Multi-LLM API Integration)
 * 支持 OpenAI 兼容格式 (DeepSeek, OpenAI, Gemini, 阿里通义千问, Kimi, Ollama, 自定义等)
 */

import { coordToNotation, notationToCoord, getCandidateMoves, describePoint, evaluateDirection, SCORES } from './engine.js';
import { inBoard, EMPTY, BLACK, WHITE, DIRECTIONS, checkForbidden } from './rules.js';

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

export const AI_PLAYSTYLES = {
  openmind: {
    name: '天马行空',
    tag: '🌌 灵动奇谋',
    desc: '视野开阔，灵动善变。善用大局外势、跳二跳三奇袭与多线策应，打破千篇一律的局部死缠。',
    defaultTemperature: 0.8,
    prompt: `【战略棋风偏好：天马行空 / 灵动奇谋】
你追求灵动多变、出其不意的棋风，打破千篇一律的机械套路。
1. 灵动策应：在没有即刻生死威胁时，善于利用跳一步（跳二）、大飞等富有弹性的手段开辟侧翼战线，与远端子力立体呼应，绝不死板硬凑。
2. 严守战术底线：五子棋不同于围棋，严禁去离主战场四五格开外的荒漠空旷角落（如盘角A1、A14等毫无联系的位置）下完全脱节的废子！任何灵动走法必须与已有棋子保持战术接触（相距不超过2格）。
3. 危机清醒：若己方出现连五必胜手，或对手出现冲四/活四/活三致命威胁，必须果断出击或精确封堵！`
  },
  aggressive: {
    name: '狂暴猛攻',
    tag: '⚔️ 侵略如火',
    desc: '极具攻击性，步步紧逼。主动做活二、冲活三、强行做杀，逼迫对手步步受制。',
    defaultTemperature: 0.7,
    prompt: `【战略棋风偏好：狂暴猛攻 / 侵略如火】
你是一位进攻欲望极强的攻击型棋手。
1. 以攻代守：优先寻找能建立连续攻势的点（如主动做活二、跳活三、构建四三杀点），逼迫对手只能被动防守。
2. 争夺先手：敢于对攻抢先手，把控棋局主动权。
3. 发现杀招时绝不留情，一气呵成连续冲杀锁定胜局。`
  },
  defensive: {
    name: '太极坚壁',
    tag: '🛡️ 不动如山',
    desc: '深谋远虑，防守反击。最爱封堵对手眼位、抢占战略关隘、破除潜在杀线，等对手力竭时一击致命。',
    defaultTemperature: 0.5,
    prompt: `【战略棋风偏好：太极坚壁 / 不动如山】
你是一位稳若泰山、善于防守反击的防守大师。
1. 坚壁清野：重点审视对手的棋子走向，敏锐识别其活二、眠三等潜在杀招，提前卡死对手的延展路线与战略要冲。
2. 蓄力待发：落子厚重沉稳，兼顾自身防守与长远阵型蓄力。
3. 待对手攻势耗尽露出破绽，顺势反戈一击，一招制敌。`
  },
  balanced: {
    name: '经典稳健',
    tag: '⚖️ 经典大师',
    desc: '攻守兼备，讲求子力效率与中庸之道，严谨权衡局面。',
    defaultTemperature: 0.6,
    prompt: `【战略棋风偏好：经典稳健 / 攻守兼备】
你遵循正统连珠棋理，讲求效率与中正平和。
1. 攻守平衡，根据盘面动态调整策略，当攻则攻，当防则防。
2. 注重棋子的高效连接与空间控制，步步为营。`
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
 * 数组洗牌工具函数（打乱推荐顺序，消除大模型自上而下选第一项的认知偏差）
 */
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 为大模型生成战术分类候选点（彻底隐藏数值评分，提供战术语义与战略选项）
 * @param {number[][]} board 15x15 盘面
 * @param {number} myColor 当前执棋方 (1:黑, 2:白)
 * @param {boolean} checkBlackForbidden 是否启用黑棋禁手规则
 * @param {string} playstyle 棋风偏好 ('openmind' | 'aggressive' | 'defensive' | 'balanced')
 * @returns {{ urgent: Array, attack: Array, defense: Array, flank: Array, fallback: Object, summaryText: string }}
 */
export function categorizeTacticalMoves(board, myColor, checkBlackForbidden = true, playstyle = 'openmind') {
  const opponentColor = myColor === BLACK ? WHITE : BLACK;
  const stoneCount = countStones(board);

  // 1. 如果棋盘完全为空（黑棋第 1 手开局，打破死板的天元锁定）
  if (stoneCount === 0) {
    let openings = [
      { coord: 'H8', r: 7, c: 7, desc: '天元中宫，传统正统定式，中心控盘力强' },
      { coord: 'H9', r: 6, c: 7, desc: '直指起势，向上纵向蓄力，直指开局之起点' },
      { coord: 'G7', r: 8, c: 6, desc: '斜指起步，对角纵深展开，斜指开局之起点' },
      { coord: 'I8', r: 7, c: 8, desc: '横向直指，向右翼舒展' },
      { coord: 'G9', r: 6, c: 6, desc: '星角奇兵，突破传统中宫定式' },
      { coord: 'F6', r: 9, c: 5, desc: '外围大飞，拉开空间蓄势待发' }
    ];
    if (playstyle === 'openmind') {
      openings = shuffle(openings);
    }
    return {
      urgent: [],
      attack: openings.slice(0, 3),
      defense: [],
      flank: openings.slice(3),
      fallback: openings[0],
      summaryText: openings.map(o => `  • [${o.coord}]：${o.desc}`).join('\n')
    };
  }

  // 2. 如果棋盘只有 1 颗子（白棋第 2 手应对）
  if (stoneCount === 1) {
    let firstR = 7, firstC = 7;
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        if (board[r][c] !== EMPTY) { firstR = r; firstC = c; break; }
      }
    }
    let responses = [
      { r: firstR - 1, c: firstC, desc: '正向直堵，抢占上方要道，遏制对手纵向连线' },
      { r: firstR + 1, c: firstC - 1, desc: '斜向贴防，破坏对手对角延展（斜指定式）' },
      { r: firstR, c: firstC + 1, desc: '横向侧翼阻截，建立右侧屏障' },
      { r: firstR, c: firstC - 1, desc: '左翼贴靠防守，争夺中腹控制权' },
      { r: firstR - 2, c: firstC, desc: '跳一步大局牵制，留出腾挪空间' },
      { r: firstR - 1, c: firstC - 1, desc: '斜向小飞，构筑自身外围势力' },
      { r: firstR + 2, c: firstC + 2, desc: '天马行空外势，避其锋芒，开辟新战场' }
    ].filter(item => inBoard(item.r, item.c) && board[item.r][item.c] === EMPTY)
     .map(item => ({ ...item, coord: coordToNotation(item.r, item.c) }));

    if (playstyle === 'openmind') {
      responses = shuffle(responses);
    }

    return {
      urgent: [],
      attack: responses.slice(0, 2),
      defense: responses.slice(2, 4),
      flank: responses.slice(4),
      fallback: responses[0] || { r: 7, c: 7, coord: 'H8' },
      summaryText: responses.map(o => `  • [${o.coord}]：${o.desc}`).join('\n')
    };
  }

  // 3. 正常盘面评估：扫描所有距离棋子 <= 2~3 格的空位
  const evaluatedPoints = [];
  const nearby = Array.from({ length: 15 }, () => Array(15).fill(0));

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (board[r][c] !== EMPTY) {
        for (let dr = -3; dr <= 3; dr++) {
          for (let dc = -3; dc <= 3; dc++) {
            const nr = r + dr, nc = c + dc;
            if (inBoard(nr, nc) && board[nr][nc] === EMPTY) {
              const dist = Math.max(Math.abs(dr), Math.abs(dc));
              if (dist <= 2) {
                nearby[nr][nc] = Math.max(nearby[nr][nc], 2);
              } else if (dist === 3 && nearby[nr][nc] === 0) {
                nearby[nr][nc] = 1;
              }
            }
          }
        }
      }
    }
  }

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (nearby[r][c] > 0 && board[r][c] === EMPTY) {
        if (myColor === BLACK && checkBlackForbidden) {
          const forbidden = checkForbidden(board, r, c);
          if (forbidden.isForbidden) continue;
        }

        board[r][c] = myColor;
        let attackScore = 0;
        for (const [dr, dc] of DIRECTIONS) {
          attackScore += evaluateDirection(board, r, c, dr, dc, myColor);
        }
        const myShapes = describePoint(board, r, c, myColor);
        board[r][c] = EMPTY;

        board[r][c] = opponentColor;
        let defenseScore = 0;
        for (const [dr, dc] of DIRECTIONS) {
          defenseScore += evaluateDirection(board, r, c, dr, dc, opponentColor);
        }
        const oppShapes = describePoint(board, r, c, opponentColor);
        board[r][c] = EMPTY;

        const distCenter = Math.abs(r - 7) + Math.abs(c - 7);
        const positionScore = 14 - distCenter;
        const totalScore = attackScore * 1.1 + defenseScore * 1.0 + positionScore;

        evaluatedPoints.push({
          r,
          c,
          coord: coordToNotation(r, c),
          isCore: nearby[r][c] === 2,
          attackScore,
          defenseScore,
          totalScore,
          myShapes,
          oppShapes
        });
      }
    }
  }

  if (evaluatedPoints.length === 0) {
    const def = { r: 7, c: 7, coord: 'H8', totalScore: 0 };
    return { urgent: [], attack: [], defense: [], flank: [], fallback: def, summaryText: '  • [H8]：中宫落子' };
  }

  // 紧急情况处理（连五绝杀 或 封堵致命冲四/活四/双重杀）
  const urgent = [];
  for (const pt of evaluatedPoints) {
    if (pt.attackScore >= SCORES.WIN) {
      urgent.push({ ...pt, desc: '🚨 己方连五绝杀！落子此点即刻锁定胜局！' });
    } else if (pt.defenseScore >= SCORES.WIN) {
      urgent.push({ ...pt, desc: '🚨 敌方即将连五获胜！必须在此封堵阻击！' });
    } else if (pt.attackScore >= SCORES.LIVE_FOUR) {
      urgent.push({ ...pt, desc: '⚡ 己方成活四！两头通绝杀，必胜之机！' });
    } else if (pt.defenseScore >= SCORES.LIVE_FOUR) {
      urgent.push({ ...pt, desc: '⚠️ 敌方活四成型在即（已有活三）！必须紧急堵截！' });
    } else if (pt.defenseScore >= SCORES.LIVE_THREE * 1.8) {
      urgent.push({ ...pt, desc: '⚠️ 敌方双重杀线（双三/四三）在即！必须抢先阻断！' });
    }
  }

  // 进攻候选池
  const attackList = evaluatedPoints
    .filter(p => p.attackScore > 0 && !urgent.some(u => u.coord === p.coord))
    .sort((a, b) => b.attackScore - a.attackScore)
    .slice(0, 4)
    .map(p => {
      const shapeStr = p.myShapes.slice(0, 2).join('、') || '展开连子攻势';
      return {
        ...p,
        desc: `进攻突破，形成【${shapeStr}】，主动施压寻求做杀`
      };
    });

  // 防守候选池
  const defenseList = evaluatedPoints
    .filter(p => p.defenseScore > 0 && !urgent.some(u => u.coord === p.coord) && !attackList.some(a => a.coord === p.coord))
    .sort((a, b) => b.defenseScore - a.defenseScore)
    .slice(0, 4)
    .map(p => {
      const oppShapeStr = p.oppShapes.slice(0, 2).join('、') || '潜在连线';
      return {
        ...p,
        desc: `关键防守，封阻敌方【${oppShapeStr}】，抢占要冲化解危机`
      };
    });

  // 外势与大局策应池（偏外围、具有广阔施展空间的点）
  const flankList = evaluatedPoints
    .filter(p => !urgent.some(u => u.coord === p.coord) && !attackList.some(a => a.coord === p.coord) && !defenseList.some(d => d.coord === p.coord))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 3)
    .map(p => ({
      ...p,
      desc: '大局外势，避开狭小缠斗，在开阔区域开辟新战线、遥相呼应'
    }));

  const sortedOverall = [...evaluatedPoints].sort((a, b) => b.totalScore - a.totalScore);
  const fallback = urgent[0] || sortedOverall[0];

  const sections = [];
  if (urgent.length > 0) {
    sections.push('【🚨 紧急胜负手（生死攸关，强烈建议优先处理）】：\n' + urgent.map(u => `  • [${u.coord}]：${u.desc}`).join('\n'));
  }

  let finalAttack = attackList;
  let finalDefense = defenseList;
  let finalFlank = flankList;

  if (playstyle === 'openmind') {
    finalAttack = shuffle(attackList);
    finalDefense = shuffle(defenseList);
    finalFlank = shuffle(flankList);
  }

  const normalSections = [];
  if (finalAttack.length > 0) {
    normalSections.push('【⚔️ 攻势推进选项（以攻代守，主动造势）】：\n' + finalAttack.map(a => `  • [${a.coord}]：${a.desc}`).join('\n'));
  }
  if (finalDefense.length > 0) {
    normalSections.push('【🛡️ 稳健防守选项（坚壁清野，遏制敌方）】：\n' + finalDefense.map(d => `  • [${d.coord}]：${d.desc}`).join('\n'));
  }
  if (finalFlank.length > 0) {
    normalSections.push('【🌌 大局外势 / 奇兵策应（打破僵局，开辟天地）】：\n' + finalFlank.map(f => `  • [${f.coord}]：${f.desc}`).join('\n'));
  }

  if (playstyle === 'openmind') {
    // 随机打乱大局外势、攻势、防守的呈现顺序，彻底打破大模型自上而下选第一项的习惯偏见
    sections.push(...shuffle(normalSections));
  } else if (playstyle === 'defensive') {
    // 防守流：防守栏优先
    const defSec = normalSections.find(s => s.includes('稳健防守'));
    const others = normalSections.filter(s => !s.includes('稳健防守'));
    if (defSec) sections.push(defSec);
    sections.push(...others);
  } else {
    sections.push(...normalSections);
  }

  return {
    urgent,
    attack: attackList,
    defense: defenseList,
    flank: flankList,
    fallback,
    summaryText: sections.join('\n\n')
  };
}

/**
 * 构建大模型提示词（融入 ASCII 棋盘大局视觉、战术语义选项与个性化棋风）
 * @param {number[][]} board 棋盘状态
 * @param {number} myColor AI 棋子颜色 (1:黑, 2:白)
 * @param {Array} history 落子历史
 * @param {Array} [rawCandidates] 兜底候选点
 * @param {Object|string} [configOrPersona] 配置对象或人设 key
 */
export function buildPrompt(board, myColor, history, rawCandidates = [], configOrPersona = 'humorous') {
  const colorName = myColor === 1 ? '黑棋 (先手)' : '白棋 (后手)';

  let personaKey = 'humorous';
  let playstyleKey = 'openmind';
  let checkBlackForbidden = true;

  if (typeof configOrPersona === 'string') {
    personaKey = configOrPersona;
  } else if (configOrPersona && typeof configOrPersona === 'object') {
    personaKey = configOrPersona.persona || 'humorous';
    playstyleKey = configOrPersona.playstyle || 'openmind';
    if (typeof configOrPersona.checkBlackForbidden === 'boolean') {
      checkBlackForbidden = configOrPersona.checkBlackForbidden;
    }
  }

  const persona = AI_PERSONAS[personaKey] || AI_PERSONAS.humorous;
  const playstyle = AI_PLAYSTYLES[playstyleKey] || AI_PLAYSTYLES.openmind;

  const tactical = categorizeTacticalMoves(board, myColor, checkBlackForbidden, playstyleKey);
  const lastMove = history && history.length > 0 ? history[history.length - 1] : null;
  const boardAscii = renderBoardAscii(board, lastMove);

  const hasUrgentThreat = (tactical.urgent || []).length > 0;
  const urgentWarning = hasUrgentThreat
    ? `\n\n【🚨 最高防守铁律·生死攸关警报】
当前盘面检测到致命威胁（敌方已有活三或冲四，或己方有绝杀）！
五子棋绝对规则：一旦敌方形成活三，必须在活三两端紧急封堵！任何大局外势在生死威胁面前均无意义，绝不可在无关空位落子！请务必从上方【🚨 紧急胜负手】中挑选落子！`
    : '';

  const systemPrompt = `${persona.prompt}

${playstyle.prompt}

【对弈背景】
你正在与人类棋手在一张 15x15 的标准五子棋盘上对弈。
你执【${colorName}】。
棋盘坐标规范：横轴 A 到 O (列0到14)，纵轴 1 到 15 (行14到0)。中心天元为 H8。
规则约束：五子连珠即获胜；若你执黑棋先手，严禁下出三三、四四或长连禁手点，否则判负；若执白棋则无任何禁手限制。

【当前 15x15 棋盘全局实况（●=黑棋，○=白棋，.=空位，★/☆=最近一手落子）】
${boardAscii}

【落子决策要求】
1. 观察上方 15x15 真实盘面，理解整体黑白势力分布与空旷区域。
2. 结合你的【战略棋风偏好】权衡决策。优先从上方给出的【⚔️ 攻势】、【🛡️ 稳健防守】或【🌌 大局外势】中挑选最具策略价值的落子。除参考选项外，若自选坐标，必须与盘面已有棋子保持战术接触（相距不超过2格，严禁在脱离战场的空旷角落闲逛落子）；若存在【🚨 紧急胜负手】（敌方活三/冲四），你必须优先封堵生死威胁！${urgentWarning}
3. 请同时输出一句符合你人设口吻的生动对弈交流（20~50字以内）。

【输出格式约束】
你必须且仅能以严格的 JSON 格式回复，不要携带任何 Markdown 代码块标记（如 \`\`\`json），格式如下：
{"coord": "H8", "comment": "你的对弈发言"}`;

  const userPrompt = `当前对局态势：
- 最近步数回顾：${formatMoveHistory(history)}

${tactical.summaryText}${hasUrgentThreat ? '\n\n【⚠️ 紧急提醒】：敌方已有致命杀线（活三/冲四）或己方绝杀！请务必优先选择【🚨 紧急胜负手】中的坐标！' : ''}

请综合评估全局局势，挑选你决定落子的坐标，并说一句符合你性格的对话。请必须且仅输出严格的 JSON 对象（不要写任何解释、不要写前置废话）：
{"coord": "落子坐标", "comment": "对弈发言"}`;

  return { systemPrompt, userPrompt, tactical };
}

/**
 * 规范化 Base URL：去除末尾斜杠，并容错剔除用户不小心复制进来的 /chat/completions
 */
export function normalizeBaseUrl(url, defaultPreset = 'deepseek') {
  let clean = (url || '').trim().replace(/\/+$/, '');
  if (!clean) clean = PROVIDER_PRESETS[defaultPreset]?.baseUrl || PROVIDER_PRESETS.deepseek.baseUrl;
  clean = clean.replace(/\/chat\/completions\/?$/, '');
  return clean;
}

/**
 * 从非流式响应中鲁棒提取 content 与 reasoning（兼容 OpenAI / Anthropic / Gemini / 各种代理网关）
 */
function extractFromNonStream(data) {
  if (!data || typeof data !== 'object') return { content: '', reasoning: '', error: null };

  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
    return { content: '', reasoning: '', error: errMsg };
  }

  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || choice.delta || choice;
  let content =
    (typeof msg.content === 'string' && msg.content) ||
    (typeof msg.text === 'string' && msg.text) ||
    (typeof choice.text === 'string' && choice.text) ||
    (typeof data.response === 'string' && data.response) ||
    (typeof data.text === 'string' && data.text) ||
    '';

  let reasoning =
    (typeof msg.reasoning_content === 'string' && msg.reasoning_content) ||
    (typeof msg.reasoning === 'string' && msg.reasoning) ||
    (typeof msg.thinking === 'string' && msg.thinking) ||
    (typeof msg.thought === 'string' && msg.thought) ||
    '';

  // Anthropic native messages: data.content = [{ type: 'text', text: '...' }]
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text' && typeof block.text === 'string') content += block.text;
      if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    }
  }

  // Gemini native: data.candidates[0].content.parts
  if (data.candidates && data.candidates[0]?.content?.parts) {
    for (const part of data.candidates[0].content.parts) {
      if (typeof part.text === 'string') content += part.text;
      if (typeof part.thought === 'string') reasoning += part.thought;
    }
  }

  if (!content.trim() && reasoning.trim()) {
    content = reasoning;
  }

  return { content, reasoning, error: null };
}

/**
 * 消费 OpenAI 兼容及各类代理的 SSE 流式响应
 * 鲁棒提取 content（兼容 content / text / response 等）与 reasoning（思考链 / thinking）
 * @param {Response} response fetch 返回的流式响应
 * @param {{ onIdle?: Function, onDelta?: Function }} handlers
 *   onIdle() 每收到一个数据块调用一次（用于重置空闲超时）
 *   onDelta({ content, reasoning, phase }) 内容有更新时调用；返回 false 表示要求中止
 * @returns {Promise<{ content: string, reasoning: string, cancelled: boolean, error: string|null, hitLengthLimit: boolean, rawChunkCount: number, samplePayload: string }>}
 */
export async function consumeChatStream(response, handlers = {}) {
  const { onIdle, onDelta } = handlers;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let cancelled = false;
  let lastError = null;
  let hitLengthLimit = false;
  let rawChunkCount = 0;
  let samplePayload = '';

  const processPayload = (payload) => {
    rawChunkCount++;
    if (!samplePayload && payload.length > 0) {
      samplePayload = payload.slice(0, 120);
    }

    let json;
    try {
      json = JSON.parse(payload);
    } catch (e) {
      return; // 心跳包或半截数据，直接跳过
    }

    if (json.error) {
      lastError = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
      return;
    }

    const finishReason = json.choices?.[0]?.finish_reason || json.finish_reason || json.stop_reason;
    if (finishReason === 'length' || finishReason === 'max_tokens') {
      hitLengthLimit = true;
    }

    const choice = (json.choices && json.choices[0]) || {};
    const delta = choice.delta || choice.message || json.delta || json.message || choice || json;

    let chunkContent = '';
    if (typeof delta.content === 'string') {
      chunkContent = delta.content;
    } else if (Array.isArray(delta.content)) {
      for (const p of delta.content) {
        if (p.type === 'text' && typeof p.text === 'string') chunkContent += p.text;
      }
    } else if (typeof delta.text === 'string') {
      chunkContent = delta.text;
    } else if (typeof choice.text === 'string') {
      chunkContent = choice.text;
    } else if (typeof json.response === 'string') {
      chunkContent = json.response;
    } else if (typeof json.text === 'string') {
      chunkContent = json.text;
    } else if (typeof json.content === 'string') {
      chunkContent = json.content;
    } else if (Array.isArray(json.content)) {
      for (const p of json.content) {
        if (p.type === 'text' && typeof p.text === 'string') chunkContent += p.text;
      }
    } else if (json.content_block && typeof json.content_block.text === 'string') {
      chunkContent = json.content_block.text;
    } else if (json.candidates && json.candidates[0]?.content?.parts) {
      for (const p of json.candidates[0].content.parts) {
        if (typeof p.text === 'string') chunkContent += p.text;
      }
    }

    let chunkReasoning = '';
    if (typeof delta.reasoning_content === 'string') {
      chunkReasoning = delta.reasoning_content;
    } else if (typeof delta.reasoning === 'string') {
      chunkReasoning = delta.reasoning;
    } else if (typeof delta.thinking === 'string') {
      chunkReasoning = delta.thinking;
    } else if (typeof delta.thought === 'string') {
      chunkReasoning = delta.thought;
    } else if (json.content_block && typeof json.content_block.thinking === 'string') {
      chunkReasoning = json.content_block.thinking;
    } else if (Array.isArray(delta.content)) {
      for (const p of delta.content) {
        if (p.type === 'thinking' && typeof p.thinking === 'string') chunkReasoning += p.thinking;
      }
    }

    let changed = false;
    if (chunkReasoning) {
      reasoning += chunkReasoning;
      changed = true;
    }
    if (chunkContent) {
      content += chunkContent;
      changed = true;
    }

    if (changed && onDelta) {
      const keepGoing = onDelta({ content, reasoning, phase: content ? 'answer' : 'reasoning' });
      if (keepGoing === false) {
        cancelled = true;
      }
    }
  };

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
        if (!line) continue;

        let payload = '';
        if (line.indexOf('data:') === 0) {
          payload = line.slice(5).trim();
        } else if (line.startsWith('{') && line.endsWith('}')) {
          payload = line;
        }

        if (!payload || payload === '[DONE]') continue;
        processPayload(payload);
        if (cancelled) break;
      }

      if (cancelled) break;
    }

    // 处理末尾残留未加换行的数据
    if (!cancelled && buffer && buffer.trim()) {
      const line = buffer.trim();
      let payload = '';
      if (line.indexOf('data:') === 0) {
        payload = line.slice(5).trim();
      } else if (line.startsWith('{') && line.endsWith('}')) {
        payload = line;
      }
      if (payload && payload !== '[DONE]') {
        processPayload(payload);
      }
    }
  } finally {
    if (cancelled) {
      try { await reader.cancel(); } catch (e) { /* 流已关闭，忽略 */ }
    }
  }

  // 关键兜底：如果 content 为空但 reasoning 有文本（例如纯思考型输出或 Claude thinking），以 reasoning 兜底
  if (!content.trim() && reasoning.trim()) {
    content = reasoning;
  }

  return { content, reasoning, cancelled, error: lastError, hitLengthLimit, rawChunkCount, samplePayload };
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
/**
 * 调用单次大模型 API 进行对弈落子（流式 + 双超时 + 完整棋形安全防御）
 */
async function callSingleLLM(config, board, myColor, promptPack, candidates, options = {}) {
  const startedAt = Date.now();
  const { systemPrompt, userPrompt, tactical } = promptPack;

  const fallbackMove = (tactical && tactical.fallback)
    ? { r: tactical.fallback.r, c: tactical.fallback.c, notation: tactical.fallback.coord }
    : (candidates[0] || { r: 7, c: 7, notation: 'H8' });

  if (!config.apiKey || config.apiKey.trim() === '') {
    return {
      ...fallbackMove,
      comment: '（未配置 API Key，已切换为本地智能落子）',
      isFallback: true,
      elapsedMs: 0
    };
  }

  const cleanBaseUrl = normalizeBaseUrl(config.baseUrl);
  const endpoint = `${cleanBaseUrl}/chat/completions`;

  const modelName = config.model || 'deepseek-chat';
  // 推理型模型的思考链不受 max_tokens 约束，且部分服务商要求 temperature 必须为 1.0
  const isReasoningModel = /reasoner|thinking|qwq|\br1\b|\bo1\b|\bo3\b/i.test(modelName);

  // 双超时：空闲超时（多久收不到数据算卡死）+ 总超时（整轮硬上限）
  const defaultIdleSec = Number(config.timeoutSec) || 90;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : defaultIdleSec * 1000;
  const totalTimeoutMs = Number.isFinite(options.totalTimeoutMs) ? options.totalTimeoutMs : Math.max(180000, idleTimeoutMs * 2);
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
      stream: true
    };
    if (/^o[134](-|$)/i.test(modelName)) {
      requestBody.max_completion_tokens = 2000;
    } else {
      requestBody.max_tokens = 1500;
    }
    if (!isReasoningModel) {
      const playstyle = AI_PLAYSTYLES[config.playstyle] || AI_PLAYSTYLES.openmind;
      const reqTemp = typeof config.temperature === 'number'
        ? config.temperature
        : playstyle.defaultTemperature;
      requestBody.temperature = Math.max(0.1, Math.min(1.2, reqTemp));
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
        comment: `（API 响应异常 ${response.status}）`,
        isFallback: true,
        elapsedMs: Date.now() - startedAt,
        errorStatus: response.status
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
      const extracted = extractFromNonStream(data);
      content = extracted.content;
      reasoning = extracted.reasoning;
      emit({
        phase: 'answer',
        text: content,
        contentChars: content.length,
        reasoningChars: reasoning.length
      });
    }

    // 关键防退化兜底：如果流式响应内容为空且未取消（部分三方中转代理 SSE 存在空包兼容问题），自动发起非流式挽救请求！
    if (!content.trim() && !cancelled) {
      try {
        const nonStreamBody = { ...requestBody, stream: false };
        const nonStreamResp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey.trim()}`
          },
          signal: controller.signal,
          body: JSON.stringify(nonStreamBody)
        });
        if (nonStreamResp.ok) {
          const nonStreamData = await nonStreamResp.json();
          const nonStreamExtracted = extractFromNonStream(nonStreamData);
          if (nonStreamExtracted.content.trim() || nonStreamExtracted.reasoning.trim()) {
            content = nonStreamExtracted.content || nonStreamExtracted.reasoning;
            reasoning = nonStreamExtracted.reasoning;
          }
        }
      } catch (nonStreamErr) {
        // 忽略非流式失败
      }
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
        // 1. 禁手防自杀保护：执黑时若误选禁手点，智能校准为合规好手
        if (myColor === BLACK) {
          const forbidden = checkForbidden(board, coord[0], coord[1]);
          if (forbidden.isForbidden) {
            return {
              ...fallbackMove,
              comment: (parsed.comment ? `${parsed.comment} ` : '') + '（原选点为禁手点，智能校准为合规手）',
              isFallback: false,
              elapsedMs,
              reasoning
            };
          }
        }

        // 2. 绝杀与生死拦截安全兜底 (Safety Guard)
        // A. 己方直接连五绝杀：若 LLM 错失杀机，自动完成致命一击！
        const winMove = tactical?.urgent?.find(u => u.attackScore >= SCORES.WIN);
        if (winMove && (coord[0] !== winMove.r || coord[1] !== winMove.c)) {
          return {
            r: winMove.r,
            c: winMove.c,
            notation: winMove.coord,
            comment: parsed.comment ? `${parsed.comment}（五子连珠，锁定胜局！）` : '五子连珠，锁定胜局！',
            isFallback: false,
            elapsedMs,
            reasoning
          };
        }

        // B. 敌方即将连五绝杀（冲四/成五）：若 LLM 未堵截该致命威胁，紧急封死！
        const blockWinMoves = (tactical?.urgent || []).filter(u => u.defenseScore >= SCORES.WIN);
        if (blockWinMoves.length > 0 && !blockWinMoves.some(b => b.r === coord[0] && b.c === coord[1])) {
          const emergencyBlock = blockWinMoves.sort((a, b) => b.defenseScore - a.defenseScore)[0];
          return {
            r: emergencyBlock.r,
            c: emergencyBlock.c,
            notation: emergencyBlock.coord,
            comment: parsed.comment ? `${parsed.comment}（险！绝杀在即，紧急封死！）` : '险！绝杀在即，紧急封死！',
            isFallback: false,
            elapsedMs,
            reasoning
          };
        }

        // C. 己方有活四杀招（两头通绝杀）：优先进攻绝杀！
        const myLiveFour = tactical?.urgent?.find(u => u.attackScore >= SCORES.LIVE_FOUR);

        // D. 敌方即将成活四（敌方已有活三）或双重杀线（双活三/四三杀）：
        // 五子棋铁律：一旦敌方下出活四两头通，下回合必死无疑，神仙难救！
        // 若己方没有成五或成活四的绝杀，必须强制堵截活三！
        const blockThreatMoves = (tactical?.urgent || []).filter(u => u.defenseScore >= SCORES.LIVE_FOUR || u.defenseScore >= SCORES.LIVE_THREE * 1.8);
        if (blockThreatMoves.length > 0) {
          const llmMoveIsBlock = blockThreatMoves.some(b => b.r === coord[0] && b.c === coord[1]);
          const llmMoveIsAttackWin = myLiveFour && (myLiveFour.r === coord[0] && myLiveFour.c === coord[1]);
          if (!llmMoveIsBlock && !llmMoveIsAttackWin) {
            // LLM 选了一个无关痛痒的点（例如脱离战场的奇兵），强制紧急阻截！
            const emergencyBlock = blockThreatMoves.sort((a, b) => b.defenseScore - a.defenseScore || b.totalScore - a.totalScore)[0];
            return {
              r: emergencyBlock.r,
              c: emergencyBlock.c,
              notation: emergencyBlock.coord,
              comment: parsed.comment
                ? `${parsed.comment}（警惕！敌方活三已成，若不堵截必成活四绝杀！紧急拦截在 [${emergencyBlock.coord}]）`
                : `警惕！敌方活三已成，紧急拦截在 [${emergencyBlock.coord}]！`,
              isFallback: false,
              elapsedMs,
              reasoning
            };
          }
        }

        // E. 拒斥脱离战场的荒漠“太空步”（防大模型误将五子棋当围棋占角）：
        // 五子棋任何落子必须与已有棋子保持战术接触（切比雪夫距离 <= 2，即跳一步或相邻）。
        // 若大模型在离主战场 >= 3 格的无人空旷角落落子（如 A14），自动拦截并校准！
        const totalStones = countStones(board);
        if (totalStones >= 2) {
          const minDist = minDistanceToExistingStones(board, coord[0], coord[1]);
          if (minDist > 2) {
            const tacticalBest = (tactical?.flank && tactical.flank[0]) || (tactical?.attack && tactical.attack[0]) || fallbackMove;
            return {
              r: tacticalBest.r,
              c: tacticalBest.c,
              notation: tacticalBest.coord,
              comment: (parsed.comment ? `${parsed.comment} ` : '') +
                `（原选点 [${parsed.coord.toUpperCase()}] 距离主战场脱节 ${minDist} 格无战术联系，自动校准至有效要点 [${tacticalBest.coord}]）`,
              isFallback: false,
              elapsedMs,
              reasoning
            };
          }
        }

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
        comment: `（大模型 ${waitSec} 秒无响应已超时）`,
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
      comment: '（网络连接异常）',
      isFallback: true,
      elapsedMs
    };
  }
}

/**
 * 调用大模型 API 进行对弈落子（支持单步超时自定义 + 备用大模型故障无缝自动接管）
 * @param {Object} config API 配置 { provider, baseUrl, apiKey, model, persona, timeoutSec, enableBackup, backupModel... }
 * @param {number[][]} board 棋盘状态
 * @param {number} myColor AI 棋子颜色
 * @param {Array} history 落子历史
 * @param {Array} candidates 本地引擎预选点
 * @param {Object} [options]
 *   onProgress({ phase, text, contentChars, reasoningChars, elapsedMs }) 流式进度回调，返回 false 可中止
 *   idleTimeoutMs  空闲超时：多久收不到数据算卡死（未指定时优先读取 config.timeoutSec，默认 90000）
 *   totalTimeoutMs 总超时：整轮硬上限（默认 180000）
 * @returns {Promise<{ r: number, c: number, notation: string, comment: string, isFallback: boolean,
 *                     timedOut?: boolean, cancelled?: boolean, elapsedMs: number, reasoning?: string, usedBackup?: boolean }>}
 */
export async function getLLMMove(config, board, myColor, history, candidates, options = {}) {
  const startedAt = Date.now();

  const promptPack = buildPrompt(board, myColor, history, candidates, {
    persona: config.persona,
    playstyle: config.playstyle || 'openmind',
    checkBlackForbidden: myColor === BLACK
  });
  const { tactical } = promptPack;
  const fallbackMove = (tactical && tactical.fallback)
    ? { r: tactical.fallback.r, c: tactical.fallback.c, notation: tactical.fallback.coord }
    : (candidates[0] || { r: 7, c: 7, notation: 'H8' });

  if (!config.apiKey || config.apiKey.trim() === '') {
    return {
      ...fallbackMove,
      comment: '（未配置 API Key，已切换为本地智能落子）',
      isFallback: true,
      elapsedMs: 0
    };
  }

  const defaultTimeoutSec = Number(config.timeoutSec) || 90;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : defaultTimeoutSec * 1000;

  // 1. 先尝试主模型调用
  let primaryResult = await callSingleLLM(config, board, myColor, promptPack, candidates, {
    ...options,
    idleTimeoutMs
  });

  // 主模型应答成功或玩家已撤销/重开，直接返回
  if (!primaryResult.isFallback || primaryResult.cancelled) {
    return primaryResult;
  }

  const policy = config.failoverPolicy || 'auto_backup';
  let backupConfig = options.backupConfig || config.backupLlmConfig || null;
  if (!backupConfig && config.enableBackup && (config.backupModel || '').trim()) {
    backupConfig = {
      ...config,
      provider: config.backupProvider || config.provider,
      baseUrl: (config.backupBaseUrl && config.backupBaseUrl.trim()) ? config.backupBaseUrl.trim() : config.baseUrl,
      apiKey: (config.backupApiKey && config.backupApiKey.trim()) ? config.backupApiKey.trim() : config.apiKey,
      model: config.backupModel.trim()
    };
  }
  const hasBackup = Boolean(backupConfig && backupConfig.apiKey && backupConfig.apiKey.trim());

  const failReason = primaryResult.timedOut
    ? `超时（已等待 ${Math.round(primaryResult.elapsedMs / 1000)}s）`
    : (primaryResult.comment || '连接异常');

  // 2. 策略为「弹窗询问我」时的处理
  if (policy === 'ask_player' && typeof options.onRequestPlayerAction === 'function') {
    const action = await options.onRequestPlayerAction({
      stage: 'primary_failed',
      primaryResult,
      hasBackup,
      backupModel: backupConfig?.model,
      failReason
    });

    if (action === 'retry') {
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: 'reasoning',
          text: `继续等待中，正在重新请求主模型 [${config.model || '主模型'}]（增加 60 秒等待时间）…`,
          contentChars: 0,
          reasoningChars: 0,
          elapsedMs: Date.now() - startedAt
        });
      }
      const retryResult = await callSingleLLM(config, board, myColor, promptPack, candidates, {
        ...options,
        idleTimeoutMs: idleTimeoutMs + 60000,
        totalTimeoutMs: (options.totalTimeoutMs || 180000) + 60000
      });
      if (!retryResult.isFallback || retryResult.cancelled) {
        return retryResult;
      }
      primaryResult = retryResult;
    } else if (action === 'backup' && backupConfig) {
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: 'reasoning',
          text: `正在改用备用大模型 [${backupConfig.model}] 计算落子…`,
          contentChars: 0,
          reasoningChars: 0,
          elapsedMs: Date.now() - startedAt
        });
      }
      const backupResult = await callSingleLLM(backupConfig, board, myColor, promptPack, candidates, {
        ...options,
        idleTimeoutMs
      });
      if (!backupResult.isFallback) {
        return {
          ...backupResult,
          usedBackup: true,
          comment: (backupResult.comment ? `${backupResult.comment} ` : '') + `（已切换备用大模型 [${backupConfig.model}] 接管落子）`
        };
      }
      return backupResult;
    } else if (action === 'local') {
      return {
        ...primaryResult,
        comment: '（大模型响应异常，已由本地引擎代下）'
      };
    }
  }

  // 3. 策略为「自动切备用模型」且已配置备用模型
  if (policy !== 'auto_local' && hasBackup && backupConfig) {
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        phase: 'reasoning',
        text: `主模型 [${config.model || '主模型'}] ${failReason}，正在自动无缝唤醒备用大模型 [${backupConfig.model}] 接管对弈…`,
        contentChars: 0,
        reasoningChars: 0,
        elapsedMs: Date.now() - startedAt
      });
    }

    const backupResult = await callSingleLLM(backupConfig, board, myColor, promptPack, candidates, {
      ...options,
      idleTimeoutMs
    });

    if (!backupResult.isFallback) {
      return {
        ...backupResult,
        usedBackup: true,
        comment: (backupResult.comment ? `${backupResult.comment} ` : '') + `（主模型 ${failReason}，已由备用大模型 [${backupConfig.model}] 接管落子）`
      };
    }

    // 备用模型也失败了，如果提供了弹窗回调，询问玩家要不要再等等或切本地
    if (typeof options.onRequestPlayerAction === 'function') {
      const action = await options.onRequestPlayerAction({
        stage: 'all_failed',
        primaryResult,
        backupResult,
        hasBackup: true,
        backupModel: backupConfig.model,
        failReason: `主备模型均未响应（主模型 ${failReason}，备用模型也超时/异常）`
      });
      if (action === 'retry') {
        const retryResult = await callSingleLLM(config, board, myColor, promptPack, candidates, {
          ...options,
          idleTimeoutMs: idleTimeoutMs + 60000
        });
        if (!retryResult.isFallback) return retryResult;
      }
    }

    return {
      ...backupResult,
      primaryTimedOut: primaryResult.timedOut,
      backupTimedOut: backupResult.timedOut,
      hasBackup: true,
      backupModel: backupConfig.model,
      comment: `（主模型与备用模型均未能正常应答：主模型 ${failReason}，备用模型也无响应）`
    };
  }

  // 4. 未启用备用模型但主模型异常：若非 auto_local 则询问玩家是否继续等待或由本地代下
  if (policy !== 'auto_local' && typeof options.onRequestPlayerAction === 'function') {
    const action = await options.onRequestPlayerAction({
      stage: 'primary_failed_no_backup',
      primaryResult,
      hasBackup: false,
      failReason
    });
    if (action === 'retry') {
      const retryResult = await callSingleLLM(config, board, myColor, promptPack, candidates, {
        ...options,
        idleTimeoutMs: idleTimeoutMs + 60000
      });
      if (!retryResult.isFallback) return retryResult;
    }
  }

  return {
    ...primaryResult,
    hasBackup: false,
    timeoutSec: defaultTimeoutSec
  };
}

/**
 * 超强容错落子解析器：支持严格 JSON、单引号 JSON、含前导/后置文字、键名变体(move/position)及自然语言提取
 * @param {string} content 模型原始响应文本
 * @returns {{coord?: string, comment?: string}|null}
 */
export function parseMoveJson(content) {
  if (!content || typeof content !== 'string') return null;

  const raw = content.trim();

  // 1. 尝试直接解析 JSON 或提取最外层 {...}
  const jsonBlockMatches = raw.match(/\{[\s\S]*?\}/g);
  if (jsonBlockMatches) {
    for (const block of jsonBlockMatches) {
      try {
        const cleaned = block.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
        const obj = JSON.parse(cleaned);
        const c = obj.coord || obj.coordinate || obj.move || obj.position || obj.point || obj.location || obj.pos || obj.target || obj.cell;
        if (c && typeof c === 'string') {
          const match = c.trim().match(/^([A-O](?:[1-9]|1[0-5]))$/i);
          if (match) {
            const comment = obj.comment || obj.thought || obj.message || obj.say || obj.reason || obj.desc || obj.text || '';
            return { coord: match[1].toUpperCase(), comment: String(comment).trim() };
          }
        }
      } catch (e) {
        // 单引号替换修复
        try {
          const singleFixed = block.replace(/'/g, '"').replace(/,\s*\}/g, '}');
          const obj = JSON.parse(singleFixed);
          const c = obj.coord || obj.coordinate || obj.move || obj.position || obj.point;
          if (c && typeof c === 'string') {
            const match = c.trim().match(/^([A-O](?:[1-9]|1[0-5]))$/i);
            if (match) {
              const comment = obj.comment || obj.thought || obj.message || '';
              return { coord: match[1].toUpperCase(), comment: String(comment).trim() };
            }
          }
        } catch (e2) {}
      }
    }
  }

  // 2. 正则宽容提取键值对: coord/move/position = H8
  const kvMatch = raw.match(/(?:coord|coordinate|move|position|point|location|pos|target)\s*["']?\s*[:=]\s*["']?\s*([A-O](?:[1-9]|1[0-5]))\b/i);
  if (kvMatch) {
    const commentMatch = raw.match(/(?:comment|thought|message|say|reason|desc)\s*["']?\s*[:=]\s*["']?([^"'\r\n]+)/i);
    return {
      coord: kvMatch[1].toUpperCase(),
      comment: commentMatch ? commentMatch[1].trim() : ''
    };
  }

  // 3. 自然语言提取：如「我选择在 H8 落子」、「落子坐标为 [G7]」、「I choose H8」
  const nlMatch = raw.match(/(?:落子|走|下在|选择|坐标|位置|走子|move|play|coord|at|place)\s*(?:为|在|是|：|:)?\s*\[?\s*([A-O](?:[1-9]|1[0-5]))\b/i);
  if (nlMatch) {
    const cleanedText = raw.replace(nlMatch[0], '').replace(/[\[\]{}"]/g, '').trim().slice(0, 60);
    return {
      coord: nlMatch[1].toUpperCase(),
      comment: cleanedText || '看我这一手！'
    };
  }

  // 4. 全文兜底扫描合法五子棋坐标 (如 [H8]、**H8**、H8)
  const anyCoordMatch = raw.match(/(?:\[|\*\*|【)?([A-O](?:[1-9]|1[0-5]))(?:\b|\]|\*\*|】)/i);
  if (anyCoordMatch) {
    return {
      coord: anyCoordMatch[1].toUpperCase(),
      comment: raw.replace(anyCoordMatch[0], '').trim().slice(0, 60) || '落子无悔，请！'
    };
  }

  return null;
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
 * 计算落子点到盘面上任意已有棋子的最小切比雪夫距离 (Chebyshev distance)
 * 0: 重合已有棋子，1: 紧挨相邻，2: 跳一步/大飞（有效战术策应），>=3: 与主战场脱节的荒漠废子
 */
export function minDistanceToExistingStones(board, r, c) {
  let minDist = Infinity;
  for (let br = 0; br < 15; br++) {
    for (let bc = 0; bc < 15; bc++) {
      if (board[br][bc] !== EMPTY) {
        const dist = Math.max(Math.abs(br - r), Math.abs(bc - c));
        if (dist < minDist) {
          minDist = dist;
          if (minDist <= 1) return minDist;
        }
      }
    }
  }
  return minDist;
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

  const cleanBaseUrl = normalizeBaseUrl(config.baseUrl);
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
    const handshakeBody = {
      model: meta.model,
      messages: [{ role: 'user', content: 'ping' }]
    };
    if (/^o[134](-|$)/i.test(meta.model)) {
      handshakeBody.max_completion_tokens = 50;
    } else {
      handshakeBody.max_tokens = 50;
    }
    handshakeResponse = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders,
      signal: controller.signal,
      body: JSON.stringify(handshakeBody)
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
  const { systemPrompt, userPrompt } = buildPrompt(probeBoard, BLACK, [], candidates, config);

  lines.push({
    level: 'ok',
    text: `探测棋局：${useCurrentBoard ? '当前盘面' : '内置基准局面'}（候选点 ${candidates.length} 个）`
  });

  const defaultIdleSec = Number(config.timeoutSec) || 90;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : defaultIdleSec * 1000;
  const totalTimeoutMs = Number.isFinite(options.totalTimeoutMs) ? options.totalTimeoutMs : Math.max(180000, idleTimeoutMs * 2);
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
  let streamResult = null;

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

    const probeBody = {
      model: meta.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: true
    };
    if (/^o[134](-|$)/i.test(meta.model)) {
      probeBody.max_completion_tokens = 2000;
    } else {
      probeBody.max_tokens = 1500;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders,
      signal: controller.signal,
      body: JSON.stringify(probeBody)
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
      streamResult = await consumeChatStream(response, {
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
      content = streamResult.content;
      reasoning = streamResult.reasoning;
    } else {
      const data = await response.json();
      const extracted = extractFromNonStream(data);
      content = extracted.content;
      reasoning = extracted.reasoning;
      firstByteMs = Date.now() - probeStart;
    }

    // 关键防退化兜底：如果流式响应内容为空（常见于部分第三方代理对 Claude SSE 流式支持不完善），自动发起非流式挽救请求！
    if (!content.trim()) {
      try {
        const retryBody = { ...probeBody, stream: false };
        const retryResp = await fetch(endpoint, {
          method: 'POST',
          headers: authHeaders,
          signal: controller.signal,
          body: JSON.stringify(retryBody)
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          const retryExtracted = extractFromNonStream(retryData);
          if (retryExtracted.content.trim() || retryExtracted.reasoning.trim()) {
            content = retryExtracted.content || retryExtracted.reasoning;
            reasoning = retryExtracted.reasoning;
            lines.push({
              level: 'warn',
              text: '提示：服务端 SSE 流式传输为空（代理通道流式不兼容），已自动无缝切换为非流式通道并成功返回落子！'
            });
          }
        }
      } catch (retryErr) {
        // 忽略非流式重试失败，继续进入详细诊断
      }
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
      lines.push({ level: 'ok', text: `返回格式合法，落子建议 ${meta.coord}${parsed.comment ? `（"${parsed.comment}"）` : ''}` });
    } else {
      lines.push({ level: 'warn', text: `模型返回坐标 ${parsed.coord} 越界，对弈时会自动校准为本地候选点` });
    }
  } else {
    let failReason = '';
    if (streamResult && streamResult.error) {
      failReason = `服务商返回错误：${streamResult.error}`;
    } else if (streamResult && streamResult.hitLengthLimit) {
      failReason = '模型输出因达到 Token 上限被截断（可能是深度推理思考耗尽了配额）';
    } else if (content) {
      const snippet = content.trim().replace(/\s+/g, ' ').slice(0, 40);
      failReason = `模型未按要求返回坐标（原始输出："${snippet}..."）`;
    } else if (streamResult && streamResult.rawChunkCount === 0) {
      failReason = '服务端未推送任何数据即断开连接（请检查模型名称是否正确或接口是否支持该模型）';
    } else if (streamResult && streamResult.samplePayload) {
      failReason = `服务端返回了非标准数据结构（样本："${streamResult.samplePayload.slice(0, 50)}..."）`;
    } else {
      failReason = '模型返回内容为空（请检查该模型是否有可用额度或权限）';
    }
    lines.push({ level: 'warn', text: `${failReason}，对弈时将改由本地引擎候选点兜底` });
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

  const cleanBaseUrl = normalizeBaseUrl(config.baseUrl);
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
    const extracted = extractFromNonStream(data);
    let text = extracted.content || extracted.reasoning || '';
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
