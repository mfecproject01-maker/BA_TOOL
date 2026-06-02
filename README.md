# BA_TOOL — SQL to Confluent AVRO Mapping Tool

เครื่องมือสำหรับ Business Analyst ในการแปลง SQL Schema (CREATE TABLE) จากหลาย database engine ให้เป็น Confluent AVRO mapping พร้อม export เป็น Excel/CSV

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | JS / HTML / CSS — deploy บน **Vercel** |
| Backend | Python 3.13 · **FastAPI** · Uvicorn — deploy บน **Render** |
| Database | **PostgreSQL** |
| CI/CD | GitHub Actions |

---

## โครงสร้างโปรเจค

```
BA_TOOL_For_multiple_DB/
├── frontend/
│   ├── index.html          # หน้าหลัก
│   ├── script.js           # logic หลัก: upload, convert, override, export
│   ├── presence-user.js    # WebSocket tracker
│   └── style.css
│
├── backend/
│   ├── api/
│   │   └── main.py         # FastAPI app, endpoints ทั้งหมด
│   ├── config/
│   │   ├── db.py           # PostgreSQL connection pool
│   │   ├── logger.py       # in-memory log buffer
│   │   └── database_support_matrix.json
│   ├── core/
│   │   ├── converter.py    # แปลง SQL type → AVRO raw/logical/final type
│   │   └── cache_store.py  # in-memory session cache
│   ├── middleware/
│   │   └── maintenance_middleware.py
│   ├── parser/
│   │   └── sql_parser.py   # parse CREATE TABLE statement
│   ├── repository/
│   │   └── mapping_repo.py # query mapping จาก PostgreSQL
│   └── exporter/
│       └── excel_exporter.py
│
├── data/                   # SQL ตัวอย่างสำหรับทดสอบ
├── tests/
├── .env.example
├── render.yaml
├── vercel.json
└── requirements.txt
```

---

## การติดตั้ง (Local Development)

### 1. Clone และติดตั้ง dependencies

```bash
git clone https://github.com/csongph/BA_TOOL_For_multiple_DB.git
cd BA_TOOL_For_multiple_DB
pip install -r requirements.txt
```

### 2. ตั้งค่า Environment Variables

```bash
cp .env.example .env
```

### 3. รัน Backend

```bash
uvicorn backend.api.main:app --reload --port 8000
```

### 4. เปิด Frontend

เปิด `frontend/index.html` ผ่าน Live Server (VS Code) ที่ port 5500

---

## API Endpoints

### Core

| Method | Endpoint | คำอธิบาย |
|--------|----------|----------|
| `GET` | `/health` | ตรวจสอบสถานะ backend และ DB |
| `GET` | `/db-pairs` | ดึงรายการ source/dest DB ที่มี mapping |
| `GET` | `/database-support` | ดึง database compatibility matrix |
| `POST` | `/convert` | อัปโหลด SQL file และแปลง type mapping |
| `GET` | `/result/{session_id}` | ดึงผลลัพธ์ตาม session |
| `POST` | `/override/{session_id}` | override type ของ column ที่ระบุ |
| `DELETE` | `/session/{session_id}` | ลบ session |

### Export

| Method | Endpoint | คำอธิบาย |
|--------|----------|----------|
| `GET` | `/export/{session_id}/xlsx` | export ทุกตารางเป็น Excel |
| `GET` | `/export/{session_id}/xlsx/{table_name}` | export ตารางเดียวเป็น Excel |
| `GET` | `/export/{session_id}/csv` | export ทุกตารางเป็น CSV |
| `GET` | `/export/{session_id}/csv/{table_name}` | export ตารางเดียวเป็น CSV |

---

## Deployment

### Backend → Render

1. Push code ขึ้น GitHub
2. สร้าง Web Service ใน Render เลือก repo นี้
3. ตั้งค่า environment variables ใน Render dashboard:

| Key | Value |
|-----|-------|
| `DB_URL` | PostgreSQL connection string |
| `VERCEL_ORIGIN` | URL ของ frontend Vercel |
| `ADMIN_ORIGIN` | URL ของ admin console Vercel |
| `DB_POOL_MIN` | `2` |
| `DB_POOL_MAX` | `10` |

### Frontend → Vercel (ผ่าน GitHub Actions)

1. สร้าง Vercel project เชื่อมกับ repo
2. เพิ่ม secret ใน GitHub: `VERCEL_TOKEN`
3. เพิ่ม variable ใน GitHub Actions: `API_BASE` = URL ของ Render backend
4. Push ไปที่ branch `main` → deploy production อัตโนมัติ

ดูรายละเอียดเพิ่มเติมใน [DEPLOY.md](./DEPLOY.md)

---

## Features & Integrations (ระบบที่เพิ่มเติมเข้ามา)

### 1. ระบบข้อมูลระบุตัวตนและบันทึกประวัติผู้ใช้งาน (Username Logging & Attribution)
- วิดเจ็ต **User Profile** ดีไซน์ Glassmorphic ในแถบ Topbar สำหรับระบุตัวตนของผู้ส่งงานแปลงไฟล์
- แนบข้อมูล `username` ในรูปแบบ Form Data ไปกับการแปลงไฟล์ (`POST /convert`) และลบเซสชัน (`DELETE /session/{session_id}`)
- ระบบ Backend (`logger.py`) ดึงข้อมูลผู้ใช้จาก Log output ด้วย regex และจัดเก็บใน JSON buffer เพื่อให้ Admin Console ดึงไปเก็บลงฐานข้อมูลล็อกระบบหลัก

### 2. ระบบติดตามผู้ใช้งานออนไลน์แบบ Real-time (Active Presence Tracking)
- ฝัง WebSocket (`presence-user.js`) เพื่อเชื่อมต่อไปยังระบบ Presence Server ของ Admin Console Backend
- รายงานสถานะผู้ใช้ออนไลน์ หน้าเว็บที่ทำงานอยู่ (Page) และเวลาเชื่อมต่อให้ระบบกลางรับทราบแบบ Real-time
- ปรับปรุงและอัปเดตชื่อผู้ใช้ออนไลน์บน Dashboard ทันทีเมื่อมีการพิมพ์แก้ไขชื่อบน Topbar

---

## Database Support

รองรับ source database:
- Microsoft SQL Server
- MySQL
- PostgreSQL
- Oracle

---

## Rate Limiting

endpoint `/convert` จำกัด **30 requests/minute** ต่อ IP

---

## Session

- ผลลัพธ์การ convert เก็บใน in-memory session cache
- Session หมดอายุหลัง **1 ชั่วโมง**
- Cleanup loop ทำงานทุก 5 นาที

---

*MFEC Internship Project*
