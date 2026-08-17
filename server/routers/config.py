"""AI 配置管理"""

import json
import os
import logging
from fastapi import APIRouter, Depends, HTTPException
from litellm import completion, supports_vision
from openai import OpenAI

from models.schemas import AiConfig, AiTestResponse, AsrTestRequest, AsrTestResponse
from config import CONFIG_FILE
from deps import verify_key

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(verify_key)])

# litellm 原生支持的提供商
_NATIVE_PROVIDERS = {"deepseek", "openai", "ollama"}

# 各提供商的默认 API 地址
_DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com",
    "ollama": "http://localhost:11434",
}


def _build_test_model(provider: str, model: str, base_url: str | None) -> str:
    """和 llm.py 一致的模型名构建逻辑"""
    if base_url:
        return model  # 裸模型名，直连时用
    if provider in _NATIVE_PROVIDERS:
        return f"{provider}/{model}" if "/" not in model else model
    return model


@router.post("/config/ai")
async def save_ai_config(cfg: AiConfig):
    """保存 AI 配置（由扩展推送）"""
    if not cfg.provider or not cfg.api_key or not cfg.model:
        raise HTTPException(status_code=400, detail="provider, api_key, model 均为必填")

    data = cfg.model_dump()
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return {"ok": True, "message": f"AI 配置已保存: {cfg.provider}/{cfg.model}"}


@router.get("/config/ai")
async def get_ai_config():
    """读取当前 AI 配置（脱敏返回）"""
    if not os.path.exists(CONFIG_FILE):
        return {"ok": True, "data": {"configured": False}}

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return {
            "ok": True,
            "data": {
                "configured": True,
                "provider": cfg.get("provider", ""),
                "model": cfg.get("model", ""),
                "api_key": cfg.get("api_key", "")[:8] + "****" if cfg.get("api_key") else "",
            },
        }
    except Exception:
        return {"ok": True, "data": {"configured": False}}


def _call_openai_direct(model: str, messages: list, api_key: str, base_url: str,
                        max_tokens: int = 10, temperature: float = 0.7, stream: bool = False):
    """直接用 OpenAI 客户端调用兼容 API"""
    # 确保 base_url 以 /v1 结尾（OpenAI 客户端内部会追加 /chat/completions）
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    client = OpenAI(
        api_key=api_key,
        base_url=base,
    )
    return client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        stream=stream,
    )


@router.post("/ai/test")
async def test_ai_connection(cfg: AiConfig) -> AiTestResponse:
    """测试 AI 连接（用用户填的 Key 发一次请求）"""
    if not cfg.provider or not cfg.api_key or not cfg.model:
        return AiTestResponse(success=False, message="provider, api_key, model 均为必填")

    try:
        # base_url 为空时尝试默认地址
        effective_base_url = cfg.base_url or _DEFAULT_BASE_URLS.get(cfg.provider, "")
        if effective_base_url:
            # 有自定义地址 → 绕过 litellm，直连 OpenAI 兼容 API
            logger.info("[Test] 直连 %s 测试模型 %s", effective_base_url, cfg.model)
            resp = _call_openai_direct(
                model=cfg.model,
                messages=[{"role": "user", "content": "ping"}],
                api_key=cfg.api_key,
                base_url=effective_base_url,
                max_tokens=10,
            )
        else:
            full_model = _build_test_model(cfg.provider, cfg.model, cfg.base_url)
            logger.info("[Test] 通过 litellm 调用 %s", full_model)
            resp = completion(
                model=full_model,
                messages=[{"role": "user", "content": "ping"}],
                api_key=cfg.api_key,
                max_tokens=10,
            )

        if resp and resp.choices:
            return AiTestResponse(success=True, message="连接成功")
        return AiTestResponse(success=False, message="AI 未返回有效响应")
    except Exception as e:
        msg = str(e)
        logger.warning("[Test] 测试连接失败: %s", msg)
        # 精简错误消息
        for keyword in ["AuthenticationError", "RateLimitError", "NotFoundError", "BadRequestError"]:
            if keyword in msg:
                msg = msg.split(keyword)[-1].strip().split(".")[0][:80]
                break
        return AiTestResponse(success=False, message=msg[:120])


@router.post("/asr/test")
async def test_asr_connection(req: AsrTestRequest) -> AsrTestResponse:
    """测试 ASR 配置"""
    logger.info("[AsrTest] 测试 ASR 连接: engine=%s, model=%s", req.engine, req.model)

    if req.engine == "whisper":
        try:
            import whisper
            return AsrTestResponse(
                success=True,
                message="Whisper 已安装",
                detail="Whisper 框架可用。首次运行 ASR 时会自动下载模型，请确保网络畅通"
            )
        except ImportError as e:
            return AsrTestResponse(
                success=False,
                message="Whisper 未安装",
                detail=f"请运行 pip install openai-whisper: {str(e)}"
            )
        except Exception as e:
            return AsrTestResponse(
                success=False,
                message="Whisper 加载失败",
                detail=str(e)
            )

    elif req.engine == "bailian":
        api_key = req.api_key or os.environ.get("DASHSCOPE_API_KEY", "")
        if not api_key:
            return AsrTestResponse(
                success=False,
                message="未配置 API Key",
                detail="请在 AI 设置中选择阿里云百炼引擎并填写 API Key"
            )
        try:
            import httpx
            # 调用 chat completions 端点验证 API Key
            with httpx.Client(timeout=15) as client:
                resp = client.post(
                    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": req.model or "qwen-turbo",
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "input_audio",
                                        "input_audio": {
                                            "data": "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                )
                if resp.status_code == 200:
                    return AsrTestResponse(
                        success=True,
                        message="阿里云百炼 API Key 有效",
                        detail="ASR 服务可用"
                    )
                elif resp.status_code in (401, 403):
                    return AsrTestResponse(
                        success=False,
                        message="阿里云百炼 API Key 无效",
                        detail=f"HTTP {resp.status_code}: {resp.text[:200]}"
                    )
                else:
                    return AsrTestResponse(
                        success=True,
                        message="阿里云百炼 API Key 有效",
                        detail=f"服务响应正常 (HTTP {resp.status_code})"
                    )
        except ImportError:
            return AsrTestResponse(
                success=False,
                message="httpx 未安装",
                detail="请运行 pip install httpx"
            )
        except Exception as e:
            return AsrTestResponse(
                success=False,
                message="无法连接到阿里云百炼",
                detail=str(e)
            )


@router.get("/asr/engines")
async def list_asr_engines(api_key: str = ""):
    """返回所有 ASR 引擎及对应的模型列表（含大小）"""
    import httpx

    return {
        "ok": True,
        "data": {
            "engines": [
                {
                    "id": "whisper",
                    "label": "Whisper (本地)",
                    "models": [
                        {"id": "tiny", "label": "Whisper Tiny", "size_mb": 75, "description": "39M参数·~1GB显存·~10x速度"},
                        {"id": "base", "label": "Whisper Base", "size_mb": 142, "description": "74M参数·~1GB显存·~7x速度"},
                        {"id": "small", "label": "Whisper Small", "size_mb": 466, "description": "244M参数·~2GB显存·~4x速度"},
                        {"id": "medium", "label": "Whisper Medium", "size_mb": 1450, "description": "769M参数·~5GB显存·~2x速度"},
                        {"id": "large-v3", "label": "Whisper Large-v3", "size_mb": 2880, "description": "1550M参数·~10GB显存·1x速度"},
                        {"id": "turbo", "label": "Whisper Turbo", "size_mb": 1600, "description": "809M参数·~6GB显存·~8x速度·推荐"},
                    ],
                },
                {
                    "id": "bailian",
                    "label": "阿里云百炼 (在线)",
                    "models": [
                        {"id": "paraformer-realtime-v2", "label": "Paraformer-实时-v2", "size_mb": 0, "description": "多语种·字级时间戳·本地文件直传"},
                        {"id": "paraformer-realtime-v1", "label": "Paraformer-实时-v1", "size_mb": 0, "description": "中英文·字级时间戳·本地文件直传"},
                        {"id": "fun-asr-realtime", "label": "Fun-ASR-实时", "size_mb": 0, "description": "通用·字级时间戳·本地文件直传"},
                        {"id": "fun-asr-realtime-2026-02-28", "label": "Fun-ASR-最新快照", "size_mb": 0, "description": "最新版·字级时间戳·本地文件直传"},
                    ],
                },
            ]
        },
    }


@router.get("/asr/cache")
async def get_asr_cache():
    """扫描本地 ASR 模型缓存目录"""
    import os
    from pathlib import Path

    cache_info = {}
    total_mb = 0

    # Whisper 缓存目录
    whisper_dir = Path.home() / ".cache" / "whisper"
    whisper_models = {}
    if whisper_dir.exists():
        for f in whisper_dir.iterdir():
            if f.suffix == ".pt":
                size_mb = round(f.stat().st_size / 1024 / 1024, 1)
                model_name = f.stem
                if model_name.startswith("large-v"):
                    model_name = model_name  # keep as-is: large-v3 etc.
                whisper_models[model_name] = size_mb
                total_mb += size_mb

    return {
        "ok": True,
        "data": {
            "whisper": whisper_models,
            "total_mb": round(total_mb, 1),
        },
    }


@router.delete("/asr/cache/{engine}/{model:path}")
async def delete_asr_cache(engine: str, model: str):
    """删除已缓存的 ASR 模型"""
    import shutil
    from pathlib import Path

    if engine == "whisper":
        whisper_dir = Path.home() / ".cache" / "whisper"
        # Whisper 模型文件名: tiny.pt, base.pt, small.pt, medium.pt, large-v3.pt
        file_path = whisper_dir / f"{model}.pt"
        if file_path.exists():
            file_path.unlink()
            logger.info("[AsrCache] 删除 Whisper 模型缓存: %s", file_path)
            return {"ok": True, "message": f"已删除 {model}"}
        return {"ok": False, "message": f"模型 {model} 未找到缓存"}

    return {"ok": False, "message": f"未知引擎: {engine}"}


@router.get("/check-vision")
async def check_vision(model: str):
    """查询指定模型是否支持多模态（视觉）能力"""
    # 优先用关键词匹配（零依赖），与 ai.py 的 _is_vision_model 保持一致
    _VISION_KEYWORDS = ["vision", "multimodal", "claude-3", "gemini-", "4o", "vl"]
    name = model.lower()
    for kw in _VISION_KEYWORDS:
        if kw in name:
            return {"ok": True, "data": {"model": model, "supports_vision": True}}
    try:
        result = supports_vision(model)
        return {"ok": True, "data": {"model": model, "supports_vision": result}}
    except Exception as e:
        logger.warning("[Vision] 检查模型 %s 失败: %s", model, str(e))
        return {"ok": True, "data": {"model": model, "supports_vision": False}}
