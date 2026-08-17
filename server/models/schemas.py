"""请求/响应模型"""

from pydantic import BaseModel, Field


class SummarizeRequest(BaseModel):
    text: str = Field(..., description="用户高亮的文本")
    record_id: str = Field("", description="前端传递的记录 ID")


class TranslateRequest(BaseModel):
    text: str = Field(..., description="用户高亮的文本")
    record_id: str = Field("", description="前端传递的记录 ID")
    target_lang: str = Field("zh", description="目标语言")


class ExplainRequest(BaseModel):
    text: str = Field(..., description="用户高亮的文本")
    record_id: str = Field("", description="前端传递的记录 ID")


class AiConfig(BaseModel):
    provider: str = Field("", description="LLM 提供商")
    api_key: str = Field("", description="LLM API Key")
    model: str = Field("", description="模型名称")
    max_tokens: int = Field(1024, description="最大输出 Token 数")
    base_url: str | None = Field(None, description="自定义 API 地址")
    stream: bool = Field(True, description="是否启用流式输出")
    embedding_model: str = Field("", description="向量嵌入模型名称，如 text-embedding-v3")
    embedding_provider: str = Field("", description="Embedding 提供商")
    embedding_api_key: str = Field("", description="Embedding API Key")
    embedding_base_url: str | None = Field(None, description="Embedding API 地址")


class AiTestResponse(BaseModel):
    success: bool
    message: str


class AsrTestRequest(BaseModel):
    engine: str = Field("whisper", description="ASR 引擎: whisper, bailian")
    model: str = Field("iic/SenseVoiceSmall", description="ASR 模型名称")
    api_key: str = Field("", description="在线 ASR API Key (仅 siliconflow 需要)")


class AsrTestResponse(BaseModel):
    success: bool
    message: str
    detail: str = ""


class ChatMessage(BaseModel):
    role: str = Field(..., description="user 或 assistant")
    content: str = Field(..., description="消息内容")
    images: list[str] = Field(default_factory=list, description="图片 base64 数据（data:image/...）")


class ChatRequest(BaseModel):
    message: str = Field(..., description="用户当前消息")
    history: list[ChatMessage] = Field(default_factory=list, description="历史消息")
    page_context: dict | None = Field(None, description="当前页面上下文 {title, url, content}")
    stream: bool = Field(False, description="是否使用流式输出")
    images: list[str] = Field(default_factory=list, description="当前消息的图片 base64 数据")


class ChatResponse(BaseModel):
    reply: str


class VideoSummarizeRequest(BaseModel):
    url: str = Field(..., description="视频页面 URL")
    title: str = Field("", description="视频标题")
    subtitles: str = Field("", description="视频字幕内容（带时间戳）")
    model: str = Field("", description="模型名称，用于自适应帧策略")
    use_asr: bool = Field(False, description="是否使用语音识别生成字幕")
    asr_engine: str = Field("whisper", description="ASR 引擎: whisper, bailian")
    asr_local_model: str = Field("tiny", description="本地 ASR 模型名称")
    asr_model: str = Field("FunAudioLLM/SenseVoiceSmall", description="在线 ASR 模型名称")
    asr_api_key: str = Field("", description="在线 ASR API Key (仅 siliconflow 需要)")
    custom_prompt: str = Field("", description="自定义提示词，不为空时替换默认总结提示词")
    skip_frames: bool = Field(False, description="是否跳过帧画面，仅使用字幕文本")



