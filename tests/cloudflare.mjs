// Legacy fixture name retained for the restored tests; uses the production Node adapter.
import {openDatabase} from '../db/sqlite.mjs';
const database = openDatabase(':memory:');
process.env.DATABASE_PATH = ':memory:';
globalThis.ptraamDatabase = database;
globalThis.ptraamDatabasePath = ':memory:';
export const sqlite = database.connection;
export const env = process.env;
