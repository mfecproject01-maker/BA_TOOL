import os
import logging
from collections import deque
from datetime import datetime
from threading import Lock

LOG_BUFFER_LIMIT = 5000
_LOG_BUFFER  = deque(maxlen=LOG_BUFFER_LIMIT)
_LOG_LOCK    = Lock()
_LOG_COUNTER = 0          # sequential id ป้องกัน collision ข้าม restart


def _make_source_file(record: logging.LogRecord) -> str:
    """
    สร้าง source_file string จาก LogRecord โดยตรง
    Python logging ติด pathname / filename / lineno มาให้แล้ว

    คืนค่าในรูป  'api/main.py:329'
    ถ้า pathname มี 'backend/' ให้ตัดเอาส่วน relative จาก backend/ ออกมา
    """
    pathname = record.pathname or ""
    sep      = os.sep

    # พยายาม cut ส่วน relative จาก 'backend/'
    marker = f"backend{sep}"
    if marker in pathname:
        rel = pathname.split(marker, 1)[-1]
    else:
        # fallback: ใช้ชื่อไฟล์ล้วน ๆ
        rel = record.filename

    return f"{rel}:{record.lineno}"


class InMemoryLogHandler(logging.Handler):
    """Small ring-buffer handler for the frontend live log console."""

    def emit(self, record: logging.LogRecord) -> None:
        global _LOG_COUNTER
        try:
            source_file = _make_source_file(record)
            with _LOG_LOCK:
                _LOG_COUNTER += 1
                entry = {
                    "id":          _LOG_COUNTER,
                    "timestamp":   datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S"),
                    "level":       record.levelname,
                    "message":     record.getMessage(),
                    "name":        record.name,
                    "source_file": source_file,
                }
                _LOG_BUFFER.append(entry)

            # Alert ออก Terminal สำหรับ WARNING ขึ้นไป
            if record.levelno >= logging.WARNING:
                symbol = "❌" if record.levelno >= logging.ERROR else "⚠️"
                print(f"\n{symbol}  [{entry['level']}] {entry['message']}  ({source_file})\n")

        except Exception:
            self.handleError(record)


def get_recent_logs(only_errors: bool = False) -> list[dict]:
    """ดึงข้อมูล Log ล่าสุดจาก Buffer — รวม source_file ด้วยทุก entry"""
    with _LOG_LOCK:
        if only_errors:
            return [
                log for log in _LOG_BUFFER
                if log["level"] in ("WARNING", "ERROR", "CRITICAL")
            ]
        return list(_LOG_BUFFER)


def clear_logs() -> None:
    """ล้างข้อมูล Log ใน Buffer ทั้งหมด"""
    with _LOG_LOCK:
        _LOG_BUFFER.clear()


# ── Logging config ────────────────────────────────────────────────────────────
logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s | %(levelname)-8s | %(name)s | [%(filename)s:%(lineno)d] : %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
)

_root_logger = logging.getLogger()

# ป้องกัน Handler ซ้ำ
if not any(getattr(h, "_ba_tool_memory_handler", False) for h in _root_logger.handlers):
    _memory_handler = InMemoryLogHandler(level=logging.INFO)
    _memory_handler._ba_tool_memory_handler = True
    _root_logger.addHandler(_memory_handler)

# logger instance สำหรับโปรเจกต์
logger = logging.getLogger("ba_tool")