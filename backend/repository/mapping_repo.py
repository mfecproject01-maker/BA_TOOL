from backend.config.db import get_connection, release_connection


class MappingRepository:
    def __init__(self, db_name: str = "default"):
        """
        db_name: ชื่อ pool ที่ต้องการใช้ (ต้องตรงกับที่ init_db_pool() สร้างไว้)
        default = "default" ซึ่งตรงกับ DB_URL env var
        """
        self.db_name = db_name

    # Query หลัก: JOIN 3 ทาง
    #   datatype_raw_mapping  (source type → Avro raw/logical)
    #   datatype_standard     (standard type กลาง)
    #   datatype_mapping      (dest DB final type)
    #
    # ผลลัพธ์มี 2 final_type:
    #   standard_type  = Confluent/Avro standard (เหมือนกันทุก dest)
    #   dest_type      = SQL type จริงของ dest DB (ต่างกันตาม dest)
    _SELECT = """
        SELECT
            drm.source_type     AS sql_type,
            drm.raw_type,
            drm.logical_type,
            ds.standard_type,
            dm.final_type       AS dest_type,
            drm.db_id           AS source_db_id,
            dm.db_id            AS dest_db_id,
            dm.has_length,
            dm.has_precision,
            dm.has_scale
        FROM datatype_raw_mapping drm
        JOIN database_records src_dt     ON src_dt.id   = drm.db_id
        LEFT JOIN datatype_standard ds  ON ds.id = drm.standard_id
        LEFT JOIN datatype_mapping dm   ON dm.standard_id = drm.standard_id
        JOIN database_records dst_dt     ON dst_dt.id   = dm.db_id
    """

    def get_all(self, source_db: str = None) -> dict:
        """ดึง mapping ทั้งหมด (ใช้ standard_type เป็น final) — แนะนำให้ระบุ source_db เพื่อป้องกันข้อมูลปนกัน"""
        conn = get_connection(self.db_name)
        try:
            with conn.cursor() as cur:
                query = """
                    SELECT
                        drm.source_type  AS sql_type,
                        drm.raw_type,
                        drm.logical_type,
                        ds.standard_type AS final_type,
                        drm.db_id
                    FROM datatype_raw_mapping drm
                    JOIN database_records dt ON dt.id = drm.db_id
                    LEFT JOIN datatype_standard ds ON ds.id = drm.standard_id
                """
                params = []
                if source_db:
                    query += " WHERE LOWER(dt.key) = LOWER(%s)"
                    params.append(source_db)

                query += " ORDER BY drm.db_id, drm.id"
                cur.execute(query, tuple(params))
                rows = cur.fetchall()
            return self._rows_to_dict(rows)
        finally:
            release_connection(conn, self.db_name)

    def get_by_source_db(self, source_db: str) -> dict:
        """ดึง mapping เฉพาะ source DB — ใช้ standard_type เป็น final (ไม่มี dest)"""
        return self.get_all(source_db=source_db)

    def get_by_db_pair(self, source_db: str, dest_db: str) -> dict:
        """
        ดึง mapping สำหรับ source→dest DB pair
        final_type = dest SQL type จาก datatype_mapping (ต่างกันตาม dest DB)
        """
        conn = get_connection(self.db_name)
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        drm.source_type     AS sql_type,
                        drm.raw_type,
                        drm.logical_type,
                        ds.standard_type,
                        COALESCE(dm.final_type, ds.standard_type) AS dest_type,
                        COALESCE(dm.has_length,    false) AS has_length,
                        COALESCE(dm.has_precision, false) AS has_precision,
                        COALESCE(dm.has_scale,     false) AS has_scale
                    FROM datatype_raw_mapping drm
                    JOIN database_records src_dt
                        ON src_dt.id = drm.db_id
                       AND LOWER(src_dt.key) = LOWER(%s)
                    LEFT JOIN datatype_standard ds
                        ON ds.id = drm.standard_id
                    LEFT JOIN datatype_mapping dm
                        ON dm.standard_id = drm.standard_id
                       AND dm.db_id = (
                               SELECT id FROM database_records
                               WHERE LOWER(key) = LOWER(%s)
                           )
                    ORDER BY drm.id
                """, (source_db, dest_db))
                rows = cur.fetchall()

            if rows:
                return self._rows_to_dict_pair(rows)

            # fallback ถ้าไม่มี mapping pair ให้ใช้ mapping ของ source_db นั้นๆ
            return self.get_all(source_db=source_db)
        finally:
            release_connection(conn, self.db_name)

    def get_available_db_pairs(self) -> list[dict]:
        conn = get_connection(self.db_name)
        try:
            with conn.cursor() as cur:
                # Get all enabled databases
                cur.execute("""
                    SELECT DISTINCT key FROM database_records
                    WHERE enabled = true
                    ORDER BY key
                """)
                all_rows = cur.fetchall()

            sources = [r[0] for r in all_rows]
            all_dbs = sources

            return [
                {"source_db": src, "dest_db": dst}
                for src in sources
                for dst in all_dbs
                if src != dst
            ]
        finally:
            release_connection(conn, self.db_name)

    @staticmethod
    def _rows_to_dict(rows: list) -> dict:
        """
        สำหรับ get_all / get_by_source_db
        rows: (sql_type, raw_type, logical_type, final_type, db_id)
        final = standard_type (เหมือนกันทุก dest)
        """
        mapping = {}
        for row in rows:
            if len(row) < 5:
                continue
            sql_type, raw_type, logical_type, final_type, _db_id = row[:5]
            if sql_type is None:
                continue
            key = str(sql_type).lower().strip()
            if key not in mapping:
                mapping[key] = {
                    "raw":        raw_type,
                    "logical":    logical_type,
                    "final":      final_type,  # standard type
                    "dest_final": None,         # ไม่มี dest context
                }
        return mapping

    @staticmethod
    def _rows_to_dict_pair(rows: list) -> dict:
        """
        สำหรับ get_by_db_pair
        rows: (sql_type, raw_type, logical_type, standard_type, dest_type,
               has_length, has_precision, has_scale)
        final     = standard_type (Avro/Confluent)
        dest_final = dest SQL type จริง
        """
        mapping = {}
        for row in rows:
            if len(row) < 5:
                continue
            sql_type, raw_type, logical_type, standard_type, dest_type = row[:5]
            has_length = row[5] if len(row) > 5 else False
            has_precision = row[6] if len(row) > 6 else False
            has_scale = row[7] if len(row) > 7 else False

            if sql_type is None:
                continue
            key = str(sql_type).lower().strip()
            if key not in mapping:
                mapping[key] = {
                    "raw": raw_type,
                    "logical": logical_type,
                    "final": standard_type,
                    "dest_final": dest_type,
                    "has_length": has_length,
                    "has_precision": has_precision,
                    "has_scale": has_scale,
                }
        return mapping
