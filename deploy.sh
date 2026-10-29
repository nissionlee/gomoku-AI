#!/usr/bin/env bash
# 安全发布到 Cloudflare Pages。
#
# 仅把需要发布的文件复制到临时发布目录，避免无关文件被上传。
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
elif [ -n "${APPDATA:-}" ] && [ -f "${APPDATA}/npm/node_modules/wrangler/bin/wrangler.js" ]; then
  WRANGLER=(node "${APPDATA}/npm/node_modules/wrangler/bin/wrangler.js")
else
  WRANGLER=(npx --yes wrangler)
fi

"${WRANGLER[@]}" pages deploy "$STAGE" \
  --project-name=gomoku-ai \
  --branch=main \
  --commit-dirty=true

rm -rf "$STAGE"
echo "✅ 发布完成！线上地址：https://gomoku-ai.pages.dev"
