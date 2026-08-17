"""AI 相关接口：摘要 / 翻译 / 解释"""

import json
import logging
import os
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from litellm import supports_vision
from models.schemas import SummarizeRequest, TranslateRequest, ExplainRequest, ChatRequest, ChatResponse
from services.llm import call_llm, call_llm_chat, call_llm_chat_stream
from config import CONFIG_FILE
from deps import verify_key

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_key)])


def _read_max_tokens() -> int:
    """读取用户配置的 max_tokens，未配置则返回 1024"""
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return int(cfg.get("max_tokens", 1024))
    except Exception:
        pass
    return 1024


def _build_user_content(text: str, images: list[str] | None = None) -> str | list[dict]:
    """构建用户消息 content 字段。无图片直接返回文字，有图片返回 OpenAI 多模态 content 数组。"""
    if not images:
        return text
    # 检查当前配置的模型是否支持多模态（前端已隐藏按钮，后台作为兜底校验）
    model_name = _get_current_model()
    if model_name and not _is_vision_model(model_name):
        raise HTTPException(
            status_code=400,
            detail=f"当前模型 ({model_name}) 不支持图片理解，请切换到其它模型。"
        )
    # 过滤空图片
    images = [img for img in images if img and img.startswith('data:')]
    if not images:
        return text
    parts = [{"type": "text", "text": text}]
    for img in images:
        parts.append({"type": "image_url", "image_url": {"url": img}})
    return parts


def _get_current_model() -> str | None:
    """读取当前配置的模型名称"""
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return cfg.get("model", "") or None
    except Exception:
        pass
    return None


# 多模态模型关键词列表（与前端保持一致）
_VISION_KEYWORDS = ["vision", "multimodal", "claude-3", "gemini-", "4o", "vl"]

def _is_vision_model(model_name: str) -> bool:
    """判断模型名称是否为已知的多模态模型。优先用关键词匹配（零依赖），
    未命中时再委托 litellm 维护的模型能力列表。"""
    name = model_name.lower()
    for kw in _VISION_KEYWORDS:
        if kw in name:
            return True
    try:
        return supports_vision(model_name)
    except Exception:
        return False


@router.post("/summarize")
async def summarize(req: SummarizeRequest):
    """AI 摘要"""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    result = call_llm(
        system_prompt="你是一个专业的内容摘要助手。请用简洁的中文总结用户发来的文本，保留关键信息，控制在 3-5 句话内。",
        user_text=text,
    )
    if result is None:
        # 兜底：返回 mock 摘要
        result = f"📝 {text[:60]}……（AI 摘要功能已就绪，请检查 LLM 配置）"
    return {"ok": True, "data": {"summarize": result}}


@router.post("/translate")
async def translate(req: TranslateRequest):
    """AI 翻译"""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    lang_name = {"zh": "简体中文", "en": "English", "ja": "日本語", "fr": "Français"}.get(
        req.target_lang, req.target_lang
    )

    result = call_llm(
        system_prompt=f"你是一个专业翻译。请将用户发来的文本翻译成 {lang_name}，只输出翻译结果，不要添加任何说明。",
        user_text=text,
    )
    if result is None:
        result = f"🌐 {text}（翻译功能已就绪，请检查 LLM 配置）"
    return {"ok": True, "data": {"translate": result}}


@router.post("/explain")
async def explain(req: ExplainRequest):
    """AI 解释 / 通俗化"""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    result = call_llm(
        system_prompt="你是一个知识科普助手。请用通俗易懂的语言解释用户发来的文本，帮助读者理解其中核心概念。如果文本本身已经很通俗，直接总结其要点即可。控制在 200 字以内。数学公式请使用 LaTeX 格式，用 $...$ 包裹。",
        user_text=text,
    )
    if result is None:
        result = f"💡 {text[:60]}……（解释功能已就绪，请检查 LLM 配置）"
    return {"ok": True, "data": {"explain": result}}


@router.post("/chat")
async def chat(req: ChatRequest):
    """AI 多轮对话"""
    text = req.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="message is required")

    # ── 构建系统级上下文 ──
    system_content = (
        "你是一个知识助手，用户是知寻(KnowSeek)扩展的使用者。"
        "你擅长回答关于网页内容、知识整理、学习总结等问题。"
        "请给出简洁、准确的回答。使用中文回复。"
        "数学公式请使用 LaTeX 格式，用 $...$ 包裹行内公式，用 $$...$$ 包裹独立公式。"
    )

    # 如果携带了页面上下文，注入 system prompt
    if req.page_context:
        ctx = req.page_context
        title = ctx.get("title", "") or ""
        url = ctx.get("url", "") or ""
        content = ctx.get("content") or ""
        if title or url or content:
            # 日志：检查实际收到的内容
            is_video = content.startswith("## 视频字幕")
            logger.info("[Chat] page_context: title=%s, content_len=%d, has_subtitles=%s",
                        title, len(content), is_video)
            if is_video:
                # 视频字幕内容
                system_content += (
                    "\n\n用户正在观看一个视频。视频字幕内容如下（带时间戳）："
                    f"\n{content}"
                )
            else:
                # 网页文章内容
                system_content += (
                    "\n\n用户当前正在浏览以下网页（页面完整文字内容已附在下方，你无需访问任何网址）："
                    f"\n标题：{title}"
                    f"\n\n===== 以下为用户正在查看的页面完整内容 =====\n{content}\n===== 页面内容结束 ====="
                )

    messages = [{"role": "system", "content": system_content}]

    # 追加历史消息（含图片）
    for msg in req.history[-20:]:
        if msg.role == "user" and msg.images:
            messages.append({"role": msg.role, "content": _build_user_content(msg.content, msg.images)})
        else:
            messages.append({"role": msg.role, "content": msg.content})

    # 追加当前消息
    messages.append({"role": "user", "content": _build_user_content(text, req.images or None)})

    max_tokens = _read_max_tokens()
    result = call_llm_chat(messages, max_tokens=max_tokens)
    if result is None:
        return {"ok": False, "data": {"reply": "AI 处理失败，请检查 AI 配置"}, "message": "AI 未配置或调用失败"}

    return {"ok": True, "data": {"reply": result}}


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """AI 多轮对话（流式输出 SSE）"""
    text = req.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="message is required")

    # 构建系统级上下文
    system_content = (
        "你是一个知识助手，用户是知寻(KnowSeek)扩展的使用者。"
        "你擅长回答关于网页内容、知识整理、学习总结等问题。"
        "请给出简洁、准确的回答。使用中文回复。"
        "数学公式请使用 LaTeX 格式，用 $...$ 包裹行内公式，用 $$...$$ 包裹独立公式。"
    )

    if req.page_context:
        ctx = req.page_context
        title = ctx.get("title", "") or ""
        url = ctx.get("url", "") or ""
        content = ctx.get("content") or ""
        if title or url or content:
            is_video = content.startswith("## 视频字幕")
            logger.info("[Chat/Stream] page_context: title=%s, content_len=%d, has_subtitles=%s",
                        title, len(content), is_video)
            if is_video:
                system_content += (
                    "\n\n用户正在观看一个视频。视频字幕内容如下（带时间戳）："
                    f"\n{content}"
                )
            else:
                system_content += (
                    "\n\n用户当前正在浏览以下网页（页面完整文字内容已附在下方，你无需访问任何网址）："
                    f"\n标题：{title}"
                    f"\n\n===== 以下为用户正在查看的页面完整内容 =====\n{content}\n===== 页面内容结束 ====="
                )

    messages = [{"role": "system", "content": system_content}]
    for msg in req.history[-20:]:
        if msg.role == "user" and msg.images:
            messages.append({"role": msg.role, "content": _build_user_content(msg.content, msg.images)})
        else:
            messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": _build_user_content(text, req.images or None)})

    max_tokens = _read_max_tokens()

    async def event_generator():
        try:
            for chunk in call_llm_chat_stream(messages, max_tokens=max_tokens):
                if chunk is None:
                    yield f"event: error\ndata: {json.dumps({'error': 'AI 调用失败'})}\n\n"
                    return
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("[Chat/Stream] 流式输出异常: %s", str(e))
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
