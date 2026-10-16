#!/usr/bin/env bash
# 安全发布到 Cloudflare Pages。
#
# 为什么需要这个脚本：
#   `wrangler pages deploy .` 不读 .gitignore，会把「整个项目目录」原样上传。
#   本项目的 wrangler.toml 里 pages_build_output_dir = "."，所以上次部署把
#   .workbuddy-ai/（本地工作日志与记忆）、.git/、临时文件一并传上了公网 ——
#   线上 /.workbuddy-ai/memory/*.md 可被任意人读取。
#   这里改为：只把该发布的文件复制到临时目录，再发布那个目录。
#
# 用法：bash deploy.sh

set -euo pipefail
cd "$(dirname "$0")"

STAGE="_deploy_stage"
PUBLISH_ITEMS=(index.html css js functions _headers)

rm -rf "$STAGE"
mkdir -p "$STAGE"
for item in "${PUBLISH_ITEMS[@]}"; do
  if [ -e "$item" ]; then
    cp -r "$item" "$STAGE/"
  else
    echo "⚠️  待发布项不存在，已跳过：$item" >&2
  fi
done

echo "→ 本次发布内容："
( cd "$STAGE" && find . -type f | sed 's|^\./|  |' | sort )

# 定位 wrangler：优先 PATH，其次 npm 全局目录，最后 npx
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
elif [ -f "C:/Users/nissi/AppData/Roaming/npm/node_modules/wrangler/bin/wrangler.js" ]; then
  WRANGLER=(node "C:/Users/nissi/AppData/Roaming/npm/node_modules/wrangler/bin/wrangler.js")
else
  WRANGLER=(npx --yes wrangler)
fi

"${WRANGLER[@]}" pages deploy "$STAGE" \
  --project-name=gomoku-ai \
  --branch=main \
  --commit-dirty=true

rm -rf "$STAGE"
echo "✅ 发布完成，临时目录已清理"
