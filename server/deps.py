"""公共 FastAPI 依赖"""

from fastapi import Header, HTTPException, Depends

from config import API_KEY

def verify_key(authorization: str = Header("", alias="Authorization")):
    """简单的 API Key 认证"""
    if not API_KEY:
        return True
    # 支持 Bearer token
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing API Key")
    if token != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid API Key")
    return True

# 供路由使用的完整依赖别名
auth_dependency = Depends(verify_key)