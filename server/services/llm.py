"""LLM 调用服务"""

import json
import logging
import os
from litellm import completion
from openai import OpenAI

from config import CONFIG_FILE, LLM_KEY, LLM_PROVIDER, LLM_MODEL

logger = logging.getLogger(__name__)

# litellm 原生支持的提供商（可通过 provider 前缀直接路由）
_NATIVE_PROVIDERS = {"deepseek", "openai", "ollama"}

# 各提供商的默认 API 地址
_DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com",
    "siliconflow": "https://api.siliconflow.cn",
    "ollama": "http://localhost:11434",
}


def _get_llm_config():
    """读取 LLM 配置，优先级：扩展推送的 config.json > 环境变量"""
    # 1. 从 config.json 读取
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            provider = cfg.get("provider", "").strip()
            api_key = cfg.get("api_key", "").strip()
            model = cfg.get("model", "").strip()
            base_url = cfg.get("base_url", "").strip() or None
            if provider and api_key and model:
                if not base_url:
                    base_url = _DEFAULT_BASE_URLS.get(provider)
                return provider, api_key, model, base_url
        except Exception:
            pass

    # 2. 从环境变量读取
    if LLM_PROVIDER and LLM_KEY and LLM_MODEL:
        return LLM_PROVIDER, LLM_KEY, LLM_MODEL, None

    return None, None, None, None


def _build_model(provider: str, model: str, base_url: str | None) -> str:
    """构造传给 litellm 的 model 字符串。

    有自定义 base_url → 用裸模型名 + 直连
    无自定义 base_url 且是原生提供商 → 用 {provider}/{model}
    其他 → 直接用 model
    """
    if base_url:
        return model  # 裸模型名，直连时用
    if provider in _NATIVE_PROVIDERS:
        return f"{provider}/{model}" if "/" not in model else model
    return model


def _call_openai_direct(model: str, messages: list, api_key: str, base_url: str,
                        max_tokens: int, temperature: float = 0.7, stream: bool = False):
    """直接用 OpenAI 客户端调用兼容 API"""
    timeout_val = 180.0 if stream else 300.0
    # 确保 base_url 以 /v1 结尾（OpenAI 客户端内部会追加 /chat/completions）
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    client = OpenAI(
        api_key=api_key,
        base_url=base,
        timeout=timeout_val,
    )
    return client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        stream=stream,
    )


def call_llm(system_prompt: str, user_text: str, max_tokens: int = 512) -> str | None:
    """调用 LLM 并返回文本结果"""
    provider, api_key, model, base_url = _get_llm_config()
    if not all([provider, api_key, model]):
        logger.warning("[LLM] 未配置 AI 提供商/密钥/模型")
        return None

    full_model = _build_model(provider, model, base_url)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text},
    ]
    logger.info("[LLM] 调用 %s | api_base=%s | 输入: %.200s",
                full_model, base_url or "(默认)", user_text.replace("\n", " ")[:200])

    try:
        if base_url:
            resp = _call_openai_direct(full_model, messages, api_key, base_url,
                                       max_tokens=max_tokens, temperature=0.3)
        else:
            resp = completion(
                model=full_model,
                messages=messages,
                api_key=api_key,
                max_tokens=max_tokens,
                temperature=0.3,
            )
        reply = resp.choices[0].message.content.strip()
        logger.info("[LLM] 回复: %.200s", reply.replace("\n", " ")[:200])
        return reply
    except Exception as e:
        logger.error("[LLM] 调用失败: %s", str(e), exc_info=True)
        return None


def call_llm_chat(messages: list[dict], max_tokens: int = 1024) -> str | None:
    """调用 LLM 进行多轮对话。messages 应包含 system 消息。"""
    provider, api_key, model, base_url = _get_llm_config()
    if not all([provider, api_key, model]):
        logger.warning("[LLM] 未配置 AI 提供商/密钥/模型")
        return None

    full_model = _build_model(provider, model, base_url)
    user_msgs = [m for m in messages if m["role"] == "user"]
    last_raw = user_msgs[-1]["content"] if user_msgs else ""
    last_input = (last_raw.replace("\n", " ")[:150] if isinstance(last_raw, str) else "[multimodal]") if last_raw else ""
    logger.info("[LLM] 调用 %s | api_base=%s | 消息数 %d | 最后输入: %.150s",
                full_model, base_url or "(默认)", len(messages), last_input)

    try:
        if base_url:
            resp = _call_openai_direct(full_model, messages, api_key, base_url,
                                       max_tokens=max_tokens)
        else:
            resp = completion(
                model=full_model,
                messages=messages,
                api_key=api_key,
                max_tokens=max_tokens,
                temperature=0.7,
            )
        reply = resp.choices[0].message.content.strip()
        logger.info("[LLM] 回复: %.200s", reply.replace("\n", " ")[:200])
        return reply
    except Exception as e:
        logger.error("[LLM] 调用失败: %s", str(e), exc_info=True)
        return None


def call_llm_chat_stream(messages: list[dict], max_tokens: int = 1024):
    """调用 LLM 进行流式多轮对话，返回文本块生成器（generator）。"""
    provider, api_key, model, base_url = _get_llm_config()
    if not all([provider, api_key, model]):
        logger.warning("[LLM] 未配置 AI 提供商/密钥/模型")
        yield None
        return

    full_model = _build_model(provider, model, base_url)
    user_msgs = [m for m in messages if m["role"] == "user"]
    last_raw = user_msgs[-1]["content"] if user_msgs else ""
    last_input = (last_raw.replace("\n", " ")[:150] if isinstance(last_raw, str) else "[multimodal]") if last_raw else ""
    logger.info("[LLM] 流式调用 %s | api_base=%s | 消息数 %d | 最后输入: %.150s",
                full_model, base_url or "(默认)", len(messages), last_input)

    try:
        if base_url:
            resp = _call_openai_direct(full_model, messages, api_key, base_url,
                                       max_tokens=max_tokens, stream=True)
        else:
            resp = completion(
                model=full_model,
                messages=messages,
                api_key=api_key,
                max_tokens=max_tokens,
                temperature=0.7,
                stream=True,
            )
        if resp is None:
            yield None
            return
        for chunk in resp:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    except Exception as e:
        logger.error("[LLM] 流式调用失败: %s", str(e), exc_info=True)
        yield None
