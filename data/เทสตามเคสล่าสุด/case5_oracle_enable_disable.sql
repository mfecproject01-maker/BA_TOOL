-- เคส 5: Oracle ENABLE/DISABLE ต่อท้าย column constraint
-- ทดสอบ: parser ต้องตัด/ignore "ENABLE" หรือ "DISABLE" ที่ตามหลัง NOT NULL หรือ constraint อื่น
-- (ถ้า parser อ่าน "ENABLE" เป็นส่วนของ datatype หรือชื่อ column ถัดไปจะ parse พัง)

CREATE TABLE hrEmployee_Personal (
    EmployeeID VARCHAR2(36) NOT NULL ENABLE,
    EmployeeCode VARCHAR2(50) NOT NULL ENABLE,
    NationalID VARCHAR2(30) NULL,
    FirstNameThai NVARCHAR2(150) NOT NULL ENABLE,
    LastNameThai NVARCHAR2(150) NOT NULL ENABLE,
    BirthDate DATE NULL,

    CONSTRAINT pk_hrEmployee_Personal PRIMARY KEY (EmployeeID) ENABLE
);

-- ตัวแปร: DISABLE บน constraint ระดับ column
CREATE TABLE hrEmployee_Work (
    EmployeeID VARCHAR2(36) NOT NULL ENABLE,
    CompanyID VARCHAR2(36) NULL,
    BasicSalary NUMBER(12,2) NULL,
    IsActive NUMBER(1) DEFAULT 1 NOT NULL ENABLE,

    CONSTRAINT pk_hrEmployee_Work PRIMARY KEY (EmployeeID) ENABLE,
    CONSTRAINT fk_hrEmployee_Work_Personal FOREIGN KEY (EmployeeID)
        REFERENCES hrEmployee_Personal (EmployeeID) ENABLE NOVALIDATE
);

-- ตัวแปร: UNIQUE constraint ต่อท้ายด้วย DISABLE
CREATE TABLE hrEmployee_Audit_Health (
    EmployeeID VARCHAR2(36) NOT NULL ENABLE,
    BiometricID VARCHAR2(50) NULL,
    CONSTRAINT uq_biometric UNIQUE (BiometricID) DISABLE
);
