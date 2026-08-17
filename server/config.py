"""服务器配置"""

import os

# ─── 认证 ───
API_KEY = os.environ.get("API_KEY", "sk-knowseek-demo")

# ─── LLM 配置 ───
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "")
LLM_KEY = os.environ.get("LLM_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "")

# ─── 配置存储路径 ───
CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.json")

# ─── LLM 提供商可选列表 ───
PROVIDER_LABELS = {
    "deepseek": ("DeepSeek", "deepseek-chat"),
    "openai":   ("OpenAI",   "gpt-4o-mini"),
    "siliconflow": ("SiliconFlow", "Pro/deepseek-poser"),
    "ollama":   ("Ollama",   "ollama/llama3"),
}
