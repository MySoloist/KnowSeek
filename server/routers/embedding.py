"""内容语义检测 API（基于向量嵌入）"""

import logging
from fastapi import APIRouter, Depends, HTTPException, Body

from deps import verify_key

from models.schemas import AiConfig
from services.vector import (
    add_page_embedding,
    compare_paragraphs_batch,
    delete_page_embedding,
    generate_embedding,
    is_embedding_configured,
    list_page_embeddings,
    search_similar,
)

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(verify_key)])


@router.get("/embedding/status")
async def embedding_status():
    """查询 embedding 配置状态"""
    return {
        "ok": True,
        "data": {
            "configured": is_embedding_configured(),
        },
    }


@router.post("/embedding/test")
async def test_embedding_connection(
    api_key: str = Body(..., embed=True),
    model: str = Body(..., embed=True),
    base_url: str = Body("", embed=True),
):
    """测试 embedding 连接"""
    from services.vector import _get_openai_client

    # 临时构建客户端测试连接
    if not api_key or not model:
        raise HTTPException(status_code=400, detail="api_key 和 model 为必填")
    base = base_url.rstrip("/") if base_url else None
    if base and not base.endswith("/v1"):
        base += "/v1"
    try:
        import openai
        client = openai.OpenAI(api_key=api_key, base_url=base) if base else openai.OpenAI(api_key=api_key)
        resp = client.embeddings.create(model=model, input="ping")
        dims = len(resp.data[0].embedding)
        return {"ok": True, "message": f"连接成功，向量维度: {dims}"}
    except Exception as e:
        logger.warning("Embedding 测试失败: %s", str(e))
        msg = str(e)
        for kw in ["AuthenticationError", "RateLimitError", "NotFoundError", "BadRequestError"]:
            if kw in msg:
                msg = msg.split(kw)[-1].strip().split(".")[0][:80]
                break
        return {"ok": False, "message": msg[:120]}


@router.post("/embedding/generate")
async def generate_embedding_api(text: str = Body(..., embed=True)):
    """生成文本的向量嵌入"""
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if not is_embedding_configured():
        raise HTTPException(status_code=400, detail="Embedding 模型未配置，请在 AI 设置中填写")
    result = generate_embedding(text.strip())
    if result is None:
        raise HTTPException(status_code=500, detail="Embedding 生成失败")
    return {"ok": True, "data": {"embedding": result, "dimensions": len(result)}}


@router.post("/embedding/save")
async def save_page_embedding(
    url: str = Body(..., embed=True),
    title: str = Body("", embed=True),
    content: str = Body(..., embed=True),
):
    """保存页面快照的 embedding"""
    if not url or not content:
        raise HTTPException(status_code=400, detail="url 和 content 为必填")
    ok = add_page_embedding(url, title, content)
    return {"ok": ok, "message": "已保存" if ok else "保存失败"}


@router.post("/embedding/search")
async def search_similar_embedding(
    url: str = Body(..., embed=True),
    content: str = Body(..., embed=True),
    top_k: int = Body(1, embed=True),
):
    """搜索与当前内容最相似的旧快照"""
    if not url or not content:
        raise HTTPException(status_code=400, detail="url 和 content 为必填")
    results = search_similar(url, content, top_k=top_k)
    return {"ok": True, "data": {"results": results}}


@router.post("/embedding/compare")
async def compare_paragraphs(
    old_paragraphs: list[str] = Body(..., embed=True),
    new_paragraphs: list[str] = Body(..., embed=True),
):
    """批量语义对比新旧段落，返回匹配对与未匹配索引"""
    if not is_embedding_configured():
        raise HTTPException(status_code=400, detail="Embedding 模型未配置，请在 AI 设置中填写")

    logger.info("===== 段落对比请求 =====")
    logger.info("旧段落 (%d 个):", len(old_paragraphs))
    for i, p in enumerate(old_paragraphs):
        logger.info("  old[%d]: %s...", i, p[:80].replace("\n", "\\n"))
    logger.info("新段落 (%d 个):", len(new_paragraphs))
    for i, p in enumerate(new_paragraphs):
        logger.info("  new[%d]: %s...", i, p[:80].replace("\n", "\\n"))

    result = compare_paragraphs_batch(old_paragraphs, new_paragraphs)

    logger.info("匹配结果:")
    for p in result.get("matched_pairs", []):
        logger.info("  old[%d] ↔ new[%d] (相似度=%.4f)", p["old_index"], p["new_index"], p["similarity"])
    logger.info("  未匹配旧段落索引: %s", result.get("unmatched_old_indices", []))
    logger.info("  未匹配新闻落段索引: %s", result.get("unmatched_new_indices", []))

    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return {"ok": True, "data": result}


@router.delete("/embedding/delete")
async def delete_embedding(url: str = Body(..., embed=True)):
    """删除指定 URL 的 embedding"""
    if not url:
        raise HTTPException(status_code=400, detail="url 为必填")
    ok = delete_page_embedding(url)
    return {"ok": ok, "message": "已删除" if ok else "删除失败"}


@router.get("/embedding/list")
async def list_embeddings(limit: int = 50):
    """列出所有已保存的 embedding 元数据"""
    items = list_page_embeddings(limit=limit)
    return {"ok": True, "data": {"count": len(items), "items": items}}