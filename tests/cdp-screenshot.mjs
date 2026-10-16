/**
 * 用 CDP 精确设定视口并截图（真实渲染，不走虚拟时钟）。
 *
 * 用法: node tests/cdp-screenshot.mjs <页面url> <宽> <高> <输出png>
 * 例:   node tests/cdp-screenshot.mjs "file:///.../tests/preview-layout.html?ingame=1" 1920 1080 shot.png
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, wArg, hArg, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node tests/cdp-screenshot.mjs <url> <宽> <高> <输出png>');
  process.exit(1);
}
const W = Number(wArg), H = Number(hArg);
const PORT = 9733 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'shot-'));

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
    } catch { /* 等端口 */ }
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
  // 精确设定视口：不受 --window-size 里的浏览器边框影响
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(4000); // 等布局、字体、测试页摆子完成

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`✅ ${out}  (${W}x${H})`);
  ws.close();
} catch (e) {
  console.error('截图失败:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
