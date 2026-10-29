import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const STAGE = '_deploy_stage';
const PUBLISH_ITEMS = ['index.html', 'css', 'js', 'functions', '_headers'];

// 优先读取本地令牌文件
const tokenFile = path.join(process.cwd(), '.cloudflare_token');
if (!process.env.CLOUDFLARE_API_TOKEN && fs.existsSync(tokenFile)) {
  process.env.CLOUDFLARE_API_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
}

if (fs.existsSync(STAGE)) {
  fs.rmSync(STAGE, { recursive: true, force: true });
}
fs.mkdirSync(STAGE, { recursive: true });

for (const item of PUBLISH_ITEMS) {
  if (fs.existsSync(item)) {
    fs.cpSync(item, path.join(STAGE, item), { recursive: true });
  } else {
    console.warn(`⚠️ 待发布项不存在，已跳过：${item}`);
  }
}

console.log('→ 已就绪发布文件至临时目录：' + STAGE);

// 查找 wrangler 可执行路径
let wranglerCmd = 'npx --yes wrangler';
const localWrangler = path.join(process.env.APPDATA || '', 'npm/node_modules/wrangler/bin/wrangler.js');
if (fs.existsSync(localWrangler)) {
  wranglerCmd = `node "${localWrangler}"`;
}

const cmd = `${wranglerCmd} pages deploy "${STAGE}" --project-name=gomoku-ai --branch=main --commit-dirty=true`;

console.log('→ 执行部署命令：' + cmd);
try {
  execSync(cmd, { stdio: 'inherit', env: process.env });
  console.log('✅ 发布完成！线上地址：https://5.1000rocks.com (或 https://gomoku-ai-b2f.pages.dev)');
} finally {
  if (fs.existsSync(STAGE)) {
    fs.rmSync(STAGE, { recursive: true, force: true });
  }
}
