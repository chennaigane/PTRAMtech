import {resolve} from 'node:path';
import {openDatabase, type Database} from './sqlite.mjs';

const state = globalThis as typeof globalThis & {ptraamDatabase?:Database;ptraamDatabasePath?:string};
export function db():Database {
  const path = process.env.DATABASE_PATH || (process.env.NODE_ENV === 'development' ? resolve('local-data/ptraam.sqlite') : undefined);
  if (!path) throw Error('DATABASE_PATH must identify the persistent SQLite database.');
  if (state.ptraamDatabase && state.ptraamDatabasePath !== path) throw Error('Restart the process before changing DATABASE_PATH.');
  if (!state.ptraamDatabase) { state.ptraamDatabase = openDatabase(path); state.ptraamDatabasePath = path; }
  return state.ptraamDatabase;
}
