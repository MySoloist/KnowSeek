"""测试 LLM 调用服务"""

from unittest.mock import patch, MagicMock
import pytest
from services.llm import _build_model, call_llm, call_llm_chat, call_llm_chat_stream


class TestBuildModel:
    """测试 _build_model —— 纯函数，无需 mock"""

    def test_custom_base_url_returns_model_directly(self):
        """有自定义 base_url 时，直接返回裸模型名"""
        assert _build_model("openai", "gpt-4", "https://custom.com/v1") == "gpt-4"

    def test_native_provider_without_base_url(self):
        """原生提供商且无自定义 base_url → provider/model"""
        assert _build_model("deepseek", "deepseek-chat", None) == "deepseek/deepseek-chat"
        assert _build_model("openai", "gpt-4", None) == "openai/gpt-4"
        assert _build_model("ollama", "llama3", None) == "ollama/llama3"

    def test_native_provider_model_already_has_slash(self):
        """模型名已包含斜杠，不做拼接"""
        assert _build_model("openai", "openai/gpt-4", None) == "openai/gpt-4"

    def test_non_native_provider_without_base_url(self):
        """非原生提供商且无自定义 base_url → 直接返回 model"""
        assert _build_model("siliconflow", "Pro/deepseek-chat", None) == "Pro/deepseek-chat"


class TestCallLlm:
    """测试 call_llm"""

    def test_returns_none_when_not_configured(self):
        """未配置 AI 时返回 None"""
        with patch("services.llm._get_llm_config", return_value=(None, None, None, None)):
            result = call_llm("system", "user text")
            assert result is None

    def test_returns_none_on_api_error(self):
        """API 调用失败时返回 None"""
        mock_config = ("openai", "sk-test", "gpt-4", None)
        with (
            patch("services.llm._get_llm_config", return_value=mock_config),
            patch("services.llm.completion", side_effect=Exception("API error")),
        ):
            result = call_llm("system", "user text")
            assert result is None

    def test_successful_call_without_base_url(self):
        """通过 litellm.completion 成功调用"""
        mock_response = MagicMock()
        mock_response.choices[0].message.content = "  Hello World  "

        mock_config = ("openai", "sk-test", "gpt-4", None)
        with (
            patch("services.llm._get_llm_config", return_value=mock_config),
            patch("services.llm.completion", return_value=mock_response) as mock_completion,
        ):
            result = call_llm("Be helpful", "Hi")
            assert result == "Hello World"
            mock_completion.assert_called_once()

    def test_successful_call_with_base_url(self):
        """通过 OpenAI 客户端直接调用"""
        mock_response = MagicMock()
        mock_response.choices[0].message.content = "  Reply  "

        mock_config = ("siliconflow", "sk-test", "Pro/deepseek", "https://api.siliconflow.cn")
        with (
            patch("services.llm._get_llm_config", return_value=mock_config),
            patch("services.llm.OpenAI") as mock_openai,
        ):
            mock_client = MagicMock()
            mock_openai.return_value = mock_client
            mock_client.chat.completions.create.return_value = mock_response

            result = call_llm("system", "user text")
            assert result == "Reply"


class TestCallLlmChat:
    """测试 call_llm_chat"""

    def test_returns_none_when_not_configured(self):
        with patch("services.llm._get_llm_config", return_value=(None, None, None, None)):
            result = call_llm_chat([{"role": "user", "content": "hi"}])
            assert result is None

    def test_successful_chat(self):
        mock_response = MagicMock()
        mock_response.choices[0].message.content = "  response  "

        mock_config = ("openai", "sk-test", "gpt-4", None)
        with (
            patch("services.llm._get_llm_config", return_value=mock_config),
            patch("services.llm.completion", return_value=mock_response),
        ):
            result = call_llm_chat([
                {"role": "system", "content": "helpful"},
                {"role": "user", "content": "hello"},
            ])
            assert result == "response"


class TestCallLlmChatStream:
    """测试 call_llm_chat_stream（生成器）"""

    def test_yields_none_when_not_configured(self):
        with patch("services.llm._get_llm_config", return_value=(None, None, None, None)):
            results = list(call_llm_chat_stream([{"role": "user", "content": "hi"}]))
            assert results == [None]

    def test_streams_chunks(self):
        """验证流式输出逐块返回"""
        mock_chunk_1 = MagicMock()
        mock_chunk_1.choices = [MagicMock()]
        mock_chunk_1.choices[0].delta.content = "Hello"

        mock_chunk_2 = MagicMock()
        mock_chunk_2.choices = [MagicMock()]
        mock_chunk_2.choices[0].delta.content = " World"

        mock_config = ("openai", "sk-test", "gpt-4", None)
        with (
            patch("services.llm._get_llm_config", return_value=mock_config),
            patch("services.llm.completion", return_value=iter([mock_chunk_1, mock_chunk_2])),
        ):
            results = list(call_llm_chat_stream([
                {"role": "system", "content": "helpful"},
                {"role": "user", "content": "say hi"},
            ]))
            assert results == ["Hello", " World"]

    def test_skips_chunks_without_choices(self):
        """跳过没有 choices 的 chunk"""
        empty_chunk = MagicMock()
        empty_chunk.choices = []

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "data"

        mock_config = ("openai", "sk-test", "gpt-4", None)
        with (
            patch("services.llm._get_llm_config", return_value=mock_config),
            patch("services.llm.completion", return_value=iter([empty_chunk, mock_chunk])),
        ):
            results = list(call_llm_chat_stream([{"role": "user", "content": "test"}]))
            assert results == ["data"]