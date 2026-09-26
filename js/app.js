/**
 * 五子棋主控制器 (Application Main Coordinator)
 * 调度：棋盘交互、游戏主流程、AI落子、禁手判定、悔棋、战绩记录、音效
 */

import { BOARD_SIZE, EMPTY, BLACK, WHITE, checkWin, checkForbidden, isBoardFull } from './rules.js';
import { coordToNotation, getBestMove, getCandidateMoves } from './engine.js';
import { getLLMMove, testLLMConnection, PROVIDER_PRESETS, AI_PERSONAS } from './llm.js';
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

    // DOM 元素
    this.cacheElements();

    // 棋盘 Canvas 实例
    this.goban = new Goban(this.canvasEl, {
      showCoordinates: true,
      showForbiddenMarks: this.settings.showForbiddenMarks
    });
    this.goban.onCellClick = (r, c) => this.handlePlayerClick(r, c);

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

      // 检查先手黑棋三三禁手
      if (currentColor === BLACK && this.settings.checkDoubleThree) {
        const forbidden = checkForbidden(this.board, r, c, {
          checkDoubleThree: true,
          checkDoubleFour: false,
          checkOverline: true
        });

        if (forbidden.isForbidden) {
          sound.playWarning();
          this.showToast(`⚠️ ${forbidden.reason || '先手三三禁手，此步违规不可落子！'}`);
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

      // 检查先手三三禁手限制
      if (this.playerColor === BLACK && this.settings.checkDoubleThree) {
        const forbidden = checkForbidden(this.board, r, c, {
          checkDoubleThree: true,
          checkDoubleFour: false,
          checkOverline: true
        });

        if (forbidden.isForbidden) {
          sound.playWarning();
          this.showToast(`⚠️ ${forbidden.reason || '先手三三禁手，此步违规不可落子！'}`);
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
    this.moveHistory.push({ r, c, color, notation, comment });

    sound.playPlaceStone();

    // 计算禁手标记
    const forbidden = this.turn === WHITE && this.settings.checkDoubleThree
      ? this.calculateForbiddenPoints()
      : [];

    this.goban.setBoardState(this.board, { r, c, color }, null, forbidden);
    this.goban.setTurn(color === BLACK ? WHITE : BLACK);

    this.stepCountEl.textContent = this.moveHistory.length;
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
        const candidates = getCandidateMoves(this.board, this.aiColor, 5, this.aiColor === BLACK && this.settings.checkDoubleThree);
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
          checkDoubleThree: this.settings.checkDoubleThree
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
      this.goban.setBoardState(this.board, { r: lastR, c: lastC, color: lastColor }, winResult.winLine, []);

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

    const forbidden = this.turn === BLACK && this.settings.checkDoubleThree
      ? this.calculateForbiddenPoints()
      : [];

    this.goban.setBoardState(this.board, previousMove, null, forbidden);
    this.goban.setTurn(this.turn);
    this.goban.setLocked(false);

    this.stepCountEl.textContent = this.moveHistory.length;
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
      checkDoubleThree: currentHintColor === BLACK && this.settings.checkDoubleThree
    });

    if (best) {
      const hintPlayer = currentHintColor === BLACK ? '黑方' : '白方';
      this.showToast(`💡 建议点位：${best.notation}（为【${hintPlayer}】推荐，得分: ${Math.round(best.score)}）`);
      this.goban.hoverPos = { r: best.r, c: best.c };
      this.goban.render();
    }
  }

  /**
   * 计算黑棋当前所有三三禁手点
   */
  calculateForbiddenPoints() {
    if (!this.settings.checkDoubleThree) return [];
    const forbiddenList = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (this.board[r][c] === EMPTY) {
          const res = checkForbidden(this.board, r, c, {
            checkDoubleThree: true,
            checkDoubleFour: false,
            checkOverline: true
          });
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
