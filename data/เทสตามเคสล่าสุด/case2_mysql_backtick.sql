-- เคส 2: MySQL backtick identifier `db`.`table`
-- ทดสอบ: parser ต้องดึง schema = mydb, table = employee
-- (backtick ต่างจาก bracket [] และต่างจาก double-quote "")

CREATE TABLE `mydb`.`employee` (
    `EmployeeID` varchar(36) NOT NULL,
    `EmployeeCode` varchar(50) NOT NULL,
    `FirstNameThai` varchar(150) NULL,
    `LastNameThai` varchar(150) NULL,
    `HireDate` datetime NULL,
    `IsActive` tinyint(1) NOT NULL,

    PRIMARY KEY (`EmployeeID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ตัวแปร: column ที่ชื่อเป็น reserved word ต้อง escape ด้วย backtick
CREATE TABLE `mydb`.`order` (
    `OrderID` varchar(36) NOT NULL,
    `Group` varchar(50) NULL,
    `Status` varchar(20) NULL,

    PRIMARY KEY (`OrderID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ตัวแปร: ไม่มี schema backtick แค่ table backtick อย่างเดียว
CREATE TABLE `department` (
    `DepartmentID` varchar(36) NOT NULL,
    `DepartmentName` varchar(150) NULL,

    PRIMARY KEY (`DepartmentID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
