# YouTube Subtitle Translator (YouTube AI 字幕自动翻译助手)

一个强大、无缝、抗封锁的 YouTube AI 字幕翻译系统，采用 **前端截获 + 后端无感按需翻译（Lazy Loading）** 架构，彻底告别观影延迟，支持快进与双语显示，且极大地节省了 Token 消耗。

## ✨ 核心特性

- **按需并发翻译 (Lazy Loading)**：只翻译你实际观看的片段，未播放的片段不消耗任何大模型 Token，随时快进毫无压力。
- **底层请求截胡 (Fetch & XHR Interception)**：直接在浏览器底层拦截 YouTube 原生字幕文件，彻底绕过 YouTube 对服务器 IP 的严格封锁，无需复杂的代理配置。
- **中英双语完美对照**：前端原生支持实时切换单/双语字幕显示模式，辅助理解原汁原味的语境。
- **Whisper 兜底转录**：针对没有原文字幕的视频，后端支持自动回退至 Whisper 音频提取识别，不留任何翻译死角。
- **100% 格式对齐**：使用 DeepSeek/Gemini 等大模型并优化提示词，精确切割 `vtt/srt` 块，确保返回结果完全不破坏时间轴结构，完美吻合画面。

## ⚙️ 系统架构

整个系统分为 **浏览器脚本 (Frontend)** 与 **翻译服务 (Backend)** 两部分：

1. **Frontend (Tampermonkey)**：
   - 截获原生的 `.json3` 或 `.srv3` 字幕数据，转换为规范的 `VTT`。
   - 解析全量时间轴，并通过 **滑动预加载机制** 把接下来的播放片段（默认十余句话）静默发往后端。
   - 在等待接口返回时，屏幕无缝显示带有 `⏳` 的英文原文字幕；翻译完成后瞬间切换为纯正中文。
   - 提供播放器底部的原生体验按钮（AI 字幕 / 双语模式切换）。
2. **Backend (FastAPI)**：
   - 提供轻量化的 `/api/translate_chunk` 端点，接到请求后立即触发 `asyncio` 多协程向大模型发起调用。
   - 对于兜底任务，处理 YouTube 音频下载、转换并喂给 `Whisper`。
   - 使用系统 `Semaphore` 控制并发量，对大模型请求频率进行防抖和过载保护。

## 🚀 部署指南

### 后端部署 (Ubuntu / Debian VPS 推荐)

1. **环境准备**：
   ```bash
   sudo apt update && sudo apt install -y python3-venv ffmpeg
   git clone https://github.com/lockezhan/youtube-subtitle-translator.git
   cd youtube-subtitle-translator/backend
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. **配置环境变量**：
   复制配置文件并填入你的 DeepSeek 或任何兼容 OpenAI 格式的大模型 API Key：
   ```bash
   cp .env.example .env
   vim .env
   ```

3. **配置 Systemd 守护进程**：
   为了让后端服务在后台常驻并开机自启，请使用提供的 Systemd 服务配置。
   *注意：请先打开 `backend/yt-translator.service`，将其中的绝对路径修改为你实际的克隆目录。*
   ```bash
   sudo cp backend/yt-translator.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable yt-translator
   sudo systemctl start yt-translator
   sudo systemctl status yt-translator
   ```

4. **配置 Nginx 与 SSL 证书 (必须)**：
   由于现代浏览器强制要求扩展脚本发起跨域网络请求时必须使用 `HTTPS` 协议，因此必须为后端 API 配置域名的 SSL 证书。
   推荐使用免费的 `certbot` 自动签发 Let's Encrypt 证书：

   **申请 SSL 证书**：
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d 你的域名.com
   ```

   **配置 Nginx 反代转发**：
   将代码库中提供的示例配置移动到 Nginx。请注意，你必须先打开 `backend/nginx-yt.conf` 文件，将里面的 `your-backend-domain.com` 替换为你自己的实际域名，并确认证书的存放路径是否正确：
   ```bash
   sudo cp backend/nginx-yt.conf /etc/nginx/sites-available/yt-translator
   sudo ln -s /etc/nginx/sites-available/yt-translator /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

### 前端安装 (浏览器)

1. 安装 [Tampermonkey (油猴)](https://www.tampermonkey.net/) 浏览器扩展。
2. 打开油猴的控制台，新建一个脚本。
3. 将本项目 `frontend/youtube_sub_injector.js` 的所有代码复制粘贴进去并保存。
4. **注意修改脚本内的 `API_BASE_URL`** 为你刚才部署后端的实际域名（必须支持 HTTPS）。

## 💡 使用方法

打开任意 YouTube 视频，在播放器下方的控制栏找到闪烁霓虹灯效的 **“AI 字幕”** 按钮。点击它，一切将自动在无感中进行。你也可以点击旁边的 **“单语/双语”** 图标实时切换排版模式。

## 📝 License
MIT License
