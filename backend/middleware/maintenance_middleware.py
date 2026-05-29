"""
maintenance_middleware.py  —  BA_TOOL backend
เช็ค maintenance mode จาก PostgreSQL (shared DB กับ admin console)
ถ้า maintenance=True → return 503 ทันที ยกเว้น /health
"""

import os
import time
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

# Cache flag ไว้ 10 วินาที (ลดจาก 30 เพื่อ sync admin เร็วขึ้น)
_cache: dict = {"enabled": False, "reason": "", "updated_at": 0.0}
_CACHE_TTL = 10  # seconds


def invalidate_maintenance_cache() -> None:
    """บังคับ clear cache ทันที — เรียกหลัง admin เปลี่ยน maintenance state"""
    _cache["updated_at"] = 0.0


def _fetch_maintenance_state() -> tuple[bool, str]:
    """Query ตรงจาก PostgreSQL — ใช้ connection จาก pool default"""
    try:
        from backend.config.db import get_connection, release_connection
        conn = get_connection("default")
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT key, value FROM system_settings WHERE key IN ('maintenance_mode', 'maintenance_reason')"
                )
                rows = cur.fetchall()
                data = {row[0]: row[1] for row in rows}
                enabled = data.get("maintenance_mode", "false").strip().lower() == "true"
                reason  = data.get("maintenance_reason", "")
                return enabled, reason
        finally:
            release_connection(conn, "default")
    except Exception as e:
        logger.warning(f"[maintenance] DB check failed: {e}")
        return False, ""  # fail-open: ถ้า query ไม่ได้ให้ผ่านต่อ


def _get_maintenance_state() -> tuple[bool, str]:
    now = time.monotonic()
    if now - _cache["updated_at"] > _CACHE_TTL:
        enabled, reason = _fetch_maintenance_state()
        _cache["enabled"]    = enabled
        _cache["reason"]     = reason
        _cache["updated_at"] = now
    return _cache["enabled"], _cache["reason"]


# Paths ที่ยังให้ผ่านได้แม้ maintenance
# NOTE: /system/maintenance ต้องอยู่ที่นี่ ไม่งั้น frontend poll แล้ว middleware block
#       ตัวเองก่อน → overlay ไม่มีทางขึ้นได้เลย
_BYPASS_PATHS = {"/health", "/", "/system/maintenance"}


class MaintenanceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in _BYPASS_PATHS:
            return await call_next(request)

        enabled, reason = _get_maintenance_state()
        if enabled:
            msg = reason or "ระบบอยู่ในช่วงปิดปรับปรุง กรุณาลองใหม่ภายหลัง"
            return JSONResponse(
                status_code=503,
                content={"success": False, "message": msg, "maintenance": True},
                headers={"Retry-After": "300"},
            )

        return await call_next(request)