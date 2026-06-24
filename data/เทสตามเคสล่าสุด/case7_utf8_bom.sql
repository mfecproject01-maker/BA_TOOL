

CREATE TABLE hrEmployee_Personal (
    EmployeeID varchar(36) NOT NULL,
    EmployeeCode varchar(50) NOT NULL,
    FirstNameThai nvarchar(150) NULL,
    LastNameThai nvarchar(150) NULL,
    BirthDate date NULL,

    PRIMARY KEY (EmployeeID)
);

CREATE TABLE hrEmployee_Work (
    EmployeeID varchar(36) NOT NULL,
    CompanyID varchar(36) NULL,
    BasicSalary decimal(12,2) NULL,

    PRIMARY KEY (EmployeeID),
    FOREIGN KEY (EmployeeID) REFERENCES hrEmployee_Personal(EmployeeID)
);
