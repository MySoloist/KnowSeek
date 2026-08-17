"""
RSSHub 代理 — 转发请求绕开浏览器 CORS 限制
"""

import logging

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from deps import verify_key

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(verify_key)])


@router.get("/rss-proxy")
async def rss_proxy(url: str = Query(..., description="目标 RSSHub URL")):
    """代理 RSSHub 请求，后端转发不受 CORS 限制"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={"User-Agent": "KnowSeek/1.0"},
        )
        return JSONResponse(content=resp.json(), status_code=resp.status_code)