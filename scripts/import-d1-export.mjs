import {DatabaseSync} from 'node:sqlite';
import {readFileSync, openSync, closeSync, mkdirSync, linkSync, unlinkSync, existsSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

export const requiredTables = ['users','sessions','settings','records','workforce_entries','workforce_profiles','workforce_audit','workforce_locks'];

// Split SQL without treating semicolons or comment markers in quoted data as SQL.
export function statements(sql) {
  const result = []; let out = '', quote = '', comment = '';
  for (let i=0; i<sql.length; i++) {
    const c=sql[i], next=sql[i+1];
    if (comment === 'line') { if (c === '\n') { comment=''; out+=' '; } continue; }
    if (comment === 'block') { if (c==='*' && next==='/') { comment=''; out+=' '; i++; } continue; }
    if (quote) {
      out += c;
      if (c===quote) { if (next===quote && quote!==']') { out+=next; i++; } else quote=''; }
      continue;
    }
    if (c==='-' && next==='-') { comment='line'; i++; continue; }
    if (c==='/' && next==='*') { comment='block'; i++; continue; }
    if (c==="'" || c==='"' || c==='`' || c==='[') { quote=c==='['?']':c; out+=c; continue; }
    if (c===';') { if (out.trim()) result.push(out.trim()); out=''; } else out+=c;
  }
  if (quote || comment==='block') throw Error('Unterminated SQL quote/comment');
  if (out.trim()) result.push(out.trim());
  return result;
}

export function importExport(source, destination) {
  if (!isAbsolute(destination)) throw Error('DATABASE_PATH must be absolute');
  if (existsSync(destination)) throw Error('Refusing to overwrite an existing database (including an empty file)');
  const sql = readFileSync(source, 'utf8');
  const commands = statements(sql).filter(command => {
    if (/^(BEGIN(?: TRANSACTION| IMMEDIATE)?|COMMIT|END(?: TRANSACTION)?)$/i.test(command)) return false;
    if (/^PRAGMA\s+(?:foreign_keys|defer_foreign_keys)\s*=\s*(?:ON|OFF|0|1)$/i.test(command)) return false;
    if (!/^(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s|INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s|DELETE\s+FROM\s+["`]?sqlite_sequence["`]?\s*$)/i.test(command))
      throw Error('Unsupported export statement; review the export. ATTACH, triggers, extensions and arbitrary PRAGMAs are not accepted.');
    return true;
  });
  mkdirSync(dirname(destination), {recursive:true, mode:0o700});
  const staged = destination + '.import-' + randomUUID();
  closeSync(openSync(staged, 'wx', 0o600));
  let db;
  try {
    db = new DatabaseSync(staged, {allowExtension:false});
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE;');
    for (const command of commands) db.exec(command);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    for (const name of requiredTables) if (!tables.has(name)) throw Error('Missing required table: '+name);
    const expected = {users:['id','phone','name','role','team','password_hash','status','created'],records:['id','owner','kind','data','created'],settings:['key','value'],workforce_entries:['id','kind','employee','date','data','updated'],workforce_profiles:['employee','data']};
    for (const [table, names] of Object.entries(expected)) {
      const columns = new Set(db.prepare('PRAGMA table_info('+table+')').all().map(row=>row.name));
      if (names.some(name=>!columns.has(name))) throw Error('Incompatible columns in '+table);
    }
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('SQLite integrity check failed');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('SQLite foreign-key check failed');
    const counts = {};
    for (const table of requiredTables) counts[table] = db.prepare('SELECT count(*) AS n FROM '+table).get().n;
    db.exec('DELETE FROM sessions; DELETE FROM workforce_locks; COMMIT; VACUUM;');
    counts.sessionsAfterImport = 0; counts.locksAfterImport = 0;
    db.close(); db=undefined;
    // Atomic publication without replacing an existing file, even if it appeared meanwhile.
    linkSync(staged, destination);
    return counts;
  } finally {
    if (db) db.close();
    if (existsSync(staged)) unlinkSync(staged);
    if (existsSync(staged+'-journal')) unlinkSync(staged+'-journal');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || !process.env.DATABASE_PATH) throw Error('Usage: DATABASE_PATH=/absolute/new.sqlite node scripts/import-d1-export.mjs /secure/export.sql');
    console.log(JSON.stringify(importExport(process.argv[2], process.env.DATABASE_PATH), null, 2));
  } catch (error) { console.error('Import failed:', error.message); process.exitCode=1; }
}
