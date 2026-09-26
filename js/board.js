/**
 * 五子棋盘 Canvas 高清渲染引擎 (High-DPI Goban Renderer)
 * 具备：拟真天然木纹底色、立体玉质黑白棋子、落子高亮标记、胜利连线光效、悬浮虚影预览
 */

import { BOARD_SIZE, EMPTY, BLACK, WHITE } from './rules.js';

export class Goban {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} options
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      showCoordinates: true,
      showForbiddenMarks: true,
      ...options
    };

    this.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
    this.lastMove = null;        // { r, c, color }
    this.hoverPos = null;        // { r, c }
    this.winningLine = null;     // Array<[r, c]>
    this.forbiddenPoints = [];   // Array<{ r, c }>
    this.turnColor = BLACK;
    this.isLocked = false;       // AI 思考或游戏结束时锁定

    this.onCellClick = null;     // 回调 (r, c)

    this.initEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const containerWidth = parent.clientWidth;
    // 保持正方形，考虑 padding
    const size = Math.min(containerWidth, 680);
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;

    this.dpr = dpr;
    this.displaySize = size;

    // 重新计算格间距
    this.margin = size * 0.07; // 边距留给坐标 A-O, 1-15
    this.cellSize = (size - this.margin * 2) / (BOARD_SIZE - 1);
    this.stoneRadius = this.cellSize * 0.44;

    this.render();
  }

  initEvents() {
    const getPosFromEvent = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const col = Math.round((x - this.margin) / this.cellSize);
      const row = Math.round((y - this.margin) / this.cellSize);

      if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE) {
        return { r: row, c: col };
      }
      return null;
    };

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isLocked) return;
      const pos = getPosFromEvent(e);
      if (!this.hoverPos || !pos || this.hoverPos.r !== pos.r || this.hoverPos.c !== pos.c) {
        this.hoverPos = pos;
        this.render();
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (this.hoverPos) {
        this.hoverPos = null;
        this.render();
      }
    });

    const handleClickOrTouch = (e) => {
      if (this.isLocked) return;
      const pos = getPosFromEvent(e);
      if (pos && this.onCellClick) {
        this.onCellClick(pos.r, pos.c);
      }
    };

    this.canvas.addEventListener('click', (e) => {
      e.preventDefault();
      handleClickOrTouch(e);
    });

    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleClickOrTouch(e);
      this.hoverPos = null;
    });
  }

  /**
   * 更新棋盘状态并重绘
   */
  setBoardState(board, lastMove = null, winningLine = null, forbiddenPoints = []) {
    this.board = board;
    this.lastMove = lastMove;
    this.winningLine = winningLine;
    this.forbiddenPoints = forbiddenPoints;
    this.render();
  }

  setTurn(turnColor) {
    this.turnColor = turnColor;
    this.render();
  }

  setLocked(locked) {
    this.isLocked = locked;
    this.render();
  }

  /**
   * 绘制整个棋盘
   */
  render() {
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const size = this.displaySize;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    // 1. 绘制棋盘底木纹与阴影边框
    this.drawBoardBackground(ctx, size);

    // 2. 绘制网格线与坐标
    this.drawGridAndCoordinates(ctx);

    // 3. 绘制星位 (天元及四角星位)
    this.drawStarPoints(ctx);

    // 4. 绘制所有已下棋子
    this.drawStones(ctx);

    // 5. 绘制禁手标记 (若开启)
    if (this.options.showForbiddenMarks && this.forbiddenPoints.length > 0 && this.turnColor === BLACK) {
      this.drawForbiddenMarks(ctx);
    }

    // 6. 绘制最新一步的标记
    if (this.lastMove) {
      this.drawLastMoveMarker(ctx, this.lastMove.r, this.lastMove.c, this.lastMove.color);
    }

    // 7. 绘制获胜连线发光效果
    if (this.winningLine && this.winningLine.length >= 5) {
      this.drawWinningLine(ctx, this.winningLine);
    }

    // 8. 绘制鼠标/触摸虚影
    if (!this.isLocked && this.hoverPos && this.board[this.hoverPos.r][this.hoverPos.c] === EMPTY) {
      this.drawGhostStone(ctx, this.hoverPos.r, this.hoverPos.c, this.turnColor);
    }

    ctx.restore();
  }

  drawBoardBackground(ctx, size) {
    // 棋盘主体温润木质渐变
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.7);
    grad.addColorStop(0, '#f2d096');
    grad.addColorStop(0.7, '#e4bc7b');
    grad.addColorStop(1, '#c89d5b');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // 细致的天然木纹线条
    ctx.save();
    ctx.strokeStyle = 'rgba(168, 115, 52, 0.08)';
    ctx.lineWidth = 1;
    for (let y = 4; y < size; y += 6) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + Math.sin(y * 0.1) * 2, size * 0.7, y - Math.cos(y * 0.1) * 2, size, y);
      ctx.stroke();
    }
    ctx.restore();

    // 棋盘内阴影与木质外边框
    ctx.save();
    ctx.strokeStyle = '#8d5d29';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(this.margin - 4, this.margin - 4, (BOARD_SIZE - 1) * this.cellSize + 8, (BOARD_SIZE - 1) * this.cellSize + 8);
    ctx.restore();
  }

  drawGridAndCoordinates(ctx) {
    ctx.save();
    ctx.strokeStyle = '#5a3818';
    ctx.lineWidth = 1.2;

    const startX = this.margin;
    const startY = this.margin;
    const end = (BOARD_SIZE - 1) * this.cellSize;

    for (let i = 0; i < BOARD_SIZE; i++) {
      const pos = this.margin + i * this.cellSize;

      // 横线
      ctx.beginPath();
      ctx.moveTo(startX, pos);
      ctx.lineTo(startX + end, pos);
      ctx.stroke();

      // 竖线
      ctx.beginPath();
      ctx.moveTo(pos, startY);
      ctx.lineTo(pos, startY + end);
      ctx.stroke();

      // 坐标文字
      if (this.options.showCoordinates) {
        ctx.fillStyle = '#6b441f';
        ctx.font = `600 ${Math.max(10, this.cellSize * 0.32)}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 顶底字母 A-O
        const colLetter = String.fromCharCode(65 + i);
        ctx.fillText(colLetter, pos, this.margin * 0.45);
        ctx.fillText(colLetter, pos, startY + end + this.margin * 0.55);

        // 左右数字 15-1
        const rowNumber = (15 - i).toString();
        ctx.fillText(rowNumber, this.margin * 0.45, pos);
        ctx.fillText(rowNumber, startX + end + this.margin * 0.55, pos);
      }
    }

    ctx.restore();
  }

  drawStarPoints(ctx) {
    // 五个星位：天元(7,7)，以及 (3,3), (3,11), (11,3), (11,11)
    const stars = [
      [7, 7],
      [3, 3], [3, 11],
      [11, 3], [11, 11]
    ];

    ctx.save();
    ctx.fillStyle = '#4a2c11';
    const radius = Math.max(3, this.cellSize * 0.08);

    for (const [r, c] of stars) {
      const x = this.margin + c * this.cellSize;
      const y = this.margin + r * this.cellSize;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawStones(ctx) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const color = this.board[r][c];
        if (color !== EMPTY) {
          const x = this.margin + c * this.cellSize;
          const y = this.margin + r * this.cellSize;
          this.drawRealisticStone(ctx, x, y, color);
        }
      }
    }
  }

  /**
   * 绘制 3D 拟真质感棋子 (高光、环境光散射、拟真投影)
   */
  drawRealisticStone(ctx, x, y, color, alpha = 1) {
    const r = this.stoneRadius;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 棋子投影
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = r * 0.35;
    ctx.shadowOffsetX = r * 0.15;
    ctx.shadowOffsetY = r * 0.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color === BLACK ? '#111' : '#ddd';
    ctx.fill();
    ctx.restore();

    // 棋子球体渐变材质
    const grad = ctx.createRadialGradient(
      x - r * 0.3, y - r * 0.35, r * 0.08,
      x, y, r
    );

    if (color === BLACK) {
      // 墨玉黑子：暗黑色调、微弱环境光与高亮反光
      grad.addColorStop(0, '#555555');
      grad.addColorStop(0.25, '#2b2b2b');
      grad.addColorStop(0.8, '#141414');
      grad.addColorStop(1, '#050505');
    } else {
      // 凝脂白子：温润白玉、微妙阴影渐变
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, '#f7f7f7');
      grad.addColorStop(0.8, '#dfdfdf');
      grad.addColorStop(1, '#b5b5b5');
    }

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // 顶部弧面高光微光点
    const shineGrad = ctx.createRadialGradient(
      x - r * 0.32, y - r * 0.36, 0,
      x - r * 0.32, y - r * 0.36, r * 0.45
    );
    shineGrad.addColorStop(0, color === BLACK ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.85)');
    shineGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = shineGrad;
    ctx.beginPath();
    ctx.arc(x - r * 0.32, y - r * 0.36, r * 0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawGhostStone(ctx, r, c, color) {
    const x = this.margin + c * this.cellSize;
    const y = this.margin + r * this.cellSize;
    this.drawRealisticStone(ctx, x, y, color, 0.45);
  }

  drawLastMoveMarker(ctx, r, c, color) {
    const x = this.margin + c * this.cellSize;
    const y = this.margin + r * this.cellSize;
    const markerRadius = this.stoneRadius * 0.3;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, markerRadius, 0, Math.PI * 2);
    // 标记颜色：在黑子上画亮红/金橙，在白子上画深红
    ctx.fillStyle = color === BLACK ? '#ff4d4f' : '#cf1322';
    ctx.shadowColor = 'rgba(255, 77, 79, 0.8)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  }

  drawForbiddenMarks(ctx) {
    ctx.save();
    ctx.strokeStyle = '#e60000';
    ctx.lineWidth = 2.2;

    for (const point of this.forbiddenPoints) {
      if (this.board[point.r][point.c] === EMPTY) {
        const x = this.margin + point.c * this.cellSize;
        const y = this.margin + point.r * this.cellSize;
        const d = this.cellSize * 0.22;

        ctx.beginPath();
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawWinningLine(ctx, line) {
    if (!line || line.length < 5) return;

    ctx.save();
    // 1. 发光外环连线
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#ffae00';
    ctx.shadowBlur = 12;

    ctx.beginPath();
    const first = line[0];
    ctx.moveTo(this.margin + first[1] * this.cellSize, this.margin + first[0] * this.cellSize);
    for (let i = 1; i < line.length; i++) {
      ctx.lineTo(this.margin + line[i][1] * this.cellSize, this.margin + line[i][0] * this.cellSize);
    }
    ctx.stroke();

    // 2. 优胜棋子闪耀金环
    for (const [r, c] of line) {
      const x = this.margin + c * this.cellSize;
      const y = this.margin + r * this.cellSize;

      ctx.beginPath();
      ctx.arc(x, y, this.stoneRadius + 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.restore();
  }
}
