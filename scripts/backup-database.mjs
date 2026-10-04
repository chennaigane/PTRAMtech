import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, chmodSync} from 'node:fs';
import {isAbsolute, dirname, resolve} from 'node:path';

// VACUUM INTO takes a consistent SQLite snapshot, including committed WAL content.
// The output must subsequently be encrypted and copied off-host; never cp a live DB.
const source = process.env.DATABASE_PATH, output = process.argv[2];
if (!source || !output || !isAbsolute(source) || !isAbsolute(output) || !existsSync(source) || existsSync(output) || resolve(source)===resolve(output))
  throw Error('Provide DATABASE_PATH and an absolute, nonexistent backup filename');
process.umask(0o077);
mkdirSync(dirname(output), {recursive:true,mode:0o700});
const db = new DatabaseSync(source, {readOnly:true});
try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('VACUUM INTO ?').run(output); chmodSync(output,0o600); }
finally { db.close(); }
const copy = new DatabaseSync(output, {readOnly:true});
try { if (copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || copy.prepare('PRAGMA foreign_key_check').all().length) throw Error('Backup integrity check failed'); }
finally { copy.close(); }
console.log('Consistent local snapshot created. Off-host encryption and restore verification are still required.');
