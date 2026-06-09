"""
maintenance_middleware.py  —  BA_TOOL backend
เช็ค maintenance mode จาก PostgreSQL (shared DB กับ admin console)
ถ้า maintenance=True → return 503 ทันที ยกเว้น /health

[CACHE] TTL-based caching: DB query ถูกเรียกแค่ครั้งแรก หรือหลัง TTL หมด
        ไม่มีการ query ทุก request อีกต่อไป
"""

import os
import time
import threading
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

# ── TTL cache ────────────────────────────────────────────────────────────────
# _cache เก็บ state ล่าสุด; updated_at=0.0 บังคับ refresh ตอน startup
_cache: dict = {"enabled": False, "reason": "", "updated_at": 0.0}
_CACHE_TTL = 10          # seconds — ลดจาก 30 เพื่อ sync admin เร็วขึ้น
_cache_lock = threading.Lock()   # thread-safe สำหรับ worker threads ของ uvicorn


def invalidate_maintenance_cache() -> None:
    """บังคับ clear cache ทันที — เรียกหลัง admin เปลี่ยน maintenance state"""
    with _cache_lock:
        _cache["updated_at"] = 0.0
    logger.info("[MAINTENANCE] Cache invalidated — next request will re-fetch from DB")


def _fetch_maintenance_state() -> tuple[bool, str]:
    """Query ตรงจาก PostgreSQL — ใช้ connection จาก pool default
    คืน (False, "") เสมอถ้า query ล้มเหลว (fail-open)
    """
    try:
        from backend.config.db import get_connection, release_connection
        conn = get_connection("default")
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT key, value FROM system_settings "
                    "WHERE key IN ('maintenance_mode', 'maintenance_reason')"
                )
                rows = cur.fetchall()
                data = {row[0]: row[1] for row in rows}
                enabled = data.get("maintenance_mode", "false").strip().lower() == "true"
                reason  = data.get("maintenance_reason", "")
                logger.debug(
                    "[MAINTENANCE] Fetched from DB — enabled=%s reason=%r", enabled, reason
                )
                return enabled, reason
        finally:
            release_connection(conn, "default")
    except Exception as e:
        logger.warning("[MAINTENANCE] DB check failed (fail-open): %s", e)
        return False, ""


def _get_maintenance_state() -> tuple[bool, str]:
    """
    คืน maintenance state จาก cache ถ้า TTL ยังไม่หมด
    ถ้า TTL หมด → query DB แล้ว update cache ก่อนคืน
    Thread-safe ผ่าน _cache_lock
    """
    now = time.monotonic()

    # Fast path: ตรวจ cache โดยไม่ต้องล็อก (อ่าน float อะตอมิกบน CPython)
    if now - _cache["updated_at"] < _CACHE_TTL:
        return _cache["enabled"], _cache["reason"]

    # Slow path: TTL หมดแล้ว ต้อง refresh
    with _cache_lock:
        # Double-check หลัง acquire lock เผื่อ thread อื่น refresh ไปแล้ว
        if now - _cache["updated_at"] < _CACHE_TTL:
            return _cache["enabled"], _cache["reason"]

        enabled, reason = _fetch_maintenance_state()
        _cache["enabled"]    = enabled
        _cache["reason"]     = reason
        _cache["updated_at"] = time.monotonic()
        return enabled, reason


# ── Bypass paths ─────────────────────────────────────────────────────────────
# NOTE: /system/maintenance ต้องอยู่ที่นี่ ไม่งั้น frontend poll แล้ว middleware
#       block ตัวเองก่อน → overlay ขึ้นไม่ได้
# NOTE: /health ต้องผ่านเสมอ — ใช้โดย wake proxy และ Render health check
_BYPASS_PATHS = {"/health", "/", "/system/maintenance", "/system/maintenance/refresh"}


class MaintenanceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in _BYPASS_PATHS:
            return await call_next(request)

        enabled, reason = _get_maintenance_state()
        if enabled:
            msg = reason or "ระบบอยู่ในช่วงปิดปรับปรุง กรุณาลองใหม่ภายหลัง"
            logger.info(
                "[MAINTENANCE] Blocked %s %s — maintenance active",
                request.method, request.url.path,
            )
            return JSONResponse(
                status_code=503,
                content={"success": False, "message": msg, "maintenance": True},
                headers={"Retry-After": "300"},
            )

        return await call_next(request)