-- เคส 4: ไม่มี schema เลย (unqualified table name)
-- ทดสอบ: parser ต้อง handle กรณีไม่มี "schema." นำหน้า table name
-- (ถ้า regex บังคับว่าต้องมี schema.table จะ parse ไฟล์นี้ไม่ออกเลย)

CREATE TABLE Employee (
    EmployeeID varchar(36) NOT NULL,
    EmployeeCode varchar(50) NOT NULL,
    FirstNameThai nvarchar(150) NULL,
    LastNameThai nvarchar(150) NULL,
    HireDate datetime NULL,
    IsActive bit NOT NULL,

    PRIMARY KEY (EmployeeID)
);

-- ตัวแปร: unqualified + FK อ้างอิง unqualified table อีกตัว
CREATE TABLE hrEmployee_Work (
    EmployeeID varchar(36) NOT NULL,
    CompanyID varchar(36) NULL,
    BasicSalary decimal(12,2) NULL,

    PRIMARY KEY (EmployeeID),
    FOREIGN KEY (EmployeeID) REFERENCES Employee(EmployeeID)
);

-- ตัวแปร: unqualified + ชื่อ table มี underscore/เลขปนกัน
CREATE TABLE hr_dept_2024 (
    DeptID varchar(36) NOT NULL,
    DeptName nvarchar(150) NULL,

    PRIMARY KEY (DeptID)
);
