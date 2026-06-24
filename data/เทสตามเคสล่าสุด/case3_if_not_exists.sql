-- เคส 3: CREATE TABLE IF NOT EXISTS "schema"."table"
-- ทดสอบ: parser ต้อง skip "IF NOT EXISTS" แล้วยังดึง schema/table ได้ถูก
-- (ถ้า regex ไม่รองรับ optional "IF NOT EXISTS" จะ match table name ผิดเป็น "IF")

CREATE TABLE IF NOT EXISTS "X"."Y" (
    "EmployeeID" varchar(36) NOT NULL,
    "EmployeeCode" varchar(50) NOT NULL,
    "HireDate" timestamp NULL,
    "IsActive" boolean NOT NULL,

    PRIMARY KEY ("EmployeeID")
);

-- ตัวแปร: IF NOT EXISTS แบบไม่มี schema
CREATE TABLE IF NOT EXISTS "Department" (
    "DepartmentID" varchar(36) NOT NULL,
    "DepartmentName" varchar(150) NULL,

    PRIMARY KEY ("DepartmentID")
);

-- ตัวแปร: IF NOT EXISTS แบบ unquoted (PostgreSQL/MySQL style ไม่มี quote เลย)
CREATE TABLE IF NOT EXISTS public.section (
    SectionID varchar(36) NOT NULL,
    SectionName varchar(150) NULL,

    PRIMARY KEY (SectionID)
);
