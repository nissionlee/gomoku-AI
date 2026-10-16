#!/usr/bin/env python3
"""无头 Chrome 测量棋盘布局几何（棋盘 / 木框 / 顶部占用 / 约束来源）。

用法（在项目根或任意目录下）：
    python tests/layout-measure.py              # 测当前工作区
    python tests/layout-measure.py _baseline    # 测项目下某个子目录（如 git worktree 出来的对照版本）

依赖：本机 Chrome。可用环境变量 CHROME 覆盖可执行文件路径。
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

CHROME = os.environ.get(
    "CHROME", r"C:/Program Files/Google/Chrome/Application/chrome.exe"
)
HERE = Path(__file__).resolve().parent          # tests/
PROJECT = HERE.parent                           # 项目根

# 允许用第一个命令行参数指定被测目录（相对项目根），默认当前工作区
_TARGET = PROJECT / (sys.argv[1] if len(sys.argv) > 1 else ".")
PAGE = (_TARGET / "tests" / "preview-layout.html").as_uri()
LABEL = sys.argv[1] if len(sys.argv) > 1 else "(当前工作区)"

VIEWPORTS = [
    (1920, 1080), (1600, 900), (1366, 768), (1109, 1104),
    (1493, 1236), (1126, 1236),
]


def run(w, h, ingame):
    url = f"{PAGE}?vw={w}&vh={h}" + ("&ingame=1" if ingame else "")
    tmp = Path(tempfile.gettempdir()) / f"gm-{uuid.uuid4().hex[:8]}"
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--allow-file-access-from-files", "--hide-scrollbars",
        f"--user-data-dir={tmp}",
        # 外层窗口只要够大即可：被测视口由 iframe 的 vw/vh 参数决定。
        # （--headless=new 的 --window-size 含约 150px 浏览器边框，直接当视口用会量错。）
        f"--window-size={max(w, 1280)},{h + 260}",
        "--virtual-time-budget=8000",
        "--dump-dom", url,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    m = re.search(r'<pre id="metrics">(.*?)</pre>', p.stdout or "", re.S)
    if not m:
        return {"_err": "no metrics node"}
    raw = m.group(1).strip()
    if raw in ("pending", "measuring…", ""):
        return {"_err": f"metrics pending: {raw[:80]}"}
    try:
        return json.loads(raw)
    except Exception as e:
        return {"_err": f"json fail {e}", "_raw": raw[:300]}


def main():
    print(f"===== 被测目标: {LABEL} =====")
    print(f"===== page: {PAGE} =====")
    print()
    for (w, h) in VIEWPORTS:
        for ingame in (False, True):
            d = run(w, h, ingame)
            tag = f"{w}x{h} {'对局中' if ingame else '初始态'}"
            if "_err" in d:
                print(f"### {tag}  !! {d['_err']}")
                continue
            c = d.get("画布") or {}
            g = d.get("画布占视口") or {}
            z = d.get("_诊断") or {}
            vp = d.get("viewport") or {}
            print(f"### {tag}   实测视口 {vp.get('w')}x{vp.get('h')}")
            print(f"    导航{d.get('导航栏高')} 横幅{d.get('战绩横幅')} "
                  f"in-game={d.get('inGameClass')}")
            print(f"    画布 {c.get('w')}x{c.get('h')}px | 占视口 宽{g.get('宽')} "
                  f"高{g.get('高')} | 上{g.get('上')} 下{g.get('下')}")
            print(f"    木框 {d.get('木框')}")
            print(f"    诊断: 新版={z.get('新版算法')} wrapper宽={z.get('boardWrapper宽')} "
                  f"availW={z.get('可用宽度availW')} availH={z.get('可用高度availH')} "
                  f"-> {z.get('约束')}")
        print()


if __name__ == "__main__":
    main()
