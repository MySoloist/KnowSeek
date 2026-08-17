"""视频总结接口：后端 yt-dlp 下载 + ffmpeg 场景检测截帧 + AI 一轮总结"""

import asyncio
import base64
import gc
import io
import json
import logging
import math
import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import VideoSummarizeRequest
from services.llm import call_llm_chat_stream
from deps import verify_key

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_key)])

# 帧图片持久化目录
FRAMES_DIR = Path(__file__).parent.parent / "static" / "frames"
FRAMES_DIR.mkdir(parents=True, exist_ok=True)

# 工作临时目录（用完即删）
TEMP_DIR = Path(__file__).parent.parent / "temp"
TEMP_DIR.mkdir(exist_ok=True)

# yt-dlp cookies 文件（用于 Bilibili 等需要登录的平台）
COOKIES_FILE = Path(__file__).parent.parent / "cookies.txt"
if not COOKIES_FILE.exists():
    COOKIES_FILE = None

# 使用虚拟环境中的 yt-dlp
VENV_DIR = Path(__file__).parent.parent
YTDLP_CMD = str(VENV_DIR / ".venv" / "Scripts" / "yt-dlp.exe")

# 最大下载时长（秒），超过则截断
MAX_DOWNLOAD_SECONDS = 600  # 10 分钟


def _cleanup_old_frames(max_age_seconds: int = 3600):
    """清理过期帧文件"""
    try:
        now = __import__('time').time()
        for entry in os.scandir(FRAMES_DIR):
            if entry.is_dir():
                mtime = entry.stat().st_mtime
                age = now - mtime
                if age > max_age_seconds:
                    shutil.rmtree(entry.path, ignore_errors=True)
    except Exception:
        pass


def _get_max_individual_frames(model_name: str) -> int:
    """根据模型上下文窗口动态计算最大独立帧数。

    通过 litellm 查询模型的 max_input_tokens，再结合模型图片编码效率估算：
    - GPT-4o：约 85-300 tokens/图，极高效率
    - Gemini：约 258-500 tokens/图，高效率
    - Claude：约 1500 tokens/图
    - Qwen VL：约 3000-4000 tokens/图
    - 未知：保守估计 2000 tokens/图
    """
    # 1. 尝试从 litellm 获取模型 max_input_tokens
    try:
        from litellm import get_model_info
        info = get_model_info(model_name)
        max_input = info.get("max_input_tokens", 0)
        if max_input > 0:
            lower = model_name.lower()
            # 各模型每帧 token 估算
            if 'gemini' in lower:
                per_frame = 500
            elif 'gpt-4o' in lower:
                per_frame = 300
            elif 'claude' in lower:
                per_frame = 1500
            elif 'qwen' in lower and 'vl' in lower:
                per_frame = 3500
            else:
                per_frame = 2000  # 通用保守

            reserved = 6000  # 保留给系统提示 + 字幕 + 输出
            max_frames = max(5, (max_input - reserved) // per_frame)
            return min(max_frames, 100)  # 上限 100 帧
    except Exception:
        pass

    # 2. 回退到配置文件
    return _load_max_from_config(model_name)


def _load_max_from_config(model_name: str) -> int:
    """从 model_frame_config.json 加载帧策略配置"""
    config_path = Path(__file__).parent.parent / "model_frame_config.json"
    rules = []
    default_val = 15
    try:
        import json
        import re
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        rules = cfg.get("rules", [])
        default_val = cfg.get("default", 15)
    except Exception:
        pass

    name = model_name.lower()
    for rule in rules:
        try:
            if re.search(rule["pattern"], name):
                return rule["max_individual"]
        except Exception:
            continue
    return default_val


def _create_grid_image(image_paths: list[Path], cols: int = 3, max_size: int = 2048) -> io.BytesIO:
    """将多张图片排列成网格图，返回 JPEG 字节流。
    
    max_size: 网格图最长边的最大像素，超出的自动等比缩放。
    """
    if not HAS_PIL:
        return None
    images = [Image.open(p) for p in image_paths]
    # 统一缩放到相同尺寸
    widths = [im.width for im in images]
    heights = [im.height for im in images]
    cell_w = max(widths)
    cell_h = max(heights)
    resized = []
    for im in images:
        if im.width != cell_w or im.height != cell_h:
            im = im.resize((cell_w, cell_h), Image.LANCZOS)
        resized.append(im)

    rows = math.ceil(len(resized) / cols)
    grid_w = cols * cell_w
    grid_h = rows * cell_h
    grid = Image.new("RGB", (grid_w, grid_h), (0, 0, 0))

    for i, im in enumerate(resized):
        r = i // cols
        c = i % cols
        grid.paste(im, (c * cell_w, r * cell_h))

    # 缩放网格图到模型可接受的最大尺寸
    if max_size > 0 and (grid_w > max_size or grid_h > max_size):
        scale = min(max_size / grid_w, max_size / grid_h)
        new_w = int(grid_w * scale)
        new_h = int(grid_h * scale)
        grid = grid.resize((new_w, new_h), Image.LANCZOS)

    buf = io.BytesIO()
    grid.save(buf, format="JPEG", quality=80)
    buf.seek(0)
    return buf


@router.post("/video/summarize")
async def video_summarize(req: VideoSummarizeRequest):
    if not req.url:
        raise HTTPException(status_code=400, detail="url is required")
    if not req.subtitles and not req.use_asr:
        raise HTTPException(status_code=400, detail="subtitles is required")

    session_id = uuid.uuid4().hex
    work_dir = TEMP_DIR / session_id
    work_dir.mkdir(parents=True)
    video_path = work_dir / "video.mp4"
    frames_out_dir = work_dir / "frames"
    persis_dir = FRAMES_DIR / session_id

    async def event_generator():
        try:
            # ========== 1. 判断是否需要下载 ==========
            need_download = req.use_asr or not req.skip_frames
            audio_source_path = None  # 单独下载的音频源文件（如有）

            if need_download:
                # ========== yt-dlp 下载视频/音频 ==========
                yield _sse("progress", {"status": "downloading", "message": "正在下载视频（可能需要一些时间）..."})
                logger.info("[VideoSummary] 开始下载: %s", req.url)

                # 分类下载：视频和音频分开下载，避免合并步骤 timeout
                if req.skip_frames:
                    # 只需音频
                    audio_source_path = work_dir / "audio_source.m4a"
                    downloads = [("ba", str(audio_source_path))]
                elif req.use_asr:
                    # 需要视频（帧画面）+ 音频（ASR），分开下载，不合并
                    audio_source_path = work_dir / "audio_source.m4a"
                    downloads = [("bv*", str(video_path)), ("ba", str(audio_source_path))]
                else:
                    # 只需视频（帧画面）
                    downloads = [("bv*", str(video_path))]

                async def _download_one(fmt: str, out_path: str, _rc: list, extra_args: list = None):
                    """执行单次 yt-dlp 下载，将退出码存入 _rc"""
                    args = [
                        YTDLP_CMD,
                        "-o", out_path,
                        "--max-filesize", "200M",
                        "--no-playlist",
                        "--format", fmt,
                    ]
                    if extra_args:
                        args.extend(extra_args)
                    if COOKIES_FILE:
                        args.extend(["--cookies", str(COOKIES_FILE)])
                    args.append(req.url)

                    p = await asyncio.create_subprocess_exec(
                        *args,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    progress_q: asyncio.Queue = asyncio.Queue()

                    async def _read_stderr():
                        try:
                            while True:
                                raw = await p.stderr.readline()
                                if not raw:
                                    break
                                text = raw.decode("utf-8", errors="replace").strip()
                                if not text:
                                    continue
                                if "RequestsDependencyWarning" in text or "doesn't match a supported version" in text:
                                    continue
                                logger.info("[yt-dlp] %s", text)
                                dm = re.search(r"\[download\]\s+([\d.]+)%", text)
                                if dm:
                                    await progress_q.put(f"正在下载... {dm.group(1)}%")
                        except Exception as e:
                            logger.error("[yt-dlp] stderr reader error: %s", e)

                    stderr_task = asyncio.create_task(_read_stderr())
                    wait_t = asyncio.create_task(p.wait())
                    while True:
                        done, _ = await asyncio.wait([wait_t], timeout=0.3)
                        while not progress_q.empty():
                            yield _sse("progress", {"status": "downloading", "message": progress_q.get_nowait()})
                        if done:
                            _rc.append(wait_t.result())
                            break
                    while not progress_q.empty():
                        yield _sse("progress", {"status": "downloading", "message": progress_q.get_nowait()})
                    await stderr_task

                # 依次执行所有下载任务
                for fmt, out_path in downloads:
                    # 音频下载：尝试不同 CDN（B站各 CDN 连通性不同）
                    if fmt == "ba":
                        cdns = [None, "ali", "tx", "hw", "bs"]
                    else:
                        cdns = [None]
                    audio_dl_ok = False
                    for cdn in cdns:
                        ret_box = []
                        extra = ["--extractor-args", f"bilibili:cdn={cdn}"] if cdn else None
                        async for _ in _download_one(fmt, out_path, ret_box, extra):
                            pass
                        ret = ret_box[0] if ret_box else -1
                        pobj = Path(out_path)
                        if ret == 0 and pobj.exists() and pobj.stat().st_size > 0:
                            audio_dl_ok = True
                            break
                        logger.warning("[VideoSummary] CDN=%s 下载失败(code=%d), 尝试下一个", cdn or "默认", ret)
                        # 清理失败文件
                        if pobj.exists():
                            pobj.unlink()
                    if not audio_dl_ok:
                        # 所有 CDN 都失败
                        if fmt == "ba" and video_path.exists() and video_path.stat().st_size > 0:
                            logger.warning("[VideoSummary] 所有音频 CDN 均失败，尝试从视频中提取音频")
                            audio_source_path = None
                            continue
                        yield _sse("error", {"message": f"音频下载失败，请检查网络或更换视频"})
                        logger.error("[VideoSummary] 音频下载失败，所有 CDN 均不可用")
                        return
                    pobj = Path(out_path)
                    if not pobj.exists() or pobj.stat().st_size == 0:
                        if fmt == "ba" and video_path.exists() and video_path.stat().st_size > 0:
                            logger.warning("[VideoSummary] 音频文件为空，尝试从视频中提取")
                            audio_source_path = None
                            continue
                        yield _sse("error", {"message": f"下载失败: {pobj.name}，请检查视频链接是否有效"})
                        logger.error("[VideoSummary] 下载失败: %s", pobj.name)
                        return

                file_size_mb = video_path.stat().st_size / (1024 * 1024) if video_path.exists() else 0
                logger.info("[VideoSummary] 下载完成: %.1fMB", file_size_mb)
                # 记录视频总时长（用于对比音频时长）
                if video_path.exists():
                    probe_vid = await asyncio.create_subprocess_exec(
                        "ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", str(video_path),
                        stderr=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    )
                    vid_out, _ = await probe_vid.communicate()
                    vid_dur = float(vid_out.decode().strip())
                    logger.info("[VideoSummary] 视频文件时长: %.1f 秒", vid_dur)
            else:
                yield _sse("progress", {"status": "ready", "message": "字幕已就绪，正在生成总结..."})
                logger.info("[VideoSummary] 无需下载视频（skip_frames=True, use_asr=False）")

            # ========== ASR 字幕生成（可选） ==========
            if req.use_asr:
                yield _sse("progress", {"status": "asr", "message": "正在通过语音识别生成字幕..."})
                logger.info("[VideoSummary] ASR 已启用 (engine=%s)", req.asr_engine)

                # 提取/转换音频：如果有单独下载的音频源文件则直接用，否则从视频中提取
                audio_path = work_dir / "audio.wav"
                if audio_source_path and audio_source_path.exists():
                    # 直接转换单独下载的音频源为 WAV
                    logger.info("[VideoSummary] 使用单独下载的音频源: %s，大小=%.1fMB", audio_source_path.name,
                                audio_source_path.stat().st_size / (1024 * 1024))
                    # 记录音频源时长
                    probe_src = await asyncio.create_subprocess_exec(
                        "ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", str(audio_source_path),
                        stderr=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    )
                    src_out, _ = await probe_src.communicate()
                    src_dur = float(src_out.decode().strip())
                    logger.info("[VideoSummary] 音频源文件时长: %.1f 秒", src_dur)
                    ffmpeg_audio_proc = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-y", "-i", str(audio_source_path),
                        "-ar", "16000", "-ac", "1",
                        str(audio_path),
                        stderr=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                    )
                    await ffmpeg_audio_proc.communicate()
                else:
                    # 从视频中提取音频轨（bv* 可能不含音频，尝试后 fallback）
                    logger.info("[VideoSummary] 尝试从视频中提取音频")
                    ffmpeg_audio_proc = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-y", "-i", str(video_path),
                        "-vn", "-ar", "16000", "-ac", "1",
                        str(audio_path),
                        stderr=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                    )
                    await ffmpeg_audio_proc.communicate()
                    if not audio_path.exists():
                        # bv* 无音频轨，尝试下载 ba
                        logger.warning("[VideoSummary] 视频中无音频轨，尝试单独下载音频流")
                        yield _sse("progress", {"status": "downloading", "message": "正在下载音频流..."})
                        audio_fallback = work_dir / "audio_fallback.m4a"
                        fb_box = []
                        async for _ in _download_one("ba", str(audio_fallback), fb_box):
                            pass
                        if audio_fallback.exists() and audio_fallback.stat().st_size > 0:
                            ffmpeg_audio_proc = await asyncio.create_subprocess_exec(
                                "ffmpeg", "-y", "-i", str(audio_fallback),
                                "-ar", "16000", "-ac", "1",
                                str(audio_path),
                                stderr=asyncio.subprocess.PIPE,
                                stdout=asyncio.subprocess.PIPE,
                            )
                            await ffmpeg_audio_proc.communicate()

                if not audio_path.exists():
                    yield _sse("error", {"message": "音频提取失败，无法进行语音识别"})
                    logger.error("[VideoSummary] 音频提取失败")
                    return

                try:
                    if req.asr_engine == 'whisper':
                        logger.info("[VideoSummary] Whisper 使用子进程模式")

                        # 先检查音频时长
                        probe = await asyncio.create_subprocess_exec(
                            "ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path),
                            stderr=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        )
                        probe_out, _ = await probe.communicate()
                        audio_duration = float(probe_out.decode().strip())
                        logger.info("[VideoSummary] 音频文件时长: %.1f 秒", audio_duration)

                        # 在独立子进程中运行 Whisper，进程退出后所有内存自动归还
                        python_exe = str(VENV_DIR / ".venv" / "Scripts" / "python.exe")
                        worker_script = str(VENV_DIR / "whisper_worker.py")
                        whisper_result_path = work_dir / "whisper_result.json"

                        proc = await asyncio.create_subprocess_exec(
                            python_exe, worker_script,
                            req.asr_local_model, str(audio_path), str(whisper_result_path),
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                        )
                        _, stderr = await proc.communicate()
                        if proc.returncode != 0:
                            err_msg = stderr.decode("utf-8", errors="replace")[-500:]
                            raise Exception(f"Whisper 子进程失败 (code={proc.returncode}): {err_msg}")

                        if not whisper_result_path.exists():
                            raise Exception("Whisper 子进程未生成结果文件")

                        with open(whisper_result_path, "r", encoding="utf-8") as f:
                            segments = json.load(f)

                        asr_lines = []
                        last_end = 0
                        for seg in segments:
                            ts = _fmt_ts(seg.get("start", 0))
                            text = seg.get("text", "").strip()
                            if text:
                                asr_lines.append(f"{ts} {text}")
                            last_end = max(last_end, seg.get("end", 0) or 0)
                        req.subtitles = "\n".join(asr_lines)
                        logger.info("[VideoSummary] Whisper 子进程完成: %d 行字幕, 最后时间戳=%.1fs, 音频总长=%.1fs, 覆盖率=%.1f%%",
                                    len(asr_lines), last_end, audio_duration, last_end / audio_duration * 100 if audio_duration > 0 else 0)

                    elif req.asr_engine == 'bailian':
                        # 阿里云百炼 ASR — 使用 DashScope Recognition API（实时模型）
                        # paraformer-realtime-v1 / fun-asr-realtime 等支持字级时间戳+本地文件直传
                        import dashscope
                        from dashscope.audio.asr import Recognition, RecognitionCallback
                        dashscope.api_key = req.asr_api_key or os.environ.get("DASHSCOPE_API_KEY", "")
                        if not dashscope.api_key:
                            raise Exception("未配置阿里云百炼 API Key")

                        # 旧模型名 → 实时模型名映射（qwen3-asr-flash 等不支持时间戳，自动映射到支持时间戳的模型）
                        _model_map = {
                            "qwen3-asr-flash": "paraformer-realtime-v2",
                            "qwen3.5-omni-plus": "paraformer-realtime-v2",
                            "paraformer-v1": "paraformer-realtime-v1",
                            "paraformer-8k-v1": "paraformer-realtime-8k-v1",
                            "paraformer-mtl-v1": "paraformer-realtime-v2",
                            "fun-asr": "fun-asr-realtime",
                        }
                        bailian_model = _model_map.get(req.asr_model, req.asr_model)
                        logger.info("[VideoSummary] Bailian 使用模型: %s (原始配置: %s)", bailian_model, req.asr_model)

                        # 获取音频时长
                        probe = await asyncio.create_subprocess_exec(
                            "ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path),
                            stderr=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        )
                        stdout, _ = await probe.communicate()
                        duration = float(stdout.decode().strip())
                        logger.info("[VideoSummary] Bailian 音频时长=%.1f秒", duration)

                        # Recognition 非流式调用有限制，超过则分片
                        CHUNK_SEC = 290  # 每片 ~5min
                        chunk_count = max(1, math.ceil(duration / CHUNK_SEC))

                        # 第一步：并行压缩所有分片
                        compress_tasks = []
                        for ci in range(chunk_count):
                            start = ci * CHUNK_SEC
                            chunk_name = f"audio_chunk_{ci}.mp3"
                            chunk_path = work_dir / chunk_name
                            compress_tasks.append(_compress_audio(
                                audio_path, chunk_path, start, CHUNK_SEC))
                        chunk_paths = await asyncio.gather(*compress_tasks)

                        # 第二步：并行调用 ASR（限制并发数避免限流）
                        sem = asyncio.Semaphore(3)

                        async def _do_chunk(ci):
                            async with sem:
                                chunk_path = chunk_paths[ci]
                                start = ci * CHUNK_SEC

                                def _call():
                                    rec = Recognition(
                                        model=bailian_model,
                                        callback=RecognitionCallback(),
                                        format='mp3',
                                        sample_rate=16000,
                                    )
                                    return rec.call(str(chunk_path))

                                result = await asyncio.to_thread(_call)

                                # 提取句子
                                try:
                                    sentences = result.get_sentence()
                                except Exception:
                                    sentences = []

                                if not sentences:
                                    output = result.output if hasattr(result, 'output') else {}
                                    if isinstance(output, dict):
                                        sentences = output.get('sentence', output.get('sentences', []))

                                if ci == 0:
                                    logger.info("[VideoSummary] Bailian 分片0 Recognition 结果:\n%s",
                                                json.dumps(result, ensure_ascii=False, default=str)[:2000])

                                logger.info("[VideoSummary] Bailian 分片%d/%d: 句子=%d个",
                                            ci + 1, chunk_count, len(sentences))

                                return ci, start, sentences

                        chunk_results = await asyncio.gather(*[_do_chunk(ci) for ci in range(chunk_count)])

                        # 第三步：合并结果
                        asr_lines = []
                        for ci, start, sentences in sorted(chunk_results, key=lambda x: x[0]):
                            if sentences:
                                for sentence in sentences:
                                    if isinstance(sentence, dict):
                                        s_text = sentence.get('text', '').strip()
                                        if not s_text:
                                            continue
                                        s_start = start + sentence.get('begin_time', 0) / 1000
                                        s_end = start + sentence.get('end_time', 0) / 1000
                                        asr_lines.append((s_start, s_end, s_text))
                            else:
                                logger.warning("[VideoSummary] Bailian 分片%d 无识别结果", ci + 1)

                        # 按时间排序并生成字幕
                        asr_lines.sort(key=lambda x: x[0])
                        subtitle_lines = []
                        for seg_start, seg_end, text in asr_lines:
                            ts = _fmt_ts(seg_start)
                            subtitle_lines.append(f"{ts} {text}")
                        req.subtitles = "\n".join(subtitle_lines)
                        logger.info("[VideoSummary] Bailian 完成: %d 行字幕, 来自%d个分片",
                                    len(asr_lines), chunk_count)

                    else:
                        # 在线 ASR (SiliconFlow API)
                        import httpx
                        audio_bytes = audio_path.read_bytes()
                        async with httpx.AsyncClient(timeout=600) as client:
                            resp = await client.post(
                                "https://api.siliconflow.cn/v1/audio/transcriptions",
                                headers={"Authorization": f"Bearer {req.asr_api_key}"},
                                files={"file": ("audio.wav", audio_bytes, "audio/wav")},
                                data={"model": req.asr_model},
                            )
                            resp_text = resp.text
                            logger.info("[VideoSummary] ASR online raw response[:500]: %s", resp_text[:500])
                            if resp.status_code != 200:
                                raise Exception(f"SiliconFlow API 返回 {resp.status_code}: {resp_text}")
                            data = resp.json()
                            full_text = data.get("text", "")
                            if full_text:
                                sentences = _split_asr_text(full_text)
                            else:
                                sentences = []
                            asr_lines = []
                            for seg in sentences:
                                ts = _fmt_ts(seg.get("start", 0))
                                asr_lines.append(f"{ts} {seg['text']}")
                            req.subtitles = "\n".join(asr_lines)
                            logger.info("[VideoSummary] 在线 ASR 完成: %d 行字幕", len(asr_lines))
                except Exception as e:
                    yield _sse("error", {"message": f"ASR 语音识别失败: {str(e)}"})
                    logger.error("[VideoSummary] ASR 失败: %s", e)
                    return

                if not req.subtitles.strip():
                    yield _sse("error", {"message": "ASR 未能识别出任何文字"})
                    return

            # ========== 2. ffmpeg 场景检测截帧 ==========
            if not req.skip_frames:
                yield _sse("progress", {"status": "extracting", "message": "正在检测画面变化并提取关键帧..."})
                logger.info("[VideoSummary] 开始 ffmpeg 场景检测")

                frames_out_dir.mkdir(parents=True)

                ffmpeg_proc = await asyncio.create_subprocess_exec(
                    "ffmpeg",
                    "-i", str(video_path),
                    "-vf", "select='gt(scene,0.2)',showinfo",
                    "-vsync", "vfr",
                    "-q:v", "3",
                    str(frames_out_dir / "%08d.jpg"),
                    stderr=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                )
                _, ffmpeg_stderr = await ffmpeg_proc.communicate()

                # 收集帧文件，按修改时间排序（写入顺序 = 时间线顺序）
                frame_files = sorted(frames_out_dir.glob("*.jpg"), key=lambda p: p.stat().st_mtime)

                # 解析帧时间戳（从 ffmpeg stderr 的 showinfo 输出），用时间戳重命名帧文件
                frame_ts = []
                for line in ffmpeg_stderr.decode("utf-8", errors="replace").split("\n"):
                    m = re.search(r"pts_time:([\d.]+)", line)
                    if m:
                        frame_ts.append(float(m.group(1)))
                for i, f in enumerate(frame_files):
                    ts = frame_ts[i] if i < len(frame_ts) else 0.0
                    f.rename(frames_out_dir / f"{i+1:04d}_{ts:.2f}s.jpg")
                frame_files = sorted(frames_out_dir.glob("*.jpg"))
                frame_count = len(frame_files)

                if frame_count == 0:
                    yield _sse("error", {"message": "未能从视频中提取到画面帧"})
                    logger.error("[VideoSummary] 帧提取失败: 无输出帧")
                    return

                logger.info("[VideoSummary] 提取到 %d 帧变化帧", frame_count)

                # 复制帧到持久化目录（供前端加载）
                persis_dir.mkdir(parents=True)
                frame_urls = []
                for f in frame_files:
                    dest = persis_dir / f.name
                    shutil.copy2(f, dest)
                    frame_urls.append(f"/frames/{session_id}/{f.name}")
                logger.info("[VideoSummary] 已复制 %d 帧到 %s: %s", len(frame_files), persis_dir, [f.name for f in frame_files])

                yield _sse("frames", {"count": frame_count, "urls": frame_urls})
            else:
                frame_count = 0
                frame_files = []
                frame_ts = []
                frame_urls = []
                yield _sse("frames", {"count": 0, "urls": []})

            

            # ========== 3. AI 一轮总结 ==========
            yield _sse("progress", {"status": "summarizing", "message": "正在生成视频总结..."})

            # ── 构建消息（基础文本部分） ──
            user_content_parts = [
                {"type": "text", "text": f"视频标题：{req.title}\n\n"}
            ]

            # 先发送全部字幕（带时间戳）
            user_content_parts.append({"type": "text", "text": f"视频字幕（带时间戳）：\n{req.subtitles.strip()}\n\n"})

            if not req.skip_frames:
                # 自适应帧策略：根据模型决定最大独立帧数
                max_individual = _get_max_individual_frames(req.model)
                use_grid = frame_count > max_individual
                logger.info("[VideoSummary] 模型=%s, 帧数=%d, 最大独立帧=%d, 使用网格图=%s",
                            req.model, frame_count, max_individual, use_grid)

                # ── 获取视频时长 + 解析帧时间戳 ──
                ffprobe_proc = await asyncio.create_subprocess_exec(
                    "ffprobe", "-i", str(video_path),
                    "-show_entries", "format=duration",
                    "-v", "quiet", "-of", "csv=p=0",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                dur_stdout, _ = await ffprobe_proc.communicate()
                duration = float(dur_stdout.strip())

                # 帧时间戳已在截帧阶段解析，若解析失败则按时长均匀分布
                if len(frame_ts) != frame_count:
                    frame_ts = [i * duration / max(frame_count, 1) for i in range(frame_count)]

                if use_grid:
                    # ── 网格图模式 ──
                    grid_entries = []  # [(b64, first_frame_index)]
                    if not HAS_PIL:
                        logger.warning("[VideoSummary] PIL 未安装，无法创建网格图，将按独立帧发送")
                        use_grid = False
                        for fi in range(frame_count):
                            with open(frame_files[fi], "rb") as fh:
                                b64 = base64.b64encode(fh.read()).decode()
                                grid_entries.append((b64, fi))
                    else:
                        cols = 3
                        batch_size = cols * 3
                        for i in range(0, frame_count, batch_size):
                            batch = frame_files[i:i + batch_size]
                            buf = _create_grid_image(batch, cols=cols, max_size=2048)
                            if buf:
                                b64 = base64.b64encode(buf.read()).decode()
                                grid_entries.append((b64, i))
                                grid_idx = i // batch_size + 1
                                total_grids = math.ceil(frame_count / batch_size)
                                logger.info("[VideoSummary] 网格图 %d/%d: 包含帧 %d-%d",
                                            grid_idx, total_grids, i + 1, min(i + batch_size, frame_count))
                        logger.info("[VideoSummary] 打包为 %d 张网格图发送给 AI (原始 %d 帧)",
                                    len(grid_entries), frame_count)

                    # 全部网格图按时间顺序发送
                    if grid_entries:
                        user_content_parts.append({"type": "text", "text": "对应时间点的视频画面（网格图，按时间顺序排列）：\n"})
                        for i, (b64, idx) in enumerate(grid_entries):
                            end_idx = grid_entries[i + 1][1] - 1 if i + 1 < len(grid_entries) else frame_count - 1
                            start_ts = _fmt_ts(frame_ts[idx])
                            end_ts = _fmt_ts(frame_ts[end_idx])
                            if start_ts == end_ts:
                                user_content_parts.append({"type": "text", "text": f"[{start_ts}] 画面:\n"})
                            else:
                                user_content_parts.append({"type": "text", "text": f"[{start_ts} - {end_ts}] 画面:\n"})
                            user_content_parts.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
                            })

                if not use_grid:
                    # ── 独立帧模式 ──
                    user_content_parts.append({"type": "text", "text": "对应时间点的视频画面（按时间顺序排列）：\n"})
                    for fi in range(frame_count):
                        ts = _fmt_ts(frame_ts[fi])
                        user_content_parts.append({"type": "text", "text": f"[{ts}] 画面:\n"})
                        with open(frame_files[fi], "rb") as fh:
                            b64 = base64.b64encode(fh.read()).decode()
                            user_content_parts.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
                            })

                    logger.info("[VideoSummary] 共发送 %d 张独立帧给 AI", frame_count)
            else:
                logger.info("[VideoSummary] skip_frames=True，跳过帧画面，仅使用字幕文本")

            # 打印字幕内容供用户验证时间轴
            logger.info("[VideoSummary] 传入 AI 的字幕内容 (%d 行):\n%s",
                        len(req.subtitles.splitlines()), req.subtitles[:5000])

            # 使用自定义提示词或默认总结提示词
            is_mindmap = "思维导图" in req.custom_prompt
            if req.custom_prompt:
                user_prompt = req.custom_prompt
            else:
                user_prompt = (
                    "请用中文详细总结当前视频的内容。\n\n"
                    "核心要求：以上是视频的完整字幕（带时间戳）和对应画面。"
                    "请根据字幕内容的语义变化（话题切换）自行分段，每个段落覆盖一个完整的话题。"
                    "要尽量保留视频中的关键数据、具体案例、重要论点和技术细节等等，不要只概括大意，"
                    "确保内容完整详实。\n\n"
                    "格式要求：\n"
                    "- 每段以 [MM:SS] 时间戳开头（**独占一行**），**下方空一行**，再跟一个 `##` 标题（标题独占一行），再换行后写总结内容\n"
                    "- 按时间顺序组织段落\n"
                    "- 段落之间不要使用空行分隔，每段顶格写，不要缩进\n\n"
                    "示例格式：\n"
                    "[00:00]\n"
                    "\n"
                    "## 标题\n"
                    "总结内容...\n"
                    "[02:30]\n"
                    "\n"
                    "## 标题\n"
                    "总结内容...\n\n"
                    "重要：不要使用\"该视频\"\"本视频\"\"视频中\"\"视频首先\"\"视频总结\"\"首先\"\"总的来说\"等冗余表述，直接讲述内容本身。每段总结直接写内容，不要加任何开场白。\n\n"
                    "在完整总结之后，在末尾用一句话对整段视频进行精简总结，格式为：\n"
                    "> **精简总结：**（一句话概括核心要点）\n"
                )
            user_content_parts.append({"type": "text", "text": f"\n\n{user_prompt}"})

            if is_mindmap:
                system_prompt = (
                    "你是一个专业的视频内容整理助手。你善于分析视频字幕和画面，"
                    "提取核心知识点，将其组织成结构清晰的思维导图格式。"
                    "请使用中文回复。只输出思维导图内容，不要添加任何说明文字。"
                    "数学公式请使用 LaTeX 格式，用 $...$ 包裹行内公式，用 $$...$$ 包裹独立公式。"
                )
            else:
                system_prompt = (
                    "你是一个专业的视频内容总结助手。你善于分析视频字幕和画面，"
                    "提取核心信息，生成结构清晰、带时间戳和画面的总结。"
                    "请使用中文回复。不要使用任何开场白（如「视频首先」「视频总结」「首先」「总的来说」等），"
                    "直接开始总结内容。每段直接写具体内容，不要加冗余引导语。"
                    "数学公式请使用 LaTeX 格式，用 $...$ 包裹行内公式，用 $$...$$ 包裹独立公式。"
                )

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content_parts}
            ]

            # 流式输出 AI 回复
            for chunk in call_llm_chat_stream(messages, max_tokens=4096):
                if chunk is None:
                    yield _sse("error", {"message": "AI 调用失败，请检查 AI 配置"})
                    return
                yield _sse("chunk", {"chunk": chunk})

            # 发送帧元数据（供前端渲染 [IMAGE:N] 使用）
            yield _sse("frames_data", {"urls": frame_urls, "count": len(frame_urls)})

            yield _sse("done", {})
            logger.info("[VideoSummary] 总结完成: %s", req.url)

        except asyncio.CancelledError:
            logger.info("[VideoSummary] 请求被取消: %s", req.url)
        except Exception as e:
            logger.error("[VideoSummary] 处理异常: %s", str(e), exc_info=True)
            yield _sse("error", {"message": f"处理失败: {str(e)}"})
        finally:
            # 清理临时文件
            shutil.rmtree(work_dir, ignore_errors=True)
            # 异步清理过期帧
            try:
                _cleanup_old_frames()
            except Exception:
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


async def _compress_audio(src: Path, dst: Path, ss: float, t: float) -> Path:
    """压缩音频分片，返回输出路径"""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", str(src),
        "-ss", str(ss), "-t", str(t),
        "-codec:a", "libmp3lame", "-b:a", "32k",
        "-ac", "1", "-ar", "16000",
        str(dst),
        stderr=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    if not dst.exists():
        raise RuntimeError(f"音频分片压缩失败: {dst}")
    return dst


def _fmt_ts(seconds: float) -> str:
    """将秒数转换为 [MM:SS] 格式"""
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"[{m:02d}:{s:02d}]"


def _split_asr_text(text: str) -> list[dict]:
    """将无时间戳的 ASR 全文按标点拆分为多段"""
    # 先按句末标点（。！？.!?）拆分
    segments = re.split(r'(?<=[。！？.!?\n])\s*', text)
    segments = [s.strip() for s in segments if s.strip()]
    # 若拆不出多段，再按逗号类停顿标点（，、,;；）拆分
    if len(segments) <= 1:
        segments = re.split(r'(?<=[，、,;；])\s*', text)
        segments = [s.strip() for s in segments if s.strip()]
    # 仍然只有一段，说明模型输出无标点，按最大长度强制拆分
    if len(segments) <= 1:
        max_chars = 80
        segments = [text[i:i+max_chars] for i in range(0, len(text), max_chars)]
        segments = [s.strip() for s in segments if s.strip()]
    if not segments:
        return [{"start": 0, "text": text}]
    return [{"start": 0, "text": seg} for seg in segments]


def _sse(event: str, data: dict) -> str:
    """构造 SSE 消息"""
    payload = json.dumps({"type": event, **data})
    return f"data: {payload}\n\n"