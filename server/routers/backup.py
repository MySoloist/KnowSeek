"""服务器定时备份 — 接收/管理前端推送的备份文件"""

import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from deps import verify_key

logger = logging.getLogger(__name__)
router = APIRouter()

# ─── 备份目录 ───
BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"
BACKUP_DIR.mkdir(exist_ok=True)

# ─── 保留的最大备份份数 ───
MAX_BACKUPS = 30

# ─── 文件名安全替换 ───
_FILENAME_CLEAN_RE = re.compile(r"[^\w\.\-]")


def _safe_filename(name: str) -> str:
    """移除文件名中不安全字符"""
    return _FILENAME_CLEAN_RE.sub("_", name)


def _list_backups() -> list[dict]:
    """列出所有备份文件，按修改时间降序"""
    files = []
    for f in BACKUP_DIR.iterdir():
        if f.is_file() and f.suffix.lower() == ".zip":
            mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
            size_kb = round(f.stat().st_size / 1024, 1)
            files.append({
                "filename": f.name,
                "size_kb": size_kb,
                "created_at": mtime.isoformat(),
            })
    files.sort(key=lambda x: x["created_at"], reverse=True)
    return files


def _cleanup_old_backups():
    """保留最近 MAX_BACKUPS 份，删除更旧的"""
    files = sorted(BACKUP_DIR.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True)
    keep = set()
    for f in files:
        if f.is_file() and f.suffix.lower() == ".zip":
            keep.add(f.name)
            if len(keep) > MAX_BACKUPS:
                try:
                    f.unlink()
                    logger.info("[Backup] 清理旧备份: %s", f.name)
                except Exception as e:
                    logger.warning("[Backup] 清理失败 %s: %s", f.name, e)


@router.post("/backup/upload")
async def upload_backup(
    file: UploadFile = File(...),
    _auth=Depends(verify_key),
):
    """接收前端推送的备份 ZIP 文件"""
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="仅支持 .zip 文件")

    # 生成带时间戳的文件名
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    safe_name = _safe_filename(file.filename)
    # 保留原始文件名的主体部分，插入时间戳
    stem, ext = os.path.splitext(safe_name)
    dest_name = f"{stem}_{ts}{ext}"
    dest_path = BACKUP_DIR / dest_name

    try:
        content = await file.read()
        dest_path.write_bytes(content)
        logger.info("[Backup] 已保存备份: %s (%d KB)", dest_name, len(content) // 1024)
    except Exception as e:
        logger.error("[Backup] 保存失败: %s", e)
        raise HTTPException(status_code=500, detail=f"保存备份失败: {str(e)}")

    # 清理旧备份
    _cleanup_old_backups()

    return {
        "ok": True,
        "message": f"备份已保存: {dest_name}",
        "data": {"filename": dest_name},
    }


@router.get("/backup/list")
async def list_backups(_auth=Depends(verify_key)):
    """列出所有备份"""
    backups = _list_backups()
    return {
        "ok": True,
        "data": {
            "backups": backups,
            "total": len(backups),
            "max_backups": MAX_BACKUPS,
            "backup_dir": str(BACKUP_DIR),
        },
    }


@router.delete("/backup/delete/{filename:path}")
async def delete_backup(
    filename: str,
    _auth=Depends(verify_key),
):
    """删除指定备份"""
    safe_name = _safe_filename(filename)
    file_path = BACKUP_DIR / safe_name

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"备份文件不存在: {safe_name}")

    try:
        file_path.unlink()
        logger.info("[Backup] 已删除备份: %s", safe_name)
        return {"ok": True, "message": f"已删除: {safe_name}"}
    except Exception as e:
        logger.error("[Backup] 删除失败 %s: %s", safe_name, e)
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")


@router.get("/backup/download/{filename:path}")
async def download_backup(
    filename: str,
    _auth=Depends(verify_key),
):
    """下载指定备份文件"""
    safe_name = _safe_filename(filename)
    file_path = BACKUP_DIR / safe_name

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"备份文件不存在: {safe_name}")

    return FileResponse(
        path=str(file_path),
        media_type="application/zip",
        filename=safe_name,
    )
