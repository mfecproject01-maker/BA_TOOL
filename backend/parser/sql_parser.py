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
    tables = []
    sql_text = _strip_sql_comments(sql_text)

    for table_name, body in _iter_create_table_blocks(sql_text):
        name_parts = _identifier_parts(table_name)
        schema_name = _unquote_identifier(name_parts[-2]) if len(name_parts) > 1 else None
        table_original = _unquote_identifier(name_parts[-1]) if name_parts else _unquote_identifier(table_name)
        clean_table_name = _clean_name(name_parts[-1] if name_parts else table_name)
        logger.debug(
            "CREATE TABLE matched: raw=%r schema=%r table=%r normalized_table=%r",
            table_name,
            schema_name,
            table_original,
            clean_table_name,
        )
        lines = _split_columns(body)

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

            tables.append({
                "table": clean_table_name,
                "schema":   schema_name,
                "table_original": table_original,
                "column":   column_name,
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

    return tables


def _iter_create_table_blocks(sql_text: str):
    for match in _TABLE_PATTERN.finditer(sql_text):
        table_name = match.group(1)
        open_idx = match.end() - 1
        depth = 0
        in_single = False
        in_double = False
        in_bracket = False
        in_backtick = False

        idx = open_idx
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

            if ch == "'":
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
                    yield table_name, sql_text[open_idx + 1:idx]
                    break
            idx += 1


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
