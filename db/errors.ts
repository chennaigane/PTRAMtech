export class DatabaseSetupError extends Error {}
export class DatabaseUnavailableError extends Error {}

// Never serialize driver errors: messages, SQL, stacks and causes can contain
// credentials or account data. Only known diagnostic codes leave this boundary.
const diagnosticCodes=new Set([
  'ENOENT','EACCES','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST','ER_ACCESS_DENIED_ERROR','ER_BAD_DB_ERROR',
  'ER_DBACCESS_DENIED_ERROR','ER_TABLEACCESS_DENIED_ERROR',
  'ER_LOCK_WAIT_TIMEOUT','ER_LOCK_DEADLOCK','ER_CON_COUNT_ERROR',
]);
export function databaseDiagnostic(error:unknown,env:NodeJS.ProcessEnv=process.env) {
  let code:string|undefined,current=error;
  for(let depth=0;depth<5&&current&&typeof current==='object';depth++){
    const entry=current as {code?:unknown;cause?:unknown};
    if(typeof entry.code==='string'&&diagnosticCodes.has(entry.code)){code=entry.code;break;}
    current=entry.cause;
  }
  return {
    category:error instanceof DatabaseSetupError?'configuration':error instanceof DatabaseUnavailableError?'availability':'unexpected',
    driver:env.DATABASE_DRIVER==='mysql'?'mysql':env.DATABASE_DRIVER==='sqlite'?'sqlite':env.DATABASE_DRIVER?'invalid':'auto',
    transport:env.DB_SOCKET_PATH?'socket':'tcp',
    configured:Object.fromEntries(['DB_SOCKET_PATH','DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'].map(key=>[key,!!env[key]])),
    ...(code?{code}:{}),
  };
}
