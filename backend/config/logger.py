import os
import logging
import re
from collections import deque
from datetime import datetime
from threading import Lock

LOG_BUFFER_LIMIT = 5000
_LOG_BUFFER  = deque(maxlen=LOG_BUFFER_LIMIT)
_LOG_LOCK    = Lock()
_LOG_COUNTER = 0          # sequential id ป้องกัน collision ข้าม restart

# ── Enhanced API log fields (parsed from structured log messages) ──────────
_API_LOG_PATTERN = re.compile(
    r"(?:request_id=(?P<request_id>[^\s]+))?"
    r"(?:.*?endpoint=(?P<endpoint>[^\s]+))?"
    r"(?:.*?method=(?P<method>[A-Z]+))?"
    r"(?:.*?status=(?P<http_status>\d+))?"
    r"(?:.*?response_time=(?P<response_time>[\d.]+)ms)?"
    r"(?:.*?error_type=(?P<error_type>[^\s]+))?"
    r"(?:.*?retry_count=(?P<retry_count>\d+))?",
    re.DOTALL,
)


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


def _extract_api_fields(msg: str) -> dict:
    """
    ดึงข้อมูล API diagnostic fields จาก log message ที่ถูก format แบบ structured
    คืน dict ที่มีเฉพาะ key ที่ parse ได้ (None ถูก filter ออก)
    """
    fields: dict = {}
    if not isinstance(msg, str):
        return fields

    # request_id
    m = re.search(r"\brequest_id=([a-f0-9-]{8,})", msg)
    if m:
        fields["request_id"] = m.group(1)

    # endpoint
    m = re.search(r"\bendpoint=([^\s,]+)", msg)
    if m:
        fields["endpoint"] = m.group(1)

    # method
    m = re.search(r"\bmethod=(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)", msg)
    if m:
        fields["method"] = m.group(1)

    # http_status
    m = re.search(r"\bstatus=(\d{3})\b", msg)
    if m:
        fields["http_status"] = int(m.group(1))

    # response_time
    m = re.search(r"\bresponse_time=([\d.]+)ms\b", msg)
    if m:
        fields["response_time_ms"] = float(m.group(1))

    # error_type
    m = re.search(r"\berror_type=([^\s,]+)", msg)
    if m:
        fields["error_type"] = m.group(1)

    # error_message (quoted or until end of known key)
    m = re.search(r'\berror_message="([^"]+)"', msg)
    if m:
        fields["error_message"] = m.group(1)

    # retry_count
    m = re.search(r"\bretry_count=(\d+)\b", msg)
    if m:
        fields["retry_count"] = int(m.group(1))

    # username
    m = re.search(r"\busername=([^\s,;]+)", msg)
    if m:
        fields["username"] = m.group(1)

    return fields


class InMemoryLogHandler(logging.Handler):
    """Small ring-buffer handler for the frontend live log console."""

    def emit(self, record: logging.LogRecord) -> None:
        global _LOG_COUNTER
        try:
            msg = record.getMessage()
            api_fields = _extract_api_fields(msg if isinstance(msg, str) else "")

            source_file = _make_source_file(record)
            with _LOG_LOCK:
                _LOG_COUNTER += 1
                entry: dict = {
                    "id":          _LOG_COUNTER,
                    "timestamp":   datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S"),
                    "level":       record.levelname,
                    "message":     msg,
                    "name":        record.name,
                    "source_file": source_file,
                }
                # Merge API diagnostic fields ถ้ามี
                entry.update(api_fields)
                _LOG_BUFFER.append(entry)

            # Alert ออก Terminal สำหรับ WARNING ขึ้นไป
            if record.levelno >= logging.WARNING:
                symbol = "❌" if record.levelno >= logging.ERROR else "⚠️"
                print(f"\n{symbol}  [{entry['level']}] {entry['message']}  ({source_file})\n")

        except Exception:
            self.handleError(record)


def get_recent_logs(only_errors: bool = False) -> list[dict]:
    """ดึงข้อมูล Log ล่าสุดจาก Buffer — รวม source_file และ API fields ด้วยทุก entry"""
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