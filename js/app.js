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
import { getLLMMove, testLLMConnection, requestDeepAnalysis, renderBoardAscii, PROVIDER_PRESETS, AI_PERSONAS, AI_PLAYSTYLES } from './llm.js?v=2026.10.29-dual-llm-v1';
import { searchPro, boardToFlat } from './engine-pro.js';
import {
  generateSyncCode,
  normalizeSyncCode,
  isValidSyncCode,
  getSavedSyncCode,
  saveSyncCode,
  forgetSyncCode,
  isAutoSyncEnabled,
  setAutoSyncEnabled,
  pushSettings,
  pullSettings,
  deleteSettings,
  mergeSettings
} from './sync.js?v=2026.10.29-dual-llm-v1';
import { sound } from './audio.js';
import { StorageManager } from './storage.js?v=2026.10.29-dual-llm-v1';
import { Goban } from './board.js';
import { api } from './api.js';

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

    // 联机对战状态
    this.onlineGame = null;    // 当前联机对局对象；null 表示不在联机模式
    this.pollTimer = null;     // 轮询定时器
    this.pollBusy = false;     // 防重入
    this.currentUser = null;   // 登录用户
    this.lastMoveCount = 0;    // 已渲染到第几手（增量拉取用）

    // 局面代际：悔棋 / 重开 / 切局时 +1，用来作废所有「进行中」的 AI 请求。
    // 没有它的话，悔棋后 AI 的旧响应会照样落子，甚至覆盖掉已有的棋子。
    this.moveGen = 0;

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
    this.analysisCache = new Map(); // key: `${来源}-${m|p}${手数}`，如 live-m5 / g1727-m9
    this.deepCache = new Map();     // key: 同上 → { text, model }
    this.lastAnalysis = null;       // 当前展示的分析 { kind, scopeKey, moveNo, data, deep, deepError, deepLoading }
    this.analyzing = false;
    this.deepAnalyzing = false;
    this.statusShowsReplay = false;

    // 跨设备配置同步
    this.syncBusy = false;
    this.pendingSyncToast = '';

    // DOM 元素
    this.cacheElements();

    // 棋盘 Canvas 实例
    this.goban = new Goban(this.canvasEl, {
      showCoordinates: true,
      showForbiddenMarks: this.settings.showForbiddenMarks,
      showMoveNumbers: this.settings.showMoveNumbers !== false
    });
    this.goban.onCellClick = (r, c) => this.handlePlayerClick(r, c);
    this.goban.onCellInspect = (r, c) => this.handleInspectClick(r, c);

    // 绑定 UI 事件
    this.bindEvents();

    // 同步设置到 UI 界面
    this.syncSettingsToUI();
    this.updateStatsBar();

    // 先尝试套用云端较新的配置，再自动开启第一局
    this.bootApp();
  }

  /**
   * 异步启动：自动同步（若已绑定同步码）→ 开第一局
   */
  async bootApp() {
    try {
      await this.autoPullSettings();
    } catch (err) {
      console.warn('自动同步设置失败：', err);
    }
    this.selectedColor = Number(this.settings.playerColor) === WHITE ? WHITE : BLACK;
    this.updateStartColorSelection();
    this.startNewGame();
    if (this.pendingSyncToast) {
      this.showToast(this.pendingSyncToast);
      this.pendingSyncToast = '';
    }
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

    // 棋谱轨迹与局势分析标签页
    this.tabBtnReplay = document.getElementById('tabBtnReplay');
    this.tabBtnAnalysis = document.getElementById('tabBtnAnalysis');
    this.tabPaneReplay = document.getElementById('tabPaneReplay');
    this.tabPaneAnalysis = document.getElementById('tabPaneAnalysis');

    // 备用大模型配置元素
    this.cfgBackupLlmProvider = document.getElementById('cfgBackupLlmProvider');
    this.cfgBackupLlmBaseUrl = document.getElementById('cfgBackupLlmBaseUrl');
    this.cfgBackupLlmApiKey = document.getElementById('cfgBackupLlmApiKey');
    this.cfgBackupLlmModel = document.getElementById('cfgBackupLlmModel');
    this.cfgBackupLlmPersona = document.getElementById('cfgBackupLlmPersona');
    this.cfgBackupLlmPlaystyle = document.getElementById('cfgBackupLlmPlaystyle');
    this.cfgBackupLlmTemperature = document.getElementById('cfgBackupLlmTemperature');
    this.cfgBackupTempDisplay = document.getElementById('cfgBackupTempDisplay');
    this.btnToggleBackupKeyVisibility = document.getElementById('btnToggleBackupKeyVisibility');

    // 跨设备配置同步（设置弹窗内）
    this.syncSection = document.getElementById('syncSection');
    this.syncCodeInput = document.getElementById('syncCodeInput');
    this.btnSyncNewCode = document.getElementById('btnSyncNewCode');
    this.btnSyncUpload = document.getElementById('btnSyncUpload');
    this.btnSyncDownload = document.getElementById('btnSyncDownload');
    this.btnSyncCopy = document.getElementById('btnSyncCopy');
    this.btnSyncDelete = document.getElementById('btnSyncDelete');
    this.syncStatusEl = document.getElementById('syncStatus');
    this.cfgSyncAuto = document.getElementById('cfgSyncAuto');

    // 难度与引擎快捷选择
    this.difficultySelect = document.getElementById('difficultySelect');
    this.engineSelect = document.getElementById('engineSelect');

    // 开局面板（先手选择 + 正式开始）
    this.startOverlay = document.getElementById('startOverlay');
    this.startColorGroup = document.getElementById('startColorGroup');
    this.btnStartGame = document.getElementById('btnStartGame');
    this.startColorBtns = this.startColorGroup
      ? Array.from(this.startColorGroup.querySelectorAll('.start-color-btn'))
      : [];
    this.selectedColor = BLACK;

    // 弹窗
    this.settingsModal = document.getElementById('settingsModal');
    this.historyModal = document.getElementById('historyModal');
    this.rulesModal = document.getElementById('rulesModal');
    this.winModal = document.getElementById('winModal');
    this.toastEl = document.getElementById('toast');

    // 登录与认证元素
    this.authOverlay = document.getElementById('authOverlay');
    this.authCard = document.getElementById('authCard');
    this.authPinInput = document.getElementById('authPinInput');
    this.authRememberMe = document.getElementById('authRememberMe');
    this.btnUnlockApp = document.getElementById('btnUnlockApp');
    this.authErrorMsg = document.getElementById('authErrorMsg');
    this.btnLockApp = document.getElementById('btnLockApp');
  }

  switchReplayAnalysisTab(tab) {
    if (tab === 'analysis') {
      if (this.tabBtnAnalysis) this.tabBtnAnalysis.classList.add('active');
      if (this.tabBtnReplay) this.tabBtnReplay.classList.remove('active');
      if (this.tabPaneAnalysis) this.tabPaneAnalysis.style.display = 'block';
      if (this.tabPaneReplay) this.tabPaneReplay.style.display = 'none';
    } else {
      if (this.tabBtnReplay) this.tabBtnReplay.classList.add('active');
      if (this.tabBtnAnalysis) this.tabBtnAnalysis.classList.remove('active');
      if (this.tabPaneReplay) this.tabPaneReplay.style.display = 'block';
      if (this.tabPaneAnalysis) this.tabPaneAnalysis.style.display = 'none';
    }
  }

  bindEvents() {
    // 棋谱轨迹与局势分析标签页切换
    this.tabBtnReplay?.addEventListener('click', () => this.switchReplayAnalysisTab('replay'));
    this.tabBtnAnalysis?.addEventListener('click', () => this.switchReplayAnalysisTab('analysis'));

    // 密码认证体系
    this.initAuth();

    // 开局面板：先手选择与正式开始
    this.bindStartOverlayEvents();

    // 基础控制
    this.btnNewGame.addEventListener('click', () => this.requestNewGame());
    this.btnUndo.addEventListener('click', () => this.handleUndo());
    this.btnResign.addEventListener('click', () => this.handleResign());
    this.btnHint.addEventListener('click', () => this.handleHint());

    // 快捷切换
    this.difficultySelect.addEventListener('change', (e) => {
      this.settings.difficulty = e.target.value;
      this.persistSettings();
      this.showToast(`已切换为：${this.getDifficultyLabel(e.target.value)}`);
    });

    this.engineSelect.addEventListener('change', (e) => {
      this.settings.aiEngine = e.target.value;
      this.persistSettings();
      this.updateEngineBadge();
      this.updateSideCard();
      const label = e.target.value === 'pvp'
        ? '双人同屏对弈 (人人模式)'
        : (e.target.value === 'llm' ? '大模型对弈模式' : '本地算法模式');
      this.showToast(`已切换为：${label}`);
      this.requestNewGame();
    });

    // 顶部导航栏快捷切换棋风偏好
    const quickPlaystyleSelect = document.getElementById('quickPlaystyleSelect');
    quickPlaystyleSelect?.addEventListener('change', (e) => {
      this.settings.llmConfig.playstyle = e.target.value;
      this.persistSettings();
      this.updateSideCard();
      const styleName = AI_PLAYSTYLES[e.target.value]?.name || '天马行空';
      this.showToast(`棋风已切换为：${styleName}`);
    });

    // 静音切换
    this.btnSoundToggle.addEventListener('click', () => {
      const current = sound.isMuted();
      sound.setMuted(!current);
      this.settings.soundEnabled = current;
      this.persistSettings();
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

    // 跨设备配置同步
    this.bindSettingsSyncEvents();

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
      this.requestNewGame();
    });
    document.getElementById('btnWinModalViewHistory')?.addEventListener('click', () => {
      this.winModal.classList.remove('active');
      this.openHistoryModal();
    });
  }

  /**
   * 认证体系：用户名 + 密码，会话由服务端 HttpOnly Cookie 承载
   */
  async initAuth() {
    this.authUsername = document.getElementById('authUsername');
    this.authPassword = document.getElementById('authPassword');
    this.authTitle = document.getElementById('authTitle');
    this.authDesc = document.getElementById('authDesc');
    this.authMode = 'login';
    this.currentUser = null;
    this.authBusy = false;

    this.btnUnlockApp?.addEventListener('click', () => this.handleLogin());
    this.authPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleLogin();
    });
    this.authUsername?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.authPassword?.focus();
    });
    this.btnLockApp?.addEventListener('click', () => this.handleLogout());

    const savedName = localStorage.getItem('gomoku_username');
    if (savedName && this.authUsername) {
      this.authUsername.value = savedName;
      setTimeout(() => this.authPassword?.focus(), 50);
    }

    // 系统里还没有账号时，切换成「创建首个管理员」模式
    try {
      const st = await api.bootstrapStatus();
      if (st && st.needBootstrap) {
        this.authMode = 'bootstrap';
        if (this.authTitle) this.authTitle.textContent = '首次使用 · 创建管理员';
        if (this.authDesc) this.authDesc.textContent = '系统里还没有任何账号，请创建第一个管理员';
        if (this.btnUnlockApp) this.btnUnlockApp.textContent = '创建管理员并进入';
      }
    } catch (e) {
      /* 后端不可用时先不拦，登录那一刻再报错 */
    }

    // 已有有效会话则识别用户
    try {
      const res = await api.me();
      if (res && res.user) {
        this.applyUser(res.user);
      }
    } catch (e) {
      /* 未登录或单机使用，直接放行 */
    }

    // 单页面无跳转模式：无论后端是否配置了会话，未登录一律直接给予默认本地用户，保证随时能下棋
    if (!this.currentUser) {
      this.applyUser({ id: 'local_player', username: 'player', displayName: '棋友', role: 'user' });
    }

    // 直接放行进入棋盘，不弹登录遮罩
    document.documentElement.classList.add('app-unlocked');
    if (this.authOverlay) this.authOverlay.style.display = 'none';
  }

  applyUser(user) {
    this.currentUser = user;
    const label = user ? `${user.displayName}${user.role === 'admin' ? ' · 管理员' : ''}` : '';
    const navUser = document.getElementById('navUser');
    if (navUser) navUser.textContent = label;
    const lobbyText = document.getElementById('lobbyUserText');
    if (lobbyText) lobbyText.textContent = label ? `👤 ${label}` : '';
    document.querySelectorAll('#btnAdmin, #btnLobbyAdmin').forEach((b) => {
      if (b) b.hidden = !(user && user.role === 'admin');
    });
  }

  async handleLogin() {
    if (this.authBusy) return;

    const username = (this.authUsername?.value || '').trim();
    const password = this.authPassword?.value || '';
    const errEl = this.authErrorMsg;

    const fail = (msg) => {
      if (errEl) errEl.textContent = msg;
      if (this.authCard) {
        this.authCard.classList.remove('shake');
        void this.authCard.offsetWidth;
        this.authCard.classList.add('shake');
      }
    };

    if (!username || !password) return fail('请输入用户名和密码');
    if (password.length < 6) return fail('密码至少 6 位');

    this.authBusy = true;
    if (this.btnUnlockApp) this.btnUnlockApp.disabled = true;
    if (errEl) errEl.textContent = this.authMode === 'bootstrap' ? '正在创建管理员…' : '正在登录…';

    try {
      const fn = this.authMode === 'bootstrap' ? api.bootstrap : api.login;
      const res = await fn(username, password);

      localStorage.setItem('gomoku_session', '1');
      if (this.authRememberMe?.checked) localStorage.setItem('gomoku_username', username);
      else localStorage.removeItem('gomoku_username');

      this.applyUser(res.user);
      this.afterLogin();
      this.showToast(`✅ 欢迎，${res.user.displayName}`);
    } catch (err) {
      fail(err.message || '登录失败');
    } finally {
      this.authBusy = false;
      if (this.btnUnlockApp) this.btnUnlockApp.disabled = false;
    }
  }

  afterLogin() {
    document.documentElement.classList.add('app-unlocked');
    if (this.authOverlay) this.authOverlay.style.display = 'none';
    this.enterAIMode();
  }

  async handleLogout() {
    try {
      await api.logout();
    } catch (e) {
      /* 忽略 */
    }
    localStorage.removeItem('gomoku_session');
    this.stopPolling();
    location.reload();
  }

  /* ==================== 对局大厅 ==================== */

  showLobby() {
    const lobby = document.getElementById('lobbyOverlay');
    if (lobby) lobby.hidden = false;
    // 回到大厅 = 不在对局中，恢复顶部导航与战绩横幅
    this.syncGameChrome();
    this.bindLobbyEventsOnce();
    this.refreshLobby();
  }

  hideLobby() {
    const lobby = document.getElementById('lobbyOverlay');
    if (lobby) lobby.hidden = true;
  }

  bindLobbyEventsOnce() {
    if (this.lobbyBound) return;
    this.lobbyBound = true;

    document.getElementById('btnLobbyLogout')?.addEventListener('click', () => this.handleLogout());
    document.getElementById('btnLobbyAdmin')?.addEventListener('click', () => this.openAdminModal());
    document.getElementById('btnAdmin')?.addEventListener('click', () => this.openAdminModal());
    document.getElementById('btnLobby')?.addEventListener('click', () => this.leaveToLobby());

    const group = document.getElementById('lobbyColorGroup');
    group?.addEventListener('click', (e) => {
      const btn = e.target.closest('.lobby-color-btn');
      if (!btn) return;
      group.querySelectorAll('.lobby-color-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });

    document.getElementById('btnCreateGame')?.addEventListener('click', () => this.createOnlineGame());
    document.getElementById('btnJoinGame')?.addEventListener('click', () => this.joinOnlineGame());
    document.getElementById('lobbyRoomInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinOnlineGame();
    });
    document.getElementById('btnPlayAI')?.addEventListener('click', () => this.enterAIMode());
    document.getElementById('btnAdminCreate')?.addEventListener('click', () => this.adminCreateUser());
  }

  async refreshLobby() {
    const myEl = document.getElementById('lobbyMyGames');
    const waitEl = document.getElementById('lobbyWaiting');
    const onlineEl = document.getElementById('lobbyOnline');

    try {
      const [mine, lobby] = await Promise.all([api.listGames(), api.lobby()]);
      this.renderMyGames(mine.games || []);
      this.renderWaiting(lobby.waiting || []);
      this.renderOnline(lobby.online || []);
    } catch (err) {
      if (err.status === 401) {
        this.handleLogout();
        return;
      }
      const msg = `<p class="lobby-empty">加载失败：${this.esc(err.message)}</p>`;
      if (myEl) myEl.innerHTML = msg;
      if (waitEl) waitEl.innerHTML = msg;
      if (onlineEl) onlineEl.innerHTML = '';
    }
  }

  renderMyGames(games) {
    const el = document.getElementById('lobbyMyGames');
    if (!el) return;
    if (!games.length) {
      el.innerHTML = '<p class="lobby-empty">还没有对局，创建一个房间吧</p>';
      return;
    }

    el.innerHTML = games
      .map((g) => {
        const opp = g.myColor === 'black' ? g.whiteName || '等待对手' : g.blackName || '等待对手';
        const meLabel = g.myColor === 'black' ? '黑' : '白';
        let statusText;
        let cls;
        if (g.status === 'waiting') {
          statusText = '等待对手加入';
          cls = 'wait';
        } else if (g.status === 'playing') {
          statusText = g.turn === g.myColor ? '轮到你落子' : '等待对方落子';
          cls = 'play';
        } else {
          const w = g.winner === 'draw' ? '和棋' : g.winner === g.myColor ? '你赢了' : '你输了';
          statusText = `${w}${g.winReason ? ` · ${g.winReason}` : ''}`;
          cls = 'done';
        }
        return `<div class="lobby-item">
          <div class="lobby-item-main">
            <span class="lobby-item-title">${this.esc(opp)}</span>
            <span class="lobby-item-sub">你执${meLabel} · ${g.moveCount} 手 · 房间 ${this.esc(g.roomCode)}</span>
          </div>
          <div class="lobby-item-side">
            <span class="lobby-status lobby-status-${cls}">${statusText}</span>
            <button type="button" class="btn btn-outline-sm" data-enter="${g.id}">${g.status === 'finished' ? '查看' : '进入'}</button>
          </div>
        </div>`;
      })
      .join('');

    el.querySelectorAll('[data-enter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.enter);
        const g = games.find((x) => x.id === id);
        if (g) this.enterOnlineGame(g);
      });
    });
  }

  renderWaiting(list) {
    const el = document.getElementById('lobbyWaiting');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="lobby-empty">暂时没有等待中的房间</p>';
      return;
    }
    el.innerHTML = list
      .map((g) => {
        const host = g.blackName || g.whiteName || '某位棋友';
        const side = g.blackName ? '执黑' : '执白';
        return `<div class="lobby-item">
          <div class="lobby-item-main">
            <span class="lobby-item-title">${this.esc(host)}</span>
            <span class="lobby-item-sub">${side} · 房间 ${this.esc(g.roomCode)}</span>
          </div>
          <div class="lobby-item-side">
            <button type="button" class="btn btn-outline-sm" data-room="${this.esc(g.roomCode)}">加入</button>
          </div>
        </div>`;
      })
      .join('');

    el.querySelectorAll('[data-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('lobbyRoomInput');
        if (input) input.value = btn.dataset.room;
        this.joinOnlineGame();
      });
    });
  }

  renderOnline(list) {
    const el = document.getElementById('lobbyOnline');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="lobby-empty">暂时没有其他在线玩家</p>';
      return;
    }
    el.innerHTML = list
      .map(
        (u) => `<div class="lobby-item">
          <div class="lobby-item-main"><span class="lobby-item-title">${this.esc(u.name)}</span></div>
          <div class="lobby-item-side"><span class="lobby-status lobby-status-play">在线</span></div>
        </div>`
      )
      .join('');
  }

  async createOnlineGame() {
    const active = document.querySelector('.lobby-color-btn.is-active');
    const myColor = active ? active.dataset.color : 'black';
    const btn = document.getElementById('btnCreateGame');
    if (btn) btn.disabled = true;

    try {
      const res = await api.createGame(myColor);
      this.showToast(`✅ 房间已创建：${res.game.roomCode}，把它发给对手吧`);
      this.enterOnlineGame(res.game);
    } catch (err) {
      this.showToast(`创建失败：${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async joinOnlineGame() {
    const input = document.getElementById('lobbyRoomInput');
    const code = (input?.value || '').trim().toUpperCase();
    if (code.length !== 6) {
      this.showToast('请输入 6 位房间码');
      return;
    }
    try {
      const res = await api.joinGame(code);
      if (input) input.value = '';
      this.enterOnlineGame(res.game);
    } catch (err) {
      this.showToast(`加入失败：${err.message}`);
    }
  }

  enterAIMode() {
    this.onlineGame = null;
    this.stopPolling();
    this.moveGen++; // 作废可能残留的 AI 请求
    this.hideLobby();
    if (this.startOverlay) this.startOverlay.hidden = false;
    if (this.goban) this.goban.setLocked(true);
    this.updateSideCard();
  }

  leaveToLobby() {
    this.onlineGame = null;
    this.stopPolling();
    // 离开对局 → 不再算「对局中」，顶部导航与战绩横幅恢复
    this.gameStatus = 'idle';
    this.showLobby();
  }

  /* ==================== 联机对战 ==================== */

  enterOnlineGame(game) {
    this.onlineGame = { id: game.id, roomCode: game.roomCode, myColor: game.myColor };
    this.hideLobby();
    this.hideStartOverlay();
    this.lastMoveCount = 0;
    this.applyOnlineGame(game, true);
    this.startPolling();
    this.showToast(`进入房间 ${game.roomCode}`);
  }

  /**
   * 把服务端对局状态合并到本地
   * @param {Object} game 服务端返回的 game（可能是增量：只含新落子）
   * @param {boolean} reset 是否重建棋盘
   */
  applyOnlineGame(game, reset = false) {
    const incoming = game.moves || [];

    if (reset) {
      this.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
      this.moveHistory = [];
      this.lastMoveCount = 0;
    }

    incoming.forEach((m) => {
      if (!this.board[m.r] || this.board[m.r][m.c] !== EMPTY) return;
      this.board[m.r][m.c] = m.color;
      this.moveHistory.push({
        r: m.r,
        c: m.c,
        color: m.color,
        notation: m.notation,
        comment: ''
      });
    });
    this.lastMoveCount = this.moveHistory.length;

    const prevStatus = this.gameStatus;

    this.playerColor = game.myColor === 'black' ? BLACK : WHITE;
    this.aiColor = this.playerColor === BLACK ? WHITE : BLACK;
    this.turn = game.turn === 'black' ? BLACK : WHITE;
    this.gameStatus = game.status === 'finished' ? 'ended' : 'playing';
    this.winner =
      game.winner === 'draw'
        ? 'draw'
        : game.winner === 'black'
          ? BLACK
          : game.winner === 'white'
            ? WHITE
            : null;

    // 保留 myColor / id 等本地字段，其余用服务端最新值覆盖
    this.onlineGame = {
      ...this.onlineGame,
      ...game,
      moves: undefined
    };

    if (reset) {
      this.resetReplayState();
      this.startTimer();
    }

    const last = this.moveHistory[this.moveHistory.length - 1];
    this.goban.setBoardState(
      this.board,
      last ? { r: last.r, c: last.c, color: last.color } : null,
      this.winningLine,
      [],
      [],
      this.moveHistory
    );
    this.goban.setTurn(this.turn);
    this.goban.setLocked(!this.isMyOnlineTurn());

    this.updateOnlineSideCard();
    this.updateStatus();
    this.renderMoveList();
    this.updateReplayUI();

    if (this.gameStatus === 'ended' && prevStatus !== 'ended') {
      this.onOnlineGameEnd();
    }
  }

  startPolling() {
    this.stopPolling();
    const tick = async () => {
      if (!this.onlineGame || this.pollBusy) return;
      this.pollBusy = true;
      try {
        const res = await api.getGame(this.onlineGame.id, this.lastMoveCount);
        const g = res.game;
        if (!g) return;

        const changed =
          g.totalMoves > this.lastMoveCount ||
          g.status !== this.onlineGame.status ||
          g.turn !== this.onlineGame.turn;

        if (changed) this.applyOnlineGame(g, false);
      } catch (err) {
        if (err.status === 401) {
          this.handleLogout();
          return;
        }
        if (err.status === 403 || err.status === 404) {
          this.showToast('对局已不可用，返回大厅');
          this.leaveToLobby();
          return;
        }
        // 其余（网络抖动等）忽略，下个周期重试
      } finally {
        this.pollBusy = false;
      }
    };
    this.pollTimer = setInterval(tick, 2000);
    tick();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async handleOnlineClick(r, c) {
    const g = this.onlineGame;
    if (!g || g.status !== 'playing') return;
    if (g.turn !== g.myColor) {
      this.showToast('还没轮到你落子');
      return;
    }

    const color = g.myColor === 'black' ? BLACK : WHITE;

    // 本地先校验黑棋禁手，减少无效请求（服务端仍会再验一次）
    if (color === BLACK && this.isForbiddenRuleOn()) {
      const fb = checkForbidden(this.board, r, c, this.forbiddenOptions());
      if (fb.isForbidden) {
        sound.playWarning();
        this.showToast(`⚠️ ${fb.reason}`);
        return;
      }
    }

    // 乐观更新，落子立刻可见
    this.board[r][c] = color;
    this.moveHistory.push({
      r,
      c,
      color,
      notation: coordToNotation(r, c),
      comment: ''
    });
    this.goban.setBoardState(this.board, { r, c, color }, null, [], [], this.moveHistory);
    this.goban.setLocked(true);
    sound.playPlaceStone();

    try {
      const res = await api.move(g.id, r, c);
      this.applyOnlineGame(res.game, false);
    } catch (err) {
      this.showToast(`落子被拒：${err.message}`);
      // 回滚到服务端真实状态
      try {
        const fresh = await api.getGame(g.id, 0);
        this.applyOnlineGame(fresh.game, true);
      } catch (e2) {
        /* 拉取也失败就先这样，下个轮询周期会纠正 */
      }
    }
  }

  async onlineResign() {
    const g = this.onlineGame;
    if (!g || g.status !== 'playing') return;
    if (!confirm('确定要认输吗？')) return;
    try {
      const res = await api.resign(g.id);
      this.applyOnlineGame(res.game, false);
    } catch (err) {
      this.showToast(`认输失败：${err.message}`);
    }
  }

  onOnlineGameEnd() {
    const g = this.onlineGame;
    if (!g) return;
    const iWon = g.winner === g.myColor;

    if (g.winner === 'draw' || !iWon) sound.playLose();
    else sound.playWin();

    const text =
      g.winner === 'draw'
        ? '和棋，势均力敌！'
        : iWon
          ? `恭喜获胜${g.winReason ? `（${g.winReason}）` : ''}`
          : `惜败${g.winReason ? `（${g.winReason}）` : ''}`;

    setTimeout(() => this.showWinModal(iWon, text), 500);
  }

  updateOnlineSideCard() {
    const g = this.onlineGame;
    if (!g) return;
    const titleEl = document.getElementById('aiCardTitle');
    const tagEl = document.querySelector('.ai-tag');
    const avatarEl = document.querySelector('.ai-avatar');
    const oppName =
      g.myColor === 'black' ? g.whiteName || '等待对手' : g.blackName || '等待对手';

    if (titleEl) titleEl.textContent = oppName;
    if (tagEl) tagEl.textContent = '联机对手';
    if (avatarEl) avatarEl.textContent = '🌐';
    if (this.aiSpeechTextEl) {
      this.aiSpeechTextEl.textContent =
        g.status === 'waiting'
          ? `房间号 ${g.roomCode}，等待对手加入…`
          : g.status === 'playing'
            ? this.isMyOnlineTurn()
              ? '轮到你落子'
              : '对方思考中…'
            : '对局已结束';
    }
  }

  /* ==================== 用户管理（管理员） ==================== */

  openAdminModal() {
    if (!this.currentUser || this.currentUser.role !== 'admin') {
      this.showToast('需要管理员权限');
      return;
    }
    const modal = document.getElementById('adminModal');
    if (modal) modal.classList.add('active');
    this.refreshAdminUsers();
  }

  async refreshAdminUsers() {
    const el = document.getElementById('adminUserList');
    const errEl = document.getElementById('adminError');
    if (errEl) errEl.textContent = '';

    try {
      const res = await api.listUsers();
      this.renderAdminUsers(res.users || []);
    } catch (err) {
      if (err.status === 403) {
        if (el) el.innerHTML = '<p class="lobby-empty">需要管理员权限</p>';
        return;
      }
      if (el) el.innerHTML = `<p class="lobby-empty">加载失败：${this.esc(err.message)}</p>`;
    }
  }

  renderAdminUsers(users) {
    const el = document.getElementById('adminUserList');
    if (!el) return;

    el.innerHTML = users
      .map((u) => {
        const isSelf = this.currentUser && u.id === this.currentUser.id;
        const last = u.lastLoginAt
          ? new Date(u.lastLoginAt).toLocaleString('zh-CN', { hour12: false })
          : '从未登录';
        return `<div class="admin-user-row">
          <div class="admin-user-main">
            <span class="admin-user-name">${this.esc(u.displayName)}${
              u.role === 'admin' ? ' <em>管理员</em>' : ''
            }</span>
            <span class="admin-user-sub">@${this.esc(u.username)} · ${u.gamesCount} 局 · 最近登录 ${last}</span>
          </div>
          <div class="admin-user-ops">
            <button type="button" class="btn btn-outline-sm" data-reset="${u.id}">重置密码</button>
            ${
              isSelf
                ? ''
                : `<button type="button" class="btn btn-outline-danger btn-sm" data-del="${u.id}">删除</button>`
            }
          </div>
        </div>`;
      })
      .join('');

    el.querySelectorAll('[data-reset]').forEach((b) =>
      b.addEventListener('click', () => this.adminResetPassword(Number(b.dataset.reset)))
    );
    el.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => this.adminDeleteUser(Number(b.dataset.del)))
    );
  }

  async adminCreateUser() {
    const nameEl = document.getElementById('adminNewName');
    const passEl = document.getElementById('adminNewPass');
    const roleEl = document.getElementById('adminNewRole');
    const errEl = document.getElementById('adminError');

    const username = (nameEl?.value || '').trim();
    const password = passEl?.value || '';
    const role = roleEl?.value || 'user';

    if (!username || password.length < 6) {
      if (errEl) errEl.textContent = '用户名必填，密码至少 6 位';
      return;
    }

    try {
      await api.createUser({ username, password, role });
      if (nameEl) nameEl.value = '';
      if (passEl) passEl.value = '';
      if (errEl) errEl.textContent = '';
      this.showToast(`✅ 已创建用户 ${username}`);
      this.refreshAdminUsers();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  }

  async adminResetPassword(id) {
    const pw = prompt('请输入新密码（至少 6 位）');
    if (pw === null) return;
    if (pw.length < 6) {
      this.showToast('密码至少 6 位');
      return;
    }
    try {
      await api.updateUser(id, { password: pw });
      this.showToast('✅ 密码已重置，该用户的登录状态已失效');
    } catch (err) {
      this.showToast(`重置失败：${err.message}`);
    }
  }

  async adminDeleteUser(id) {
    if (!confirm('确定删除该用户吗？此操作不可恢复。')) return;
    try {
      await api.deleteUser(id);
      this.showToast('✅ 用户已删除');
      this.refreshAdminUsers();
    } catch (err) {
      this.showToast(`删除失败：${err.message}`);
    }
  }

  /**
   * 「双人同屏」已下线（改为多账号联机对战）。
   * 这里恒返回 false，让历史上所有 isPvP() 分支自动走人机逻辑，
   * 避免遗漏调用点造成行为不一致。
   */
  isPvP() {
    return false;
  }

  /**
   * 是否处于联机对战（对手是另一个真人账号）
   */
  isOnline() {
    return !!this.onlineGame;
  }

  /** 联机模式下，当前是否轮到自己落子 */
  isMyOnlineTurn() {
    const g = this.onlineGame;
    if (!g) return false;
    return g.status === 'playing' && g.turn === g.myColor;
  }

  /* ---------------- 开局面板：先手选择 + 正式开始 ---------------- */

  bindStartOverlayEvents() {
    this.startColorBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedColor = Number(btn.dataset.color) === WHITE ? WHITE : BLACK;
        this.updateStartColorSelection();
        this.settings.playerColor = this.selectedColor;
        this.persistSettings();
        this.syncPlayerColorRadios();
      });
    });

    this.btnStartGame?.addEventListener('click', () => {
      // 确认选定先后手并正式新开一局
      this.settings.playerColor = this.selectedColor;
      this.persistSettings();
      this.syncPlayerColorRadios();
      this.startNewGame();
      this.showToast(`⚔️ 对局开始，你${this.selectedColor === BLACK ? '执黑先行' : '执白后行'}`);
    });
  }

  /**
   * 同步开局面板里先手选择的高亮状态与描述文案
   */
  updateStartColorSelection() {
    this.startColorBtns.forEach((btn) => {
      btn.classList.toggle('is-active', Number(btn.dataset.color) === this.selectedColor);
    });
    const desc = document.getElementById('setupColorDesc');
    if (desc) {
      desc.textContent = this.selectedColor === BLACK
        ? '先手执黑 · 受禁手限制'
        : '后手执白 · 无禁手限制 (AI先下)';
    }
  }

  /**
   * 把当前先手选择回显到设置弹窗的单选按钮上
   */
  syncPlayerColorRadios() {
    document.querySelectorAll('input[name="cfgPlayerColor"]').forEach((radio) => {
      radio.checked = Number(radio.value) === this.selectedColor;
    });
  }

  /**
   * 请求开始新对局：直接以当前选定的先后手开启，绝不弹出遮罩层（墨水屏无残影）
   */
  requestNewGame() {
    if (this.isOnline()) {
      if (confirm('离开当前联机对局并返回大厅？对局会保留，可稍后再进来。')) {
        this.leaveToLobby();
      }
      return;
    }

    this.startNewGame();
  }

  /**
   * 隐藏开局面板（已重构为常驻页面无弹窗，保留空实现兼容旧逻辑）
   */
  hideStartOverlay() {
    if (this.startOverlay) this.startOverlay.hidden = true;
  }

  /**
   * 开局面板是否正显示（当前已常驻页面无弹窗遮罩，恒返回 false）
   */
  isStartPanelOpen() {
    return false;
  }

  /**
   * 更新侧边栏 AI 卡片与对话人设信息
   */
  updateSideCard() {
    const titleEl = document.getElementById('aiCardTitle');
    const tagEl = document.querySelector('.ai-tag');
    const avatarEl = document.querySelector('.ai-avatar');
    const playstylePill = document.getElementById('aiPlaystylePill');

    if (this.isPvP()) {
      if (titleEl) titleEl.textContent = '双人对弈';
      if (tagEl) tagEl.textContent = '同屏轮流博弈';
      if (avatarEl) avatarEl.textContent = '👥';
      if (playstylePill) playstylePill.style.display = 'none';
      this.aiSpeechTextEl.textContent = '双人对弈已开启！黑方先行，双方轮流在同一屏幕落子，预祝棋逢对手！';
    } else {
      const isLLM = this.settings.aiEngine === 'llm';
      const persona = AI_PERSONAS[this.settings.llmConfig.persona] || AI_PERSONAS.humorous;
      const playstyle = AI_PLAYSTYLES[this.settings.llmConfig.playstyle] || AI_PLAYSTYLES.openmind;

      if (titleEl) titleEl.textContent = isLLM ? `AI · ${this.settings.llmConfig.model || '大模型'}` : 'AI 棋客';
      if (tagEl) tagEl.textContent = isLLM ? persona.name : '博弈对手';
      if (avatarEl) avatarEl.textContent = isLLM ? '🧠' : '🤖';

      if (playstylePill) {
        if (isLLM) {
          playstylePill.textContent = playstyle.tag || playstyle.name;
          playstylePill.style.display = 'inline-flex';
        } else {
          playstylePill.style.display = 'none';
        }
      }

      this.aiSpeechTextEl.textContent = isLLM
        ? `【${persona.name} · ${playstyle.name}】棋局已开，请阁下落子！`
        : '棋逢对手，请赐教！';
    }
  }

  /**
   * 开始新对局
   */
  startNewGame() {
    this.hideStartOverlay();

    this.moveGen++; // 作废上一局残留的 AI 请求

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
    this.goban.setBoardState(this.board, null, null, this.calculateForbiddenPoints(), [], this.moveHistory);
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
    if (!this.currentUser) {
      this.applyUser({ id: 'local_player', username: 'player', displayName: '棋友', role: 'user' });
    }
    if (this.gameStatus !== 'playing') return;
    if (this.board[r][c] !== EMPTY) return;

    // ===== 联机对战：走网络，等对手确认 =====
    if (this.isOnline()) {
      this.handleOnlineClick(r, c);
      return;
    }

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
    // 最后一道防线：绝不覆盖已有棋子。
    // 早先这里直接赋值，AI 的过期落子会把对手的棋子「吃掉」，导致盘面黑白数量失衡。
    if (!this.board[r] || this.board[r][c] !== EMPTY) {
      console.warn('executeMove: 目标位置已有棋子或越界，已忽略', r, c);
      return false;
    }

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

    this.goban.setBoardState(this.board, { r, c, color }, null, forbidden, [], this.moveHistory);
    this.goban.setTurn(color === BLACK ? WHITE : BLACK);
  }

  /**
   * AI 思考并落子
   */
  async triggerAIMove(isFirstMove = false) {
    // 记下当前局面代际：悔棋 / 重开会让它自增，届时本次思考的结果一律作废
    const gen = this.moveGen;

    this.goban.setLocked(true);
    this.statusTextEl.textContent = 'AI 正在精密计算中...';
    this.statusTextEl.classList.add('ai-thinking');

    try {
      let chosenMove;
      let aiComment = '';

      if (isFirstMove && this.settings.aiEngine !== 'llm') {
        // 本地引擎第一手默认落天元 H8 (低难度偶尔出奇)
        if (this.settings.difficulty === 'low' && Math.random() < 0.4) {
          const firstPool = [
            { r: 7, c: 7, notation: 'H8' },
            { r: 6, c: 7, notation: 'H9' },
            { r: 7, c: 6, notation: 'G8' },
            { r: 8, c: 6, notation: 'G7' }
          ];
          chosenMove = firstPool[Math.floor(Math.random() * firstPool.length)];
          aiComment = '首手落子，偏锋开局！';
        } else {
          chosenMove = { r: 7, c: 7, notation: 'H8' };
          aiComment = '天元启手，先占中宫！';
        }
      } else if (this.settings.aiEngine === 'llm') {
        // 大模型对弈：流式输出 + 双超时，战术棋风与自主开局（打破千篇一律的固定走法）
        const candidates = getCandidateMoves(this.board, this.aiColor, 12, this.aiColor === BLACK && this.isForbiddenRuleOn());
        let llmResult = await getLLMMove(
          this.settings.llmConfig,
          this.board,
          this.aiColor,
          this.moveHistory,
          candidates,
          {
            onProgress: (progress) => {
              // 玩家已悔棋 / 已切局 → 返回 false 通知上游中止流，别再往下算了
              if (gen !== this.moveGen) return false;
              if (this.gameStatus !== 'playing') return false;
              this.renderLLMProgress(progress);
              return true;
            }
          }
        );

        // 主模型异常且配置了备用大模型时，自动无缝接力
        const backupCfg = this.settings.backupLlmConfig;
        const hasBackupKey = backupCfg && backupCfg.apiKey && backupCfg.apiKey.trim();
        if (llmResult.isFallback && !llmResult.cancelled && hasBackupKey) {
          const bModel = backupCfg.model || '备用模型';
          this.showToast(`⚠️ 主模型未应答，正在无缝切换备用大模型（${bModel}）…`);
          const backupResult = await getLLMMove(
            backupCfg,
            this.board,
            this.aiColor,
            this.moveHistory,
            candidates,
            {
              onProgress: (progress) => {
                if (gen !== this.moveGen) return false;
                if (this.gameStatus !== 'playing') return false;
                this.renderLLMProgress({ ...progress, label: `备用模型 ${bModel} 思考中` });
                return true;
              }
            }
          );
          if (!backupResult.isFallback) {
            llmResult = backupResult;
            llmResult.usedBackup = true;
          }
        }

        chosenMove = { r: llmResult.r, c: llmResult.c, notation: llmResult.notation };
        aiComment = llmResult.comment;

        if (llmResult.usedBackup) {
          this.showToast(`🛡️ 备用模型（${this.settings.backupLlmConfig?.model}）接手成功`);
        } else if (llmResult.isFallback && !llmResult.cancelled) {
          this.showToast(`⚠️ 大模型未正常应答：${llmResult.comment}`);
        } else if (llmResult.timedOut) {
          const waited = Math.round((llmResult.elapsedMs || 0) / 1000);
          this.showToast(`⏱️ 大模型 ${waited} 秒无响应，已改由本地引擎代下这一手`);
        }
      } else if (this.settings.difficulty === 'pro') {
        // 职业级：Web Worker 后台深度搜索（VCF 杀棋 + 迭代加深），主线程不卡
        this.statusTextEl.textContent = 'AI 职业级深度思考中…';
        const proMove = await this.requestProMove(this.board, this.aiColor, {
          timeLimit: 1400,
          maxDepth: 8,
          forbidOptions: this.forbiddenOptions()
        });
        if (proMove) {
          chosenMove = proMove;
          aiComment = this.generateAlgorithmComment(proMove.score);
          if (proMove.reason && String(proMove.reason).indexOf('vcf') === 0) {
            aiComment = '已算到连续冲四的必胜路线，请小心！';
          }
        } else {
          // Worker 不可用或超时 → 回退到大师级，保证仍能落子
          chosenMove = getBestMove(this.board, this.aiColor, 'high', {
            checkBlackForbidden: this.aiColor === BLACK && this.isForbiddenRuleOn()
          });
          aiComment = this.generateAlgorithmComment(chosenMove.score);
        }
      } else {
        // 本地算法引擎
        await new Promise(res => setTimeout(res, 350 + Math.random() * 250)); // 自然拟人停顿
        chosenMove = getBestMove(this.board, this.aiColor, this.settings.difficulty, {
          checkBlackForbidden: this.aiColor === BLACK && this.isForbiddenRuleOn()
        });
        aiComment = this.generateAlgorithmComment(chosenMove.score);
      }

      // 落子前的三道校验：局面没被改过、确实轮到 AI、落点仍然空着。
      // 任一不满足就安静放弃这一手 —— 悔棋后玩家会自己继续下，AI 不该再插一脚。
      if (gen !== this.moveGen) return;
      if (this.gameStatus !== 'playing') return;
      if (this.turn !== this.aiColor) return;
      if (!this.board[chosenMove.r] || this.board[chosenMove.r][chosenMove.c] !== EMPTY) {
        console.warn('AI 落点已被占用，放弃这一手', chosenMove);
        this.turn = this.playerColor;
        this.goban.setLocked(false);
        this.updateStatus();
        return;
      }

      // 更新 AI 气泡对话
      if (aiComment) {
        this.aiSpeechTextEl.textContent = aiComment;
      }

      // 执行 AI 落子（executeMove 内部还有一道「不覆盖已有棋子」的防线）
      if (this.executeMove(chosenMove.r, chosenMove.c, this.aiColor, aiComment) === false) {
        this.turn = this.playerColor;
        this.goban.setLocked(false);
        this.updateStatus();
        return;
      }

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
      if (this.aiSpeechBubbleEl) this.aiSpeechBubbleEl.classList.remove('llm-streaming');
    }
  }

  /**
   * 渲染大模型流式思考进度
   * 状态栏显示计时与已接收字数（跳动的数字 = 模型还活着），气泡滚动显示最新输出片段
   * @param {{phase:'reasoning'|'answer', text:string, contentChars:number, reasoningChars:number, elapsedMs:number}} progress
   */
  renderLLMProgress(progress) {
    const sec = Math.max(1, Math.round((progress.elapsedMs || 0) / 1000));
    const totalChars = (progress.contentChars || 0) + (progress.reasoningChars || 0);
    const phaseLabel = progress.phase === 'reasoning' ? '深度推演中' : '正在组织落子';

    if (this.statusTextEl) {
      this.statusTextEl.textContent = `AI ${phaseLabel}… 已用 ${sec}s · 接收 ${totalChars} 字`;
    }

    if (this.aiSpeechBubbleEl) {
      this.aiSpeechBubbleEl.classList.add('llm-streaming');
    }
    if (this.aiSpeechTextEl && progress.text) {
      const limit = 80;
      const tail = progress.text.slice(-limit).replace(/\s+/g, ' ').trim();
      this.aiSpeechTextEl.textContent = (progress.text.length > limit ? '…' : '') + tail;
    }
  }

  /**
   * 惰性创建职业级搜索 Worker；不支持模块 Worker 的浏览器（部分电子书/旧内核）返回 null
   */
  ensureProWorker() {
    if (this.proWorker !== undefined) return this.proWorker;
    this.proWorker = null;
    try {
      const url = new URL('js/engine-worker.js', document.baseURI).href;
      const worker = new Worker(url, { type: 'module' });
      worker.onerror = () => {
        console.warn('职业级 Worker 出错，回退到主线程搜索');
        try { worker.terminate(); } catch (e) { /* ignore */ }
        if (this.proWorker === worker) this.proWorker = null;
      };
      this.proWorker = worker;
    } catch (e) {
      console.warn('Web Worker 不可用，职业级改用主线程同步搜索', e);
      this.proWorker = null;
    }
    return this.proWorker;
  }

  /**
   * 请求职业级着法：优先 Worker，失败/超时回退主线程，再不行返回 null 由调用方兜底
   */
  requestProMove(board, color, options = {}) {
    const timeLimit = options.timeLimit || 1400;
    return new Promise((resolve) => {
      const worker = this.ensureProWorker();

      if (!worker) {
        try {
          const mv = searchPro(board, color, { ...options, timeLimit: Math.min(900, timeLimit) });
          resolve(mv ? { r: mv.r, c: mv.c, notation: mv.notation, score: mv.score, depth: mv.depth, reason: mv.reason } : null);
        } catch (e) {
          console.error('职业级同步搜索失败:', e);
          resolve(null);
        }
        return;
      }

      const id = (this.proReqId = (this.proReqId || 0) + 1);
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        resolve(value);
      };

      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.id !== id) return;
        if (!data.ok || !data.move) return finish(null);
        finish({
          r: data.move.r,
          c: data.move.c,
          notation: data.move.notation,
          score: data.move.score,
          depth: data.move.depth,
          reason: data.move.reason
        });
      };

      // 兜底超时：Worker 卡死也不能让对局停摆
      const timer = setTimeout(() => finish(null), timeLimit + 3000);

      worker.addEventListener('message', onMessage);
      try {
        worker.postMessage({ id, flat: boardToFlat(board), color, options });
      } catch (e) {
        finish(null);
      }
    });
  }

  /**
   * 检查对局胜负或平局
   */
  checkGameEnd(lastR, lastC, lastColor) {
    const winResult = checkWin(this.board, lastR, lastC, lastColor);

    if (winResult.win) {
      this.gameStatus = 'ended';
      this.syncGameChrome();
      this.winner = lastColor;
      this.winningLine = winResult.winLine;
      this.stopTimer();
      this.goban.setLocked(true);

      if (!this.replay.active) {
        this.goban.setBoardState(this.board, { r: lastR, c: lastC, color: lastColor }, winResult.winLine, [], [], this.moveHistory);
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
      this.syncGameChrome();
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
   * 用 moveHistory 重建棋盘。
   * 棋盘状态只由历史唯一决定 —— 这样「悔棋 / 回放 / 读档」都不可能再和手数失步。
   * 历史里的 color 可能是数字（新数据）或 'black'/'white' 字符串（老数据），这里统一归一化。
   */
  rebuildBoardFromHistory() {
    const next = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
    for (const m of this.moveHistory) {
      if (!m || !Number.isInteger(m.r) || !Number.isInteger(m.c)) continue;
      if (m.r < 0 || m.r >= BOARD_SIZE || m.c < 0 || m.c >= BOARD_SIZE) continue;
      let v = m.color;
      if (v === 'black') v = BLACK;
      else if (v === 'white') v = WHITE;
      if (v === BLACK || v === WHITE) next[m.r][m.c] = v;
    }
    this.board = next;
    return next;
  }

  /**
   * 清理 moveHistory 中「同一落点出现多次」的脏数据。
   * 旧版本 executeMove 不判空位，AI 的过期落子会覆盖对手棋子，历史里就留下同点两条记录，
   * 于是「盘上子数」少于「手数」。保留每个落点的最后一次（与棋盘最终状态一致）。
   * @returns {number} 被移除的条数
   */
  sanitizeMoveHistory() {
    const lastAt = new Map();
    this.moveHistory.forEach((m, i) => lastAt.set(`${m.r},${m.c}`, i));
    const before = this.moveHistory.length;
    this.moveHistory = this.moveHistory.filter((m, i) => lastAt.get(`${m.r},${m.c}`) === i);
    return before - this.moveHistory.length;
  }

  /** 统计某一方在盘上的子数 */
  countColor(color) {
    let n = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (this.board[r][c] === color) n++;
      }
    }
    return n;
  }

  /**
   * 自检：盘上子数必须等于手数，且黑白数量满足先后手奇偶（黑 == 白 或 黑 == 白 + 1）。
   * 不满足说明还有别的路径在偷偷改棋盘 —— 直接报错，别让它静默烂下去。
   * @returns {boolean} 是否一致
   */
  assertBoardConsistency(tag = '') {
    let stones = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (this.board[r][c] !== EMPTY) stones++;
      }
    }
    const blk = this.countColor(BLACK);
    const wht = this.countColor(WHITE);
    const okCount = stones === this.moveHistory.length;
    const okParity = blk === wht || blk === wht + 1;
    if (!okCount || !okParity) {
      console.error(
        `[棋盘自检失败${tag ? ' @' + tag : ''}] 盘上 ${stones} 子（黑 ${blk} / 白 ${wht}），` +
        `手数 ${this.moveHistory.length}；子数${okCount ? '一致' : '不一致'}，奇偶${okParity ? '正常' : '异常'}`
      );
      return false;
    }
    return true;
  }

  /**
   * 悔棋处理
   */
  handleUndo() {
    if (this.isOnline()) {
      this.showToast('联机对局不支持悔棋');
      return;
    }
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

    // 先清掉历史里可能残留的重复落点（旧版本允许覆盖时留下的脏数据）
    const dropped = this.sanitizeMoveHistory();
    if (dropped > 0) {
      console.warn(`悔棋前清理了 ${dropped} 条重复落点记录（旧版本遗留脏数据）`);
      this.rebuildBoardFromHistory();
      this.stepCountEl.textContent = this.moveHistory.length;
    }

    // 悔棋语义：撤到「玩家自己最后一手之前」—— 那个时刻天然轮到玩家落子，
    // 黑白手数也天然满足先后手奇偶（黑先白后，黑 ∈ {白, 白 + 1}）。
    // 旧实现按「当前轮到谁」决定撤 1 手还是 2 手：玩家在 AI 思考期间点悔棋时
    // 只撤掉自己那一手，AI 多出来的那手留在了盘上，黑白差每悔一次就滚大 1 手
    // —— 这正是「我只有 3 枚棋、黑棋 6 个」的成因。
    let cut = -1;
    const normColor = (v) => (v === 'black' ? BLACK : (v === 'white' ? WHITE : v));
    for (let i = this.moveHistory.length - 1; i >= 0; i--) {
      if (normColor(this.moveHistory[i].color) === this.playerColor) {
        cut = i;
        break;
      }
    }

    if (cut < 0) {
      this.showToast('还没有你的落子，无法悔棋');
      return;
    }

    // 局面已经变了，作废所有进行中的 AI 请求：之前那一步的思考结果不能再落地
    this.moveGen++;

    const undone = this.moveHistory.length - cut;
    this.moveHistory.length = cut;

    // 棋盘交给历史重建，杜绝增量回退漏改 / 多改
    this.rebuildBoardFromHistory();

    sound.playUndo();

    this.turn = this.playerColor;

    const previousMove = this.moveHistory[this.moveHistory.length - 1] || null;

    const forbidden = this.turn === BLACK && this.isForbiddenRuleOn()
      ? this.calculateForbiddenPoints()
      : [];

    this.goban.setBoardState(this.board, previousMove, null, forbidden, [], this.moveHistory);
    this.goban.setTurn(this.turn);
    this.goban.setLocked(false);

    this.stepCountEl.textContent = this.moveHistory.length;
    this.invalidateLiveAnalysis(this.moveHistory.length);
    this.renderMoveList();
    this.updateReplayUI();
    this.updateStatus();

    this.assertBoardConsistency('悔棋');

    const blk = this.countColor(BLACK);
    const wht = this.countColor(WHITE);
    this.showToast(
      `已撤回 ${undone} 手，轮到【${this.playerColor === BLACK ? '黑方' : '白方'}】重新落子` +
      `（盘面 黑 ${blk} · 白 ${wht}）`
    );

    if (dropped > 0) {
      console.warn(`悔棋时清理了 ${dropped} 条重复落点记录（旧版本遗留脏数据）`);
    }
  }

  /**
   * 玩家认输
   */
  handleResign() {
    if (this.isOnline()) {
      this.onlineResign();
      return;
    }
    if (this.gameStatus !== 'playing') return;

    if (this.isPvP()) {
      const resignPlayer = this.turn === BLACK ? '黑方' : '白方';
      const winPlayer = this.turn === BLACK ? '白方' : '黑方';
      if (confirm(`当前轮到【${resignPlayer}】落子，确定要认输吗？`)) {
        this.gameStatus = 'ended';
        this.syncGameChrome();
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
      this.syncGameChrome();
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

    if (this.isOnline()) {
      this.showToast('联机对局不支持走法提示');
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
      trail,
      moves.slice(0, idx)
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
      forbidden,
      [],
      this.moveHistory
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
  /**
   * 对局中收窄顶部：压薄导航栏 + 收起战绩横幅，把省下的纵向空间让给棋盘。
   *
   * 棋盘是正方形，尺寸上限 = min(容器宽度, 视口高度 − 顶部占用)，在 16:9 桌面上
   * 几乎总是被视口高度卡住，所以「省高度」就等于「放大棋盘」。
   * 具体样式见 css/style.css 的 body.in-game 规则；board.js 的
   * reservedViewportHeight() 会实测这些元素的高度，无需两边写死同一个数字。
   */
  syncGameChrome() {
    const inGame = this.gameStatus === 'playing';
    const body = document.body;
    if (!body || body.classList.contains('in-game') === inGame) return;

    body.classList.toggle('in-game', inGame);

    // 等浏览器把新布局算完再量尺寸；再补一帧兜住字体/行高带来的细微变化
    requestAnimationFrame(() => {
      if (!this.goban) return;
      this.goban.resize();
      requestAnimationFrame(() => this.goban && this.goban.resize());
    });
  }

  updateStatus() {
    // 顶部占用随对局状态变化，棋盘尺寸要跟着重算
    this.syncGameChrome();

    if (this.gameStatus === 'playing') {
      if (this.isOnline()) {
        const myTurn = this.isMyOnlineTurn();
        this.statusTextEl.textContent = myTurn ? '轮到您落子' : '等待对方落子…';
        this.turnBadgeEl.className = `turn-badge ${this.turn === BLACK ? 'turn-black' : 'turn-white'}`;
        this.turnBadgeEl.textContent = this.turn === BLACK ? '黑方回合' : '白方回合';
      } else if (this.isPvP()) {
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
      if (this.isOnline()) {
        if (this.winner === 'draw') {
          this.statusTextEl.textContent = '握手言和！';
        } else if (this.winner === this.playerColor) {
          this.statusTextEl.textContent = '🎉 恭喜获得胜利！';
        } else {
          this.statusTextEl.textContent = '⚔️ 惜败，再接再厉！';
        }
      } else if (this.isPvP()) {
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
    const quickPlaystyleGroup = document.getElementById('quickPlaystyleGroup');
    const quickPlaystyleSelect = document.getElementById('quickPlaystyleSelect');

    if (badge) {
      if (this.isOnline()) {
        badge.textContent = '联机对战';
        badge.className = 'badge badge-llm';
      } else if (this.isPvP()) {
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

    if (quickPlaystyleGroup) {
      const isLLM = this.settings.aiEngine === 'llm' && !this.isOnline() && !this.isPvP();
      quickPlaystyleGroup.style.display = isLLM ? 'inline-flex' : 'none';
      if (isLLM && quickPlaystyleSelect) {
        quickPlaystyleSelect.value = this.settings.llmConfig.playstyle || 'openmind';
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
      case 'pro': return '职业级';
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

    const showMoveNumbers = document.getElementById('cfgShowMoveNumbers');
    if (showMoveNumbers) showMoveNumbers.checked = this.settings.showMoveNumbers !== false;

    // LLM 相关表单
    const llmProvider = document.getElementById('cfgLlmProvider');
    const llmBaseUrl = document.getElementById('cfgLlmBaseUrl');
    const llmApiKey = document.getElementById('cfgLlmApiKey');
    const llmModel = document.getElementById('cfgLlmModel');
    const llmPersona = document.getElementById('cfgLlmPersona');
    const llmPlaystyle = document.getElementById('cfgLlmPlaystyle');
    const llmTemperature = document.getElementById('cfgLlmTemperature');
    const tempDisplay = document.getElementById('cfgTempDisplay');

    if (llmProvider) llmProvider.value = this.settings.llmConfig.provider || 'deepseek';
    if (llmBaseUrl) llmBaseUrl.value = this.settings.llmConfig.baseUrl || '';
    if (llmApiKey) llmApiKey.value = this.settings.llmConfig.apiKey || '';
    if (llmModel) llmModel.value = this.settings.llmConfig.model || '';
    if (llmPersona) llmPersona.value = this.settings.llmConfig.persona || 'humorous';
    if (llmPlaystyle) llmPlaystyle.value = this.settings.llmConfig.playstyle || 'openmind';
    if (llmTemperature) {
      const tempVal = typeof this.settings.llmConfig.temperature === 'number' ? this.settings.llmConfig.temperature : 0.85;
      llmTemperature.value = tempVal;
      if (tempDisplay) tempDisplay.textContent = Number(tempVal).toFixed(2);
    }

    // 备用大模型相关表单
    const bProvider = document.getElementById('cfgBackupLlmProvider');
    const bBaseUrl = document.getElementById('cfgBackupLlmBaseUrl');
    const bApiKey = document.getElementById('cfgBackupLlmApiKey');
    const bModel = document.getElementById('cfgBackupLlmModel');
    const bPersona = document.getElementById('cfgBackupLlmPersona');
    const bPlaystyle = document.getElementById('cfgBackupLlmPlaystyle');
    const bTemperature = document.getElementById('cfgBackupLlmTemperature');
    const bTempDisplay = document.getElementById('cfgBackupTempDisplay');

    const backupCfg = this.settings.backupLlmConfig || {};
    if (bProvider) bProvider.value = backupCfg.provider || 'gemini';
    if (bBaseUrl) bBaseUrl.value = backupCfg.baseUrl || '';
    if (bApiKey) bApiKey.value = backupCfg.apiKey || '';
    if (bModel) bModel.value = backupCfg.model || '';
    if (bPersona) bPersona.value = backupCfg.persona || 'humorous';
    if (bPlaystyle) bPlaystyle.value = backupCfg.playstyle || 'openmind';
    if (bTemperature) {
      const bTempVal = typeof backupCfg.temperature === 'number' ? backupCfg.temperature : 0.85;
      bTemperature.value = bTempVal;
      if (bTempDisplay) bTempDisplay.textContent = Number(bTempVal).toFixed(2);
    }

    this.toggleLlmConfigSection(this.settings.aiEngine === 'llm');
  }

  toggleLlmConfigSection(show) {
    const section = document.getElementById('llmConfigSection');
    if (section) {
      section.style.display = show ? 'block' : 'none';
    }
  }

  /**
   * 渲染主备双模型并发检测报告
   * @param {Array<{level:'ok'|'warn'|'fail'|'testing', text:string}>} primaryLines
   * @param {Array<{level:'ok'|'warn'|'fail'|'testing', text:string}>} backupLines
   */
  renderDualTestResult(primaryLines, backupLines) {
    const el = document.getElementById('llmTestResult');
    if (!el) return;

    const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
    const validLevels = ['ok', 'warn', 'fail', 'testing'];

    const formatCol = (title, lines, isPrimary) => {
      const badgeCls = isPrimary ? 'primary-title' : 'backup-title';
      const colCls = isPrimary ? 'primary-col' : 'backup-col';
      const linesHtml = (lines || []).map((line) => {
        const level = validLevels.indexOf(line.level) !== -1 ? line.level : 'ok';
        return '<div class="test-result-line">' +
          `<span class="test-result-dot level-${level}"></span>` +
          `<span class="test-result-text level-${level}">${esc(line.text)}</span>` +
          '</div>';
      }).join('');

      return `<div class="dual-test-col ${colCls}">` +
        `<div class="dual-test-head ${badgeCls}"><span>${title}</span></div>` +
        linesHtml +
        `</div>`;
    };

    const pModel = document.getElementById('cfgLlmModel')?.value || 'deepseek-chat';
    const bModel = document.getElementById('cfgBackupLlmModel')?.value || 'gemini-1.5-flash';

    el.innerHTML = '<div class="dual-test-container">' +
      formatCol(`🔵 主大模型（${esc(pModel)}）`, primaryLines, true) +
      formatCol(`🟣 备用大模型（${esc(bModel)}）`, backupLines, false) +
      '</div>';

    el.classList.add('visible');
  }

  renderTestResult(lines) {
    // 兼容单通道调用，默认按主模型通道展示
    this.renderDualTestResult(lines, [{ level: 'ok', text: '备用模型处于待机状态' }]);
  }

  initSettingsModalEvents() {
    // 引擎切换
    document.querySelectorAll('input[name="cfgAiEngine"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.toggleLlmConfigSection(e.target.value === 'llm');
      });
    });

    // 主模型服务商下拉选择联动
    const providerSelect = document.getElementById('cfgLlmProvider');
    providerSelect?.addEventListener('change', (e) => {
      const preset = PROVIDER_PRESETS[e.target.value];
      if (preset) {
        document.getElementById('cfgLlmBaseUrl').value = preset.baseUrl;
        document.getElementById('cfgLlmModel').value = preset.defaultModel;
      }
    });

    // 备用模型服务商下拉选择联动
    const backupProviderSelect = document.getElementById('cfgBackupLlmProvider');
    backupProviderSelect?.addEventListener('change', (e) => {
      const preset = PROVIDER_PRESETS[e.target.value];
      if (preset) {
        document.getElementById('cfgBackupLlmBaseUrl').value = preset.baseUrl;
        document.getElementById('cfgBackupLlmModel').value = preset.defaultModel;
      }
    });

    // 主模型 API Key 明文/密文切换
    const btnToggleKey = document.getElementById('btnToggleKeyVisibility');
    const inputKey = document.getElementById('cfgLlmApiKey');
    btnToggleKey?.addEventListener('click', () => {
      inputKey.type = inputKey.type === 'password' ? 'text' : 'password';
      btnToggleKey.textContent = inputKey.type === 'password' ? '👁️ 显示' : '🔒 隐藏';
    });

    // 备用模型 API Key 明文/密文切换
    const btnToggleBackupKey = document.getElementById('btnToggleBackupKeyVisibility');
    const inputBackupKey = document.getElementById('cfgBackupLlmApiKey');
    btnToggleBackupKey?.addEventListener('click', () => {
      inputBackupKey.type = inputBackupKey.type === 'password' ? 'text' : 'password';
      btnToggleBackupKey.textContent = inputBackupKey.type === 'password' ? '👁️ 显示' : '🔒 隐藏';
    });

    // 主模型发散度/温度滑动条联动显示
    const inputTemp = document.getElementById('cfgLlmTemperature');
    const tempDisplay = document.getElementById('cfgTempDisplay');
    inputTemp?.addEventListener('input', (e) => {
      if (tempDisplay) tempDisplay.textContent = Number(e.target.value).toFixed(2);
    });

    // 备用模型发散度/温度滑动条联动显示
    const inputBackupTemp = document.getElementById('cfgBackupLlmTemperature');
    const backupTempDisplay = document.getElementById('cfgBackupTempDisplay');
    inputBackupTemp?.addEventListener('input', (e) => {
      if (backupTempDisplay) backupTempDisplay.textContent = Number(e.target.value).toFixed(2);
    });

    // 双模型并发体检按键：主备两个大模型同时检测
    const btnTestLlm = document.getElementById('btnTestLlm');
    btnTestLlm?.addEventListener('click', async () => {
      const primaryConfig = {
        baseUrl: document.getElementById('cfgLlmBaseUrl').value,
        apiKey: document.getElementById('cfgLlmApiKey').value,
        model: document.getElementById('cfgLlmModel').value,
        persona: document.getElementById('cfgLlmPersona')?.value || 'humorous',
        playstyle: document.getElementById('cfgLlmPlaystyle')?.value || 'openmind',
        temperature: parseFloat(document.getElementById('cfgLlmTemperature')?.value || '0.85')
      };

      const backupConfig = {
        baseUrl: document.getElementById('cfgBackupLlmBaseUrl')?.value || '',
        apiKey: document.getElementById('cfgBackupLlmApiKey')?.value || '',
        model: document.getElementById('cfgBackupLlmModel')?.value || '',
        persona: document.getElementById('cfgBackupLlmPersona')?.value || 'humorous',
        playstyle: document.getElementById('cfgBackupLlmPlaystyle')?.value || 'openmind',
        temperature: parseFloat(document.getElementById('cfgBackupLlmTemperature')?.value || '0.85')
      };

      btnTestLlm.disabled = true;

      let primaryLines = [{ level: 'testing', text: '阶段一：正在发起主大模型握手…' }];
      let backupLines = [{ level: 'testing', text: '阶段一：正在发起备用大模型握手…' }];
      this.renderDualTestResult(primaryLines, backupLines);

      const runTest = async (cfg, isBackup) => {
        if (!cfg.apiKey || !cfg.apiKey.trim()) {
          return {
            lines: [{
              level: isBackup ? 'warn' : 'fail',
              text: isBackup ? '未填写备用 API Key（若主模型故障将自动回退本地高强度算法）' : '尚未填写主大模型 API Key'
            }]
          };
        }
        return testLLMConnection(cfg, {
          board: this.board,
          onProgress: (p) => {
            const sec = Math.max(1, Math.round(p.elapsedMs / 1000));
            const label = p.phase === 'reasoning' ? '正在推理' : '正在输出落子';
            const activeLines = [{
              level: 'testing',
              text: `阶段二：${label}… 已等待 ${sec}s · 接收 ${p.chars} 字`
            }];
            if (isBackup) {
              backupLines = activeLines;
            } else {
              primaryLines = activeLines;
            }
            this.renderDualTestResult(primaryLines, backupLines);
          }
        });
      };

      try {
        const [primaryRes, backupRes] = await Promise.all([
          runTest(primaryConfig, false),
          runTest(backupConfig, true)
        ]);
        this.renderDualTestResult(primaryRes.lines, backupRes.lines);
      } catch (err) {
        this.renderDualTestResult(
          [{ level: 'fail', text: `主模型检测异常：${(err && err.message) || err}` }],
          [{ level: 'warn', text: '备用检测中止' }]
        );
      } finally {
        btnTestLlm.disabled = false;
      }
    });

    // 保存设置按钮
    document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
      const next = this.readSettingsForm();
      const colorChanged = this.settings.playerColor !== next.playerColor;
      const modeChanged = this.settings.aiEngine !== next.aiEngine;

      this.settings = { ...this.settings, ...next };

      this.persistSettings();
      this.goban.options.showForbiddenMarks = next.showForbiddenMarks;
      this.goban.options.showMoveNumbers = next.showMoveNumbers !== false;
      this.goban.render();
      this.difficultySelect.value = next.difficulty;
      this.engineSelect.value = next.aiEngine;
      this.updateEngineBadge();
      const quickPlaystyleSelect = document.getElementById('quickPlaystyleSelect');
      if (quickPlaystyleSelect && next.llmConfig?.playstyle) {
        quickPlaystyleSelect.value = next.llmConfig.playstyle;
      }
      this.updateSideCard();

      this.settingsModal.classList.remove('active');
      this.showToast('设置已保存（包含主备双大模型）');

      if ((colorChanged || modeChanged) && confirm('对弈模式或执棋方已发生变动，是否立即重新开局？')) {
        this.startNewGame();
      }
    });
  }

  /**
   * 读取设置弹窗当前表单值（不写盘，供保存与云端上传共用）
   */
  readSettingsForm() {
    return {
      aiEngine: document.querySelector('input[name="cfgAiEngine"]:checked')?.value || 'local',
      playerColor: Number(document.querySelector('input[name="cfgPlayerColor"]:checked')?.value || 1),
      difficulty: document.querySelector('input[name="cfgDifficulty"]:checked')?.value || 'medium',
      checkDoubleThree: document.getElementById('cfgCheckDoubleThree')?.checked ?? true,
      checkDoubleFour: document.getElementById('cfgCheckDoubleFour')?.checked ?? true,
      showForbiddenMarks: document.getElementById('cfgShowForbiddenMarks')?.checked ?? true,
      showMoveNumbers: document.getElementById('cfgShowMoveNumbers')?.checked ?? true,
      llmConfig: {
        provider: document.getElementById('cfgLlmProvider')?.value || 'deepseek',
        baseUrl: document.getElementById('cfgLlmBaseUrl')?.value || '',
        apiKey: document.getElementById('cfgLlmApiKey')?.value || '',
        model: document.getElementById('cfgLlmModel')?.value || '',
        persona: document.getElementById('cfgLlmPersona')?.value || 'humorous',
        playstyle: document.getElementById('cfgLlmPlaystyle')?.value || 'openmind',
        temperature: parseFloat(document.getElementById('cfgLlmTemperature')?.value || '0.85')
      },
      backupLlmConfig: {
        provider: document.getElementById('cfgBackupLlmProvider')?.value || 'gemini',
        baseUrl: document.getElementById('cfgBackupLlmBaseUrl')?.value || '',
        apiKey: document.getElementById('cfgBackupLlmApiKey')?.value || '',
        model: document.getElementById('cfgBackupLlmModel')?.value || '',
        persona: document.getElementById('cfgBackupLlmPersona')?.value || 'humorous',
        playstyle: document.getElementById('cfgBackupLlmPlaystyle')?.value || 'openmind',
        temperature: parseFloat(document.getElementById('cfgBackupLlmTemperature')?.value || '0.85')
      }
    };
  }

  /**
   * 写盘并刷新更新时间戳（跨设备同步靠它判断哪份配置更新）
   */
  persistSettings(updatedAt = Date.now()) {
    this.settings = { ...this.settings, updatedAt };
    StorageManager.saveSettings(this.settings);
  }

  /* ======================================================================
     跨设备配置同步
     ====================================================================== */

  bindSettingsSyncEvents() {
    this.btnSyncNewCode?.addEventListener('click', () => {
      const code = generateSyncCode();
      if (this.syncCodeInput) {
        this.syncCodeInput.value = code;
        this.syncCodeInput.focus();
        this.syncCodeInput.select();
      }
      this.setSyncStatus(`已生成同步码 ${code}。点「⬆️ 上传本机设置」后，在手机浏览器输入这串码点「拉取并套用」。`, 'ok');
    });

    this.btnSyncUpload?.addEventListener('click', () => this.handleSyncUpload());
    this.btnSyncDownload?.addEventListener('click', () => this.handleSyncDownload());
    this.btnSyncDelete?.addEventListener('click', () => this.handleSyncDelete());
    this.btnSyncCopy?.addEventListener('click', () => this.handleSyncCopy());

    this.cfgSyncAuto?.addEventListener('change', (e) => {
      setAutoSyncEnabled(e.target.checked);
      this.setSyncStatus(e.target.checked
        ? '已开启开机自动拉取：本机记住同步码后，打开页面会自动套用云端更新过的配置。'
        : '已关闭开机自动拉取，仍可手动点「⬇️ 拉取并套用」。', 'ok');
    });
  }

  setSyncStatus(msg, tone = '') {
    if (!this.syncStatusEl) return;
    this.syncStatusEl.textContent = msg;
    this.syncStatusEl.className = `sync-status ${tone}`.trim();
  }

  /**
   * 取输入框中合法的同步码，非法则回显提示并返回空串
   */
  currentSyncCode() {
    const raw = this.syncCodeInput ? this.syncCodeInput.value : '';
    const code = normalizeSyncCode(raw);
    if (this.syncCodeInput && this.syncCodeInput.value !== code) this.syncCodeInput.value = code;

    if (!isValidSyncCode(code)) {
      this.setSyncStatus('同步码需为 8-16 位字母或数字（可点「🎲 新建」生成 10 位）。', 'err');
      return '';
    }
    return code;
  }

  /**
   * 打开设置弹窗时回填本机同步码与自动拉取勾选
   */
  syncSyncUi() {
    const saved = getSavedSyncCode();
    if (this.syncCodeInput && !this.syncCodeInput.value && saved) {
      this.syncCodeInput.value = saved;
    }
    if (this.cfgSyncAuto) this.cfgSyncAuto.checked = isAutoSyncEnabled();

    if (this.syncStatusEl && !this.syncStatusEl.textContent) {
      this.setSyncStatus(saved
        ? `本机已绑定同步码 ${saved}，改完设置点「⬆️ 上传本机设置」即可更新云端。`
        : '首次使用：点「🎲 新建」生成同步码 → 「⬆️ 上传本机设置」→ 手机输入同一串码「⬇️ 拉取并套用」。', '');
    }
  }

  async handleSyncUpload() {
    if (this.syncBusy) return;
    const code = this.currentSyncCode();
    if (!code) return;

    // 先把弹窗里尚未保存的表单值纳入，避免上传的是旧配置
    this.settings = { ...this.settings, ...this.readSettingsForm() };

    this.syncBusy = true;
    this.setSyncStatus('正在上传本机设置到云端…', 'busy');
    const res = await pushSettings(code, this.settings);
    this.syncBusy = false;

    if (!res.ok) {
      this.setSyncStatus(`上传失败：${res.error}`, 'err');
      return;
    }

    saveSyncCode(code);
    const expire = res.expiresAt ? `，有效期至 ${this.formatStamp(res.expiresAt)}` : '';
    this.setSyncStatus(`✅ 已上传（同步码 ${code}）${expire}。在手机浏览器「⚙️ 设置 → 跨设备同步」输入该码并拉取即可。`, 'ok');
    this.showToast('☁️ 本机设置已上传云端');
  }

  async handleSyncDownload() {
    if (this.syncBusy) return;
    const code = this.currentSyncCode();
    if (!code) return;

    this.syncBusy = true;
    this.setSyncStatus('正在拉取云端配置…', 'busy');
    const res = await pullSettings(code);
    this.syncBusy = false;

    if (!res.ok) {
      this.setSyncStatus(`拉取失败：${res.error}`, 'err');
      return;
    }

    saveSyncCode(code);
    this.applyRemoteSettings(res.settings, res.updatedAt);
    this.setSyncStatus(
      `✅ 已套用云端配置：${this.describeSettingsBrief(res.settings)}，更新于 ${this.formatStamp(res.updatedAt)}。`,
      'ok'
    );
    this.showToast('☁️ 已套用云端配置');
  }

  async handleSyncDelete() {
    if (this.syncBusy) return;
    const code = this.currentSyncCode();
    if (!code) return;
    if (!confirm(`确定清除云端配置（同步码 ${code}）吗？清除后其他设备将无法再拉取该配置。`)) return;

    this.syncBusy = true;
    const res = await deleteSettings(code);
    this.syncBusy = false;

    if (!res.ok) {
      this.setSyncStatus(`清除失败：${res.error}`, 'err');
      return;
    }
    if (getSavedSyncCode() === code) forgetSyncCode();
    this.setSyncStatus('🗑 云端配置已清除。', 'ok');
  }

  async handleSyncCopy() {
    const code = this.syncCodeInput ? this.syncCodeInput.value.trim() : '';
    if (!code) {
      this.setSyncStatus('请先生成或输入同步码。', 'err');
      return;
    }

    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        // 部分浏览器在无用户手势时会长时间挂起，加超时兜底避免状态卡住
        const outcome = await Promise.race([
          navigator.clipboard.writeText(code).then(() => 'ok').catch(() => 'fail'),
          new Promise(resolve => setTimeout(() => resolve('timeout'), 1200))
        ]);
        copied = outcome === 'ok';
      }
    } catch (e) {
      copied = false;
    }
    if (!copied) {
      try {
        this.syncCodeInput.select();
        copied = document.execCommand('copy');
      } catch (e) {
        copied = false;
      }
    }

    this.setSyncStatus(copied
      ? `📋 同步码 ${code} 已复制，去手机浏览器粘贴即可。`
      : `浏览器不允许自动复制，请手动记下同步码：${code}`, copied ? 'ok' : 'err');
  }

  /**
   * 套用远端设置并同步到界面（opts.silent = 由调用方决定是否重开一局）
   */
  applyRemoteSettings(incoming, updatedAt, opts = {}) {
    const beforeEngine = this.settings.aiEngine;
    const beforeColor = Number(this.settings.playerColor);

    this.settings = mergeSettings(this.settings, incoming);
    this.persistSettings(Number(updatedAt) || Date.now());

    sound.setMuted(this.settings.soundEnabled === false);
    this.goban.options.showForbiddenMarks = this.settings.showForbiddenMarks !== false;
    this.goban.options.showMoveNumbers = this.settings.showMoveNumbers !== false;

    this.syncSettingsToUI();
    this.updateSoundButton();
    this.updateEngineBadge();
    this.updateSideCard();

    const changed = beforeEngine !== this.settings.aiEngine || beforeColor !== Number(this.settings.playerColor);
    if (opts.silent || !changed) {
      if (!this.replay.active) this.restoreLiveView();
      return { changed };
    }

    if (this.gameStatus === 'playing' && this.moveHistory.length > 0) {
      if (confirm('已套用云端配置，对弈模式或执棋方有变化，是否立即重新开局？')) {
        this.requestNewGame();
      } else {
        this.restoreLiveView();
      }
    } else {
      this.requestNewGame();
    }
    return { changed };
  }

  /**
   * 开机静默自动拉取（仅当本机已绑定同步码且云端更新）
   */
  async autoPullSettings() {
    if (!isAutoSyncEnabled()) return;
    const code = getSavedSyncCode();
    if (!code || !isValidSyncCode(code)) return;

    if (this.statusTextEl) this.statusTextEl.textContent = '正在检查云端配置…';

    const res = await pullSettings(code, { timeout: 3500 });
    if (this.statusTextEl && /正在检查云端配置/.test(this.statusTextEl.textContent)) {
      this.statusTextEl.textContent = '';
    }

    if (!res.ok) {
      // 静默失败不打扰开局，但把原因留在同步状态区，用户打开设置可见
      this.setSyncStatus(`开机自动拉取未成功：${res.error}`, 'err');
      return;
    }

    const localUpdated = Number(this.settings.updatedAt) || 0;
    if (res.updatedAt <= localUpdated) return; // 本机更新，保持不动

    this.applyRemoteSettings(res.settings, res.updatedAt, { silent: true });
    this.pendingSyncToast = `☁️ 已自动套用云端配置（${this.describeSettingsBrief(res.settings)}）`;
  }

  describeSettingsBrief(s) {
    const src = s || {};
    let engine = src.aiEngine === 'llm'
      ? `大模型 ${(src.llmConfig && src.llmConfig.model) || '未填主模型'}`
      : (src.aiEngine === 'pvp' ? '双人同屏' : '本地算法');
    if (src.backupLlmConfig && src.backupLlmConfig.model) {
      engine += ` (备用:${src.backupLlmConfig.model})`;
    }
    const color = Number(src.playerColor) === 2 ? '执白后手' : '执黑先手';
    return `${engine} · ${this.getDifficultyLabel(src.difficulty)} · ${color}`;
  }

  formatStamp(ms) {
    const n = Number(ms);
    if (!n) return '未知时间';
    try {
      return new Date(n).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return '未知时间';
    }
  }

  openSettingsModal() {
    this.syncSettingsToUI();
    this.syncSyncUi();
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
