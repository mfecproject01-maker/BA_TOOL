-- เคส 1: SQL Server bracket identifier [schema].[table]
-- ทดสอบ: parser ต้องดึง schema = dbo, table = Employee
-- (ไม่ใช่ดึงทั้ง "[dbo].[Employee]" เป็น table name)

CREATE TABLE [dbo].[Employee] (
    [EmployeeID] varchar(36) NOT NULL,
    [EmployeeCode] nvarchar(50) NOT NULL,
    [FirstNameThai] nvarchar(150) NULL,
    [LastNameThai] nvarchar(150) NULL,
    [HireDate] datetime2(9) NULL,
    [IsActive] bit NOT NULL,

    PRIMARY KEY ([EmployeeID])
);

-- ตัวแปร: column ก็เป็น bracket ด้วย ต้องแยกชื่อ column ออกจาก [ ] ให้ถูก
CREATE TABLE [dbo].[hrEmployee_Work] (
    [EmployeeID] varchar(36) NOT NULL,
    [CompanyID] varchar(36) NULL,
    [BasicSalary] decimal(12,2) NULL,

    PRIMARY KEY ([EmployeeID]),
    FOREIGN KEY ([EmployeeID]) REFERENCES [dbo].[Employee]([EmployeeID])
);

-- ตัวแปร: ไม่มี schema bracket แค่ table bracket อย่างเดียว
CREATE TABLE [Department] (
    [DepartmentID] varchar(36) NOT NULL,
    [DepartmentName] nvarchar(150) NULL,

    PRIMARY KEY ([DepartmentID])
);
