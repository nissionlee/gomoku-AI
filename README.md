# 弈境五子棋 · AI 对弈平台 (Gomoku Web)

精美典雅的东方现代风格五子棋网页版，支持与本地多等级智能算法或云端大语言模型（DeepSeek、Gemini、OpenAI、通义千问等）实时对弈。

---

## ✨ 核心特性

1. **🚀 100% 免费部署于 Cloudflare**
   - 纯前端零后端依赖架构，原生适配 **Cloudflare Pages**（无限流量、全球 CDN 加速、自带免费 HTTPS）。
   - 随附 `functions/api/proxy.js` 无服务器反向代理，解决部分国内大模型 API 跨域问题。
2. **🤖 多大模型自定义配置**
   - 支持主流大模型服务商预设：**DeepSeek**、**Google Gemini**、**OpenAI**、**阿里通义千问 (DashScope)**、**月之暗面 (Kimi)** 以及 **本地 Ollama / OneAPI / 自定义兼容端点**。
   - 具有 4 种生动的 AI 对话人设性格（**幽默话痨**、**世外高人**、**傲娇对手**、**严谨冷静**），边下棋边对话吐槽！
   - 支持直观的“测试模型连接”按键与 API 密钥本地安全加密存储。
3. **📊 输赢战绩与历史保存**
   - 自动持久化保存总局数、胜局、败局、综合胜率、连胜记录于本地 `localStorage`。
   - 详细历史对局流水账（对战时间、执棋先后手、对手模型与难度、步数、用时）。
4. **⚔️ 三档对战难度可调**
   - **入门低难度 (Novice)**：基础威胁识别与适当随机性，适合轻松休闲。
   - **业余中难度 (Intermediate)**：攻防兼备，敏锐捕捉冲四、活三威胁。
   - **大师高难度 (Master)**：Alpha-Beta 剪枝深度极小化极大搜索，步步为营。
5. **⚖️ 先手三三禁手规则与贴心辅助**
   - **规则限制**：严格遵循连珠规则，先手黑棋不可下“三三禁手”（同时形成两个及以上活三），违规落子时伴随声音与提示阻止。
   - **悔棋按键**：一键撤销双方最近一轮走步，随时调整棋路。
   - **赢局高光提示**：五连成线金色光环特效与结算奖杯弹窗。
   - **原生音频合成**：内置 Web Audio API 拟真玉石落子声、胜利和弦、警告蜂鸣。
6. **📜 落子轨迹回放与逐手 AI 分析**
   - **落子轨迹面板**：每一手的序号、黑白、坐标、落子归属（你/AI）与单手用时自动成表，点击任意一手即跳回当时的盘面，最近八手以金色轨迹连线呈现在棋盘上。
   - **回放控制条**：首手/上一手/下一手/末手逐手浏览，支持自动播放（慢/常/快三档）与进度滑块拖动，键盘 ←/→ 也可逐手翻阅；回放中棋盘只读，点「返回对局」无缝续战。
   - **逐手质量分析（本地引擎，离线可用）**：任意一手可算出评分、与引擎最佳点的匹配度、形成的棋形（活三/冲四/活四…）、防守价值，并自动定级为「引擎首选 / 好手 / 缓手 / 疑问手 / 关键漏防 / 错失杀招 / 一手致胜」等，同时给出更优替代点（点击即在棋盘上标出光环）。
   - **后续三手推演**：从任意局面出发，按双方最强应对推演下一步、下下一步、下下下一步的变化主线，并标注是否有一方连五致胜。
   - **大模型深度解读**：本地结论 + ASCII 文字棋盘一起交给 DeepSeek/Gemini 等大模型，产出教练口吻的四段棋评（本手定性/局势判断/后续变化/改进建议）。
   - **旧对局复盘**：战绩记录中的每一局都可一键载入完整棋谱，用同样的回放与分析工具复盘；分析结论与当前对局相互隔离、互不污染。

---

## 🛠️ 本地运行与体验

本项目采用原生现代 Web 标准（ES6+ Modules），无需复杂的 Node 打包编译：

### 方式 1：使用 Python 快速启动本地静态服务器
```bash
# 在项目根目录下运行
python -m http.server 8080
```
然后在浏览器访问：`http://localhost:8080`

### 方式 2：使用 Node.js / npx
```bash
npx serve .
```

---

## ☁️ Cloudflare Pages 免费部署指南

Cloudflare Pages 提供完全免费的静态网页托管与全球 CDN，每月提供无限访问请求。

### 方法一：通过 GitHub 自动构建部署（推荐，更新代码自动同步）
1. 将当前项目推送至您的 GitHub 仓库。
2. 打开 [Cloudflare 仪表盘 (Dash)](https://dash.cloudflare.com/)，在左侧导航栏点击 **Workers & Pages** -> **Create application** -> **Pages**。
3. 点击 **Connect to Git** 并选中您的五子棋代码仓库。
4. 构建配置：
   - **Framework preset (框架预设)**: `None`
   - **Build command (构建命令)**: 留空（无需构建）
   - **Build output directory (输出目录)**: `.` (即根目录)
5. 点击 **Save and Deploy**。几秒钟内即可生成 `https://your-project.pages.dev` 访问链接！

### 方法二：使用 Wrangler 命令行 1 秒快速部署
在本地终端中运行：
```bash
# 首次使用需登录 Cloudflare
npx wrangler login

# 一键部署当前目录
npx wrangler pages deploy . --project-name gomoku-ai
```

### 方法三：网页端直接上传文件夹 (Direct Upload)
1. 登录 Cloudflare 后台，进入 **Workers & Pages** -> **Create application** -> **Pages** -> **Upload assets**。
2. 给项目命名（如 `my-gomoku`）。
3. 直接将本文件夹拖入网页中上传，点击 **Deploy site** 即可完成！

---

## 🔑 大模型 API 获取与配置指南

点击界面上的【⚙️ 设置】按钮，即可开启大模型对战：

| 模型平台 | API Key 申请地址 | 默认 Base URL | 推荐模型名 |
| :--- | :--- | :--- | :--- |
| **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com) | `https://api.deepseek.com/v1` | `deepseek-chat` |
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **阿里通义千问** | [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| **月之暗面 Kimi** | [platform.moonshot.cn](https://platform.moonshot.cn) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| **本地 Ollama** | 本地运行 `ollama serve` | `http://localhost:11434/v1` | `qwen2.5` / `llama3` |

> 🔒 **隐私声明**：您输入的 API Key 仅保存在您当前浏览器的本地 `localStorage` 中，直接在客户端向官方 API 发起请求，没有任何中间服务器转存您的密钥。

---

## 📜 规则小知识：先手三三禁手

五子棋中，先行一方具有极大的进攻优势（先手必胜定式）。为保证公平竞技性，标准五子棋规则（Renju）规定：
- **黑方（先手）**落子若在同一位置同时产生两个或两个以上的“活三”，则被判为**三三禁手**，不可落子。
- **白方（后手）**没有此禁手限制，并且白方连成 5 颗或以上均算获胜。
- 如果黑方一子同时连成“五连”和“三三”，以“五连获胜”优先，不按禁手处理。
