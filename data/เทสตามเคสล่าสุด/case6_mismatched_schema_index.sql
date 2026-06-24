-- เคส 6: Schema ไม่ตรงกันระหว่าง CREATE TABLE กับ CREATE INDEX ในไฟล์เดียวกัน
-- ทดสอบ: parser ต้อง handle ได้ทั้งสองแบบโดยไม่ panic หรือเอา schema ของ statement แรก
--         ไปปนกับ table ของ statement หลังผิดตัว
-- (บั๊กที่เคยพบ: false-positive "CREATE" match กับ column ชื่อ CreatedAt ต้องใช้ regex
--  pattern object ที่ compile แล้ว ไม่ใช่ plain string .find("CREATE") เทียบ)

CREATE TABLE "DNUCBBLU"."FIN_L202503" (
    RecordID varchar(36) NOT NULL,
    EmployeeID varchar(36) NOT NULL,
    Amount decimal(18,2) NULL,
    CreatedAt datetime NULL,  -- ชื่อ column มีคำว่า "Created" ปนอยู่ ต้องไม่ false-positive ว่าเป็น CREATE statement ใหม่
    CreatedBy varchar(36) NULL,

    PRIMARY KEY (RecordID)
);

-- index อ้าง table ชื่อ hrEmployee แต่ table จริงที่ประกาศไว้ข้างบนคือ "DNUCBBLU"."FIN_L202503"
-- (schema คนละตัว, table คนละชื่อ) -- ทดสอบว่า parser ไม่เผลอไปจับ index นี้ว่าเป็นของ FIN_L202503
CREATE INDEX idx_x ON hrEmployee(EmployeeID, CreatedAt);

-- ตัวแปร: index ที่มี schema ระบุ ต่างจาก schema ของ CREATE TABLE ด้านบน
CREATE INDEX idx_y ON "OTHERSCHEMA"."hrEmployee_Work" (CompanyID);

-- ตัวแปร: unique index พร้อม schema คนละชุดอีกแบบ
CREATE UNIQUE INDEX idx_z ON public.hrEmployee_Audit_Health (BiometricID);
