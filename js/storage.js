/**
 * 本地存储管理器 (LocalStorage Manager)
 * 负责保存/读取：胜负战绩统计、历史对局明细、游戏与大模型配置
 */

const STATS_KEY = 'gomoku_stats_v1';
const HISTORY_KEY = 'gomoku_history_v1';
const SETTINGS_KEY = 'gomoku_settings_v1';

const DEFAULT_SETTINGS = {
  aiEngine: 'local',           // 'local' | 'llm'
  difficulty: 'medium',        // 'low' | 'medium' | 'high'
  playerColor: 1,              // 1: 黑棋(先手), 2: 白棋(后手)
  checkDoubleThree: true,      // 开启先手三三禁手
  showForbiddenMarks: true,    // 棋盘上提示禁手点
  soundEnabled: true,          // 音效
  llmConfig: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    persona: 'humorous'
  }
};

const DEFAULT_STATS = {
  total: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  currentStreak: 0,
  maxStreak: 0
};

export class StorageManager {
  /**
   * 读取用户配置
   */
  static getSettings() {
    try {
      const data = localStorage.getItem(SETTINGS_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          llmConfig: {
            ...DEFAULT_SETTINGS.llmConfig,
            ...(parsed.llmConfig || {})
          }
        };
      }
    } catch (e) {
      console.warn('Failed to load settings:', e);
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * 保存用户配置
   */
  static saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  }

  /**
   * 读取战绩统计
   */
  static getStats() {
    try {
      const data = localStorage.getItem(STATS_KEY);
      if (data) {
        return { ...DEFAULT_STATS, ...JSON.parse(data) };
      }
    } catch (e) {
      console.warn('Failed to load stats:', e);
    }
    return { ...DEFAULT_STATS };
  }

  /**
   * 获取历史对局列表 (最近 50 盘)
   */
  static getHistory() {
    try {
      const data = localStorage.getItem(HISTORY_KEY);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.warn('Failed to load history:', e);
    }
    return [];
  }

  /**
   * 记录一局新的胜负结果
   * @param {Object} gameRecord 对局记录对象
   */
  static recordGame(gameRecord) {
    const stats = this.getStats();
    stats.total += 1;

    if (gameRecord.result === 'win') {
      stats.wins += 1;
      stats.currentStreak += 1;
      if (stats.currentStreak > stats.maxStreak) {
        stats.maxStreak = stats.currentStreak;
      }
    } else if (gameRecord.result === 'lose') {
      stats.losses += 1;
      stats.currentStreak = 0;
    } else {
      stats.draws += 1;
    }

    // 保存统计
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {
      console.warn('Failed to save stats:', e);
    }

    // 保存对局详情
    const history = this.getHistory();
    const newEntry = {
      id: Date.now(),
      date: new Date().toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
      result: gameRecord.result, // 'win' | 'lose' | 'draw'
      playerColor: gameRecord.playerColor,
      aiMode: gameRecord.aiMode,
      difficulty: gameRecord.difficulty,
      modelName: gameRecord.modelName,
      turns: gameRecord.turns,
      duration: gameRecord.duration,
      moves: gameRecord.moves || []
    };

    history.unshift(newEntry);
    // 只保留最近 50 局
    if (history.length > 50) {
      history.pop();
    }

    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.warn('Failed to save history:', e);
    }

    return stats;
  }

  /**
   * 清空所有战绩与历史
   */
  static clearHistory() {
    try {
      localStorage.removeItem(STATS_KEY);
      localStorage.removeItem(HISTORY_KEY);
    } catch (e) {
      console.warn('Failed to clear records:', e);
    }
  }
}
