import {DatabaseSetupError} from '@/db/errors';

export function mysqlConfigured(env:NodeJS.ProcessEnv=process.env) {
  return env.DATABASE_DRIVER==='mysql' || ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'].some(key=>!!env[key]);
}
export function mysqlConfig(env:NodeJS.ProcessEnv=process.env) {
  const missing=['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'].filter(key=>!env[key]);
  if(missing.length)throw new DatabaseSetupError(`Missing managed MySQL settings: ${missing.join(', ')}.`);
  const port=Number(env.DB_PORT);
  if(!Number.isInteger(port)||port<1||port>65535)throw new DatabaseSetupError('DB_PORT must be a valid TCP port.');
  if(env.DB_SSL && !['true','false'].includes(env.DB_SSL))throw new DatabaseSetupError('DB_SSL must be true or false.');
  return {host:env.DB_HOST!,port,database:env.DB_NAME!,user:env.DB_USER!,password:env.DB_PASSWORD!,
    connectionLimit:5,waitForConnections:true,queueLimit:100,connectTimeout:10000,
    charset:'utf8mb4_bin',supportBigNumbers:true,bigNumberStrings:false,
    multipleStatements:false,flags:['-FOUND_ROWS'],
    ...(env.DB_SSL==='true'?{ssl:{rejectUnauthorized:true,...(env.DB_SSL_CA?{ca:env.DB_SSL_CA.replace(/\\n/g,'\n')}:{})}}:{}),
  };
}
