"""健康检查 / 模型列表"""

import json
import logging
import os
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Depends

from config import PROVIDER_LABELS, CONFIG_FILE
from deps import verify_key

logger = logging.getLogger(__name__)
router = APIRouter()

# 各提供商的默认 API 地址
_DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com",
    "siliconflow": "https://api.siliconflow.cn",
    "ollama": "http://localhost:11434",
}


@router.get("/health")
async def health(_auth=Depends(verify_key)):
    """健康检查 — 返回服务器状态及可用功能"""
    ai_configured = False
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            ai_configured = bool(cfg.get("provider", "").strip()
                                 and cfg.get("api_key", "").strip()
                                 and cfg.get("model", "").strip())
        except Exception:
            pass

    return {
        "status": "ok",
        "features": {
            "ai": True,
            "ai_configured": ai_configured,
        },
    }


def _fetch_json(url: str, headers: dict | None = None, timeout: int = 15):
    """同步 HTTP GET 请求，返回解析后的 JSON"""
    req = Request(url, headers=headers or {})
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        raise RuntimeError(f"HTTP {e.code}: {body}")
    except URLError as e:
        raise RuntimeError(f"连接失败: {e.reason}")


def _fetch_openai_models(base_url: str, api_key: str) -> list[dict]:
    """通过 OpenAI 兼容的 /v1/models 接口获取模型列表"""
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        url = base + "/models"
    else:
        url = base + "/v1/models"
    data = _fetch_json(url, {"Authorization": f"Bearer {api_key}"})
    items = []
    for m in (data.get("data") or []):
        mid = m.get("id") or ""
        if mid:
            items.append({"id": mid})
    return items


def _fetch_ollama_models(base_url: str, api_key: str) -> list[dict]:
    """通过 Ollama /api/tags 接口获取模型列表"""
    url = base_url.rstrip("/") + "/api/tags"
    data = _fetch_json(url)
    items = []
    for m in (data.get("models") or []):
        name = m.get("name") or ""
        if name:
            items.append({"id": name})
    return items


@router.get("/models")
async def list_models(
    provider: str = "",
    api_key: str = "",
    base_url: str = "",
    _auth=Depends(verify_key),
):
    """动态查询指定提供商的模型列表"""
    provider = provider.strip().lower()
    api_key = api_key.strip()
    base_url = base_url.strip()

    if not provider:
        return {"ok": True, "data": {"models": []}}

    # custom 提供商必须提供 base_url
    if provider == "custom" and not base_url:
        return {"ok": True, "data": {"models": [], "hint": "自定义提供商请填写 API 地址后刷新"}}

    # Ollama 不需要 api_key
    if provider != "ollama" and not api_key:
        return {"ok": True, "data": {"models": [], "hint": "请填写 API Key 后刷新"}}

    # 确定 base_url
    if not base_url:
        base_url = _DEFAULT_BASE_URLS.get(provider, "")

    try:
        if provider == "ollama":
            items = _fetch_ollama_models(base_url, api_key)
        else:
            # 所有 OpenAI 兼容的提供商（包括自定义）都走 /v1/models
            items = _fetch_openai_models(base_url, api_key)
        return {"ok": True, "data": {"models": items}}
    except Exception as e:
        logger.warning("[Models] 查询 %s 模型列表失败: %s", provider, e)
        return {"ok": False, "data": {"models": [], "error": str(e)}}
