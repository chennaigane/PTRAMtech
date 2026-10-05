// Dedicated MySQL schema: text JSON is retained so all existing API payloads and
// exports remain identical. InnoDB is required for atomic batches and GPS ACKs.
const suffix=' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
export const mysqlSchema=[
  `CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY,phone VARCHAR(32) NOT NULL UNIQUE,name VARCHAR(255) NOT NULL,role VARCHAR(32) NOT NULL,team VARCHAR(255),password_hash TEXT NOT NULL,status VARCHAR(32) NOT NULL,failed_attempts INT NOT NULL DEFAULT 0,locked_until BIGINT,created BIGINT NOT NULL,reviewed_by VARCHAR(64),reviewed_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64) NOT NULL,expires BIGINT NOT NULL,INDEX sessions_user(user_id),INDEX sessions_expires(expires))`,
  `CREATE TABLE IF NOT EXISTS records (id VARCHAR(64) PRIMARY KEY,owner VARCHAR(64) NOT NULL,kind VARCHAR(32) NOT NULL,data LONGTEXT NOT NULL,created BIGINT NOT NULL,INDEX records_owner_kind(owner,kind),INDEX records_owner_created(owner,created))`,
  'CREATE TABLE IF NOT EXISTS settings (`key` VARCHAR(191) PRIMARY KEY,value LONGTEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS workforce_profiles (employee VARCHAR(64) PRIMARY KEY,data LONGTEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workforce_entries (id VARCHAR(191) PRIMARY KEY,kind VARCHAR(32) NOT NULL,employee VARCHAR(64) NOT NULL,date VARCHAR(10) NOT NULL,data LONGTEXT NOT NULL,updated BIGINT NOT NULL,INDEX workforce_employee_date(employee,date,kind))`,
  `CREATE TABLE IF NOT EXISTS workforce_audit (id VARCHAR(64) PRIMARY KEY,actor VARCHAR(64) NOT NULL,action VARCHAR(100) NOT NULL,target VARCHAR(191) NOT NULL,details LONGTEXT NOT NULL,created BIGINT NOT NULL,INDEX workforce_audit_created(created))`,
  `CREATE TABLE IF NOT EXISTS workforce_locks (name VARCHAR(191) PRIMARY KEY,token VARCHAR(64) NOT NULL,expires BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mobile_trips (id VARCHAR(64) PRIMARY KEY,account VARCHAR(64) NOT NULL,started_at BIGINT NOT NULL,capture_until BIGINT NOT NULL,upload_until BIGINT NOT NULL,last_seq BIGINT NOT NULL DEFAULT 0,last_time BIGINT NOT NULL DEFAULT 0,last_elapsed BIGINT NOT NULL DEFAULT 0,request_id VARCHAR(64),session_hash VARCHAR(64),stopped_at BIGINT,UNIQUE INDEX mobile_request(account,request_id))`,
  `CREATE TABLE IF NOT EXISTS mobile_points (trip VARCHAR(64) NOT NULL,seq BIGINT NOT NULL,payload LONGTEXT NOT NULL,PRIMARY KEY(trip,seq))`,
  `CREATE TABLE IF NOT EXISTS mobile_sessions (token_hash VARCHAR(64) PRIMARY KEY,account VARCHAR(64) NOT NULL,expires BIGINT NOT NULL,INDEX mobile_session_expiry(expires))`,
  'CREATE TABLE IF NOT EXISTS mobile_limits (`key` VARCHAR(191) PRIMARY KEY,`window` BIGINT NOT NULL,count BIGINT NOT NULL)',
].map(sql=>sql+suffix);

export const mysqlBackfill=`INSERT INTO workforce_profiles(employee,data)
SELECT id,JSON_OBJECT('department',CASE WHEN team IN ('Marketing','Sales','Driver','Office Admin','Finance','HR') THEN team ELSE 'Other' END,
'other',CASE WHEN team IN ('Marketing','Sales','Driver','Office Admin','Finance','HR') THEN '' ELSE 'Unassigned' END,
'salary',NULL,'divisor',NULL,'otRate',NULL,'otMultiplier',NULL,'payrollAccess',JSON_EXTRACT('false','$'))
FROM users WHERE NOT EXISTS (SELECT 1 FROM workforce_profiles WHERE employee=users.id)`;
