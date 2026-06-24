// ==UserScript==
// @name         YouTube AI 自动字幕翻译助手
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  在 YouTube 视频播放器旁注入 "AI 字幕" 按钮，优先前端提取原生/自动字幕并发往后端翻译，极速秒开、彻底绕过 YouTube VPS 封锁，无字幕视频自动降级为 Whisper 转录兜底。
// @author       Antigravity
// @match        https://*.youtube.com/*
// @match        https://youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @connect      your-backend-domain.com
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    console.log("[AI 字幕助手] 脚本已成功初始化加载，开始监测页面...");

    // =========================================================================
    // 终极破局：底层网络双擎拦截器（Fetch + XHR）+ 全局缓存
    // 拦截到的字幕会立刻被存入缓存。因为 YouTube 有缓存机制，开关 CC 按钮不会二次请求！
    // =========================================================================
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (!win._ytSubInterceptorInjected) {
        win._ytSubInterceptorInjected = true;
        win._cachedYtSub = null; // 全局字幕缓存

        const saveAndDispatch = (url, text) => {
            if (text && text.length > 0) {
                console.log("[AI 字幕助手] 成功截胡官方播放器字幕！长度:", text.length);
                let format = 'json3';
                if (url.includes('fmt=vtt')) format = 'vtt';
                else if (url.includes('fmt=srv3')) format = 'srv3';

                const payload = { text, format };
                win._cachedYtSub = payload; // 存入缓存，以防用户在点击翻译前就已经加载过字幕
                window.dispatchEvent(new CustomEvent('YtSubIntercepted', { detail: payload }));
            }
        };

        // 1. 拦截 Fetch
        const originalFetch = win.fetch;
        win.fetch = async function (...args) {
            const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const responsePromise = originalFetch.apply(this, args);
            if (requestUrl.includes('/api/timedtext')) {
                responsePromise.then(response => {
                    response.clone().text().then(text => saveAndDispatch(requestUrl, text)).catch(e => { });
                });
            }
            return responsePromise;
        };

        // 2. 拦截 XHR (部分 YouTube 版本或回退模式会使用 XHR)
        const originalXHR = win.XMLHttpRequest;
        win.XMLHttpRequest = function () {
            const xhr = new originalXHR();
            const originalOpen = xhr.open;
            xhr.open = function (method, url) {
                this._url = typeof url === 'string' ? url : url.toString();
                return originalOpen.apply(this, arguments);
            };
            xhr.addEventListener('load', function () {
                if (this._url && this._url.includes('/api/timedtext')) {
                    saveAndDispatch(this._url, this.responseText);
                }
            });
            return xhr;
        };

        console.log("[AI 字幕助手] 官方字幕底层双擎拦截器已就绪。");
    }

    // 默认后端 API 地址。如果您已完成 SSL 申请，请将协议头改为 https://
    const API_BASE_URL = "https://your-backend-domain.com";

    let originalSubtitles = [];
    let translatedSubtitles = [];
    let activeSubtitles = [];
    let translatingChunks = new Set();
    const CHUNK_SIZE = 15;
    
    let subtitleContainer = null;
    let isTrackingTime = false;
    let isBilingualMode = false;

    // 安全更新按钮内容，避免 Trusted Types 限制
    function setButtonContent(button, text, iconClass = null) {
        button.textContent = '';
        if (iconClass) {
            const icon = document.createElement('i');
            icon.className = iconClass;
            icon.style.marginRight = '6px';
            button.appendChild(icon);
        }
        button.appendChild(document.createTextNode(text));
    }

    function timeToSeconds(timeStr) {
        const parts = timeStr.split(':');
        const secondsParts = parts[2].split(/[.,]/);
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseInt(secondsParts[0], 10);
        const ms = parseInt(secondsParts[1], 10);
        return hours * 3600 + minutes * 60 + seconds + ms / 1000;
    }

    function secondsToTime(seconds) {
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        const ms = Math.round((seconds % 1) * 1000).toString().padStart(3, '0');
        return `${h}:${m}:${s},${ms}`;
    }

    // 解析后端返回的 SRT 格式内容为 JS 字幕数组
    function parseSRT(srtText) {
        const subArray = [];
        const blocks = srtText.replace(/\r\n/g, '\n').split('\n\n');

        for (let block of blocks) {
            block = block.trim();
            if (!block) continue;
            const lines = block.split('\n');
            if (lines.length >= 3) {
                const index = lines[0];
                const timeLine = lines[1];
                const textLines = lines.slice(2);

                const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
                if (timeMatch) {
                    const startTime = timeToSeconds(timeMatch[1]);
                    const endTime = timeToSeconds(timeMatch[2]);
                    const text = textLines.join('\n');
                    subArray.push({ index, startTime, endTime, text });
                }
            }
        }
        return subArray;
    }

    // 注入自定义字幕渲染浮层
    function injectSubtitleContainer(playerElement) {
        if (document.getElementById('ai-subtitles-overlay')) {
            return document.getElementById('ai-subtitles-overlay');
        }

        const container = document.createElement('div');
        container.id = 'ai-subtitles-overlay';

        // 样式设计：高对比度、半透明防眩光背景、高斯模糊、霓虹白字，保证在任何视频背景下都极度清晰
        Object.assign(container.style, {
            position: 'absolute',
            bottom: '12%',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: '99',
            backgroundColor: 'rgba(8, 5, 20, 0.72)',
            backdropFilter: 'blur(8px)',
            webkitBackdropFilter: 'blur(8px)',
            color: '#ffffff',
            padding: '10px 24px',
            borderRadius: '12px',
            fontFamily: '"Montserrat", "Noto Serif SC", sans-serif',
            fontSize: '22px',
            fontWeight: '600',
            textAlign: 'center',
            lineHeight: '1.5',
            pointerEvents: 'none', // 穿透防止干扰播放器操作
            display: 'none',
            maxWidth: '85%',
            wordWrap: 'break-word',
            textShadow: '0px 2px 6px rgba(0, 0, 0, 0.9)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
        });

        playerElement.appendChild(container);
        return container;
    }

    // 动态按需翻译核心机制
    function checkAndLoadSubtitles(currentTime) {
        if (originalSubtitles.length === 0) return;

        let currentIndex = originalSubtitles.findIndex(sub => currentTime >= sub.startTime && currentTime <= sub.endTime);
        if (currentIndex === -1) {
            currentIndex = originalSubtitles.findIndex(sub => sub.startTime >= currentTime);
        }
        if (currentIndex === -1) currentIndex = 0;

        let chunkIndex = Math.floor(currentIndex / CHUNK_SIZE);
        
        loadChunk(chunkIndex);
        if ((chunkIndex + 1) * CHUNK_SIZE < originalSubtitles.length) {
            loadChunk(chunkIndex + 1);
        }
    }

    function loadChunk(chunkIndex) {
        if (translatingChunks.has(chunkIndex)) return;
        
        const startSubIndex = chunkIndex * CHUNK_SIZE;
        const targetSub = originalSubtitles[startSubIndex];
        
        if (translatedSubtitles.some(ts => ts.startTime === targetSub.startTime && ts.endTime === targetSub.endTime)) {
            return;
        }

        translatingChunks.add(chunkIndex);

        const endSubIndex = Math.min((chunkIndex + 1) * CHUNK_SIZE, originalSubtitles.length);
        const chunkSubs = originalSubtitles.slice(startSubIndex, endSubIndex);
        
        let srtText = '';
        for (let sub of chunkSubs) {
            srtText += `${sub.index}\n${secondsToTime(sub.startTime)} --> ${secondsToTime(sub.endTime)}\n${sub.text}\n\n`;
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE_URL}/api/translate_chunk`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ srt_chunk: srtText }),
            onload: function(response) {
                translatingChunks.delete(chunkIndex);
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.srt) {
                            const parsedTranslated = parseSRT(data.srt);
                            for (let ts of parsedTranslated) {
                                if (!translatedSubtitles.some(existing => existing.startTime === ts.startTime && existing.endTime === ts.endTime)) {
                                    translatedSubtitles.push(ts);
                                }
                            }
                            activeSubtitles = [...translatedSubtitles].sort((a, b) => a.startTime - b.startTime);
                        }
                    } catch (e) {
                        console.error("Chunk parse error:", e);
                    }
                }
            },
            onerror: function(err) {
                console.error("Chunk translate error:", err);
                translatingChunks.delete(chunkIndex);
            }
        });
    }

    // 字幕时间轴同步监听
    function startSubtitleTracking(video) {
        if (isTrackingTime) return;
        isTrackingTime = true;

        video.addEventListener('timeupdate', () => {
            const currentTime = video.currentTime;
            checkAndLoadSubtitles(currentTime);

            if (originalSubtitles.length === 0 || !subtitleContainer) return;

            // 优先匹配翻译后的，如果没翻译好，匹配原始的
            let matchedSub = activeSubtitles.find(
                sub => currentTime >= sub.startTime && currentTime <= sub.endTime
            );
            let origSub = originalSubtitles.find(
                sub => currentTime >= sub.startTime && currentTime <= sub.endTime
            );
            
            let displayState = "";
            let textToDisplay = [];
            
            if (matchedSub) {
                textToDisplay.push({text: matchedSub.text, type: "zh"});
                if (isBilingualMode && origSub) {
                    textToDisplay.push({text: origSub.text, type: "en"});
                }
                displayState = "zh:" + matchedSub.text + "|en:" + (origSub ? origSub.text : "") + "|b:" + isBilingualMode;
            } else if (origSub) {
                textToDisplay.push({text: origSub.text + " ⏳", type: "en"});
                displayState = "en:" + origSub.text + " ⏳";
            }

            if (textToDisplay.length > 0) {
                if (subtitleContainer.dataset.lastState !== displayState) {
                    subtitleContainer.textContent = '';
                    textToDisplay.forEach((item, itemIdx) => {
                        const wrapper = document.createElement('div');
                        if (item.type === "en" && itemIdx > 0) {
                            wrapper.style.fontSize = "0.75em";
                            wrapper.style.color = "rgba(255, 255, 255, 0.65)";
                            wrapper.style.marginTop = "6px";
                        }
                        
                        const lines = item.text.split('\n');
                        lines.forEach((line, index) => {
                            if (index > 0) {
                                wrapper.appendChild(document.createElement('br'));
                            }
                            wrapper.appendChild(document.createTextNode(line));
                        });
                        subtitleContainer.appendChild(wrapper);
                    });
                    
                    subtitleContainer.style.display = 'block';
                    subtitleContainer.dataset.lastState = displayState;
                }
            } else {
                if (subtitleContainer.dataset.lastState !== '') {
                    subtitleContainer.textContent = '';
                    subtitleContainer.style.display = 'none';
                    subtitleContainer.dataset.lastState = '';
                }
            }
        });
    }

    // 将 YouTube json3 格式转换为标准 VTT 文本
    // json3 格式结构: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
    function convertJson3ToVtt(jsonText) {
        try {
            const data = JSON.parse(jsonText);
            if (!data.events || data.events.length === 0) return "";

            let vtt = "WEBVTT\n\n";
            for (const event of data.events) {
                // 跳过没有文本段的事件（如换行标记等）
                if (!event.segs || event.segs.length === 0) continue;

                const text = event.segs.map(s => s.utf8 || '').join('').trim();
                if (!text || text === '\n') continue;

                const startMs = event.tStartMs || 0;
                const durationMs = event.dDurationMs || 0;
                const endMs = startMs + durationMs;

                const startStr = msToVttTime(startMs);
                const endStr = msToVttTime(endMs);

                vtt += `${startStr} --> ${endStr}\n${text}\n\n`;
            }

            console.log("[AI 字幕助手] json3 转 VTT 成功，输出长度:", vtt.length);
            return vtt;
        } catch (e) {
            console.error("[AI 字幕助手] json3 解析失败:", e);
            return "";
        }
    }

    // 将 YouTube srv3 (XML) 格式转换为标准 VTT 文本
    function convertSrv3ToVtt(xmlText) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlText, 'text/xml');
            const textElements = doc.querySelectorAll('text');

            if (!textElements || textElements.length === 0) return "";

            let vtt = "WEBVTT\n\n";
            for (const el of textElements) {
                const startSec = parseFloat(el.getAttribute('start') || '0');
                const durSec = parseFloat(el.getAttribute('dur') || '0');
                const endSec = startSec + durSec;
                const text = (el.textContent || '').trim();

                if (!text) continue;

                const startStr = msToVttTime(startSec * 1000);
                const endStr = msToVttTime(endSec * 1000);

                vtt += `${startStr} --> ${endStr}\n${text}\n\n`;
            }

            console.log("[AI 字幕助手] srv3 转 VTT 成功，输出长度:", vtt.length);
            return vtt;
        } catch (e) {
            console.error("[AI 字幕助手] srv3 解析失败:", e);
            return "";
        }
    }

    // 毫秒转 VTT 时间格式 (HH:MM:SS.mmm)
    function msToVttTime(ms) {
        const totalSec = Math.floor(ms / 1000);
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;
        const millis = Math.floor(ms % 1000);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
    }

    // 终极提取方案：使用 GM_addElement 突破 TrustedTypes 在网页原生上下文中执行 fetch
    function fetchInPageContext(url) {
        return new Promise((resolve) => {
            const eventName = '__ai_sub_fetch_' + Math.random().toString(36).slice(2);

            const handler = (e) => {
                document.removeEventListener(eventName, handler);
                resolve(e.detail || "");
            };
            document.addEventListener(eventName, handler);

            const code = `
                (async () => {
                    try {
                        const res = await fetch("${url.replace(/"/g, '\\"')}");
                        const text = await res.text();
                        document.dispatchEvent(new CustomEvent("${eventName}", { detail: text }));
                    } catch (e) {
                        document.dispatchEvent(new CustomEvent("${eventName}", { detail: "" }));
                    }
                })();
            `;

            try {
                // 利用油猴特权接口合法绕过 YouTube 的 TrustedTypes 与 CSP 限制
                GM_addElement('script', { textContent: code });
            } catch (e) {
                console.warn("[AI 字幕助手] GM_addElement 注入脚本失败:", e);
                document.removeEventListener(eventName, handler);
                resolve("");
            }

            // 安全超时：10 秒后自动 resolve
            setTimeout(() => {
                document.removeEventListener(eventName, handler);
                resolve("");
            }, 10000);
        });
    }

    // 核心提取逻辑：通过操控原生播放器开启字幕，截胡底层网络请求获取最新数据
    async function extractYoutubeSubtitles() {
        try {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const moviePlayer = win.document.getElementById('movie_player') || win.document.querySelector('.html5-video-player');

            // 尝试获取字幕状态
            const captionTracks = moviePlayer?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
                win.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

            if (captionTracks.length === 0) {
                console.warn("[AI 字幕助手] 该视频没有任何可用的字幕轨道");
                return null;
            }

            console.log("[AI 字幕助手] 采用官方请求截胡模式获取字幕...");

            return new Promise((resolve) => {
                const processInterceptedPayload = (payload) => {
                    const { text, format } = payload;
                    let vttText = text;
                    if (format === 'json3') {
                        vttText = convertJson3ToVtt(text);
                    } else if (format === 'srv3') {
                        vttText = convertSrv3ToVtt(text);
                    }
                    console.log(`[AI 字幕助手] 拦截成功！最终 VTT 内容长度:`, vttText.length);
                    resolve({
                        vtt: vttText,
                        lang: captionTracks[0]?.languageCode || 'en'
                    });
                };

                // 第一道防线：检查是否在点击翻译按钮之前，就已经拦截到字幕了（全局缓存）
                if (win._cachedYtSub) {
                    console.log("[AI 字幕助手] 发现已缓存的官方字幕，直接秒取！");
                    processInterceptedPayload(win._cachedYtSub);
                    return;
                }

                let timeout;

                // 监听到底层拦截器发出的字幕数据
                const onIntercept = (e) => {
                    window.removeEventListener('YtSubIntercepted', onIntercept);
                    clearTimeout(timeout);
                    processInterceptedPayload(e.detail);
                };

                window.addEventListener('YtSubIntercepted', onIntercept);

                timeout = setTimeout(() => {
                    window.removeEventListener('YtSubIntercepted', onIntercept);
                    console.warn(`[AI 字幕助手] 等待官方字幕拦截超时 (5秒)，可能无法截取！`);
                    resolve(null);
                }, 5000);

                // --- 触发官方播放器下载字幕 ---
                const ccButton = document.querySelector('.ytp-subtitles-button');
                const wasCCActive = ccButton && ccButton.getAttribute('aria-pressed') === 'true';

                // 如果官方播放器提供了 API，且当前没有开启字幕，直接调用
                if (moviePlayer && typeof moviePlayer.toggleSubtitlesOn === 'function') {
                    if (!wasCCActive) moviePlayer.toggleSubtitlesOn();
                } else if (ccButton) {
                    // 如果没有打开字幕，则主动点击打开它触发网络请求
                    if (!wasCCActive) {
                        ccButton.click();
                    }
                }

                // 强制重置：如果本来就是打开的，但缓存里没数据，说明是页面加载前的遗留状态
                // 我们必须关掉再打开，强迫播放器发起新的网络请求！
                if (wasCCActive && ccButton) {
                    console.log("[AI 字幕助手] 字幕已是开启状态但无缓存，正在强制重启 CC 触发网络请求...");
                    ccButton.click(); // 关掉
                    setTimeout(() => ccButton.click(), 50); // 重新打开
                }
            });

        } catch (err) {
            console.error("[AI 字幕助手] 前端字幕提取异常: ", err);
            return null;
        }
    }

    // 核心网络业务：获取翻译字幕
    async function requestSubtitleTranslation(videoUrl, button) {
        setButtonContent(button, '提取字幕中...', 'fa-solid fa-spinner fa-spin');
        button.style.backgroundColor = 'rgba(255, 51, 102, 0.2)';
        button.style.borderColor = '#ff3366';

        let vttData = null;
        try {
            vttData = await extractYoutubeSubtitles();
        } catch (err) {
            console.error("[AI 字幕助手] 尝试提取前端字幕失败:", err);
        }

        const payload = { url: videoUrl };
        // 只有当 vttData 存在且 vtt 内容非空时才发送给后端
        if (vttData && vttData.vtt && vttData.vtt.length > 0) {
            payload.vtt = vttData.vtt;
            payload.lang = vttData.lang;
            console.log("[AI 字幕助手] 成功提取前端字幕，语言:", vttData.lang, "，VTT 字符数:", vttData.vtt.length);
            setButtonContent(button, 'AI 翻译中...', 'fa-solid fa-spinner fa-spin');
        } else {
            console.log("[AI 字幕助手] 前端未提取到字幕，将使用后端 Whisper 语音识别兜底。");
            setButtonContent(button, '音频下载中...', 'fa-solid fa-spinner fa-spin');
        }

        // 跨域使用 Tampermonkey 特权网络请求 API
        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE_URL}/api/translate`,
            headers: {
                "Content-Type": "application/json"
            },
            data: JSON.stringify(payload),
            timeout: 300000, // 5 分钟超时，适合长视频转录
            onload: function (response) {
                try {
                    if (response.status === 200) {
                        const data = JSON.parse(response.responseText);
                        if (data.srt) {
                            originalSubtitles = parseSRT(data.srt);
                            translatedSubtitles = [];
                            activeSubtitles = [];
                            translatingChunks.clear();

                            const moviePlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
                            const video = moviePlayer ? moviePlayer.querySelector('video') : null;

                            if (video && moviePlayer) {
                                subtitleContainer = injectSubtitleContainer(moviePlayer);
                                startSubtitleTracking(video);

                                // 强制触发一次时间更新，开始按需翻译
                                video.dispatchEvent(new Event('timeupdate'));

                                setButtonContent(button, '按需翻译就绪', 'fa-solid fa-bolt');
                                button.style.backgroundColor = 'rgba(0, 242, 254, 0.15)';
                                button.style.borderColor = '#00f2fe';
                            } else {
                                alert("找不到视频播放元素，请重试。");
                                setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines');
                            }
                        } else {
                            setButtonContent(button, '未识别出音频');
                            setTimeout(() => { setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines'); }, 3000);
                        }
                    } else {
                        setButtonContent(button, '服务异常');
                        setTimeout(() => { setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines'); }, 3000);
                    }
                } catch (e) {
                    setButtonContent(button, '解析失败');
                    setTimeout(() => { setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines'); }, 3000);
                }
            },
            onerror: function (err) {
                setButtonContent(button, '服务未启用/未配置SSL');
                console.error("网络请求异常: ", err);
                setTimeout(() => { setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines'); }, 3000);
            },
            ontimeout: function () {
                setButtonContent(button, '转录超时');
                setTimeout(() => { setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines'); }, 3000);
            }
        });
    }

    // 核心业务：在控制栏里动态注入优雅的 "AI 字幕" 按钮
    function injectAiButton() {
        // 如果不在视频播放页面，不进行注入
        if (!window.location.href.includes('watch?v=')) return;

        // 寻找主视频播放器容器
        const moviePlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (!moviePlayer) return;

        // 寻找主播放器的控制栏容器（支持右侧控制栏或者左侧控制栏作为备用）
        let controlBar = moviePlayer.querySelector('.ytp-right-controls');
        if (!controlBar) {
            controlBar = moviePlayer.querySelector('.ytp-left-controls');
        }

        if (!controlBar) {
            // 控制栏未加载，静默等待
            return;
        }

        // 避免在同一个控制栏中重复注入按钮
        if (controlBar.querySelector('#yt-ai-translate-btn')) return;

        // 动态引入 FontAwesome 图标支持
        if (!document.getElementById('font-awesome-tm')) {
            const faLink = document.createElement('link');
            faLink.id = 'font-awesome-tm';
            faLink.rel = 'stylesheet';
            faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(faLink);
        }

        const button = document.createElement('button');
        button.id = 'yt-ai-translate-btn';
        button.className = 'ytp-button';
        button.title = '一键获取 AI 中文字幕 (按需翻译)';

        // 按钮视觉设计
        setButtonContent(button, 'AI 字幕', 'fa-solid fa-microphone-lines');

        Object.assign(button.style, {
            float: 'left',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '18px',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: '600',
            padding: '0 12px',
            margin: '0 6px',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            height: '28px',
            width: 'auto',
            alignSelf: 'center',
            verticalAlign: 'middle',
            whiteSpace: 'nowrap'
        });

        button.addEventListener('mouseenter', () => {
            button.style.backgroundColor = 'rgba(255, 51, 102, 0.15)';
            button.style.borderColor = 'rgba(255, 51, 102, 0.6)';
            button.style.boxShadow = '0 0 10px rgba(255, 51, 102, 0.3)';
        });
        button.addEventListener('mouseleave', () => {
            if (button.textContent.includes('就绪')) {
                button.style.backgroundColor = 'rgba(0, 242, 254, 0.15)';
                button.style.borderColor = '#00f2fe';
            } else {
                button.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
                button.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            }
            button.style.boxShadow = 'none';
        });

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const videoUrl = window.location.href;
            if (videoUrl.includes('watch?v=')) {
                requestSubtitleTranslation(videoUrl, button);
            } else {
                alert("未检测到有效的 YouTube 播放地址。");
            }
        });

        // 注入双语切换按钮
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'yt-ai-bilingual-btn';
        toggleBtn.className = 'ytp-button';
        toggleBtn.title = '开启/关闭中英双语显示';
        setButtonContent(toggleBtn, '单语', 'fa-solid fa-language');

        Object.assign(toggleBtn.style, {
            float: 'left',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'transparent',
            border: 'none',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: '600',
            padding: '0 8px',
            margin: '0',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            height: '28px',
            width: 'auto',
            alignSelf: 'center',
            verticalAlign: 'middle',
            opacity: '0.8'
        });

        toggleBtn.addEventListener('mouseenter', () => toggleBtn.style.opacity = '1');
        toggleBtn.addEventListener('mouseleave', () => toggleBtn.style.opacity = '0.8');

        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isBilingualMode = !isBilingualMode;
            setButtonContent(toggleBtn, isBilingualMode ? '双语' : '单语', 'fa-solid fa-language');
            toggleBtn.style.color = isBilingualMode ? '#00f2fe' : '#ffffff';
            
            // 触发时间更新以刷新字幕渲染
            const video = document.querySelector('.html5-video-player video');
            if (video) video.dispatchEvent(new Event('timeupdate'));
        });

        controlBar.insertBefore(toggleBtn, controlBar.firstChild);
        controlBar.insertBefore(button, controlBar.firstChild);
        console.log("[AI 字幕助手] 按钮注入成功！插入位置: ", controlBar.className);
    }

    // 监听页面变化，确保在单页 SPA 切换视频时，能动态重建并载入按钮
    const observer = new MutationObserver(() => {
        injectAiButton();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // YouTube SPA 页面切换时清理上一集视频的缓存数据
    window.addEventListener('yt-navigate-start', () => {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (win._cachedYtSub) {
            win._cachedYtSub = null;
        }
        originalSubtitles = [];
        translatedSubtitles = [];
        activeSubtitles = [];
        translatingChunks.clear();
        if (subtitleContainer) {
            subtitleContainer.textContent = '';
            subtitleContainer.style.display = 'none';
        }
        // 重置按钮状态
        const btn = document.getElementById('yt-ai-translate-btn');
        if (btn) {
            setButtonContent(btn, 'AI 字幕', 'fa-solid fa-microphone-lines');
            btn.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
            btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        }
        const toggleBtn = document.getElementById('yt-ai-bilingual-btn');
        if (toggleBtn) {
            isBilingualMode = false;
            setButtonContent(toggleBtn, '单语', 'fa-solid fa-language');
            toggleBtn.style.color = '#ffffff';
        }
        console.log("[AI 字幕助手] 监听到页面切换，已自动清理上一个视频的字幕缓存！");
    });

    // 首次载入运行
    injectAiButton();
})();
