import os
import shutil
import uuid
import gc
import re
import sys
import requests
import uvicorn
import http.cookiejar
from typing import List, Dict
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import asyncio

# 加载环境变量
current_dir = os.path.dirname(os.path.abspath(__file__)); env_path = os.path.join(current_dir, ".env"); load_dotenv(dotenv_path=env_path, override=True)

app = FastAPI(title="YouTube 字幕翻译系统 API")

# 配置跨域请求（CORS），允许 YouTube 页面访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://www.youtube.com", "http://localhost", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 请求体定义，支持前端直接传递 VTT 内容以完全绕过 YouTube IP 限制
class TranslateRequest(BaseModel):
    url: str
    vtt: str = None
    lang: str = None

class ChunkTranslateRequest(BaseModel):
    srt_chunk: str

# 辅助函数：格式化时间戳为 SRT 规范格式 (00:00:00,000)
def format_timestamp(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    milliseconds = int(round((seconds % 1) * 1000))
    if milliseconds == 1000:
        milliseconds = 0
        secs += 1
        if secs == 60:
            secs = 0
            minutes += 1
            if minutes == 60:
                minutes = 0
                hours += 1
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"

# 辅助函数：调用 DeepSeek/OpenAI 兼容 API 进行 SRT 翻译
def translate_srt_chunk(srt_text: str) -> str:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    
    if not api_key:
        # 如果未配置 API Key，退回不翻译状态
        return srt_text
        
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    prompt = (
        "请把以下带有时间戳的视频字幕翻译成中文。保持原有的时间戳格式（如 1\\n00:00:12,000 --> 00:00:15,000）和序号绝对不变，只翻译文本内容，不要输出任何解释。\n\n"
        f"{srt_text}"
    )
    
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.3,
        "max_tokens": 4000
    }
    
    # 兼容 OpenAI v1 的 endpoint
    url = f"{base_url.rstrip('/')}/chat/completions"
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.json()
        result = data['choices'][0]['message']['content'].strip()
        
        # 清理可能被大模型误加的 Markdown 包裹符号
        result = re.sub(r'^```srt\s*', '', result, flags=re.IGNORECASE)
        result = re.sub(r'^```\s*', '', result)
        result = re.sub(r'\s*```$', '', result)
        return result.strip()
    except Exception as e:
        print(f"DeepSeek 翻译请求失败: {str(e)}")
        # 翻译失败时返回原字幕以保证系统的高可用性
        return srt_text

# 清洗并转换 VTT 字符串内容到 clean SRT，彻底消除 YouTube 自动字幕中滚动重复行（rolling duplicates）
def clean_and_convert_vtt_content_to_srt(vtt_content: str) -> str:
    import re
    if not vtt_content:
        return ""
        
    # 按双换行分割 VTT 块
    blocks = re.split(r'\n\s*\n', vtt_content)
    
    srt_blocks = []
    prev_block_lines = set()
    index = 1
    
    for block in blocks:
        block = block.strip()
        if not block or block.startswith("WEBVTT") or block.startswith("Kind:") or block.startswith("Language:"):
            continue
            
        lines = block.splitlines()
        time_line = None
        text_lines = []
        
        for line in lines:
            if "-->" in line:
                time_line = line
            elif time_line:
                text_lines.append(line)
                
        if not time_line or not text_lines:
            continue
            
        # 清理 HTML 标签和单词级微时间戳（如 <00:00:01.360>、<c>、</c>）
        cleaned_text_lines = []
        for line in text_lines:
            cleaned_line = re.sub(r'<[^>]+>', '', line).strip()
            if cleaned_line:
                cleaned_text_lines.append(cleaned_line)
                
        # 去重滚动字幕：仅保留当前块中在“前一个块”里未出现过的新行
        unique_text_lines = []
        for line in cleaned_text_lines:
            if line not in prev_block_lines:
                unique_text_lines.append(line)
                
        # 更新前一个块 of 行记录，供下一轮对比
        prev_block_lines = set(cleaned_text_lines)
        
        # 若清洗后没有新文本，则跳过此块（防止产生无意义的空字幕）
        if not unique_text_lines:
            continue
            
        # 转换时间戳格式：从 VTT 的 00:00:00.400 转为 SRT 的 00:00:00,400
        time_match = re.match(r'(\d{2}:\d{2}:\d{2})[.,](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[.,](\d{3})', time_line)
        if time_match:
            sh, sm, eh, em = time_match.group(1), time_match.group(2), time_match.group(3), time_match.group(4)
            srt_time = f"{sh},{sm} --> {eh},{em}"
        else:
            parts = time_line.split()
            srt_time = parts[0].replace(".", ",") + " --> " + parts[2].replace(".", ",")
            
        srt_text = "\n".join(unique_text_lines)
        srt_blocks.append(f"{index}\n{srt_time}\n{srt_text}\n\n")
        index += 1
        
    return "".join(srt_blocks).strip()

# 辅助清理临时目录的后台任务
def cleanup_temp_dir(dir_path: str):
    if os.path.exists(dir_path):
        shutil.rmtree(dir_path)
        print(f"临时目录已清理: {dir_path}")

@app.post("/api/translate")
async def translate_video(request_data: TranslateRequest, background_tasks: BackgroundTasks, request: Request):
    video_url = request_data.url
    vtt_content = request_data.vtt
    target_lang = request_data.lang
    
    print(f"收到 API 请求: url={video_url}, vtt_len={len(vtt_content) if vtt_content else 0}, lang={target_lang}")
    
    if not video_url:
        raise HTTPException(status_code=400, detail="未提供有效的视频 URL")
        
    # 产生唯一的临时下载目录，防止并发冲突
    task_id = str(uuid.uuid4())
    temp_dir = os.path.join("/tmp", f"yt_trans_{task_id}")
    os.makedirs(temp_dir, exist_ok=True)
    
    # 注册后台任务，确保无论成功与否都会清理磁盘上的临时文件
    background_tasks.add_task(cleanup_temp_dir, temp_dir)
    
    # 0. 如果前端提取出了字幕内容，直接进行解析并翻译，实现 100% 成功率与免 YouTube 限制的极速体验
    if vtt_content:
        try:
            print(f"收到前端传入的 VTT 字幕数据 (语言: {target_lang})。正在开始处理...")
            srt_content = clean_and_convert_vtt_content_to_srt(vtt_content)
            
            print("前端传入原生字幕解析完毕，直接返回用于按需翻译。")
            return {"srt": srt_content}
        except Exception as frontend_sub_err:
            print(f"处理前端传入的字幕失败，退回常规处理流程。错误: {str(frontend_sub_err)}")

    # 查找是否有 cookies.txt
    cookies_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")
    use_cookie = os.path.exists(cookies_path)
    
    # 1. 尝试直接获取 YouTube 现有字幕 (后端请求)
    try:
        import yt_dlp
        
        # 先提取元数据，检查可用字幕
        ydl_opts_info = {
            'skip_download': True,
            'cookiefile': cookies_path if use_cookie else None,
            'quiet': True,
            'no_warnings': True,
            'remote_components': ['ejs:github'],
            'nocheckcertificate': True,
            'headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        }
        
        print("正在获取视频字幕元数据...")
        with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
            info = ydl.extract_info(video_url, download=False)
            
        subtitles = info.get('subtitles') or {}
        auto_caps = info.get('automatic_captions') or {}
        
        target_lang = None
        is_auto = False
        
        # 优先级 1：中文手动字幕
        for l in ['zh-Hans', 'zh-CN', 'zh-SG', 'zh-Hant', 'zh-TW', 'zh-HK', 'zh']:
            if l in subtitles:
                target_lang = l
                is_auto = False
                break
                
        # 优先级 2：英文手动字幕
        if not target_lang:
            for l in ['en', 'en-US', 'en-GB']:
                if l in subtitles:
                    target_lang = l
                    is_auto = False
                    break
                    
        # 优先级 3：中文自动字幕
        if not target_lang:
            for l in ['zh-Hans', 'zh-CN', 'zh-SG', 'zh-Hant', 'zh-TW', 'zh-HK', 'zh']:
                if l in auto_caps:
                    target_lang = l
                    is_auto = True
                    break
                    
        # 优先级 4：英文自动字幕
        if not target_lang:
            for l in ['en', 'en-US', 'en-GB']:
                if l in auto_caps:
                    target_lang = l
                    is_auto = True
                    break
                    
        # 优先级 5：任意其他手动字幕
        if not target_lang and subtitles:
            target_lang = list(subtitles.keys())[0]
            is_auto = False
            
        # 优先级 6：任意其他自动字幕
        if not target_lang and auto_caps:
            target_lang = list(auto_caps.keys())[0]
            is_auto = True
            
        if target_lang:
            if await request.is_disconnected():
                print("检测到客户端在字幕下载前已断开。")
                return {"srt": ""}
                
            # 从 metadata 中找到 vtt 格式的 url
            formats = subtitles.get(target_lang) or auto_caps.get(target_lang) or []
            vtt_url = None
            for fmt in formats:
                if fmt.get('ext') == 'vtt':
                    vtt_url = fmt.get('url')
                    break
            # 如果没有 vtt 格式，就拿第一个格式的 url
            if not vtt_url and formats:
                vtt_url = formats[0].get('url')
                
            if not vtt_url:
                raise Exception("未找到对应语言的 VTT 字幕 URL")
                
            print(f"匹配到视频字幕: {target_lang} (是否自动字幕: {is_auto})。开始直接请求 URL 获取 VTT 字幕...")
            
            # 使用 requests.Session 加载 cookies 发起轻量级 GET 请求，规避 yt-dlp 触发 429 报错
            session = requests.Session()
            if use_cookie:
                cj = http.cookiejar.MozillaCookieJar(cookies_path)
                try:
                    cj.load(ignore_discard=True, ignore_expires=True)
                    session.cookies = cj
                except Exception as e:
                    print(f"加载 cookies.txt 失败: {str(e)}")
                    
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
            
            res = session.get(vtt_url, headers=headers, timeout=15)
            res.raise_for_status()
            vtt_content = res.text
            
            # 转换并清洗 VTT -> SRT
            srt_content = clean_and_convert_vtt_content_to_srt(vtt_content)
            
            print("YouTube 原生字幕解析完毕，直接返回用于按需翻译。")
            return {"srt": srt_content}
                
    except Exception as sub_err:
        print(f"尝试下载并解析 YouTube 原生字幕失败，将使用 Whisper 音频识别兜底。错误信息: {str(sub_err)}")

    # 2. 兜底方案：使用 Whisper 转录音频 (当视频没有任何字幕时)
    audio_path = None
    try:
        if await request.is_disconnected():
            print("检测到客户端在音频下载前已断开。")
            return {"srt": ""}
            
        import yt_dlp
        
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': os.path.join(temp_dir, 'audio.%(ext)s'),
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'm4a',
                'preferredquality': '128',
            }],
            'quiet': True,
            'no_warnings': True,
            'remote_components': ['ejs:github'],
            'nocheckcertificate': True,
            'headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        }

        if use_cookie:
            ydl_opts['cookiefile'] = cookies_path
            
        print(f"没有可用字幕，正在下载视频音频: {video_url}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
            
        files = os.listdir(temp_dir)
        for f in files:
            if f.endswith('.m4a'):
                audio_path = os.path.join(temp_dir, f)
                break
                
        if not audio_path or not os.path.exists(audio_path):
            raise HTTPException(status_code=500, detail="音频下载提取失败")
            
        if await request.is_disconnected():
            print("检测到客户端在 Whisper 模型加载前已断开。")
            return {"srt": ""}
            
        from faster_whisper import WhisperModel
        
        model_size = os.getenv("WHISPER_MODEL", "small")
        print(f"正在加载 Whisper 模型 ({model_size}) 并进行语音转录...")
        
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, beam_size=5)
        
        raw_srt_lines = []
        index = 1
        for segment in segments:
            start_str = format_timestamp(segment.start)
            end_str = format_timestamp(segment.end)
            text = segment.text.strip()
            if text:
                raw_srt_lines.append(f"{index}\n{start_str} --> {end_str}\n{text}\n\n")
                index += 1
                
        print(f"语音转录完成。自动检测语言: {info.language}，置信度: {info.language_probability:.2f}")
        
        del model
        gc.collect()
        
        if not raw_srt_lines:
            return {"srt": ""}
            
        final_srt = "".join(raw_srt_lines).strip()
        print("Whisper 音频提取及转录处理完毕，返回用于按需翻译！")
        return {"srt": final_srt}
        
    except Exception as e:
        print(f"系统运行异常: {str(e)}")
        raise HTTPException(status_code=500, detail=f"翻译服务运行异常: {str(e)}")

@app.post("/api/translate_chunk")
async def translate_chunk(request_data: ChunkTranslateRequest, request: Request):
    chunk_text = request_data.srt_chunk
    if not chunk_text.strip():
        return {"srt": ""}
        
    if await request.is_disconnected():
        return {"srt": ""}
        
    try:
        translated = await asyncio.to_thread(translate_srt_chunk, chunk_text)
        return {"srt": translated}
    except Exception as e:
        print(f"Chunk translation error: {str(e)}")
        return {"srt": chunk_text} # Fallback to original

if __name__ == "__main__":
    # 从环境变量读取绑定的 IP 与端口，默认在 9000 端口
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "9000"))
    uvicorn.run(app, host=host, port=port)
