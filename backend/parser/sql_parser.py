import re
import logging

logger = logging.getLogger(__name__)

# [FIX-Bug] เพิ่ม identity/generated เป็น stop keyword ใน type parsing
TYPE_STOP_KEYWORDS = {
    "default", "unique", "check", "references",
    "primary", "foreign", "constraint",
    "identity", "generated", "collate", "comment",
    "key", "index", "as", "auto_increment",
}

LINE_SKIP_KEYWORDS = {
    "primary", "foreign", "constraint", "unique", "check", "index", "key",
    "fulltext", "spatial", "like", "exclude", "period",
}

# [FIX-Bug] regex compile ครั้งเดียว ไม่ compile ในลูป
_IDENTIFIER = r'(?:\"(?:[^\"]|\"\")*\"|`[^`]*`|\[[^\]]+\]|[a-zA-Z_#@$][a-zA-Z0-9_#@$]*)'
_QUALIFIED_IDENTIFIER = rf"{_IDENTIFIER}(?:\s*\.\s*{_IDENTIFIER})*"
_TABLE_PATTERN = re.compile(
    rf"\bcreate\s+(?:or\s+replace\s+)?"
    rf"(?:(?:global|local|private)\s+temporary\s+|temporary\s+|temp\s+|unlogged\s+)?table\s+"
    rf"(?:if\s+not\s+exists\s+)?({_QUALIFIED_IDENTIFIER})\s*\(",
    re.IGNORECASE
)
_PAREN_CONTENT = re.compile(r"\(([^)]+)\)")
_PK_INLINE = re.compile(r"\bPRIMARY\s+KEY\b")
_NOT_NULL = re.compile(r"\bNOT\s+NULL\b")
_REFERENCES = re.compile(
    rf"\bREFERENCES\s+({_QUALIFIED_IDENTIFIER})\s*(?:\(([^)]*)\))?",
    re.IGNORECASE
)
_FK_LINE = re.compile(
    rf"\bFOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+({_QUALIFIED_IDENTIFIER})\s*(?:\(([^)]*)\))?",
    re.IGNORECASE
)

# [FIX-Bug] CREATE INDEX แยก parser ต่างหาก ไม่ปนกับ parse_sql เดิม
# รองรับ: UNIQUE, CLUSTERED/NONCLUSTERED (SQL Server), IF NOT EXISTS,
# schema-qualified index name, ON schema.table(col1, col2, ...)
_INDEX_PATTERN = re.compile(
    rf"\bcreate\s+(?:unique\s+)?(?:clustered\s+|nonclustered\s+)?index\s+"
    rf"(?:if\s+not\s+exists\s+)?({_QUALIFIED_IDENTIFIER})\s+"
    rf"on\s+({_QUALIFIED_IDENTIFIER})\s*\(([^)]*)\)",
    re.IGNORECASE
)


def _clean_name(s: str) -> str:
    """ลบ quote ทุกชนิด + backticks + lowercase"""
    return re.sub(r'[\"\'\[\]`]', '', s).strip().lower()




def _last_identifier_part(name: str) -> str:
    parts: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    in_bracket = False
    in_backtick = False

    for idx, ch in enumerate(name):
        next_ch = name[idx + 1] if idx + 1 < len(name) else ""
        if in_single:
            buf.append(ch)
            if ch == "'" and next_ch == "'":
                continue
            if ch == "'":
                in_single = False
            continue
        if in_double:
            buf.append(ch)
            if ch == '"' and next_ch == '"':
                continue
            if ch == '"':
                in_double = False
            continue
        if in_bracket:
            buf.append(ch)
            if ch == "]":
                in_bracket = False
            continue
        if in_backtick:
            buf.append(ch)
            if ch == "`":
                in_backtick = False
            continue

        if ch == "'":
            in_single = True
            buf.append(ch)
        elif ch == '"':
            in_double = True
            buf.append(ch)
        elif ch == "[":
            in_bracket = True
            buf.append(ch)
        elif ch == "`":
            in_backtick = True
            buf.append(ch)
        elif ch == ".":
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)

    if buf:
        parts.append("".join(buf).strip())
    return parts[-1] if parts else name


def _identifier_parts(name: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    in_bracket = False
    in_backtick = False

    for idx, ch in enumerate(name):
        next_ch = name[idx + 1] if idx + 1 < len(name) else ""
        if in_single:
            buf.append(ch)
            if ch == "'" and next_ch == "'":
                continue
            if ch == "'":
                in_single = False
            continue
        if in_double:
            buf.append(ch)
            if ch == '"' and next_ch == '"':
                continue
            if ch == '"':
                in_double = False
            continue
        if in_bracket:
            buf.append(ch)
            if ch == "]":
                in_bracket = False
            continue
        if in_backtick:
            buf.append(ch)
            if ch == "`":
                in_backtick = False
            continue

        if ch == "'":
            in_single = True
            buf.append(ch)
        elif ch == '"':
            in_double = True
            buf.append(ch)
        elif ch == "[":
            in_bracket = True
            buf.append(ch)
        elif ch == "`":
            in_backtick = True
            buf.append(ch)
        elif ch == ".":
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)

    if buf:
        parts.append("".join(buf).strip())
    return parts


def _unquote_identifier(identifier: str | None) -> str | None:
    if identifier is None:
        return None
    value = identifier.strip()
    if len(value) >= 2:
        pairs = {('"', '"'), ("'", "'"), ("`", "`"), ("[", "]")}
        if (value[0], value[-1]) in pairs:
            value = value[1:-1]
    return value.replace('""', '"').replace("''", "'").replace("``", "`")


def _consume_identifier(text: str, start: int = 0) -> tuple[str, int]:
    idx = start
    while idx < len(text) and text[idx].isspace():
        idx += 1
    if idx >= len(text):
        return "", idx

    opener = text[idx]
    if opener in ('"', "'", "`", "["):
        closer = "]" if opener == "[" else opener
        buf = [opener]
        idx += 1
        while idx < len(text):
            ch = text[idx]
            next_ch = text[idx + 1] if idx + 1 < len(text) else ""
            buf.append(ch)
            if ch == closer:
                if closer in ('"', "'") and next_ch == closer:
                    buf.append(next_ch)
                    idx += 2
                    continue
                idx += 1
                break
            idx += 1
        return "".join(buf), idx

    end_chars = set(" \t\r\n,()")
    begin = idx
    while idx < len(text) and text[idx] not in end_chars:
        idx += 1
    return text[begin:idx], idx


def _split_first_identifier(line: str) -> tuple[str, str]:
    identifier, end_idx = _consume_identifier(line)
    return identifier, line[end_idx:].strip()


def _clean_column_ref(column_ref: str) -> str:
    identifier, _ = _consume_identifier(column_ref.strip())
    return _clean_name(identifier or column_ref)


def _parse_column_list(column_list: str) -> list[str]:
    return [
        _clean_column_ref(item)
        for item in _split_columns(column_list)
        if _clean_column_ref(item)
    ]


def _split_sql_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    in_bracket = False
    in_backtick = False

    idx = 0
    while idx < len(text):
        ch = text[idx]
        next_ch = text[idx + 1] if idx + 1 < len(text) else ""

        if in_single:
            buf.append(ch)
            if ch == "'" and next_ch == "'":
                buf.append(next_ch)
                idx += 2
                continue
            if ch == "'":
                in_single = False
            idx += 1
            continue
        if in_double:
            buf.append(ch)
            if ch == '"' and next_ch == '"':
                buf.append(next_ch)
                idx += 2
                continue
            if ch == '"':
                in_double = False
            idx += 1
            continue
        if in_bracket:
            buf.append(ch)
            if ch == "]":
                in_bracket = False
            idx += 1
            continue
        if in_backtick:
            buf.append(ch)
            if ch == "`":
                in_backtick = False
            idx += 1
            continue

        if ch.isspace():
            if buf:
                tokens.append("".join(buf))
                buf = []
        elif ch == "'":
            in_single = True
            buf.append(ch)
        elif ch == '"':
            in_double = True
            buf.append(ch)
        elif ch == "[":
            in_bracket = True
            buf.append(ch)
        elif ch == "`":
            in_backtick = True
            buf.append(ch)
        else:
            buf.append(ch)
        idx += 1

    if buf:
        tokens.append("".join(buf))
    return tokens


def parse_sql(sql_text: str) -> list[dict]:
    """
    คงพฤติกรรมเดิมไว้ทุกประการสำหรับ caller เดิม (เช่น main.py /convert)
    — คืนแค่ list[dict] ของ column เหมือนก่อนหน้านี้เสมอ
    ถ้าต้องการรู้ด้วยว่ามี table ไหนวงเล็บไม่ปิด ให้ใช้ parse_sql_with_errors() แทน
    """
    tables, _errors = parse_sql_with_errors(sql_text)
    return tables


def parse_sql_with_errors(sql_text: str) -> tuple[list[dict], list[dict]]:
    """
    เหมือน parse_sql() ทุกอย่าง แต่คืน parse_errors เพิ่มมาด้วย
    เป็น tuple (tables, parse_errors)

    parse_errors แต่ละตัวมี:
      {
        "table": str,            # ชื่อ table (clean) ที่มีปัญหา
        "schema": str | None,
        "error": "UNBALANCED_PARENTHESES",
        "message": str,          # ข้อความอธิบายเป็นภาษาไทย
      }

    เมื่อ table ใดถูก mark ว่า truncated (วงเล็บไม่ปิดครบ) จะ "ไม่"
    เพิ่ม column ของ table นั้นเข้าไปใน `tables` เลย เพื่อไม่ให้ข้อมูลที่
    ไม่น่าเชื่อถือหลุดไปแสดงผลรวมกับ table อื่นที่ปกติ — ผู้ใช้ต้องกด
    แก้ไขและ parse ใหม่เท่านั้น
    """
    tables = []
    parse_errors: list[dict] = []
    sql_text = _strip_sql_comments(sql_text)

    for table_name, body, is_truncated, table_start in _iter_create_table_blocks(sql_text):
        name_parts = _identifier_parts(table_name)
        schema_name = _unquote_identifier(name_parts[-2]) if len(name_parts) > 1 else None
        table_original = _unquote_identifier(name_parts[-1]) if name_parts else _unquote_identifier(table_name)
        clean_table_name = _clean_name(name_parts[-1] if name_parts else table_name)

        if is_truncated:
            logger.warning(
                "CREATE TABLE มีวงเล็บไม่ปิดครบ: table=%r schema=%r",
                clean_table_name, schema_name,
            )
            # compute line/column from table_start
            line_no = sql_text.count("\n", 0, table_start) + 1
            parse_errors.append({
                "severity": "error",
                "line": line_no,
                "column": 1,
                "message": (
                    f"ตาราง '{clean_table_name}' วงเล็บของ CREATE TABLE ไม่ปิดให้ครบ "
                    f"(ไฟล์อาจถูกตัดตอนหรือ export มาไม่สมบูรณ์) — กรุณาแก้ไข SQL แล้ว parse ใหม่"
                ),
                "code": "UNBALANCED_PARENTHESES",
                "suggestion": None,
            })
            continue  # ไม่ parse column ของ table ที่วงเล็บไม่ครบ

        logger.debug(
            "CREATE TABLE matched: raw=%r schema=%r table=%r normalized_table=%r",
            table_name,
            schema_name,
            table_original,
            clean_table_name,
        )
        lines = _split_columns(body)
        # track position within body for line offsets
        body_search_pos = 0

        # ── Pass 1: scan table-level PK / FK constraints ──────
        pk_cols: set[str] = set()
        fk_map: dict[str, dict] = {}

        for line in lines:
            line_s = line.strip()
            upper  = line_s.upper()

            # PRIMARY KEY (col1, col2, ...)
            if re.search(r"\bPRIMARY\s+KEY\b", upper):
                m = _PAREN_CONTENT.search(line_s)
                if m:
                    for c in _parse_column_list(m.group(1)):
                        pk_cols.add(c)

            # FOREIGN KEY (col) REFERENCES tbl(col)
            fk_m = _FK_LINE.search(line_s)
            if fk_m:
                ref_table = _clean_name(_last_identifier_part(fk_m.group(2)))
                ref_cols = _parse_column_list(fk_m.group(3)) if fk_m.group(3) else []
                for idx, fk_col in enumerate(_parse_column_list(fk_m.group(1))):
                    ref_col = ref_cols[idx] if idx < len(ref_cols) else None
                    fk_map[fk_col] = {"ref_table": ref_table, "ref_column": ref_col}

        # ── Pass 2: parse columns ──────────────────────────────
        for line in lines:
            line = line.strip()
            if not line:
                continue

            column_identifier, column_rest = _split_first_identifier(line)
            if not column_identifier or not column_rest:
                continue

            first_word = _clean_name(column_identifier).rstrip(",")
            if first_word in LINE_SKIP_KEYWORDS:
                continue

            parts = _split_sql_tokens(column_rest)
            if not parts:
                continue

            column_name = _clean_name(column_identifier)

            # ── parse type ──────────────────────────────────────
            type_tokens: list[str] = []
            type_end_idx: int = 0
            paren_depth: int = 0

            for token in parts:
                paren_depth += token.count("(") - token.count(")")
                clean_token = token.lower().rstrip(",") if paren_depth == 0 else token.lower()
                clean_token_base = clean_token.split("(", 1)[0]

                if paren_depth == 0:
                    if clean_token in ("not", "null"):
                        break
                    if clean_token in TYPE_STOP_KEYWORDS or clean_token_base in TYPE_STOP_KEYWORDS:
                        break

                type_tokens.append(token)
                type_end_idx += 1

            if not type_tokens:
                continue

            sql_type = " ".join(type_tokens).rstrip(",").strip()

            # ── parse nullable ──────────────────────────────────
            remaining_tokens = [t.rstrip(",") for t in parts[type_end_idx:]]
            remaining_clean = _strip_collate(remaining_tokens).upper()

            nullable = (
                "NOT NULL"
                if _NOT_NULL.search(remaining_clean) or column_name in pk_cols or _PK_INLINE.search(remaining_clean)
                else "NULL"
            )

            # ── inline PRIMARY KEY ──────────────────────────────
            if _PK_INLINE.search(remaining_clean):
                pk_cols.add(column_name)

            # ── inline REFERENCES ───────────────────────────────
            ref_m = _REFERENCES.search(line)
            if ref_m and column_name not in fk_map:
                ref_table = _clean_name(_last_identifier_part(ref_m.group(1)))
                ref_cols = _parse_column_list(ref_m.group(2)) if ref_m.group(2) else []
                ref_col = ref_cols[0] if ref_cols else None
                fk_map[column_name] = {"ref_table": ref_table, "ref_column": ref_col}

            # determine line/column within original sql_text for this column definition
            rel_offset = body.find(line, body_search_pos)
            if rel_offset == -1:
                rel_offset = body_search_pos
            abs_index = table_start + rel_offset
            col_line_no = sql_text.count("\n", 0, abs_index) + 1
            # column position = chars after last newline
            last_nl = sql_text.rfind("\n", 0, abs_index)
            col_column = abs_index - (last_nl + 1) if last_nl != -1 else abs_index + 1
            body_search_pos = rel_offset + len(line)

            tables.append({
                "table": clean_table_name,
                "schema":   schema_name,
                "table_original": table_original,
                "column":   column_name,
                "line":     col_line_no,
                "column_pos": col_column,
                "type":     sql_type,
                "nullable": nullable,
                "is_pk":    column_name in pk_cols,
                "fk":       fk_map.get(column_name),
            })

    logger.debug("parsed rows:")
    for t in tables:
        pk = " PK" if t["is_pk"] else ""
        fk = (f" FK->{t['fk']['ref_table']}.{t['fk']['ref_column'] or '?'}"
              if t["fk"] else "")
        logger.debug(f"  {t['table']}.{t['column']} -> {t['type']} | {t['nullable']}{pk}{fk}")

    return tables, parse_errors


def parse_indexes(sql_text: str) -> list[dict]:
    """
    Parse CREATE INDEX statements แยกจาก parse_sql() โดยสิ้นเชิง
    ไม่ผูกกับ schema/table ที่ parse_sql() เจอ เพราะ CREATE INDEX
    อาจระบุ schema ไม่ตรงกับ CREATE TABLE ในไฟล์เดียวกัน (เช่น
    table มี schema แต่ index ไม่ใส่ schema) — เก็บตามที่ระบุไว้จริง
    โดยไม่พยายามเดาหรือจับคู่ schema ให้ตรงกัน

    คืนค่า list ของ dict:
      {
        "index_name": str,
        "schema": str | None,   # schema ของ "index" เอง ถ้ามีระบุ
        "table": str,           # ชื่อ table แบบ clean (lowercase, ไม่มี quote)
        "table_schema": str | None,  # schema ของ table ที่ระบุใน ON clause
        "columns": list[str],
      }
    """
    indexes: list[dict] = []
    clean_sql = _strip_sql_comments(sql_text)

    for match in _INDEX_PATTERN.finditer(clean_sql):
        raw_index_name, raw_table_name, raw_columns = match.groups()

        index_parts = _identifier_parts(raw_index_name)
        index_schema = _unquote_identifier(index_parts[-2]) if len(index_parts) > 1 else None
        index_name = _clean_name(index_parts[-1] if index_parts else raw_index_name)

        table_parts = _identifier_parts(raw_table_name)
        table_schema = _unquote_identifier(table_parts[-2]) if len(table_parts) > 1 else None
        table_name = _clean_name(table_parts[-1] if table_parts else raw_table_name)

        columns = _parse_column_list(raw_columns)

        logger.debug(
            "CREATE INDEX matched: index=%r (schema=%r) on table=%r (schema=%r) columns=%r",
            index_name, index_schema, table_name, table_schema, columns,
        )

        indexes.append({
            "index_name": index_name,
            "schema": index_schema,
            "table": table_name,
            "table_schema": table_schema,
            "columns": columns,
        })

    return indexes


def _iter_create_table_blocks(sql_text: str):
    """
    Yields (table_name, body, is_truncated).

    is_truncated=True หมายถึงวงเล็บของ CREATE TABLE นี้ไม่ปิดให้ครบ
    (เช่น EOF มาก่อน หรือเจอ CREATE TABLE/CREATE INDEX ตัวถัดไปทั้งที่
    depth ยังไม่กลับเป็น 0) — ในกรณีนี้ body ที่คืนมาคือเนื้อหาทั้งหมด
    เท่าที่อ่านได้ก่อนจะเจอจุดตัด ไม่ใช่ body ที่ถูกต้องสมบูรณ์ ผู้เรียก
    ต้องไม่ถือว่า column ที่ parse ได้จาก body นี้น่าเชื่อถือเต็มที่
    """
    for match in _TABLE_PATTERN.finditer(sql_text):
        table_name = match.group(1)
        open_idx = match.end() - 1
        depth = 0
        in_single = False
        in_double = False
        in_bracket = False
        in_backtick = False

        idx = open_idx
        closed = False
        while idx < len(sql_text):
            ch = sql_text[idx]
            next_ch = sql_text[idx + 1] if idx + 1 < len(sql_text) else ""

            if in_single:
                if ch == "'" and next_ch == "'":
                    idx += 2
                    continue
                if ch == "'":
                    in_single = False
                idx += 1
                continue
            if in_double:
                if ch == '"' and next_ch == '"':
                    idx += 2
                    continue
                if ch == '"':
                    in_double = False
                idx += 1
                continue
            if in_bracket:
                if ch == "]":
                    in_bracket = False
                idx += 1
                continue
            if in_backtick:
                if ch == "`":
                    in_backtick = False
                idx += 1
                continue

            # [FIX-Bug] ป้องกัน body ที่วงเล็บไม่ปิดกินไปถึง statement ถัดไป
            # ถ้า depth ยังไม่กลับเป็น 0 แล้วเจอ CREATE TABLE/INDEX ตัวใหม่จริงๆ
            # (เช็คด้วย _TABLE_PATTERN / _INDEX_PATTERN ตรงตำแหน่งนี้ ไม่ใช่แค่
            # substring "create" เฉยๆ เพราะอาจไปชนกับชื่อคอลัมน์เช่น "CreatedAt"
            # หรือ "create_date" ที่ไม่ใช่ statement จริง)
            if depth > 0 and ch in "Cc" and sql_text[idx:idx + 6].lower() == "create":
                boundary_ok = (idx == 0 or sql_text[idx - 1] in " \t\r\n;(,")
                if boundary_ok and (
                    _TABLE_PATTERN.match(sql_text, idx)
                    or _INDEX_PATTERN.match(sql_text, idx)
                ):
                    break
            elif ch == "'":
                in_single = True
            elif ch == '"':
                in_double = True
            elif ch == "[":
                in_bracket = True
            elif ch == "`":
                in_backtick = True
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    yield table_name, sql_text[open_idx + 1:idx], False, open_idx + 1
                    closed = True
                    break
            idx += 1

        if not closed and idx >= len(sql_text):
            # เจอ EOF ก่อนวงเล็บปิดครบ — body คือทั้งหมดที่เหลือ
            yield table_name, sql_text[open_idx + 1:idx], True, open_idx + 1
        elif not closed:
            # ตัดจบเพราะเจอ CREATE ตัวใหม่ทั้งที่ depth ยังไม่ครบ
            yield table_name, sql_text[open_idx + 1:idx], True, open_idx + 1


def validate_fk(tables: dict[str, list[dict]]) -> list:
    """
    ตรวจสอบ FK references
    tables: dict[table_name, list[col_dict]]
    col_dict รองรับ 2 รูปแบบ:
      - parse_sql output: key "column"
      - session tables (main.py): key "column_name"
    ทั้งสองกรณีใช้ col.get("column_name") or col.get("column")
    """
    errors = []
    for table_name, columns in tables.items():
        for col in columns:
            fk = col.get("fk")
            if not fk:
                continue

            # ─── handle ทั้ง str และ dict ───
            if isinstance(fk, str):
                parts = fk.split(".")
                ref_table = parts[0].strip()
                ref_col   = parts[1].strip() if len(parts) > 1 else None
            elif isinstance(fk, dict):
                ref_table = fk.get("ref_table")
                ref_col   = fk.get("ref_column")
            else:
                continue

            col_name = col.get("column_name") or col.get("column")

            if ref_table and ref_table not in tables:
                errors.append({
                    "table":     table_name,
                    "column":    col_name,
                    "ref_table": ref_table,
                    "ref_col":   ref_col,
                    "error":     f"Referenced table '{ref_table}' not found",
                })
                continue

            if ref_table and ref_col:
                ref_columns = {
                    ref.get("column_name") or ref.get("column")
                    for ref in tables.get(ref_table, [])
                }
                if ref_col not in ref_columns:
                    errors.append({
                        "table":     table_name,
                        "column":    col_name,
                        "ref_table": ref_table,
                        "ref_col":   ref_col,
                        "error":     f"Referenced column '{ref_table}.{ref_col}' not found",
                    })
    return errors

def _strip_collate(tokens: list[str]) -> str:
    result: list[str] = []
    skip_next: bool = False
    for token in tokens:
        clean = token.lower().rstrip(",")
        if skip_next:
            skip_next = False
            continue
        if clean == "collate":
            skip_next = True
            continue
        result.append(token)
    return " ".join(result)


def _strip_sql_comments(sql_text: str) -> str:
    result: list[str] = []
    in_single = False
    in_double = False
    in_bracket = False
    in_backtick = False

    idx = 0
    while idx < len(sql_text):
        ch = sql_text[idx]
        next_ch = sql_text[idx + 1] if idx + 1 < len(sql_text) else ""

        if in_single:
            result.append(ch)
            if ch == "'" and next_ch == "'":
                result.append(next_ch)
                idx += 2
                continue
            if ch == "'":
                in_single = False
            idx += 1
            continue
        if in_double:
            result.append(ch)
            if ch == '"' and next_ch == '"':
                result.append(next_ch)
                idx += 2
                continue
            if ch == '"':
                in_double = False
            idx += 1
            continue
        if in_bracket:
            result.append(ch)
            if ch == "]":
                in_bracket = False
            idx += 1
            continue
        if in_backtick:
            result.append(ch)
            if ch == "`":
                in_backtick = False
            idx += 1
            continue

        if ch == "'":
            in_single = True
            result.append(ch)
            idx += 1
        elif ch == '"':
            in_double = True
            result.append(ch)
            idx += 1
        elif ch == "[":
            in_bracket = True
            result.append(ch)
            idx += 1
        elif ch == "`":
            in_backtick = True
            result.append(ch)
            idx += 1
        elif ch == "/" and next_ch == "*":
            idx += 2
            while idx < len(sql_text) - 1 and sql_text[idx:idx + 2] != "*/":
                if sql_text[idx] in "\r\n":
                    result.append(sql_text[idx])
                idx += 1
            idx += 2
        elif ch == "-" and next_ch == "--":
            idx += 2
            while idx < len(sql_text) and sql_text[idx] not in "\r\n":
                idx += 1
        elif ch == "#":
            idx += 1
            while idx < len(sql_text) and sql_text[idx] not in "\r\n":
                idx += 1
        else:
            result.append(ch)
            idx += 1

    return "".join(result)


def _split_columns(body: str) -> list[str]:
    """แยก column definitions ด้วย comma โดยไม่สนใจ comma ใน parenthesis"""
    parts: list[str] = []
    depth: int       = 0
    buf:   list[str] = []
    in_single: bool  = False
    in_double: bool  = False

    idx = 0
    while idx < len(body):
        ch = body[idx]
        next_ch = body[idx + 1] if idx + 1 < len(body) else ""

        if in_single:
            buf.append(ch)
            if ch == "'" and next_ch == "'":
                buf.append(next_ch)
                idx += 2
                continue
            if ch == "'":
                in_single = False
            idx += 1
            continue
        if in_double:
            buf.append(ch)
            if ch == '"' and next_ch == '"':
                buf.append(next_ch)
                idx += 2
                continue
            if ch == '"':
                in_double = False
            idx += 1
            continue

        if ch == "'":
            in_single = True
            buf.append(ch)
        elif ch == '"':
            in_double = True
            buf.append(ch)
        elif ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
        idx += 1

    if buf:
        parts.append("".join(buf).strip())
    return parts


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    sql = """
    CREATE TABLE users (
        id         INT NOT NULL PRIMARY KEY,
        email      VARCHAR(100) NOT NULL UNIQUE,
        name       VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE orders (
        order_id   BIGINT NOT NULL,
        user_id    INT NOT NULL REFERENCES users(id),
        note       TEXT NULL,
        PRIMARY KEY (order_id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE order_items (
        item_id    INT NOT NULL,
        order_id   BIGINT NOT NULL,
        product_id INT NOT NULL REFERENCES products(id),
        PRIMARY KEY (item_id),
        CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(order_id)
    );
    """
    rows = parse_sql(sql)
    errors = validate_fk(rows)
    print("\n[FK VALIDATION]")
    if not errors:
        print("  OK — no issues")
    for e in errors:
        print(f"  [ERR] {e['table']}.{e['column']} -> {e['ref_table']}.{e.get('ref_col') or '?'} - {e['error']}")