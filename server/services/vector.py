"""向量嵌入与 ChromaDB 服务"""

import json
import logging
import os
import time
from typing import Any

from openai import OpenAI

from config import CONFIG_FILE

logger = logging.getLogger(__name__)

# ChromaDB 数据存储目录
CHROMA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "chroma_data")

# ── 客户端（延迟初始化）──
_chroma_client = None
_embedding_collection = None


def _get_embedding_config() -> tuple[str, str, str, str | None]:
    """读取 embedding 配置，返回 (api_key, model, base_url, provider)"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            # 仅使用独立 embedding 配置，不与 LLM 配置混用
            api_key = (cfg.get("embedding_api_key", "") or "").strip()
            model = (cfg.get("embedding_model", "") or "").strip()
            base_url = (cfg.get("embedding_base_url", "") or "").strip() or None
            provider = (cfg.get("embedding_provider", "") or "").strip()
            if api_key and model:
                return api_key, model, base_url, provider
        except Exception:
            pass
    return "", "", None, ""


def is_embedding_configured() -> bool:
    """检查是否已配置 embedding 模型"""
    _, model, _, _ = _get_embedding_config()
    return bool(model)


def _get_chroma_client():
    """获取 ChromaDB 持久化客户端（单例）"""
    global _chroma_client, _embedding_collection
    if _chroma_client is None:
        import chromadb
        os.makedirs(CHROMA_DIR, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
        _embedding_collection = _chroma_client.get_or_create_collection(
            name="page_snapshots",
            metadata={"hnsw:space": "cosine"},
        )
        logger.info("ChromaDB 已初始化: %s", CHROMA_DIR)
    return _chroma_client, _embedding_collection


def _get_openai_client() -> OpenAI | None:
    """获取 OpenAI 兼容客户端（用于 embedding API）"""
    api_key, model, base_url, provider = _get_embedding_config()
    if not api_key or not model:
        return None
    if not base_url:
        # 根据提供商设置默认地址
        defaults = {
            "deepseek": "https://api.deepseek.com",
            "openai": "https://api.openai.com",
            "siliconflow": "https://api.siliconflow.cn",
            "ollama": "http://localhost:11434",
        }
        base_url = defaults.get(provider, "")
    if not base_url:
        return None
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    return OpenAI(api_key=api_key, base_url=base)


def generate_embedding(text: str) -> list[float] | None:
    """调用 embedding API 生成向量（自动重试 3 次，应对 API 临时故障）"""
    import time

    client = _get_openai_client()
    if not client:
        logger.warning("Embedding 未配置，跳过")
        return None
    _, model, _, _ = _get_embedding_config()
    if not model:
        return None

    max_retries = 3
    for attempt in range(max_retries):
        try:
            resp = client.embeddings.create(
                model=model,
                input=text,
            )
            return resp.data[0].embedding
        except Exception as e:
            err_msg = str(e)
            # 如果是 API 内部错误（5xx / InternalError），重试
            is_retryable = any(kw in err_msg for kw in ["InternalError", "500", "503", "ServiceUnavailable", "timeout"])
            if attempt < max_retries - 1 and is_retryable:
                wait = 2 ** attempt  # 指数退避：1s, 2s, 4s
                logger.warning("Embedding 生成失败（第 %d 次，%ds 后重试）: %s", attempt + 1, wait, err_msg[:100])
                time.sleep(wait)
                continue
            logger.error("Embedding 生成失败（已重试 %d 次）: %s", attempt, str(e), exc_info=True)
            return None

    return None


def add_page_embedding(url: str, title: str, content: str) -> bool:
    """将页面快照的 embedding 存入 ChromaDB"""
    embedding = generate_embedding(content)
    if not embedding:
        return False
    try:
        _, col = _get_chroma_client()
        doc_id = _snapshot_id(url)
        col.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            metadatas=[{"url": url, "title": title, "timestamp": int(time.time())}],
            documents=[content[:1000]],  # 只存前 1000 字符作为摘要
        )
        return True
    except Exception as e:
        logger.error("ChromaDB upsert 失败: %s", str(e))
        return False


def search_similar(url: str, content: str, top_k: int = 1) -> list[dict[str, Any]]:
    """搜索与当前内容最相似的旧快照，返回 [(相似度, 元数据)]
    
    注意：同一个 URL 在 ChromaDB 中只有一条记录（upsert 覆盖），
    因此返回结果即为当前保存的旧快照。
    """
    embedding = generate_embedding(content)
    if not embedding:
        return []
    try:
        _, col = _get_chroma_client()
        results = col.query(
            query_embeddings=[embedding],
            n_results=top_k,
            where={"url": url},
        )
        if not results["ids"] or not results["ids"][0]:
            return []
        items = []
        for i, rid in enumerate(results["ids"][0]):
            items.append({
                "id": rid,
                "similarity": 1 - (results["distances"][0][i] if results["distances"] else 0),
                "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                "document": results["documents"][0][i] if results["documents"] else "",
            })
        return items
    except Exception as e:
        logger.error("ChromaDB 搜索失败: %s", str(e))
        return []


def delete_page_embedding(url: str) -> bool:
    """删除指定 URL 的 embedding"""
    try:
        _, col = _get_chroma_client()
        col.delete(where={"url": url})
        return True
    except Exception as e:
        logger.error("ChromaDB 删除失败: %s", str(e))
        return False


def list_page_embeddings(limit: int = 50) -> list[dict[str, Any]]:
    """列出所有已保存的 embedding 元数据（不含向量）"""
    try:
        _, col = _get_chroma_client()
        count = col.count()
        if count == 0:
            return []
        results = col.peek(limit)
        items = []
        for i in range(len(results["ids"])):
            items.append({
                "id": results["ids"][i],
                "url": (results["metadatas"][i] or {}).get("url", "") if results["metadatas"] else "",
                "title": (results["metadatas"][i] or {}).get("title", "") if results["metadatas"] else "",
                "document_preview": (results["documents"][i] or "")[:200] if results["documents"] else "",
            })
        return items
    except Exception as e:
        logger.error("ChromaDB 列出失败: %s", str(e))
        return []


def compare_paragraphs_batch(old_paragraphs: list[str], new_paragraphs: list[str]) -> dict:
    """批量对比新旧段落，返回语义匹配结果（相互最近邻匹配）

    返回:
        {
            "matched_pairs": [{"old_index": int, "new_index": int, "similarity": float}, ...],
            "unmatched_old_indices": [int, ...],
            "unmatched_new_indices": [int, ...],
        }
    """
    if not old_paragraphs and not new_paragraphs:
        return {"matched_pairs": [], "unmatched_old_indices": [], "unmatched_new_indices": []}

    client = _get_openai_client()
    if not client:
        return {"error": "Embedding 未配置"}
    _, model, _, _ = _get_embedding_config()
    if not model:
        return {"error": "Embedding 模型未配置"}

    # 批量向量化全部段落（分片，每片 ≤ 20 条，兼容 API 限制）
    # 先折叠段落内的空白（换行→空格），避免纯格式差异影响 embedding 相似度
    def _fold_ws(t: str) -> str:
        return " ".join(t.split())

    all_texts = [_fold_ws(p) for p in old_paragraphs] + [_fold_ws(p) for p in new_paragraphs]
    n_old = len(old_paragraphs)
    BATCH_SIZE = 20
    vectors: list[list[float]] = []
    try:
        for start in range(0, len(all_texts), BATCH_SIZE):
            batch = all_texts[start:start + BATCH_SIZE]
            resp = client.embeddings.create(model=model, input=batch)
            sorted_data = sorted(resp.data, key=lambda x: x.index)
            vectors.extend(e.embedding for e in sorted_data)
        old_vecs = vectors[:n_old]
        new_vecs = vectors[n_old:]
    except Exception as e:
        logger.error("Embedding 批量生成失败: %s", str(e))
        return {"error": str(e)}

    if not new_vecs:
        return {
            "matched_pairs": [],
            "unmatched_old_indices": list(range(n_old)),
            "unmatched_new_indices": []
        }

    # 计算余弦相似度矩阵
    n_new = len(new_vecs)
    sim_matrix = [[0.0] * n_new for _ in range(n_old)]
    for i in range(n_old):
        ov = old_vecs[i]
        norm_old = sum(a * a for a in ov) ** 0.5
        if norm_old == 0:
            continue
        for j in range(n_new):
            nv = new_vecs[j]
            dot = sum(a * b for a, b in zip(ov, nv))
            norm_new = sum(a * a for a in nv) ** 0.5
            sim_matrix[i][j] = dot / (norm_old * norm_new) if norm_new > 0 else 0.0

    MIN_MATCH_THRESHOLD = 0.50
    MIN_ALT_THRESHOLD = 0.55
    WINDOW = 2
    matched_pairs = []
    matched_new: set[int] = set()

    # ═══ 预处理阶段：精确文本匹配兜底 ═══
    # 解决 embedding 对代码行（如 ${{ }}）匹配能力差的问题
    # 相同文本即使 embedding 相似度低也应该匹配
    def _simple_norm(t: str) -> str:
        """简单的文本规范化：去首尾空白、折叠空白、转小写"""
        return " ".join(t.strip().lower().split())

    norm_old = [_simple_norm(p) for p in old_paragraphs]
    norm_new = [_simple_norm(p) for p in new_paragraphs]

    # 构建新段落规范化文本到索引的映射（一个文本可能对应多个索引）
    new_text_to_indices: dict[str, list[int]] = {}
    for j, n in enumerate(norm_new):
        new_text_to_indices.setdefault(n, []).append(j)

    for i, no in enumerate(norm_old):
        if no in new_text_to_indices:
            # 找到第一个未被匹配的相同文本新段落
            for j in new_text_to_indices[no]:
                if j not in matched_new:
                    matched_pairs.append({
                        "old_index": i,
                        "new_index": j,
                        "similarity": 1.0,
                    })
                    matched_new.add(j)
                    break

    if any(p["similarity"] == 1.0 for p in matched_pairs):
        logger.info(
            "精确文本预匹配: %d 对",
            sum(1 for p in matched_pairs if p["similarity"] == 1.0),
        )

    # 第一阶段：互相最近邻匹配（仅高置信度 > 0.90）
    # 只有新旧段落互相认为对方是各自的最佳匹配时才配对
    # 有效防止被删除的段落抢走正确段落
    for i in range(n_old):
        if any(p["old_index"] == i for p in matched_pairs):  # 跳过已预匹配的段落
            continue
        best_j = max(range(n_new), key=lambda j: sim_matrix[i][j])
        best_sim = sim_matrix[i][best_j]
        if best_sim <= 0.90:
            continue
        # 检查 new[best_j] 的最佳旧匹配是否也是 i
        best_old = max(range(n_old), key=lambda oi: sim_matrix[oi][best_j])
        if best_old == i:
            matched_pairs.append({
                "old_index": i,
                "new_index": best_j,
                "similarity": round(best_sim, 4),
            })
            matched_new.add(best_j)

    # 第二阶段：位置约束匹配（按相似度降序处理，避免低优先级段落先抢走正确匹配）
    # 收集所有窗口内候选，按相似度降序全局贪心分配，确保最高置信度的匹配优先
    candidates_p2 = []
    for i in range(n_old):
        if any(p["old_index"] == i for p in matched_pairs):
            continue
        start = max(0, i - WINDOW)
        end = min(n_new, i + WINDOW + 1)
        for j in range(start, end):
            if j not in matched_new and sim_matrix[i][j] >= MIN_MATCH_THRESHOLD:
                candidates_p2.append((sim_matrix[i][j], i, j))

    # 按相似度降序处理，确保高置信度匹配优先，防止低相似度段落偷匹配
    candidates_p2.sort(key=lambda x: -x[0])
    for sim, i, j in candidates_p2:
        if any(p["old_index"] == i for p in matched_pairs) or j in matched_new:
            continue
        # 额外检查：如果 new[j] 与其他旧段落有更高相似度，跳过（防止偷匹配）
        best_alt_oi = -1
        best_alt_sim = 0.0
        for oi in range(n_old):
            if oi == i or any(p["old_index"] == oi for p in matched_pairs):
                continue
            if sim_matrix[oi][j] > best_alt_sim:
                best_alt_sim = sim_matrix[oi][j]
                best_alt_oi = oi
        if best_alt_oi >= 0 and best_alt_sim > MIN_ALT_THRESHOLD and best_alt_sim > sim + 0.05:
            # new[j] 与其他旧段落有显著更高相似度，跳过此配对
            continue
        matched_pairs.append({
            "old_index": i,
            "new_index": j,
            "similarity": round(sim, 4),
        })
        matched_new.add(j)

    # 第三阶段：全局贪心兜底
    candidates_p3 = []
    for i in range(n_old):
        if any(p["old_index"] == i for p in matched_pairs):
            continue
        for j in range(n_new):
            if j not in matched_new and sim_matrix[i][j] >= MIN_MATCH_THRESHOLD:
                candidates_p3.append((sim_matrix[i][j], i, j))

    candidates_p3.sort(key=lambda x: -x[0])
    for sim, i, j in candidates_p3:
        if any(p["old_index"] == i for p in matched_pairs) or j in matched_new:
            continue
        matched_pairs.append({
            "old_index": i,
            "new_index": j,
            "similarity": round(sim, 4),
        })
        matched_new.add(j)

    # 第四阶段：保证配对单调性（去除交叉匹配，确保段落顺序不乱）
    # 如果 old[a]↔new[b] 且 old[c]↔new[d] 且 a<c 但 b>d，则段落顺序错位
    # 这种交叉配对会导致渲染时段落顺序混乱
    matched_pairs.sort(key=lambda p: (p["old_index"], p["new_index"]))
    monotonic_pairs = []
    dropped_old_indices: list[int] = []  # 被单调性检查丢弃的旧段落索引
    max_new_idx = -1
    for p in matched_pairs:
        if p["new_index"] > max_new_idx:
            monotonic_pairs.append(p)
            max_new_idx = p["new_index"]
        else:
            # 交叉配对，暂时丢弃（后续会尝试恢复）
            matched_new.discard(p["new_index"])
            dropped_old_indices.append(p["old_index"])
    matched_pairs = monotonic_pairs

    # 恢复阶段：对被丢弃的旧段落，尝试匹配到剩余的未匹配新段落
    # 防止段落位置偏移导致有效匹配被误删
    remaining_new = sorted(set(range(n_new)) - matched_new)
    for oi in dropped_old_indices:
        best_j = -1
        best_sim = 0.0
        for nj in remaining_new:
            if sim_matrix[oi][nj] > best_sim:
                best_sim = sim_matrix[oi][nj]
                best_j = nj
        if best_j >= 0 and best_sim >= MIN_MATCH_THRESHOLD:
            matched_pairs.append({
                "old_index": oi,
                "new_index": best_j,
                "similarity": round(best_sim, 4),
            })
            matched_new.add(best_j)
            remaining_new.remove(best_j)

    # 二次回查：对仍未匹配的新闻落段，检查其与所有旧段落的最大相似度
    # 解决段落边界变化（如一个旧段落被拆成多个新闻落段）导致的漏匹配
    SECOND_PASS_THRESHOLD = 0.90
    for ni in remaining_new:
        best_sim = 0.0
        best_oi = -1
        for oi in range(n_old):
            if sim_matrix[oi][ni] > best_sim:
                best_sim = sim_matrix[oi][ni]
                best_oi = oi
        if best_oi >= 0 and best_sim >= SECOND_PASS_THRESHOLD:
            matched_pairs.append({
                "old_index": best_oi,
                "new_index": ni,
                "similarity": round(best_sim, 4),
            })
            matched_new.add(ni)

    # 日志输出
    logger.info(
        "段落匹配结果: old=%d new=%d matched=%d unmatched_old=%d unmatched_new=%d 阈值=%.2f",
        n_old, n_new, len(matched_pairs),
        n_old - len({p["old_index"] for p in matched_pairs}),
        n_new - len(matched_new),
        MIN_MATCH_THRESHOLD,
    )

    matched_old = {p["old_index"] for p in matched_pairs}
    unmatched_old = sorted(set(range(n_old)) - matched_old)
    unmatched_new = sorted(set(range(n_new)) - matched_new)

    return {
        "matched_pairs": matched_pairs,
        "unmatched_old_indices": unmatched_old,
        "unmatched_new_indices": unmatched_new,
    }


def _snapshot_id(url: str) -> str:
    """根据 URL 生成唯一 ID"""
    import hashlib
    return "snap_" + hashlib.md5(url.encode()).hexdigest()