import asyncio
import json
import logging
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import List
import os

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from backend.middleware.maintenance_middleware import MaintenanceMiddleware

from backend.repository.mapping_repo import MappingRepository
from backend.core.converter import DataTypeConverter
from backend.parser.sql_parser import parse_sql, validate_fk
from backend.config.logger import logger, get_recent_logs, clear_logs
from backend.config.db import init_db_pool, close_db_pool
from backend.core.cache_store import result_cache
from backend.exporter.excel_exporter import export_confluent_xlsx, export_table_xlsx, export_all_csv, export_table_csv

# Logging is configured once in backend.config.logger (imported below).
# Do not call basicConfig here to avoid duplicate handlers.

# ── Startup tracking ─────────────────────────────────────
# Set to True only after lifespan startup completes successfully.
# /health checks this flag so it can return 503 during cold-start init.
_startup_complete: bool = False
_startup_error: str | None = None
_startup_time: str | None = None   # ISO-8601 UTC

# ── Constants ────────────────────────────────────────────
MAX_FILE_SIZE_MB = 10
MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
MAX_FILES = 20
SESSION_TTL = timedelta(hours=1)
CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
DATABASE_SUPPORT_MATRIX_PATH = CONFIG_DIR / "database_support_matrix.json"

# ── Mapping cache (source_db, dest_db) → (mapping_dict, loaded_at) ──────
_mapping_cache: dict[tuple, tuple] = {}
_MAPPING_TTL = timedelta(seconds=30)

converter: DataTypeConverter = DataTypeConverter({})

def _decode_sql_upload(raw: bytes, filename: str) -> str:
    """Decode SQL uploads from common export encodings."""
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig")

    sample = raw[:4096]
    even_nulls = sample[0::2].count(0)
    odd_nulls = sample[1::2].count(0)
    if odd_nulls > max(8, len(sample) // 8) and even_nulls < odd_nulls // 4:
        logger.info(f"Detected UTF-16 LE SQL upload: {filename}")
        return raw.decode("utf-16-le")
    if even_nulls > max(8, len(sample) // 8) and odd_nulls < even_nulls // 4:
        logger.info(f"Detected UTF-16 BE SQL upload: {filename}")
        return raw.decode("utf-16-be")

    for encoding in ("utf-8-sig", "cp874", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")

# ── Background session cleanup ────────────────────────────────────────────
async def _session_cleanup_loop() -> None:
    """Background task: purge expired sessions every 5 minutes."""
    while True:
        await asyncio.sleep(300)
        now = datetime.now()
        expired = [sid for sid, s in list(result_cache.items())
                   if now - s["created_at"] > SESSION_TTL]
        for sid in expired:
            result_cache.pop(sid, None)
        if expired:
            logger.info(f"🧹 Background cleanup: removed {len(expired)} expired session(s)")

limiter = Limiter(key_func=get_remote_address)

# ── Lifecycle ─────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _startup_complete, _startup_error, _startup_time
    logger.info("[HEALTH] 🚀 [1/2] Initialization: Starting FastAPI application...")

    try:
        logger.info("[HEALTH] 📡 Connecting to PostgreSQL database pool...")
        init_db_pool()
        logger.info(
            "[HEALTH] ✅ Database pool initialized. "
            "Note: Mapping loading deferred to request-time to optimize startup speed."
        )
    except Exception as e:
        _startup_error = str(e)
        logger.error(
            "[HEALTH] ❌ Critical Failure: Application failed to boot during Database Setup. Error: %s",
            e, exc_info=True,
        )
        raise

    _startup_complete = True
    _startup_time = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    logger.info("[HEALTH] 🚀 [2/2] Startup Complete: Server is ready to accept connections.")

    _cleanup_task = asyncio.create_task(_session_cleanup_loop())
    logger.info("🕐 Background session cleanup task started (interval: 5 min)")

    yield
    
    # ส่วนของ Shutdown
    logger.info("🛑 Termination: Gracefully shutting down application...")
    _cleanup_task.cancel()
    try:
        await _cleanup_task
    except asyncio.CancelledError:
        pass
    try:
        close_db_pool()
        logger.info("🔌 Database connections closed successfully.")
    except Exception as e:
        logger.error(f"⚠️ Shutdown Warning: Error while closing resources: {e}")
    
    logger.info("👋 Shutdown sequence finished.")

app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── CORS ─────────────────────────────────────────────────
_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000,null"
).split(",")

# hardcode production URLs
_ORIGINS += [
    "https://ba-tool-4bkpuk5mj-mfecproject01-makers-projects.vercel.app",
    "https://ba-tool-nine.vercel.app",
]

# VERCEL_ORIGIN: frontend production URL (ตั้งใน Railway/Render env)
_VERCEL_ORIGIN = os.getenv("VERCEL_ORIGIN", "").strip().rstrip("/")
if _VERCEL_ORIGIN:
    _ORIGINS.append(_VERCEL_ORIGIN)

# ADMIN_ORIGIN: admin console URL — ต้องเพิ่มหรือ admin console จะถูก CORS block ทุก request
_ADMIN_ORIGIN = os.getenv("ADMIN_ORIGIN", "").strip().rstrip("/")
if _ADMIN_ORIGIN:
    _ORIGINS.append(_ADMIN_ORIGIN)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGINS,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https://ba-tool(-[a-z0-9]+)*-mfecproject01-makers-projects\.vercel\.app$|^https://ba-tool-nine\.vercel\.app$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
    # ต้อง expose ออกมาเอง ไม่งั้น browser จะ block ไม่ให้ fetch() เห็น header เหล่านี้ข้าม origin
    # Content-Length: ใช้คำนวณ % progress ตอนดาวน์โหลด/export
    # Content-Disposition: เผื่อ frontend อยากอ่านชื่อไฟล์จาก header ในอนาคต
    expose_headers=["Content-Length", "Content-Disposition"],
)

app.add_middleware(MaintenanceMiddleware)

# ── Models ────────────────────────────────────────────────
class OverrideRequest(BaseModel):
    table: str
    column: str
    new_type: str

    @field_validator("table", "column", "new_type")
    @classmethod
    def no_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Field must not be empty")
        if len(v) > 256:
            raise ValueError("Field too long")
        return v

# ── Helpers ───────────────────────────────────────────────
def cleanup_expired_sessions() -> None:
    """Manual purge — kept for ad-hoc use; normal cleanup runs in background."""
    now = datetime.now()
    expired = [sid for sid, s in list(result_cache.items())
               if now - s["created_at"] > SESSION_TTL]
    for sid in expired:
        result_cache.pop(sid, None)
    if expired:
        logger.info(f"🧹 Cleaned {len(expired)} expired session(s)")

def get_cached_data(session_id: str) -> dict:
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(400, "Invalid session ID format")
    data = result_cache.get(session_id)
    if not data:
        raise HTTPException(404, "Session expired or not found")
    return data


def _prune_column_diagnostics(data: dict, table_name: str, column_name: str) -> None:
    unknown_map = data.get("unknown", {})
    unknown_map[table_name] = [
        item for item in unknown_map.get(table_name, [])
        if item.get("column_name") != column_name
    ]
    if not unknown_map.get(table_name):
        unknown_map.pop(table_name, None)

    anomaly_map = data.get("byte_anomalies", {})
    anomaly_map[table_name] = [
        item for item in anomaly_map.get(table_name, [])
        if item.get("column_name") != column_name
    ]
    if not anomaly_map.get(table_name):
        anomaly_map.pop(table_name, None)

    data["fk_errors"] = validate_fk(data.get("tables", {}))

def _make_export_filename(table_names: list[str], ext: str) -> str:
    """สร้างชื่อไฟล์จากชื่อ table ทั้งหมด + _confluent"""
    clean = [re.sub(r"[^\w]", "_", t) for t in table_names]
    if len(clean) > 5:
        # ใช้ชื่อตารางแรก + จำนวนที่เหลือ แทนการตัดกลางคำ
        joined = f"{clean[0]}_and_{len(clean) - 1}_more"
    else:
        joined = "_".join(clean)
    return f"{joined}_confluent.{ext}"


def _load_mapping(source_db: str | None, dest_db: str | None) -> dict:
    """
    โหลด mapping ตาม db pair จาก DB แบบ real-time
    - โหลดจาก DB เสมอตาม source_db ที่ระบุ เพื่อป้องกันข้อมูลปนกัน
    """
    repo = MappingRepository()

    # 1. ถ้ามีทั้งคู่ -> ดึง per-pair mapping
    if source_db and dest_db:
        try:
            pair_mapping = repo.get_by_db_pair(source_db, dest_db)
            if pair_mapping:
                logger.info(f"📦 Pair mapping loaded: {source_db} → {dest_db} ({len(pair_mapping)} types)")
                return pair_mapping
        except Exception as e:
            logger.warning(f"⚠️ Failed to load pair mapping ({source_db}→{dest_db}): {e}")

    # 2. ถ้ามีแค่ source_db หรือโหลด pair ไม่สำเร็จ -> ดึง mapping ของ source_db นั้นๆ
    if source_db:
        try:
            source_mapping = repo.get_all(source_db=source_db)
            logger.info(f"📦 Source mapping loaded for {source_db} ({len(source_mapping)} types)")
            return source_mapping
        except Exception as e:
            logger.error(f"❌ Failed to load source mapping for {source_db}: {e}")

    # 3. Fallback สุดท้าย (ไม่แนะนำ) -> ดึงทั้งหมดแบบระบุไม่ได้ (อาจปนกัน)
    logger.warning("⚠️ No source_db specified, loading all mappings (potential mix-up)")
    fallback = repo.get_all()
    return fallback


# ── API ───────────────────────────────────────────────────

def load_database_support_matrix() -> dict:
    """Read the database compatibility matrix from JSON on each request."""
    try:
        with DATABASE_SUPPORT_MATRIX_PATH.open("r", encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        logger.error("Database support matrix file not found: %s", DATABASE_SUPPORT_MATRIX_PATH)
        raise HTTPException(status_code=404, detail="Database support matrix file not found")
    except json.JSONDecodeError as exc:
        logger.error("Invalid database support matrix JSON: %s", exc)
        raise HTTPException(status_code=500, detail="Database support matrix contains invalid JSON")
    except OSError as exc:
        logger.error("Unable to read database support matrix: %s", exc)
        raise HTTPException(status_code=500, detail="Unable to read database support matrix")
@app.get("/health")
def health():
    """
    [HEALTH] ตรวจสอบสถานะ BA_TOOL service
    - 503 ถ้า startup ยังไม่เสร็จ หรือ DB pool ว่างเปล่า
    - 200 ok ถ้าทุก DB pool ใช้งานได้
    - 200 degraded ถ้า pool มีแต่บาง DB มีปัญหา
    ไม่มี false-positive: all([]) == True ถูกป้องกันด้วยการเช็ค db_names
    """
    from backend.config.db import get_connection, release_connection, get_db_names

    timestamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    # ── Guard: startup ยังไม่เสร็จ ────────────────────────────────────────
    if not _startup_complete:
        detail = _startup_error or "Application is still initializing"
        logger.warning("[HEALTH] 503 — startup not complete: %s", detail)
        return JSONResponse(
            status_code=503,
            content={
                "status":    "error",
                "detail":    detail,
                "db":        {},
                "sessions":  len(result_cache),
                "startup":   "pending",
                "timestamp": timestamp,
            },
        )

    # ── Guard: DB pool ว่างเปล่า (init ล้มเหลว หรือยังไม่ถูกเรียก) ───────
    db_names = get_db_names()
    if not db_names:
        logger.error("[HEALTH] 503 — DB pool not initialized (no pools registered)")
        return JSONResponse(
            status_code=503,
            content={
                "status":    "error",
                "detail":    "DB pool not initialized",
                "db":        {},
                "sessions":  len(result_cache),
                "startup":   "complete",
                "timestamp": timestamp,
            },
        )

    # ── Probe every registered pool ───────────────────────────────────────
    db_status: dict[str, str] = {}
    for db_name in db_names:
        conn = None
        try:
            conn = get_connection(db_name)
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            db_status[db_name] = "ok"
        except Exception as e:
            db_status[db_name] = f"error: {e}"
            logger.warning("[HEALTH] DB probe failed for '%s': %s", db_name, e)
        finally:
            if conn is not None:
                try:
                    release_connection(conn, db_name)
                except Exception:
                    pass

    all_ok  = all(v == "ok" for v in db_status.values())
    overall = "ok" if all_ok else "degraded"

    logger.info(
        "[HEALTH] %s — sessions=%d dbs=%s",
        overall.upper(), len(result_cache),
        {k: v[:20] for k, v in db_status.items()},
    )

    return {
        "status":    overall,
        "sessions":  len(result_cache),
        "db":        db_status,
        "startup":   "complete",
        "timestamp": timestamp,
    }


@app.get("/database-support")
def get_database_support():
    """Return database compatibility documentation from config JSON."""
    return load_database_support_matrix()

@app.get("/logs")
def get_logs():
    """Return recent backend processing logs for the live frontend console."""
    return get_recent_logs()


@app.delete("/logs")
def delete_logs():
    """Clear in-memory backend processing logs."""
    clear_logs()
    return {"status": "cleared"}

@app.get("/db-pairs")
def get_db_pairs():
    """
    คืนรายการ source_db / dest_db ที่มี mapping ใน DB
    Frontend ใช้เพื่อ populate dropdown แบบ dynamic
    """
    try:
        repo = MappingRepository()
        pairs = repo.get_available_db_pairs()
        return {"pairs": pairs}
    except Exception as e:
        logger.error(f"❌ Failed to fetch db pairs: {e}")
        raise HTTPException(500, "Failed to fetch DB pairs")

@app.post("/convert")
@limiter.limit("30/minute")
async def convert(
    request: Request,
    files: List[UploadFile] = File(...),
    source_db: str | None = Form(default=None),
    dest_db: str | None = Form(default=None),
    username: str | None = Form(default=None),
):
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"Too many files (max {MAX_FILES})")

    active_mapping = _load_mapping(source_db, dest_db)
    
    if username:
        logger.info(
            f"📥 Convert {len(files)} file(s) "
            f"[{source_db or 'default'} → {dest_db or 'default'}] "
            f"by username={username}"
        )
    else:
        logger.info(
            f"📥 Convert {len(files)} file(s) "
            f"[{source_db or 'default'} → {dest_db or 'default'}]"
        )

    tables: dict = {}
    unknown: dict = {}
    table_source: dict = {}
    duplicate_tables: dict = {}
    byte_anomalies: dict = {}

    for file in files:
        filename = file.filename
        logger.info(f"📄 Processing file: {filename}")
        try:
            raw = await file.read()
            if len(raw) > MAX_FILE_SIZE:
                raise HTTPException(400, f"{filename}: exceeds {MAX_FILE_SIZE_MB} MB limit")
            sql_text = _decode_sql_upload(raw, filename)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"❌ Error reading {filename}: {e}")
            raise HTTPException(400, f"Cannot read file: {filename}")

        parsed = parse_sql(sql_text)
        if not parsed:
            logger.warning(f"  ⚠️ No table found in: {filename}")
            continue

        parsed_by_table: dict = {}
        for row in parsed:
            parsed_by_table.setdefault(row["table"], []).append(row)

        for table, table_rows in parsed_by_table.items():
            is_duplicate = False
            if table in table_source:
                dup = duplicate_tables.setdefault(table, {
                    "first_file":      table_source[table],
                    "duplicate_files": [],
                })
                if filename not in dup["duplicate_files"]:
                    dup["duplicate_files"].append(filename)
                    logger.warning(
                        f"⚠️  Duplicate table '{table}' in '{filename}' "
                        f"(first defined in '{table_source[table]}')"
                    )
                is_duplicate = True
                table_key = f"{table}__{filename}"
            else:
                table_source[table] = filename
                table_key = table

            for row in table_rows:
                # ใช้ active_mapping ที่โหลดมาสดๆ ในการ convert
                res = converter.convert(row["type"], override_mapping=active_mapping)
                
                col_entry = {
                    "column_name":     row["column"],
                    "schema":          row.get("schema"),
                    "table_original":  row.get("table_original"),
                    "file":            filename,
                    "raw_type":        res.get("raw"),
                    "logical_type":    res.get("logical"),
                    "standard_type":   res.get("standard_type"),
                    "final_type":      res.get("final") if res.get("status") == "ok" else row["type"],
                    "source_sql_type": row["type"],
                    "nullable":        "NOT NULL" if row.get("nullable") == "NOT NULL" else "NULL",
                    "is_pk":           row.get("is_pk", False),
                    "fk":              row.get("fk"),
                    "is_duplicate":    is_duplicate,
                }
                tables.setdefault(table_key, []).append(col_entry)

                if res.get("status") != "ok":
                    unknown.setdefault(table_key, []).append({
                        "column_name": row["column"],
                        "type":        row["type"],
                        "file":        filename,
                    })
                
                # ตรวจสอบ byte anomalies (เช่น binary types)
                if res.get("byte_anomaly"):
                    byte_anomalies.setdefault(table_key, []).append({
                        "column_name": row["column"],
                        "source_type": row["type"],
                        "raw_type": res.get("raw"),
                        "logical_type": res.get("logical"),
                        "detail": res.get("byte_anomaly_detail"),
                        "file": filename,
                    })

    # Validate foreign keys
    fk_errors = validate_fk(tables)

    session_id = str(uuid.uuid4())
    result_cache[session_id] = {
        "tables":           tables,
        "unknown":          unknown,
        "fk_errors":        fk_errors,
        "byte_anomalies":   byte_anomalies,
        "duplicate_tables": duplicate_tables,
        "source_db":        source_db,
        "dest_db":          dest_db,
        "created_at":       datetime.now(),
    }

    logger.info(f"✅ Session {session_id} created — {len(tables)} table(s)")
    
    return {
        "session_id":       session_id,
        "file_count":       len(files),
        "source_db":        source_db,
        "dest_db":          dest_db,
        "tables":           tables,
        "unknown":          unknown,
        "fk_errors":        fk_errors,
        "byte_anomalies":   byte_anomalies,
        "duplicate_tables": duplicate_tables,
    }

@app.get("/result/{session_id}")
def get_result(session_id: str):
    return get_cached_data(session_id)

@app.post("/override/{session_id}")
def override(session_id: str, body: OverrideRequest):
    data = get_cached_data(session_id)
    table_cols = data["tables"].get(body.table)
    if table_cols is None:
        raise HTTPException(404, f"Table '{body.table}' not found")
    
    for col in table_cols:
        if col["column_name"] == body.column:
            col["final_type"] = body.new_type
            _prune_column_diagnostics(data, body.table, body.column)
            logger.info(f"✏️  Override {body.table}.{body.column} → {body.new_type}")
            return {"updated_column": col}
            
    raise HTTPException(404, f"Column '{body.column}' not found in table '{body.table}'")

@app.delete("/session/{session_id}")
def delete_session(session_id: str, username: str | None = Query(default=None)):
    # UUID validation centralised in get_cached_data; replicate here since
    # delete does not go through that helper.
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(400, "Invalid session ID format")
    if session_id in result_cache:
        del result_cache[session_id]
        if username:
            logger.info(f"🗑  Session {session_id} deleted by username={username}")
        else:
            logger.info(f"🗑  Session {session_id} deleted")
        return {"status": "deleted"}
    raise HTTPException(404, "Session not found")

# ── Export endpoints ──────────────────────────────────────
@app.get("/export/{session_id}/xlsx")
def export_all(session_id: str, tables: List[str] = Query(default=None)):
    data = get_cached_data(session_id)
    all_tables = data["tables"]
    selected = {k: v for k, v in all_tables.items() if tables is None or k in tables}
    byte_anomalies = {k: v for k, v in data.get("byte_anomalies", {}).items() if k in selected}
    
    file_names = sorted({col["file"] for cols in selected.values() for col in cols if col.get("file")})
    file_name = ", ".join(file_names) if file_names else None

    buf = export_confluent_xlsx(
        selected,
        byte_anomalies=byte_anomalies,
        source_db=data.get("source_db"),
        dest_db=data.get("dest_db"),
        file_name=file_name,
    )
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{_make_export_filename(list(selected.keys()), "xlsx")}"',
            "Content-Length": str(buf.getbuffer().nbytes),
        },
    )
def export_one(session_id: str, table_name: str):
    data = get_cached_data(session_id)
    columns = data["tables"].get(table_name)
    if columns is None:
        raise HTTPException(404, f"Table '{table_name}' not found")

    anomalies = data.get("byte_anomalies", {}).get(table_name)
    # Normalize: ensure anomalies is a list of dicts (guard against list of strings)
    if anomalies:
        anomalies = [a for a in anomalies if isinstance(a, dict)]

    file_names = sorted({col["file"] for col in columns if col.get("file")})
    file_name = ", ".join(file_names) if file_names else None

    buf = export_table_xlsx(
        columns,
        table_name,
        anomalies=anomalies,
        source_db=data.get("source_db"),
        dest_db=data.get("dest_db"),
        file_name=file_name,
    )
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{_make_export_filename([table_name], "xlsx")}"',
            "Content-Length": str(buf.getbuffer().nbytes),
        },
    )

@app.get("/export/{session_id}/csv")
def export_all_csv_endpoint(session_id: str, tables: List[str] = Query(default=None)):
    data = get_cached_data(session_id)
    all_tables = data["tables"]
    selected = {k: v for k, v in all_tables.items() if tables is None or k in tables}
    byte_anomalies = {k: v for k, v in data.get("byte_anomalies", {}).items() if k in selected}
    
    buf = export_all_csv(selected, byte_anomalies=byte_anomalies)
    return StreamingResponse(
        buf,
        media_type="text/csv; charset=utf-8-sig",
        headers={
            "Content-Disposition": f'attachment; filename="{_make_export_filename(list(selected.keys()), "csv")}"',
            "Content-Length": str(buf.getbuffer().nbytes),
        },
    )

@app.get("/export/{session_id}/csv/{table_name}")
def export_one_csv(session_id: str, table_name: str):
    data = get_cached_data(session_id)
    columns = data["tables"].get(table_name)
    if columns is None:
        raise HTTPException(404, f"Table '{table_name}' not found")
    
    anomalies = data.get("byte_anomalies", {}).get(table_name)
    buf = export_table_csv(columns, table_name, anomalies=anomalies)
    return StreamingResponse(
        buf,
        media_type="text/csv; charset=utf-8-sig",
        headers={
            "Content-Disposition": f'attachment; filename="{_make_export_filename([table_name], "csv")}"',
            "Content-Length": str(buf.getbuffer().nbytes),
        },
    )

# ── Maintenance Status ────────────────────────────────────
@app.get("/system/maintenance")
def get_maintenance():
    """BA_TOOL frontend เรียกเพื่อเช็ค maintenance state"""
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
        finally:
            release_connection(conn, "default")
    except Exception:
        enabled = False
        reason  = ""

    return {
        "success": True,
        "data": {
            "maintenance": enabled,
            "reason": reason,
        }
    }


@app.post("/system/maintenance/refresh")
def refresh_maintenance_cache():
    """
    Admin console เรียกหลังเปลี่ยน maintenance state เพื่อ force-invalidate cache ทันที
    ไม่ต้องรอ TTL หมด
    """
    try:
        from backend.middleware.maintenance_middleware import invalidate_maintenance_cache
        invalidate_maintenance_cache()
        logger.info("🔧 Maintenance cache invalidated by admin")
        return {"success": True, "message": "Cache invalidated"}
    except Exception as e:
        logger.error(f"❌ Failed to invalidate maintenance cache: {e}")
        raise HTTPException(500, "Failed to invalidate cache")