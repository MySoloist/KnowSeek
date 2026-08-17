"""
知寻 - 后端服务
入口文件，组装中间件 + 路由
"""

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from fastapi.staticfiles import StaticFiles

from config import API_KEY
from routers import health, ai, config, backup, video, embedding, rss

# ─── 日志配置 ───
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
# 让 uvicorn 的日志也走我们的格式
for name in ("uvicorn.access", "uvicorn.error", "uvicorn"):
    logging.getLogger(name).handlers.clear()
    logging.getLogger(name).propagate = True

logger = logging.getLogger(__name__)


# ─── 创建应用 ───
app = FastAPI(title="知寻后端", version="0.2.0")


# ─── 请求校验失败时打印详细请求体 ───
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    body = await request.body()
    logger.error(
        "请求校验失败 (422):\n  URL: %s\n  Body: %s\n  错误: %s",
        request.url.path,
        body.decode("utf-8", errors="replace")[:500],
        exc.errors(),
    )   
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )

# ─── CORS ───
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 注册路由（全部挂载在 /api 前缀下）───
app.include_router(health.router, prefix="/api")
app.include_router(ai.router, prefix="/api")
app.include_router(config.router, prefix="/api")
app.include_router(backup.router, prefix="/api")
app.include_router(video.router, prefix="/api")
app.include_router(embedding.router, prefix="/api")
app.include_router(rss.router, prefix="/api")

# ─── 静态文件服务（视频帧图片）───
import os
_static_dir = os.path.join(os.path.dirname(__file__), "static")
_frames_dir = os.path.join(_static_dir, "frames")
os.makedirs(_frames_dir, exist_ok=True)
app.mount("/frames", StaticFiles(directory=_frames_dir), name="frames")


@app.get("/")
async def root():
    return {"app": "知寻后端", "version": "0.2.0", "status": "running"}


# ─── 防止浏览器的 favicon 请求产生 404 ───
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)
