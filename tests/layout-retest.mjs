/**
 * 回归测试：布局宽度变了、但没有触发 window.resize 时，棋盘会不会自己重算。
 *
 * 为什么必须用 CDP（而不是 --dump-dom + 虚拟时钟）：
 *   ResizeObserver 的回调挂在「渲染步」上，无头 + 虚拟时钟下带 iframe 的页面
 *   不会走渲染步，回调永远不投递 —— 会得到「观察器没生效」的假象。
 *   这里用真实时钟驱动，行为和用户浏览器一致。
 *
 * 用法: node tests/layout-retest.mjs [子目录]      # 默认当前工作区
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // tests/
const PROJECT = resolve(HERE, '..');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sub = process.argv[2] || '.';
const target = resolve(PROJECT, sub);
const label = process.argv[2] || '(当前工作区)';

const VW = 1493, VH = 1236;

/** 逐段 URL 编码，保留盘符与斜杠 */
const toFileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/')
  .map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');

const url = `${toFileUrl(join(target, 'tests', 'preview-layout.html'))}?vw=${VW}&vh=${VH}&retest=1`;

const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--allow-file-access-from-files',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* 端口还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 目标超时');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

try {
  const t = await findTarget();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(1500);

  const r = await send('Runtime.evaluate', {
    expression: `new Promise(res => setTimeout(() =>
      res(document.getElementById('metrics')?.textContent || 'NO-METRICS'), 9000))`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(`===== ${label}  ${VW}x${VH} =====`);
  const v = r.result?.value;
  try { console.log(JSON.stringify(JSON.parse(v), null, 2)); } catch { console.log(v); }
  ws.close();
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
