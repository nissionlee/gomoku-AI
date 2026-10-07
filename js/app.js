/**
 * 五子棋主控制器 (Application Main Coordinator)
 * 调度：棋盘交互、游戏主流程、AI落子、禁手判定、悔棋、战绩记录、音效
 */

import { BOARD_SIZE, EMPTY, BLACK, WHITE, checkWin, checkForbidden, isBoardFull } from './rules.js';
import { coordToNotation, getBestMove, getCandidateMoves } from './engine.js';
import {
  COLOR_NAMES,
  buildBoardFromMoves,
  analyzeMove,
  analyzePosition,
  formatAnalysisForLLM
} from './analysis.js';
import { getLLMMove, testLLMConnection, requestDeepAnalysis, renderBoardAscii, PROVIDER_PRESETS, AI_PERSONAS } from './llm.js';
import { sound } from './audio.js';
import { StorageManager } from './storage.js';
import { Goban } from './board.js';

class GomokuApp {
  constructor() {
    this.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
    this.moveHistory = []; // { r, c, color, notation, comment }
    this.turn = BLACK;
    this.gameStatus = 'idle'; // 'idle' | 'playing' | 'ended'
    this.winner = null;
    this.winningLine = null;
    this.startTime = null;
    this.timerInterval = null;
    this.elapsedSeconds = 0;

    // 配置与战绩
    this.settings = StorageManager.getSettings();
    sound.setMuted(!this.settings.soundEnabled);

    // 落子轨迹回放状态（cursor 为「展示前 cursor 手」，1 起始）
    this.replay = {
      active: false,
      cursor: 0,
      moves: null,     // 回放来源棋谱；对局内指向 moveHistory
      external: null,  // 非空 = 正在复盘历史旧局 { id, label, pvp, playerColor }
      playing: false,
      timer: null,
      speed: 900
    };

    // 逐手分析缓存（仅内存态，避免污染 localStorage）
    this.analysisCache = new Map(); // key: 'm#手数' | 'p#手数'
    this.deepCache = new Map();     // key: 同上 → { text, model }
    this.lastAnalysis = null;       // 当前展示的分析 { kind, scopeKey, moveNo, data, deep, deepError, deepLoading }
    this.analyzing = false;
    this.deepAnalyzing = false;
    this.statusShowsReplay = false;

    // DOM 元素
    this.cacheElements();

    // 棋盘 Canvas 实例
    this.goban = new Goban(this.canvasEl, {
      showCoordinates: true,
      showForbiddenMarks: this.settings.showForbiddenMarks
    });
    this.goban.onCellClick = (r, c) => this.handlePlayerClick(r, c);
    this.goban.onCellInspect = (r, c) => this.handleInspectClick(r, c);

    // 绑定 UI 事件
    this.bindEvents();

    // 同步设置到 UI 界面
    this.syncSettingsToUI();
    this.updateStatsBar();

    // 自动开启第一局
    this.startNewGame();
  }

  cacheElements() {
    this.canvasEl = document.getElementById('boardCanvas');
    this.statusTextEl = document.getElementById('statusText');
    this.turnBadgeEl = document.getElementById('turnBadge');
    this.stepCountEl = document.getElementById('stepCount');
    this.timerEl = document.getElementById('gameTimer');
    this.aiSpeechBubbleEl = document.getElementById('aiSpeechBubble');
    this.aiSpeechTextEl = document.getElementById('aiSpeechText');

    // 按钮
    this.btnNewGame = document.getElementById('btnNewGame');
    this.btnUndo = document.getElementById('btnUndo');
    this.btnResign = document.getElementById('btnResign');
    this.btnHint = document.getElementById('btnHint');
    this.btnSettings = document.getElementById('btnSettings');
    this.btnHistory = document.getElementById('btnHistory');
    this.btnRules = document.getElementById('btnRules');
    this.btnSoundToggle = document.getElementById('btnSoundToggle');

    // 工具栏：回放与分析入口
    this.btnReplay = document.getElementById('btnReplay');
    this.btnAnalyze = document.getElementById('btnAnalyze');

    // 落子轨迹面板
    this.replayCard = document.getElementById('replayCard');
    this.replayTitle = document.getElementById('replayTitle');
    this.replayCount = document.getElementById('replayCount');
    this.replayHint = document.getElementById('replayHint');
    this.btnRepFirst = document.getElementById('btnRepFirst');
    this.btnRepPrev = document.getElementById('btnRepPrev');
    this.btnRepPlay = document.getElementById('btnRepPlay');
    this.btnRepNext = document.getElementById('btnRepNext');
    this.btnRepLast = document.getElementById('btnRepLast');
    this.repSpeed = document.getElementById('repSpeed');
    this.repSlider = document.getElementById('repSlider');
    this.moveListContainer = document.getElementById('moveListContainer');
    this.btnRepExit = document.getElementById('btnRepExit');

    // 棋局分析面板
    this.analysisCard = document.getElementById('analysisCard');
    this.analysisScope = document.getElementById('analysisScope');
    this.btnAnalyzeMove = document.getElementById('btnAnalyzeMove');
    this.btnAnalyzeNext = document.getElementById('btnAnalyzeNext');
    this.btnAnalyzeDeep = document.getElementById('btnAnalyzeDeep');
    this.analysisResult = document.getElementById('analysisResult');

    // 难度与引擎快捷选择
    this.difficultySelect = document.getElementById('difficultySelect');
    this.engineSelect = document.getElementById('engineSelect');

    // 弹窗
    this.settingsModal = document.getElementById('settingsModal');
    this.historyModal = document.getElementById('historyModal');
    this.rulesModal = document.getElementById('rulesModal');
    this.winModal = document.getElementById('winModal');
    this.toastEl = document.getElementById('toast');

    // 锁屏认证元素 (专属密码: 362514)
    this.authOverlay = document.getElementById('authOverlay');
    this.authCard = document.getElementById('authCard');
    this.authPinInput = document.getElementById('authPinInput');
    this.authRememberMe = document.getElementById('authRememberMe');
    this.btnUnlockApp = document.getElementById('btnUnlockApp');
    this.authErrorMsg = document.getElementById('authErrorMsg');
    this.btnLockApp = document.getElementById('btnLockApp');
  }

  bindEvents() {
    // 密码认证体系
    this.initAuth();

    // 基础控制
    this.btnNewGame.addEventListener('click', () => this.startNewGame());
    this.btnUndo.addEventListener('click', () => this.handleUndo());
    this.btnResign.addEventListener('click', () => this.handleResign());
    this.btnHint.addEventListener('click', () => this.handleHint());

    // 快捷切换
    this.difficultySelect.addEventListener('change', (e) => {
      this.settings.difficulty = e.target.value;
      StorageManager.saveSettings(this.settings);
      this.showToast(`已切换为：${this.getDifficultyLabel(e.target.value)}`);
    });

    this.engineSelect.addEventListener('change', (e) => {
      this.settings.aiEngine = e.target.value;
      StorageManager.saveSettings(this.settings);
      this.updateEngineBadge();
      const label = e.target.value === 'pvp'
        ? '双人同屏对弈 (人人模式)'
        : (e.target.value === 'llm' ? '大模型对弈模式' : '本地算法模式');
      this.showToast(`已切换为：${label}`);
      this.startNewGame();
    });

    // 静音切换
    this.btnSoundToggle.addEventListener('click', () => {
      const current = sound.isMuted();
      sound.setMuted(!current);
      this.settings.soundEnabled = current;
      StorageManager.saveSettings(this.settings);
      this.updateSoundButton();
    });

    // 弹窗打开与关闭
    this.btnSettings.addEventListener('click', () => this.openSettingsModal());
    this.btnHistory.addEventListener('click', () => this.openHistoryModal());
    this.btnRules.addEventListener('click', () => this.openRulesModal());

    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal-overlay');
        if (modal) modal.classList.remove('active');
      });
    });

    // 设置弹窗内逻辑
    this.initSettingsModalEvents();

    // 落子轨迹回放 + 逐手分析
    this.bindReplayEvents();
    this.bindAnalysisEvents();

    // 战绩清空
    document.getElementById('btnClearHistory')?.addEventListener('click', () => {
      if (confirm('确定要清空所有输赢战绩和历史对局吗？此操作无法恢复。')) {
        StorageManager.clearHistory();
        this.renderHistoryList();
        this.updateStatsBar();
        this.showToast('战绩记录已清空');
      }
    });

    // 赢局弹窗按钮
    document.getElementById('btnWinModalNewGame')?.addEventListener('click', () => {
      this.winModal.classList.remove('active');
      this.startNewGame();
    });
    document.getElementById('btnWinModalViewHistory')?.addEventListener('click', () => {
      this.winModal.classList.remove('active');
      this.openHistoryModal();
    });
  }

  /**
   * 密码认证体系 (专属密码: 362514)
   */
  isUnlocked() {
    const ACCESS_PIN = '362514';
    return localStorage.getItem('gomoku_pin') === ACCESS_PIN ||
           sessionStorage.getItem('gomoku_pin') === ACCESS_PIN;
  }

  initAuth() {
    const ACCESS_PIN = '362514';

    const unlock = () => {
      document.documentElement.classList.add('app-unlocked');
      if (this.authOverlay) this.authOverlay.style.display = 'none';
      if (this.goban) this.goban.setLocked(false);
    };

    const lock = () => {
      localStorage.removeItem('gomoku_pin');
      sessionStorage.removeItem('gomoku_pin');
      document.documentElement.classList.remove('app-unlocked');
      if (this.authOverlay) {
        this.authOverlay.style.display = 'flex';
        if (this.authPinInput) {
          this.authPinInput.value = '';
          this.authPinInput.focus();
        }
        if (this.authErrorMsg) this.authErrorMsg.textContent = '';
      }
      if (this.goban) this.goban.setLocked(true);
    };

    if (this.isUnlocked()) {
      unlock();
    } else {
      document.documentElement.classList.remove('app-unlocked');
      if (this.authOverlay) this.authOverlay.style.display = 'flex';
      if (this.goban) this.goban.setLocked(true);
    }

    const handleAttempt = () => {
      const val = (this.authPinInput?.value || '').trim();
      if (val === ACCESS_PIN) {
        if (this.authRememberMe?.checked) {
          localStorage.setItem('gomoku_pin', ACCESS_PIN);
        } else {
          sessionStorage.setItem('gomoku_pin', ACCESS_PIN);
        }
        unlock();
        this.showToast('✅ 密码正确，欢迎进入对弈！');
      } else {
        if (this.authErrorMsg) this.authErrorMsg.textContent = '密码错误，请重新输入';
        if (this.authCard) {
          this.authCard.classList.remove('shake');
          void this.authCard.offsetWidth; // 触发回流动画
          this.authCard.classList.add('shake');
        }
        this.authPinInput?.select();
      }
    };

    this.btnUnlockApp?.addEventListener('click', handleAttempt);
    this.authPinInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAttempt();
    });

    this.btnLockApp?.addEventListener('click', () => {
      lock();
      this.showToast('🔒 已锁定对弈界面');
    });
  }

  /**
   * 判断是否为双人同屏 (人人对弈) 模式
   */
  isPvP() {
    return this.settings.aiEngine === 'pvp';
  }

  /**
   * 更新侧边栏 AI 卡片与对话人设信息
   */
  updateSideCard() {
    const titleEl = document.getElementById('aiCardTitle');
    const tagEl = document.querySelector('.ai-tag');
    const avatarEl = document.querySelector('.ai-avatar');

    if (this.isPvP()) {
      if (titleEl) titleEl.textContent = '双人对弈';
      if (tagEl) tagEl.textContent = '同屏轮流博弈';
      if (avatarEl) avatarEl.textContent = '👥';
      this.aiSpeechTextEl.textContent = '双人对弈已开启！黑方先行，双方轮流在同一屏幕落子，预祝棋逢对手！';
    } else {
      if (titleEl) titleEl.textContent = 'AI 棋客';
      if (tagEl) tagEl.textContent = '博弈对手';
      if (avatarEl) avatarEl.textContent = '🤖';
      const isLLM = this.settings.aiEngine === 'llm';
      const persona = AI_PERSONAS[this.settings.llmConfig.persona] || AI_PERSONAS.humorous;
      this.aiSpeechTextEl.textContent = isLLM
        ? `【${persona.name}】棋局已开，请阁下落子！`
        : '棋逢对手，请赐教！';
    }
  }

  /**
   * 开始新对局
   */
  startNewGame() {
    this.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
    this.moveHistory = [];
    this.winner = null;
    this.winningLine = null;
    this.gameStatus = 'playing';
    this.turn = BLACK; // 黑方先手

    // 复位回放视图与逐手分析缓存，避免残留上一局的状态
    this.resetReplayState();

    if (this.isPvP()) {
      this.playerColor = BLACK;
      this.aiColor = null;
    } else {
      this.playerColor = Number(this.settings.playerColor) || BLACK;
      this.aiColor = this.playerColor === BLACK ? WHITE : BLACK;
    }

    // 重置计时器
    this.resetTimer();
    this.startTimer();

    // 重置棋盘显示
    this.goban.setBoardState(this.board, null, null, this.calculateForbiddenPoints());
    this.goban.setTurn(this.turn);
    this.goban.setLocked(false);

    // 重置侧边栏卡片与对话
    this.updateSideCard();
    this.updateStatus();

    // 若人机模式且玩家执白(后手)，AI先走第一步
    if (!this.isPvP() && this.playerColor === WHITE) {
      this.triggerAIMove(true);
    }
  }

  /**
   * 玩家点击棋盘
   */
  handlePlayerClick(r, c) {
    if (!this.isUnlocked()) return;
    if (this.gameStatus !== 'playing') return;
    if (this.board[r][c] !== EMPTY) return;

    if (this.isPvP()) {
      // ===== 双人同屏 (人人对弈) =====
      const currentColor = this.turn;

      // 检查先手黑棋禁手（三三 / 四四 / 长连）
      if (currentColor === BLACK && this.isForbiddenRuleOn()) {
        const forbidden = checkForbidden(this.board, r, c, this.forbiddenOptions());

        if (forbidden.isForbidden) {
          sound.playWarning();
          this.showToast(`⚠️ ${forbidden.reason || '先手禁手，此步违规不可落子！'}`);
          return;
        }
      }

      // 成功落子
      this.executeMove(r, c, currentColor);

      // 胜负检测
      if (this.checkGameEnd(r, c, currentColor)) {
        return;
      }

      // 切换到对方回合
      this.turn = currentColor === BLACK ? WHITE : BLACK;
      this.updateStatus();

    } else {
      // ===== 人机对弈模式 =====
      if (this.turn !== this.playerColor) return;

      // 检查先手禁手限制（三三 / 四四 / 长连）
      if (this.playerColor === BLACK && this.isForbiddenRuleOn()) {
        const forbidden = checkForbidden(this.board, r, c, this.forbiddenOptions());

        if (forbidden.isForbidden) {
          sound.playWarning();
          this.showToast(`⚠️ ${forbidden.reason || '先手禁手，此步违规不可落子！'}`);
          return;
        }
      }

      // 玩家成功落子
      this.executeMove(r, c, this.playerColor);

      // 检查胜负
      if (this.checkGameEnd(r, c, this.playerColor)) {
        return;
      }

      // 轮到 AI 落子
      this.turn = this.aiColor;
      this.updateStatus();
      this.triggerAIMove();
    }
  }

  /**
   * 执行落子
   */
  executeMove(r, c, color, comment = '') {
    this.board[r][c] = color;
    const notation = coordToNotation(r, c);
    this.moveHistory.push({ r, c, color, notation, comment, t: Date.now() });

    sound.playPlaceStone();

    this.stepCountEl.textContent = this.moveHistory.length;

    // 刷新落子轨迹面板（不改动回放游标，复盘旧局时也能看到本局最新棋谱）
    this.renderMoveList();
    this.updateReplayUI();

    // 回放/复盘视图下保持当前画面，等退出回放时由 restoreLiveView 重绘
    if (this.replay.active) return;

    // 计算禁手标记
    const forbidden = this.turn === WHITE && this.isForbiddenRuleOn()
      ? this.calculateForbiddenPoints()
      : [];

    this.goban.setBoardState(this.board, { r, c, color }, null, forbidden);
    this.goban.setTurn(color === BLACK ? WHITE : BLACK);
  }

  /**
   * AI 思考并落子
   */
  async triggerAIMove(isFirstMove = false) {
    this.goban.setLocked(true);
    this.statusTextEl.textContent = 'AI 正在精密计算中...';
    this.statusTextEl.classList.add('ai-thinking');

    try {
      let chosenMove;
      let aiComment = '';

      if (isFirstMove) {
        // 第一手默认落天元 H8
        chosenMove = { r: 7, c: 7, notation: 'H8' };
        aiComment = '天元启手，先占中宫！';
      } else if (this.settings.aiEngine === 'llm') {
        // 大模型对弈
        const candidates = getCandidateMoves(this.board, this.aiColor, 5, this.aiColor === BLACK && this.isForbiddenRuleOn());
        const llmResult = await getLLMMove(
          this.settings.llmConfig,
          this.board,
          this.aiColor,
          this.moveHistory,
          candidates
        );
        chosenMove = { r: llmResult.r, c: llmResult.c, notation: llmResult.notation };
        aiComment = llmResult.comment;
      } else {
        // 本地算法引擎
        await new Promise(res => setTimeout(res, 350 + Math.random() * 250)); // 自然拟人停顿
        chosenMove = getBestMove(this.board, this.aiColor, this.settings.difficulty, {
          checkBlackForbidden: this.aiColor === BLACK && this.isForbiddenRuleOn()
        });
        aiComment = this.generateAlgorithmComment(chosenMove.score);
      }

      if (this.gameStatus !== 'playing') return;

      // 更新 AI 气泡对话
      if (aiComment) {
        this.aiSpeechTextEl.textContent = aiComment;
      }

      // 执行 AI 落子
      this.executeMove(chosenMove.r, chosenMove.c, this.aiColor, aiComment);

      // 检查胜负
      if (this.checkGameEnd(chosenMove.r, chosenMove.c, this.aiColor)) {
        return;
      }

      // 轮回玩家
      this.turn = this.playerColor;
      this.goban.setLocked(false);
      this.updateStatus();

    } catch (err) {
      console.error('AI move error:', err);
      this.goban.setLocked(false);
      this.updateStatus();
    } finally {
      this.statusTextEl.classList.remove('ai-thinking');
    }
  }

  /**
   * 检查对局胜负或平局
   */
  checkGameEnd(lastR, lastC, lastColor) {
    const winResult = checkWin(this.board, lastR, lastC, lastColor);

    if (winResult.win) {
      this.gameStatus = 'ended';
      this.winner = lastColor;
      this.winningLine = winResult.winLine;
      this.stopTimer();
      this.goban.setLocked(true);

      if (!this.replay.active) {
        this.goban.setBoardState(this.board, { r: lastR, c: lastC, color: lastColor }, winResult.winLine, []);
      }

      // 双人人人对战模式结算
      if (this.isPvP()) {
        sound.playWin();
        const winnerName = lastColor === BLACK ? '黑方 (先手)' : '白方 (后手)';
        StorageManager.recordGame({
          result: 'win',
          playerColor: '双人对弈',
          aiMode: '双人同屏',
          difficulty: '人人对战',
          modelName: `${winnerName}胜出`,
          turns: this.moveHistory.length,
          duration: this.formatTime(this.elapsedSeconds),
          moves: this.moveHistory
        });

        this.updateStatsBar();

        setTimeout(() => {
          this.showWinModal(true, `【${winnerName}】五子连珠，恭喜获胜！`);
        }, 700);

        return true;
      }

      // 人机对弈模式结算
      const isPlayerWin = this.winner === this.playerColor;

      if (isPlayerWin) {
        sound.playWin();
      } else {
        sound.playLose();
      }

      // 保存对局战绩
      const resultType = isPlayerWin ? 'win' : 'lose';
      StorageManager.recordGame({
        result: resultType,
        playerColor: this.playerColor === BLACK ? '黑棋 (先手)' : '白棋 (后手)',
        aiMode: this.settings.aiEngine === 'llm' ? '大模型' : '本地算法',
        difficulty: this.getDifficultyLabel(this.settings.difficulty),
        modelName: this.settings.aiEngine === 'llm' ? (this.settings.llmConfig.model || 'LLM') : '内置引擎',
        turns: this.moveHistory.length,
        duration: this.formatTime(this.elapsedSeconds),
        moves: this.moveHistory
      });

      this.updateStatsBar();

      // 弹出胜利提示弹窗
      setTimeout(() => {
        this.showWinModal(isPlayerWin);
      }, 700);

      return true;
    }

    if (isBoardFull(this.board)) {
      this.gameStatus = 'ended';
      this.winner = 'draw';
      this.stopTimer();
      this.goban.setLocked(true);

      StorageManager.recordGame({
        result: 'draw',
        playerColor: this.isPvP() ? '双人对弈' : (this.playerColor === BLACK ? '黑棋' : '白棋'),
        aiMode: this.isPvP() ? '双人同屏' : (this.settings.aiEngine === 'llm' ? '大模型' : '本地算法'),
        difficulty: this.isPvP() ? '人人对战' : this.getDifficultyLabel(this.settings.difficulty),
        modelName: this.isPvP() ? '握手言和' : (this.settings.aiEngine === 'llm' ? this.settings.llmConfig.model : '内置引擎'),
        turns: this.moveHistory.length,
        duration: this.formatTime(this.elapsedSeconds),
        moves: this.moveHistory
      });

      this.updateStatsBar();
      this.showToast('棋盘已满，握手言和！');
      return true;
    }

    return false;
  }

  /**
   * 悔棋处理
   */
  handleUndo() {
    if (this.replay.external) {
      this.showToast('正在复盘历史对局，请先点「返回当前对局」再悔棋');
      return;
    }
    if (this.replay.active) {
      this.exitReplay({ silent: true });
    }

    if (this.gameStatus !== 'playing') {
      this.showToast('对局未在进行中');
      return;
    }

    if (this.moveHistory.length === 0) {
      this.showToast('尚未落子，无法悔棋');
      return;
    }

    // 双人模式每次只撤销 1 手（上一位玩家的落子）
    // 人机模式下，若轮到玩家，需同时撤销 AI 和玩家各 1 手 (共2手)
    const stepsToUndo = this.isPvP() ? 1 : (this.turn === this.playerColor ? 2 : 1);

    for (let i = 0; i < stepsToUndo; i++) {
      if (this.moveHistory.length === 0) break;
      const last = this.moveHistory.pop();
      this.board[last.r][last.c] = EMPTY;
      if (this.isPvP()) {
        this.turn = last.color; // 双人模式下，把回合准确还给刚撤销的这方
      }
    }

    sound.playUndo();

    if (!this.isPvP()) {
      this.turn = this.playerColor;
    }

    const previousMove = this.moveHistory[this.moveHistory.length - 1] || null;

    const forbidden = this.turn === BLACK && this.isForbiddenRuleOn()
      ? this.calculateForbiddenPoints()
      : [];

    this.goban.setBoardState(this.board, previousMove, null, forbidden);
    this.goban.setTurn(this.turn);
    this.goban.setLocked(false);

    this.stepCountEl.textContent = this.moveHistory.length;
    this.invalidateLiveAnalysis(this.moveHistory.length);
    this.renderMoveList();
    this.updateReplayUI();
    this.updateStatus();
    this.showToast(this.isPvP()
      ? `已撤销上一步，轮到【${this.turn === BLACK ? '黑方' : '白方'}】落子`
      : '悔棋成功，请重新落子');
  }

  /**
   * 玩家认输
   */
  handleResign() {
    if (this.gameStatus !== 'playing') return;

    if (this.isPvP()) {
      const resignPlayer = this.turn === BLACK ? '黑方' : '白方';
      const winPlayer = this.turn === BLACK ? '白方' : '黑方';
      if (confirm(`当前轮到【${resignPlayer}】落子，确定要认输吗？`)) {
        this.gameStatus = 'ended';
        this.winner = this.turn === BLACK ? WHITE : BLACK;
        this.stopTimer();
        sound.playWin();

        StorageManager.recordGame({
          result: 'win',
          playerColor: '双人对弈',
          aiMode: '双人同屏',
          difficulty: '人人对战',
          modelName: `${winPlayer}胜出`,
          turns: this.moveHistory.length,
          duration: this.formatTime(this.elapsedSeconds),
          moves: this.moveHistory
        });

        this.updateStatsBar();
        this.showWinModal(true, `【${resignPlayer}】已认输，【${winPlayer}】获胜！`);
      }
      return;
    }

    if (confirm('确定要认输本局吗？')) {
      this.gameStatus = 'ended';
      this.winner = this.aiColor;
      this.stopTimer();
      sound.playLose();

      StorageManager.recordGame({
        result: 'lose',
        playerColor: this.playerColor === BLACK ? '黑棋' : '白棋',
        aiMode: this.settings.aiEngine === 'llm' ? '大模型' : '本地算法',
        difficulty: this.getDifficultyLabel(this.settings.difficulty),
        modelName: this.settings.aiEngine === 'llm' ? this.settings.llmConfig.model : '内置引擎',
        turns: this.moveHistory.length,
        duration: this.formatTime(this.elapsedSeconds),
        moves: this.moveHistory
      });

      this.updateStatsBar();
      this.showWinModal(false, '您已认输，胜败乃兵家常事！');
    }
  }

  /**
   * 智能走法提示
   */
  handleHint() {
    if (this.replay.active) {
      this.showToast(this.replay.external ? '复盘历史对局中，请先返回当前对局' : '回放模式下不可取提示，请先返回当前对局');
      return;
    }

    if (this.gameStatus !== 'playing') {
      this.showToast('对局未在进行中');
      return;
    }

    if (!this.isPvP() && this.turn !== this.playerColor) {
      this.showToast('请在您的回合获取提示');
      return;
    }

    const currentHintColor = this.isPvP() ? this.turn : this.playerColor;

    const best = getBestMove(this.board, currentHintColor, 'high', {
      checkBlackForbidden: currentHintColor === BLACK && this.isForbiddenRuleOn()
    });

    if (best) {
      const hintPlayer = currentHintColor === BLACK ? '黑方' : '白方';
      this.showToast(`💡 建议点位：${best.notation}（为【${hintPlayer}】推荐，得分: ${Math.round(best.score)}）`);
      this.goban.hoverPos = { r: best.r, c: best.c };
      this.goban.render();
    }
  }

  /* ======================================================================
     落子轨迹与逐手回放
     ====================================================================== */

  /**
   * 绑定回放面板与分析面板的全部交互
   */
  bindReplayEvents() {
    this.btnReplay?.addEventListener('click', () => {
      if (this.replay.active) {
        this.exitReplay();
        return;
      }
      if (!this.moveHistory.length) {
        this.showToast('尚未落子，先下一手棋再回放吧');
        return;
      }
      if (this.gameStatus === 'playing' && !this.isPvP() && this.turn !== this.playerColor) {
        this.showToast('AI 正在落子，稍候再进入回放');
        return;
      }
      this.startReview(this.moveHistory, null, this.moveHistory.length);
      this.replayCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    this.btnRepFirst?.addEventListener('click', () => this.gotoMove(1));
    this.btnRepPrev?.addEventListener('click', () => this.stepReplay(-1));
    this.btnRepNext?.addEventListener('click', () => this.stepReplay(1));
    this.btnRepLast?.addEventListener('click', () => this.gotoMove(this.replayMoves().length));
    this.btnRepPlay?.addEventListener('click', () => this.toggleAutoPlay());
    this.btnRepExit?.addEventListener('click', () => this.exitReplay());

    this.repSpeed?.addEventListener('change', (e) => {
      this.replay.speed = Number(e.target.value) || 900;
      if (this.replay.playing) {
        this.stopAutoPlay();
        this.toggleAutoPlay();
      }
    });

    this.repSlider?.addEventListener('input', (e) => {
      const no = Number(e.target.value) || 1;
      if (!this.replay.active) {
        if (!this.moveHistory.length) return;
        this.startReview(this.moveHistory, null, no);
      } else {
        this.gotoMove(no);
      }
    });

    // 棋谱列表：点行跳手，点放大镜直接分析那一手
    this.moveListContainer?.addEventListener('click', (e) => {
      const analyzeBtn = e.target.closest('[data-analyze]');
      if (analyzeBtn) {
        this.analyzeMoveNo(Number(analyzeBtn.dataset.analyze));
        return;
      }
      const row = e.target.closest('.move-item');
      if (!row) return;

      const no = Number(row.dataset.idx);
      if (!no) return;

      if (!this.replay.active) {
        if (!this.moveHistory.length) return;
        this.startReview(this.moveHistory, null, no);
      } else {
        this.gotoMove(no);
      }
    });

    // 键盘左右方向键逐手浏览
    document.addEventListener('keydown', (e) => {
      if (!this.replay.active) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (document.querySelector('.modal-overlay.active')) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.stepReplay(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.stepReplay(1);
      } else if (e.key === 'Escape') {
        this.exitReplay();
      }
    });

    // 历史对局的「复盘」按钮
    document.getElementById('historyListContainer')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-review]');
      if (!btn) return;
      this.openArchiveReview(Number(btn.dataset.review));
    });
  }

  /**
   * 回放中点击棋盘：跳到该棋子落下时的那一刻
   */
  handleInspectClick(r, c) {
    const moves = this.replayMoves();
    for (let i = 0; i < moves.length; i++) {
      if (moves[i].r === r && moves[i].c === c) {
        this.gotoMove(i + 1);
        return;
      }
    }
    this.showToast('回放模式：点击已有棋子可跳到那一手');
  }

  replayMoves() {
    return this.replay.moves || this.moveHistory;
  }

  /**
   * 进入回放视图（external 非空表示复盘历史旧局）
   */
  startReview(moves, external = null, cursor) {
    if (!Array.isArray(moves) || moves.length === 0) {
      this.showToast('该局没有可回放的棋谱');
      return;
    }
    this.stopAutoPlay();
    this.replay.active = true;
    this.replay.moves = moves;
    this.replay.external = external;
    this.goban.setReviewMode(true);
    this.goban.setLocked(true);
    this.gotoMove(cursor === undefined ? moves.length : cursor);
  }

  /**
   * 退出回放，回到当前对局的实时画面
   */
  exitReplay(opts = {}) {
    const wasActive = this.replay.active;
    this.stopAutoPlay();
    this.replay.active = false;
    this.replay.external = null;
    this.replay.moves = null;
    this.replay.cursor = 0;
    this.goban.setReviewMode(false);
    this.restoreLiveView();
    this.renderMoveList();
    this.updateReplayUI();
    this.syncAnalysisToFocus();
    if (wasActive && !opts.silent) {
      this.showToast(this.gameStatus === 'playing' ? '已返回当前对局' : '已退出回放视图');
    }
  }

  /**
   * 复位回放与分析状态（新开一局时调用）
   */
  resetReplayState() {
    this.stopAutoPlay();
    this.replay.active = false;
    this.replay.external = null;
    this.replay.moves = null;
    this.replay.cursor = 0;
    this.goban.setReviewMode(false);
    this.goban.setHighlight(null);
    this.clearAnalysisCache('live');
    this.lastAnalysis = null;
    this.resetAnalysisPanel();
    this.renderMoveList();
    this.updateReplayUI();
  }

  gotoMove(rawIndex) {
    if (!this.replay.active) return;

    const moves = this.replayMoves();
    const total = moves.length;
    const idx = Math.max(1, Math.min(total, rawIndex));
    this.replay.cursor = idx;

    const board = buildBoardFromMoves(moves, idx);
    const focus = moves[idx - 1];
    const trail = moves.slice(Math.max(0, idx - 8), idx).map(m => ({ r: m.r, c: m.c, color: m.color }));

    // 走到最后一手时，若该手确为制胜手，恢复五连高光
    let winLine = null;
    if (idx === total && focus) {
      const probe = checkWin(board, focus.r, focus.c, focus.color);
      if (probe.win) winLine = probe.winLine;
    }

    this.goban.setBoardState(
      board,
      focus ? { r: focus.r, c: focus.c, color: focus.color } : null,
      winLine,
      [],
      trail
    );
    this.goban.setTurn(focus ? (focus.color === BLACK ? WHITE : BLACK) : BLACK);
    this.goban.setHighlight(null);

    this.renderMoveList();
    this.updateReplayUI();
    this.syncAnalysisToFocus();
  }

  stepReplay(delta) {
    if (!this.replay.active) {
      this.showToast('点「落子回放」或棋谱列表即可进入回放');
      return;
    }
    const total = this.replayMoves().length;
    const next = this.replay.cursor + delta;
    if (next < 1) { this.showToast('已经是第一手了'); return; }
    if (next > total) { this.showToast('已经是最后一手了'); return; }
    this.gotoMove(next);
  }

  toggleAutoPlay() {
    if (this.replay.playing) {
      this.stopAutoPlay();
      return;
    }
    const total = this.replayMoves().length;
    if (!this.replay.active || total === 0) {
      this.showToast('请先点「落子回放」进入回放视图');
      return;
    }
    if (this.replay.cursor >= total) this.gotoMove(1);

    this.replay.playing = true;
    if (this.btnRepPlay) {
      this.btnRepPlay.textContent = '暂停';
      this.btnRepPlay.classList.add('playing');
    }
    this.replay.timer = setInterval(() => {
      const len = this.replayMoves().length;
      if (!this.replay.active) { this.stopAutoPlay(); return; }
      if (this.replay.cursor >= len) { this.stopAutoPlay(); return; }
      this.gotoMove(this.replay.cursor + 1);
      if (this.replay.cursor >= len) this.stopAutoPlay();
    }, this.replay.speed);
  }

  stopAutoPlay() {
    if (this.replay.timer) {
      clearInterval(this.replay.timer);
      this.replay.timer = null;
    }
    this.replay.playing = false;
    if (this.btnRepPlay) {
      this.btnRepPlay.textContent = '播放';
      this.btnRepPlay.classList.remove('playing');
    }
  }

  /**
   * 按当前对局真实状态重绘棋盘（退出回放时调用）
   */
  restoreLiveView() {
    const last = this.moveHistory[this.moveHistory.length - 1] || null;
    const showForbidden = this.gameStatus === 'playing' && this.turn === BLACK && this.isForbiddenRuleOn();
    const forbidden = showForbidden ? this.calculateForbiddenPoints() : [];

    this.goban.setBoardState(
      this.board,
      last ? { r: last.r, c: last.c, color: last.color } : null,
      this.winningLine,
      forbidden
    );
    this.goban.setTurn(this.turn);

    const aiThinking = this.gameStatus === 'playing' && !this.isPvP() && this.turn !== this.playerColor;
    this.goban.setLocked(this.gameStatus !== 'playing' || aiThinking);
    this.updateStatus();
  }

  /**
   * 更新回放面板与状态栏
   */
  updateReplayUI() {
    const moves = this.replayMoves();
    const total = moves.length;
    const active = this.replay.active;
    const cursor = active ? this.replay.cursor : total;

    if (this.replayCount) {
      this.replayCount.textContent = active ? `第 ${cursor} / ${total} 手` : `共 ${total} 手`;
    }

    if (this.replayTitle && this.replayHint) {
      if (this.replay.external) {
        this.replayTitle.textContent = '📜 历史复盘';
        this.replayHint.textContent = `正在复盘「${this.replay.external.label}」，棋盘只读，可逐手查看与深度分析`;
      } else if (active) {
        this.replayTitle.textContent = '📜 落子轨迹';
        this.replayHint.textContent = '回放中 · 棋盘暂停落子，点棋谱或棋盘上的棋子跳手，点「返回对局」继续';
      } else {
        this.replayTitle.textContent = '📜 落子轨迹';
        this.replayHint.textContent = total
          ? '点任意一手即可跳回当时盘面，或用播放条自动回放'
          : '落子后这里会记录每一手的落点、顺序与用时';
      }
    }

    if (this.repSlider) {
      this.repSlider.max = Math.max(1, total);
      this.repSlider.value = Math.max(1, cursor);
      this.repSlider.disabled = total === 0;
    }

    const canStep = active && total > 0;
    if (this.btnRepFirst) this.btnRepFirst.disabled = !canStep || cursor <= 1;
    if (this.btnRepPrev) this.btnRepPrev.disabled = !canStep || cursor <= 1;
    if (this.btnRepNext) this.btnRepNext.disabled = !canStep || cursor >= total;
    if (this.btnRepLast) this.btnRepLast.disabled = !canStep || cursor >= total;
    if (this.btnRepPlay) this.btnRepPlay.disabled = !canStep;
    if (this.btnRepExit) this.btnRepExit.hidden = !active;

    if (this.btnReplay) {
      this.btnReplay.innerHTML = active
        ? '<span class="btn-icon-text">⏹</span> 退出回放'
        : '<span class="btn-icon-text">⏪</span> 落子回放';
    }

    if (this.analysisScope) {
      this.analysisScope.textContent = total === 0
        ? '暂无落子'
        : `焦点：第 ${cursor} 手`;
    }

    if (this.btnAnalyzeDeep) {
      const hasDeep = total > 0 && this.deepCache.has(this.scopeKey('m', cursor));
      this.btnAnalyzeDeep.disabled = total === 0;
      this.btnAnalyzeDeep.textContent = hasDeep ? '🧠 已解读，点击再看' : '🧠 深度解读';
    }

    // 状态栏：回放时改为显示当前焦点手
    if (active && this.statusTextEl && this.turnBadgeEl) {
      const focus = moves[cursor - 1];
      this.turnBadgeEl.className = `turn-badge ${focus && focus.color === WHITE ? 'turn-white' : 'turn-black'}`;
      this.turnBadgeEl.textContent = this.replay.external ? '复盘浏览' : '回放浏览';
      this.statusTextEl.textContent = focus
        ? `第 ${cursor} 手：${COLOR_NAMES[focus.color]} ${focus.notation || coordToNotation(focus.r, focus.c)}`
        : '回放起点 · 空盘';
      this.statusShowsReplay = true;
    } else if (this.statusShowsReplay) {
      this.statusShowsReplay = false;
      this.updateStatus();
    }
  }

  /**
   * 渲染棋谱列表
   */
  renderMoveList() {
    const container = this.moveListContainer;
    if (!container) return;

    const moves = this.replayMoves();
    if (!moves.length) {
      container.innerHTML = '<div class="empty-hint">本局还没有落子，去棋盘上点一手吧</div>';
      return;
    }

    const activeNo = this.replay.active ? this.replay.cursor : moves.length;

    container.innerHTML = moves.map((m, i) => {
      const no = i + 1;
      const coord = m.notation || coordToNotation(m.r, m.c);
      const cached = this.analysisCache.get(this.scopeKey('m', no));
      const gradeHtml = cached
        ? `<span class="move-grade tone-${cached.tone}">${cached.gradeLabel}</span>`
        : '';
      const timeHtml = this.moveTimeText(moves, i);

      return `<div class="move-item${no === activeNo ? ' active' : ''}" data-idx="${no}" title="跳到第 ${no} 手">
        <span class="move-no">${no}</span>
        <span class="stone-dot ${m.color === BLACK ? 'black' : 'white'}"></span>
        <span class="move-coord">${coord}</span>
        <span class="move-owner">${this.moveOwnerLabel(m.color)}</span>
        ${gradeHtml}
        <span class="move-time">${timeHtml}</span>
        <button class="move-analyze" data-analyze="${no}" title="分析这一手">🔍</button>
      </div>`;
    }).join('');

    if (this.replay.active) {
      const activeEl = container.querySelector('.move-item.active');
      if (activeEl) {
        container.scrollTop = Math.max(
          0,
          activeEl.offsetTop - container.clientHeight / 2 + activeEl.offsetHeight / 2
        );
      }
    }
  }

  /**
   * 某一手的落子归属（你 / AI / 黑 / 白）
   */
  moveOwnerLabel(color) {
    if (this.replay.external) {
      if (this.replay.external.pvp) return color === BLACK ? '黑' : '白';
      return color === this.replay.external.playerColor ? '你' : 'AI';
    }
    if (this.isPvP()) return color === BLACK ? '黑' : '白';
    return color === this.playerColor ? '你' : 'AI';
  }

  /**
   * 单手用时（相对上一手的间隔）
   */
  moveTimeText(moves, i) {
    const cur = moves[i].t;
    const prev = i > 0 ? moves[i - 1].t : (this.replay.external ? null : this.startTime);
    if (!cur || !prev) return '';
    const sec = Math.max(0, Math.round((cur - prev) / 1000));
    if (sec >= 60) {
      return `${Math.floor(sec / 60)}′${String(sec % 60).padStart(2, '0')}″`;
    }
    return `${sec}s`;
  }

  /* ======================================================================
     逐手分析与后续推演
     ====================================================================== */

  bindAnalysisEvents() {
    this.btnAnalyze?.addEventListener('click', () => {
      if (!this.replayMoves().length) {
        this.showToast('请先落一手棋再分析');
        return;
      }
      this.analysisCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this.runMoveAnalysis();
    });
    this.btnAnalyzeMove?.addEventListener('click', () => this.runMoveAnalysis());
    this.btnAnalyzeNext?.addEventListener('click', () => this.runPositionAnalysis());
    this.btnAnalyzeDeep?.addEventListener('click', () => this.runDeepAnalysis());

    // 分析结果里的推荐点：点击即在棋盘上高亮标注
    this.analysisResult?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-point]');
      if (!row) return;
      const r = Number(row.dataset.r);
      const c = Number(row.dataset.c);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return;
      this.goban.setHighlight({ r, c });
      this.showToast(`💡 引擎推荐点 ${row.dataset.point} 已在棋盘上标出`);
    });
  }

  /**
   * 当前焦点那一手的编号（1 起始，0 = 无）
   */
  focusMoveNo() {
    const moves = this.replayMoves();
    if (!moves.length) return 0;
    return this.replay.active ? this.replay.cursor : moves.length;
  }

  /**
   * 分析结果缓存键：区分「本手质量 / 局面推演」与「当前对局 / 某局历史」
   */
  scopeKey(kind, no) {
    const tag = this.replay.external ? `g${this.replay.external.id}` : 'live';
    return `${tag}-${kind}${no}`;
  }

  clearAnalysisCache(tag = 'live') {
    const prefix = `${tag}-`;
    for (const key of [...this.analysisCache.keys()]) {
      if (key.startsWith(prefix)) this.analysisCache.delete(key);
    }
    for (const key of [...this.deepCache.keys()]) {
      if (key.startsWith(prefix)) this.deepCache.delete(key);
    }
  }

  /**
   * 悔棋后作废被撤销那几手的分析
   */
  invalidateLiveAnalysis(keepMoves) {
    const drop = [];
    for (const key of this.analysisCache.keys()) {
      if (!key.startsWith('live-')) continue;
      const no = Number(key.replace('live-', '').replace(/^[mp]/, ''));
      if (no > keepMoves) drop.push(key);
    }
    drop.forEach(k => {
      this.analysisCache.delete(k);
      this.deepCache.delete(k);
    });
    if (this.lastAnalysis && drop.includes(this.lastAnalysis.scopeKey)) {
      this.lastAnalysis = null;
      this.resetAnalysisPanel();
    }
  }

  /**
   * 跳手时自动回显该手已有的分析结论
   */
  syncAnalysisToFocus() {
    const no = this.focusMoveNo();
    if (!no) {
      this.lastAnalysis = null;
      this.resetAnalysisPanel();
      return;
    }
    const mk = this.scopeKey('m', no);
    const pk = this.scopeKey('p', no);
    if (this.lastAnalysis && (this.lastAnalysis.scopeKey === mk || this.lastAnalysis.scopeKey === pk)) return;

    if (this.analysisCache.has(mk)) {
      this.lastAnalysis = { kind: 'move', scopeKey: mk, moveNo: no, data: this.analysisCache.get(mk), deep: this.deepCache.get(mk) || null };
      this.renderAnalysis();
    } else if (this.analysisCache.has(pk)) {
      this.lastAnalysis = { kind: 'position', scopeKey: pk, moveNo: no, data: this.analysisCache.get(pk), deep: this.deepCache.get(pk) || null };
      this.renderAnalysis();
    } else {
      // 换手后不沿用上一手的结论，避免误读
      this.lastAnalysis = null;
      this.showUnanalyzedHint(no);
    }
  }

  showUnanalyzedHint(no) {
    if (this.analysisResult) {
      this.analysisResult.innerHTML = `<div class="empty-hint">第 ${no} 手尚未分析，点下方「分析本手」查看棋形评分与更优下法。</div>`;
    }
  }

  /**
   * 点击棋谱里的 🔍 或直接指定某一手进行分析
   */
  analyzeMoveNo(no) {
    if (!no) return;
    const moves = this.replayMoves();
    if (!moves.length) return;

    if (!this.replay.active) {
      this.startReview(this.moveHistory, null, no);
    } else if (this.replay.cursor !== no) {
      this.gotoMove(no);
    }
    this.runMoveAnalysis();
  }

  async runMoveAnalysis() {
    if (this.analyzing) return;
    const moves = this.replayMoves();
    const no = this.focusMoveNo();
    if (!no) {
      this.showToast('请先落一手棋再分析');
      return;
    }

    const key = this.scopeKey('m', no);
    if (this.analysisCache.has(key)) {
      this.lastAnalysis = {
        kind: 'move',
        scopeKey: key,
        moveNo: no,
        data: this.analysisCache.get(key),
        deep: this.deepCache.get(key) || null
      };
      this.renderAnalysis();
      return;
    }

    this.analyzing = true;
    this.setAnalysisLoading(`本地引擎正在核算第 ${no} 手的棋形与替代下法…`);
    await new Promise(res => setTimeout(res, 20)); // 先让 loading 上屏

    try {
      const res = analyzeMove(moves, no - 1, {
        checkBlackForbidden: this.isForbiddenRuleOn()
      });
      if (!res) {
        this.renderAnalysisError('这一手记录不完整，无法分析');
        return;
      }
      this.analysisCache.set(key, res);
      this.lastAnalysis = { kind: 'move', scopeKey: key, moveNo: no, data: res, deep: this.deepCache.get(key) || null };
      this.renderAnalysis();
      this.renderMoveList();
      this.updateReplayUI();
    } catch (err) {
      console.error('分析失败:', err);
      this.renderAnalysisError(`分析失败：${err.message || err}`);
    } finally {
      this.analyzing = false;
    }
  }

  async runPositionAnalysis() {
    if (this.analyzing) return;
    const moves = this.replayMoves();
    const no = this.focusMoveNo();
    if (!no) {
      this.showToast('请先落一手棋再推演');
      return;
    }

    const key = this.scopeKey('p', no);
    if (this.analysisCache.has(key)) {
      this.lastAnalysis = {
        kind: 'position',
        scopeKey: key,
        moveNo: no,
        data: this.analysisCache.get(key),
        deep: this.deepCache.get(key) || null
      };
      this.renderAnalysis();
      return;
    }

    this.analyzing = true;
    this.setAnalysisLoading('正在推演后续三手的变化分支…');
    await new Promise(res => setTimeout(res, 20));

    try {
      const res = analyzePosition(moves, no, {
        checkBlackForbidden: this.isForbiddenRuleOn()
      });
      this.analysisCache.set(key, res);
      this.lastAnalysis = { kind: 'position', scopeKey: key, moveNo: no, data: res, deep: this.deepCache.get(key) || null };
      this.renderAnalysis();
    } catch (err) {
      console.error('推演失败:', err);
      this.renderAnalysisError(`推演失败：${err.message || err}`);
    } finally {
      this.analyzing = false;
    }
  }

  /**
   * 大模型深度解读（本地结论 + ASCII 棋盘图 → 教练口吻棋评）
   */
  async runDeepAnalysis() {
    if (this.deepAnalyzing) return;
    const moves = this.replayMoves();
    const no = this.focusMoveNo();
    if (!no) {
      this.showToast('请先落一手棋再解读');
      return;
    }

    // 沿用当前展示的分析；没有则先算一次本手分析作为依据
    let base = this.lastAnalysis && this.lastAnalysis.moveNo === no
      ? this.lastAnalysis
      : null;

    if (base && base.deep) {
      return; // 已展示解读内容
    }

    if (!base) {
      const key = this.scopeKey('m', no);
      let data = this.analysisCache.get(key);
      if (!data) {
        data = analyzeMove(moves, no - 1, { checkBlackForbidden: this.isForbiddenRuleOn() });
        if (data) this.analysisCache.set(key, data);
      }
      if (!data) {
        this.renderAnalysisError('未能取得本地分析结论，无法请大模型解读');
        return;
      }
      base = { kind: 'move', scopeKey: key, moveNo: no, data, deep: this.deepCache.get(key) || null };
      this.lastAnalysis = base;
      this.renderAnalysis();
    }

    if (base.deep) return;

    const focusMove = moves[no - 1];
    const board = buildBoardFromMoves(moves, no);
    const lastMove = base.kind === 'move' ? focusMove : null;

    this.deepAnalyzing = true;
    this.lastAnalysis = { ...base, deepLoading: true, deepError: null };
    this.renderAnalysis();

    const focusText = base.kind === 'move'
      ? `第 ${no} 手（本局共 ${moves.length} 手）：${COLOR_NAMES[base.data.color]}方落于 ${base.data.notation}，本地引擎定级「${base.data.gradeLabel}」`
      : `第 ${no} 手落子之后，轮到${COLOR_NAMES[base.data.toMove]}方行棋（本局共 ${moves.length} 手）`;

    const res = await requestDeepAnalysis(this.settings.llmConfig, {
      boardAscii: renderBoardAscii(board, lastMove),
      historyText: this.historyTextForLLM(moves, no),
      focusText,
      localReport: formatAnalysisForLLM(base.data),
      ruleText: this.isForbiddenRuleOn()
        ? `规则：15×15 棋盘，黑棋先行；黑棋受${[
            this.settings.checkDoubleThree !== false ? '三三禁手' : null,
            this.settings.checkDoubleFour !== false ? '四四禁手' : null,
            '长连禁手'
          ].filter(Boolean).join('、')}限制，白棋无禁手。`
        : '规则：15×15 棋盘，黑棋先行，无禁手限制。'
    });

    this.deepAnalyzing = false;

    if (res.ok) {
      this.deepCache.set(base.scopeKey, { text: res.text, model: res.model });
      this.lastAnalysis = { ...this.lastAnalysis, deepLoading: false, deep: { text: res.text, model: res.model }, deepError: null };
    } else {
      this.lastAnalysis = { ...this.lastAnalysis, deepLoading: false, deep: null, deepError: res.error || '大模型解读失败' };
    }
    this.renderAnalysis();
    this.updateReplayUI();
  }

  /**
   * 供大模型阅读的棋谱文本（最近 14 手）
   */
  historyTextForLLM(moves, no) {
    const slice = moves.slice(0, no);
    const from = Math.max(0, slice.length - 14);
    const text = slice.slice(from).map((m, i) => {
      const idx = from + i + 1;
      const coord = m.notation || coordToNotation(m.r, m.c);
      return `第${idx}手 ${COLOR_NAMES[m.color] || '?'} ${coord}`;
    }).join('；');
    return text || '（尚无落子）';
  }

  /* ---------- 分析结果渲染 ---------- */

  resetAnalysisPanel() {
    if (this.analysisResult) {
      this.analysisResult.innerHTML = '<div class="empty-hint">尚未分析。可在上方棋谱点选某一手，再按「分析本手」查看棋形评分、是否最优与更推荐的下法。</div>';
    }
  }

  setAnalysisLoading(msg) {
    if (this.analysisResult) {
      this.analysisResult.innerHTML = `<div class="an-loading">⏳ ${this.esc(msg)}</div>`;
    }
  }

  renderAnalysisError(msg) {
    if (this.analysisResult) {
      this.analysisResult.innerHTML = `<div class="an-error">${this.esc(msg)}</div>`;
    }
  }

  renderAnalysis() {
    const state = this.lastAnalysis;
    if (!state || !this.analysisResult) return;

    const body = state.kind === 'move'
      ? this.moveAnalysisHtml(state.data)
      : this.positionAnalysisHtml(state.data);

    this.analysisResult.innerHTML = body + this.deepHtml(state);
  }

  moveAnalysisHtml(res) {
    const owner = this.moveOwnerLabel(res.color);
    const parts = [];

    parts.push(`<div class="an-head">
      <span class="grade-badge tone-${res.tone}">${res.gradeLabel}</span>
      <span class="an-title">第 ${res.moveNo} 手 · ${COLOR_NAMES[res.color]}方（${owner}）· ${res.notation}</span>
    </div>`);

    parts.push(`<div class="score-row">
      <div class="score-box"><b>${this.fmtNum(res.myScore)}</b><span>本手评分</span></div>
      <div class="score-box"><b>${this.fmtNum(res.bestScore)}</b><span>引擎最佳</span></div>
      <div class="score-box tone-${res.tone}"><b>${res.matchRate}%</b><span>最优匹配度</span></div>
    </div>`);

    if (res.notes.length) {
      parts.push(`<ul class="an-list">${res.notes.map(n => `<li class="${this.noteClass(n)}">${this.esc(n)}</li>`).join('')}</ul>`);
    }

    if (res.alternatives.length) {
      parts.push(`<div class="an-sub">更优下法（点一行可在棋盘上标出该点）</div>`);
      parts.push(`<table class="alt-table"><thead><tr><th>点位</th><th>评分</th><th>落子后棋形</th></tr></thead><tbody>
        ${res.alternatives.map(a => `<tr class="alt-row" data-point="${a.notation}" data-r="${a.r}" data-c="${a.c}">
          <td>${a.notation}</td><td>${this.fmtNum(Math.round(a.score))}</td><td>${this.esc(a.shapes.join('、') || '—')}</td>
        </tr>`).join('')}
      </tbody></table>`);
    }

    parts.push(this.linesHtml(res.lines, '本手之后最可能的三手变化（已考虑对手最强抵抗）'));
    return parts.join('');
  }

  positionAnalysisHtml(res) {
    const parts = [];
    parts.push(`<div class="an-head">
      <span class="grade-badge tone-good">局面推演</span>
      <span class="an-title">第 ${res.moveNo} 手之后 · 轮到${COLOR_NAMES[res.toMove]}方</span>
    </div>`);

    if (res.candidates.length) {
      parts.push('<div class="an-sub">引擎推荐点</div>');
      parts.push(`<table class="alt-table"><thead><tr><th>点位</th><th>评分</th><th>落子后棋形</th></tr></thead><tbody>
        ${res.candidates.map(c => `<tr class="alt-row" data-point="${c.notation}" data-r="${c.r}" data-c="${c.c}">
          <td>${c.notation}</td><td>${this.fmtNum(Math.round(c.score))}</td><td>${this.esc(c.shapes.join('、') || '—')}</td>
        </tr>`).join('')}
      </tbody></table>`);
    }

    if (res.notes.length) {
      parts.push(`<ul class="an-list">${res.notes.map(n => `<li class="${this.noteClass(n)}">${this.esc(n)}</li>`).join('')}</ul>`);
    }

    parts.push(this.linesHtml(res.lines, '接下来三手最可能的走向（对手最强抵抗下）'));
    return parts.join('');
  }

  linesHtml(lines, title) {
    if (!lines || !lines.length) return '';
    const items = lines.map((l, i) => {
      let cls = '';
      if (l.result && l.result.indexOf('连五致胜') >= 0) {
        cls = l.result.indexOf(COLOR_NAMES[l.rootColor]) === 0 ? 'line-win' : 'line-lose';
      }
      const note = l.result
        ? l.result
        : `局面参考分 ${l.refScore > 0 ? '+' : ''}${this.fmtNum(l.refScore)}`;
      return `<li class="line-item ${cls}">
        <span class="line-seq">${i + 1}. ${this.esc(l.text)}</span>
        <span class="line-note">${this.esc(note)}</span>
      </li>`;
    }).join('');
    return `<div class="an-sub">${title}</div><ul class="line-list">${items}</ul>`;
  }

  deepHtml(state) {
    if (state.deepLoading) {
      return '<div class="an-loading">🧠 大模型正在通读棋局撰写棋评，通常需要几秒…</div>';
    }
    if (state.deep) {
      return `<div class="an-sub">🧠 大模型深度解读 · ${this.esc(state.deep.model || '')}</div>
        <div class="an-llm">${this.llmHtml(state.deep.text)}</div>`;
    }
    if (state.deepError) {
      return `<div class="an-sub">🧠 大模型深度解读</div><div class="an-error">${this.esc(state.deepError)}</div>`;
    }
    return '';
  }

  /* ---------- 小工具 ---------- */

  noteClass(text) {
    if (/漏防|错失|杀机|禁手|危险|必须|未处理|不可落子|无法/.test(text)) return 'danger';
    if (/更推荐|注意|埋伏笔|对方下一手|主动权在对方/.test(text)) return 'warn';
    return '';
  }

  fmtNum(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  llmHtml(text) {
    return this.esc(text)
      .replace(/【([^】]{2,16})】/g, '<span class="llm-sec">【$1】</span>')
      .replace(/\n/g, '<br>');
  }

  /**
   * 载入历史对局棋谱进行复盘
   */
  openArchiveReview(id) {
    const game = StorageManager.getHistory().find(g => g.id === id);
    if (!game) {
      this.showToast('找不到该局对局记录');
      return;
    }
    if (!Array.isArray(game.moves) || game.moves.length === 0) {
      this.showToast('该局未保存完整棋谱（旧版本记录），无法复盘');
      return;
    }

    const moves = game.moves
      .filter(m => m && Number.isFinite(m.r) && Number.isFinite(m.c) && m.color)
      .map(m => ({ ...m, notation: m.notation || coordToNotation(m.r, m.c) }));

    if (!moves.length) {
      this.showToast('该局棋谱数据异常，无法回放');
      return;
    }

    const external = {
      id: game.id,
      label: `${game.date || '历史对局'} · ${game.turns || moves.length} 手`,
      pvp: /双人/.test(String(game.aiMode || '')),
      playerColor: /^白/.test(String(game.playerColor || '')) ? WHITE : BLACK
    };

    this.startReview(moves, external, moves.length);
    this.historyModal.classList.remove('active');
    this.showToast(`已载入 ${external.label} 的棋谱，可逐手回放与分析`);
    setTimeout(() => {
      this.replayCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  }

  /**
   * 当前生效的禁手判定配置（白棋永远无禁手，只在黑棋回合使用）
   */
  forbiddenOptions() {
    return {
      checkDoubleThree: this.settings.checkDoubleThree !== false,
      checkDoubleFour: this.settings.checkDoubleFour !== false,
      checkOverline: true
    };
  }

  /**
   * 是否至少开启了一项禁手规则
   */
  isForbiddenRuleOn() {
    return this.settings.checkDoubleThree !== false || this.settings.checkDoubleFour !== false;
  }

  /**
   * 计算黑棋当前所有禁手点（三三 / 四四 / 长连）
   */
  calculateForbiddenPoints() {
    if (!this.isForbiddenRuleOn()) return [];
    const options = this.forbiddenOptions();
    const forbiddenList = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (this.board[r][c] === EMPTY) {
          const res = checkForbidden(this.board, r, c, options);
          if (res.isForbidden) {
            forbiddenList.push({ r, c, reason: res.reason });
          }
        }
      }
    }
    return forbiddenList;
  }

  /**
   * 更新游戏状态栏显示
   */
  updateStatus() {
    if (this.gameStatus === 'playing') {
      if (this.isPvP()) {
        this.statusTextEl.textContent = this.turn === BLACK ? '轮到黑方落子 (先手)' : '轮到白方落子 (后手)';
        this.turnBadgeEl.className = `turn-badge ${this.turn === BLACK ? 'turn-black' : 'turn-white'}`;
        this.turnBadgeEl.textContent = this.turn === BLACK ? '黑方回合' : '白方回合';
      } else {
        const isPlayerTurn = this.turn === this.playerColor;
        this.statusTextEl.textContent = isPlayerTurn ? '轮到您落子' : 'AI 思考中...';
        this.turnBadgeEl.className = `turn-badge ${this.turn === BLACK ? 'turn-black' : 'turn-white'}`;
        this.turnBadgeEl.textContent = this.turn === BLACK ? '黑方回合' : '白方回合';
      }
    } else if (this.gameStatus === 'ended') {
      this.turnBadgeEl.className = 'turn-badge turn-ended';
      this.turnBadgeEl.textContent = '对局结束';
      if (this.isPvP()) {
        if (this.winner === 'draw') {
          this.statusTextEl.textContent = '握手言和！';
        } else {
          this.statusTextEl.textContent = `🏆 【${this.winner === BLACK ? '黑方' : '白方'}】获胜！`;
        }
      } else {
        if (this.winner === this.playerColor) {
          this.statusTextEl.textContent = '🎉 恭喜获得胜利！';
        } else if (this.winner === this.aiColor) {
          this.statusTextEl.textContent = '⚔️ AI 获胜，再接再厉！';
        } else {
          this.statusTextEl.textContent = '平局！';
        }
      }
    }
  }

  updateEngineBadge() {
    const badge = document.getElementById('engineBadge');
    if (badge) {
      if (this.isPvP()) {
        badge.textContent = '双人对弈';
        badge.className = 'badge badge-pvp';
      } else if (this.settings.aiEngine === 'llm') {
        badge.textContent = '大模型';
        badge.className = 'badge badge-llm';
      } else {
        badge.textContent = '本地算法';
        badge.className = 'badge badge-local';
      }
    }
  }

  updateSoundButton() {
    const muted = sound.isMuted();
    this.btnSoundToggle.innerHTML = muted ? '🔇 声音关' : '🔊 声音开';
    this.btnSoundToggle.classList.toggle('muted', muted);
  }

  updateStatsBar() {
    const stats = StorageManager.getStats();
    const winRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 0;
    const statsBarEl = document.getElementById('statsBarText');
    if (statsBarEl) {
      statsBarEl.innerHTML = `战绩：${stats.wins}胜 / ${stats.losses}负 / ${stats.draws}平 <span class="winrate-highlight">（胜率 ${winRate}%）</span> 连胜：${stats.currentStreak}`;
    }
  }

  getDifficultyLabel(diff) {
    switch (diff) {
      case 'low': return '入门低难度';
      case 'medium': return '业余中难度';
      case 'high': return '大师高难度';
      default: return '中难度';
    }
  }

  generateAlgorithmComment(score) {
    if (score >= 100000) return '绝杀已现，承让承让！';
    if (score >= 10000) return '这一手活四，胜负已定！';
    if (score >= 1200) return '防守反击，不可大意！';
    if (score >= 1000) return '布局既成，且看我这路大军！';
    const comments = [
      '落子无悔，请！',
      '攻守兼备，静观其变。',
      '这盘棋局颇具玄机。',
      '妙招，我也出一手！'
    ];
    return comments[Math.floor(Math.random() * comments.length)];
  }

  // 计时器控制
  startTimer() {
    this.stopTimer();
    this.startTime = Date.now();
    this.elapsedSeconds = 0;
    this.timerEl.textContent = '00:00';
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      this.timerEl.textContent = this.formatTime(this.elapsedSeconds);
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  resetTimer() {
    this.stopTimer();
    this.elapsedSeconds = 0;
    this.timerEl.textContent = '00:00';
  }

  formatTime(totalSec) {
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  showToast(msg) {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, 2800);
  }

  /**
   * 胜局结算弹窗
   */
  showWinModal(isPlayerWin, customSubtitle = '') {
    const titleEl = document.getElementById('winModalTitle');
    const subtitleEl = document.getElementById('winModalSubtitle');
    const turnsEl = document.getElementById('winModalTurns');
    const timeEl = document.getElementById('winModalTime');
    const modeEl = document.getElementById('winModalMode');

    if (this.isPvP()) {
      const winnerName = this.winner === BLACK ? '黑方 (先手)' : '白方 (后手)';
      titleEl.innerHTML = `🏆 【${winnerName}】获胜！`;
      titleEl.className = 'win-title player-win';
      subtitleEl.textContent = customSubtitle || '双人同屏对弈精妙绝伦，恭喜胜出！';
      modeEl.textContent = '双人同屏 (人人对弈)';
    } else {
      if (isPlayerWin) {
        titleEl.innerHTML = '🏆 棋高一着 · 恭喜获胜！';
        titleEl.className = 'win-title player-win';
        subtitleEl.textContent = customSubtitle || '妙手连连，成功击败对手！';
      } else {
        titleEl.innerHTML = '⚔️ 棋局落幕 · AI 获胜';
        titleEl.className = 'win-title player-lose';
        subtitleEl.textContent = customSubtitle || '弈道深远，胜败皆有趣，再来一局吧！';
      }

      modeEl.textContent = this.settings.aiEngine === 'llm'
        ? `大模型 (${this.settings.llmConfig.model})`
        : `本地算法 (${this.getDifficultyLabel(this.settings.difficulty)})`;
    }

    turnsEl.textContent = `${this.moveHistory.length} 步`;
    timeEl.textContent = this.formatTime(this.elapsedSeconds);

    this.winModal.classList.add('active');
  }

  /**
   * 设置弹窗相关事件与同步
   */
  syncSettingsToUI() {
    this.difficultySelect.value = this.settings.difficulty;
    this.engineSelect.value = this.settings.aiEngine;
    this.updateSoundButton();
    this.updateEngineBadge();

    // 模态框内的表单项
    const aiEngineRadio = document.querySelector(`input[name="cfgAiEngine"][value="${this.settings.aiEngine}"]`);
    if (aiEngineRadio) aiEngineRadio.checked = true;

    const playerColorRadio = document.querySelector(`input[name="cfgPlayerColor"][value="${this.settings.playerColor}"]`);
    if (playerColorRadio) playerColorRadio.checked = true;

    const difficultyRadio = document.querySelector(`input[name="cfgDifficulty"][value="${this.settings.difficulty}"]`);
    if (difficultyRadio) difficultyRadio.checked = true;

    const checkDoubleThree = document.getElementById('cfgCheckDoubleThree');
    if (checkDoubleThree) checkDoubleThree.checked = this.settings.checkDoubleThree;

    const checkDoubleFour = document.getElementById('cfgCheckDoubleFour');
    if (checkDoubleFour) checkDoubleFour.checked = this.settings.checkDoubleFour !== false;

    const showForbiddenMarks = document.getElementById('cfgShowForbiddenMarks');
    if (showForbiddenMarks) showForbiddenMarks.checked = this.settings.showForbiddenMarks;

    // LLM 相关表单
    const llmProvider = document.getElementById('cfgLlmProvider');
    const llmBaseUrl = document.getElementById('cfgLlmBaseUrl');
    const llmApiKey = document.getElementById('cfgLlmApiKey');
    const llmModel = document.getElementById('cfgLlmModel');
    const llmPersona = document.getElementById('cfgLlmPersona');

    if (llmProvider) llmProvider.value = this.settings.llmConfig.provider || 'deepseek';
    if (llmBaseUrl) llmBaseUrl.value = this.settings.llmConfig.baseUrl || '';
    if (llmApiKey) llmApiKey.value = this.settings.llmConfig.apiKey || '';
    if (llmModel) llmModel.value = this.settings.llmConfig.model || '';
    if (llmPersona) llmPersona.value = this.settings.llmConfig.persona || 'humorous';

    this.toggleLlmConfigSection(this.settings.aiEngine === 'llm');
  }

  toggleLlmConfigSection(show) {
    const section = document.getElementById('llmConfigSection');
    if (section) {
      section.style.display = show ? 'block' : 'none';
    }
  }

  initSettingsModalEvents() {
    // 引擎切换
    document.querySelectorAll('input[name="cfgAiEngine"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.toggleLlmConfigSection(e.target.value === 'llm');
      });
    });

    // 模型服务商下拉选择联动
    const providerSelect = document.getElementById('cfgLlmProvider');
    providerSelect?.addEventListener('change', (e) => {
      const preset = PROVIDER_PRESETS[e.target.value];
      if (preset) {
        document.getElementById('cfgLlmBaseUrl').value = preset.baseUrl;
        document.getElementById('cfgLlmModel').value = preset.defaultModel;
      }
    });

    // API Key 明文/密文切换
    const btnToggleKey = document.getElementById('btnToggleKeyVisibility');
    const inputKey = document.getElementById('cfgLlmApiKey');
    btnToggleKey?.addEventListener('click', () => {
      inputKey.type = inputKey.type === 'password' ? 'text' : 'password';
      btnToggleKey.textContent = inputKey.type === 'password' ? '👁️ 显示' : '🔒 隐藏';
    });

    // 测试连接按键
    const btnTestLlm = document.getElementById('btnTestLlm');
    const testResultEl = document.getElementById('llmTestResult');
    btnTestLlm?.addEventListener('click', async () => {
      const config = {
        baseUrl: document.getElementById('cfgLlmBaseUrl').value,
        apiKey: document.getElementById('cfgLlmApiKey').value,
        model: document.getElementById('cfgLlmModel').value
      };
      testResultEl.textContent = '正在发起测试握手...';
      testResultEl.className = 'test-result testing';

      const res = await testLLMConnection(config);
      testResultEl.textContent = res.message;
      testResultEl.className = `test-result ${res.success ? 'success' : 'fail'}`;
    });

    // 保存设置按钮
    document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
      const engine = document.querySelector('input[name="cfgAiEngine"]:checked')?.value || 'local';
      const playerColor = Number(document.querySelector('input[name="cfgPlayerColor"]:checked')?.value || 1);
      const difficulty = document.querySelector('input[name="cfgDifficulty"]:checked')?.value || 'medium';
      const checkDoubleThree = document.getElementById('cfgCheckDoubleThree')?.checked ?? true;
      const checkDoubleFour = document.getElementById('cfgCheckDoubleFour')?.checked ?? true;
      const showForbiddenMarks = document.getElementById('cfgShowForbiddenMarks')?.checked ?? true;

      const llmConfig = {
        provider: document.getElementById('cfgLlmProvider')?.value || 'deepseek',
        baseUrl: document.getElementById('cfgLlmBaseUrl')?.value || '',
        apiKey: document.getElementById('cfgLlmApiKey')?.value || '',
        model: document.getElementById('cfgLlmModel')?.value || '',
        persona: document.getElementById('cfgLlmPersona')?.value || 'humorous'
      };

      const colorChanged = this.settings.playerColor !== playerColor;
      const modeChanged = this.settings.aiEngine !== engine;

      this.settings = {
        ...this.settings,
        aiEngine: engine,
        playerColor,
        difficulty,
        checkDoubleThree,
        checkDoubleFour,
        showForbiddenMarks,
        llmConfig
      };

      StorageManager.saveSettings(this.settings);
      this.goban.options.showForbiddenMarks = showForbiddenMarks;
      this.difficultySelect.value = difficulty;
      this.engineSelect.value = engine;
      this.updateEngineBadge();

      this.settingsModal.classList.remove('active');
      this.showToast('设置已保存');

      if ((colorChanged || modeChanged) && confirm('对弈模式或执棋方已发生变动，是否立即重新开局？')) {
        this.startNewGame();
      }
    });
  }

  openSettingsModal() {
    this.syncSettingsToUI();
    this.settingsModal.classList.add('active');
  }

  openHistoryModal() {
    this.renderHistoryList();
    this.historyModal.classList.add('active');
  }

  openRulesModal() {
    this.rulesModal.classList.add('active');
  }

  renderHistoryList() {
    const stats = StorageManager.getStats();
    const history = StorageManager.getHistory();

    const winRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 0;
    document.getElementById('histTotal').textContent = stats.total;
    document.getElementById('histWins').textContent = stats.wins;
    document.getElementById('histLosses').textContent = stats.losses;
    document.getElementById('histWinRate').textContent = `${winRate}%`;
    document.getElementById('histStreak').textContent = stats.maxStreak;

    const listEl = document.getElementById('historyListContainer');
    if (!listEl) return;

    if (history.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">暂无对局历史记录，快去下两盘吧！</div>';
      return;
    }

    listEl.innerHTML = history.map(item => {
      const isWin = item.result === 'win';
      const isDraw = item.result === 'draw';
      const badgeClass = isWin ? 'win' : isDraw ? 'draw' : 'lose';
      const badgeText = isWin ? '获胜' : isDraw ? '平局' : '惜败';

      const canReview = Array.isArray(item.moves) && item.moves.length > 0;

      return `
        <div class="history-item">
          <div class="history-left">
            <span class="history-result ${badgeClass}">${badgeText}</span>
            <div class="history-meta">
              <span class="history-date">${item.date}</span>
              <span class="history-desc">执${item.playerColor} · 对手：${item.aiMode} (${item.modelName || item.difficulty})</span>
            </div>
          </div>
          <div class="history-right">
            <span class="history-steps">${item.turns} 步</span>
            <span class="history-time">${item.duration}</span>
            ${canReview
              ? `<button class="btn-review" data-review="${item.id}">🔍 复盘此局</button>`
              : '<span class="btn-review disabled" title="该局未保存完整棋谱，无法回放">无棋谱</span>'}
          </div>
        </div>
      `;
    }).join('');
  }
}

// 页面加载完成后启动
window.addEventListener('DOMContentLoaded', () => {
  window.app = new GomokuApp();
});
