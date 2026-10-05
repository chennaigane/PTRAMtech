import {resolve} from 'node:path';
import {openDatabase} from './sqlite.mjs';
import type {Database} from './types';
import {openMySQL} from '@/db/mysql';
import {mysqlConfigured,mysqlConfig} from '@/db/mysql-config';
import {DatabaseSetupError,DatabaseUnavailableError} from '@/db/errors';
export {DatabaseSetupError,DatabaseUnavailableError} from '@/db/errors';

const state = globalThis as typeof globalThis & {ptraamDatabase?:Database;ptraamDatabasePath?:string};
export function db():Database {
  const driver=process.env.DATABASE_DRIVER;
  if(driver&&!['mysql','sqlite'].includes(driver))throw new DatabaseSetupError('DATABASE_DRIVER must be mysql or sqlite.');
  if(driver!=='sqlite'&&mysqlConfigured()){
    const config=mysqlConfig();
    const identity=JSON.stringify(['mysql',config.host,config.port,config.database,config.user]);
    if(state.ptraamDatabase&&state.ptraamDatabasePath!==identity)throw new DatabaseSetupError('Restart the process before changing database settings.');
    if(!state.ptraamDatabase){state.ptraamDatabase=openMySQL(config);state.ptraamDatabasePath=identity;}
    return state.ptraamDatabase;
  }
  const path = process.env.DATABASE_PATH || (process.env.NODE_ENV === 'development' ? resolve('local-data/ptraam.sqlite') : undefined);
  if (!path) throw new DatabaseSetupError('Configure managed MySQL using DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD, or configure DATABASE_PATH for persistent SQLite.');
  if (state.ptraamDatabase && state.ptraamDatabasePath !== path) throw Error('Restart the process before changing DATABASE_PATH.');
  if (!state.ptraamDatabase) {
    try { state.ptraamDatabase = openDatabase(path); state.ptraamDatabasePath = path; }
    catch(cause) { throw new DatabaseUnavailableError('Unable to open the configured account database.', {cause}); }
  }
  return state.ptraamDatabase;
}
