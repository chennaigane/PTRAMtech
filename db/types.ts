import type {Database as SQLiteDatabase} from './sqlite.mjs';
export type {Result,Statement} from './sqlite.mjs';
export type Database = Omit<SQLiteDatabase,'connection'|'close'> & {
  dialect?: 'sqlite'|'mysql';
  initialize?:()=>Promise<void>;
  transaction?:<T>(work:()=>Promise<T>)=>Promise<T>;
  withLock?:<T>(name:string,work:()=>Promise<T>)=>Promise<T>;
  close:()=>void|Promise<void>;
};
