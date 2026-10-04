import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../db/sqlite.mjs';
import {importExport, statements} from '../scripts/import-d1-export.mjs';

function workspace(t) {
  const root=resolve('.'), dir=mkdtempSync(join(root,'.deployment-test-'));
  t.after(()=>{if (!dir.startsWith(root+requireSeparator()+'.deployment-test-')) throw Error('Unsafe cleanup'); rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function requireSeparator() { return process.platform==='win32'?'\\':'/'; }
const fixture=`PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE users(id TEXT PRIMARY KEY,phone TEXT,name TEXT,role TEXT,team TEXT,password_hash TEXT,status TEXT,created INTEGER);
CREATE TABLE sessions(id TEXT,user TEXT,expires INTEGER);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE records(id TEXT PRIMARY KEY,owner TEXT,kind TEXT,data TEXT,created INTEGER);
CREATE TABLE workforce_entries(id TEXT,kind TEXT,employee TEXT,date TEXT,data TEXT,updated INTEGER);
CREATE TABLE workforce_profiles(employee TEXT,data TEXT);
CREATE TABLE workforce_audit(id TEXT);
CREATE TABLE workforce_locks(id TEXT);
INSERT INTO users VALUES('u','phone','Name; -- still data','Employee','A','hash','active',1);
INSERT INTO sessions VALUES('old-session','u',99);
INSERT INTO workforce_locks VALUES('old-lock');
INSERT INTO settings VALUES('example','apostrophe '' and /* not a comment */');
COMMIT;`;

test('Node SQLite bindings, column access and transactional rollback',async()=>{
  const db=openDatabase(':memory:');
  try {
    await db.exec('CREATE TABLE example(id TEXT PRIMARY KEY,value TEXT)');
    const insert=db.prepare('INSERT INTO example VALUES(?,?)');
    await db.batch([insert.bind('a','one'),insert.bind('b','two')]);
    assert.equal(await db.prepare('SELECT value FROM example WHERE id=?').bind('a').first('value'),'one');
    assert.equal(await db.prepare('SELECT * FROM example WHERE id=?').bind('missing').first(),null);
    await assert.rejects(db.batch([insert.bind('c','three'),insert.bind('a','duplicate')]));
    assert.equal((await db.prepare('SELECT * FROM example').all()).results.length,2);
    const foreign=openDatabase(':memory:');
    try { await assert.rejects(db.batch([foreign.prepare('SELECT 1')])); } finally {foreign.close();}
  } finally {db.close();}
});
test('D1 import preserves data, clears sessions/locks and refuses replacement',t=>{
  const dir=workspace(t),source=join(dir,'export.sql'),destination=join(dir,'app.sqlite'); writeFileSync(source,fixture);
  const counts=importExport(source,destination);
  assert.equal(counts.users,1);assert.equal(counts.sessions,1);assert.equal(counts.sessionsAfterImport,0);
  const db=new DatabaseSync(destination);
  try {
    assert.equal(db.prepare('SELECT name FROM users').get().name,'Name; -- still data');
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM workforce_locks').get().n,0);
  } finally {db.close();}
  assert.throws(()=>importExport(source,destination),/overwrite/);
});
test('incomplete or dangerous exports never publish a database',t=>{
  const dir=workspace(t),source=join(dir,'export.sql'),destination=join(dir,'app.sqlite');
  for(const sql of ['CREATE TABLE unexpected(id);',fixture+" ATTACH DATABASE 'other.sqlite' AS other;",fixture+' PRAGMA writable_schema=ON;',fixture+' CREATE TRIGGER bad AFTER INSERT ON users BEGIN DELETE FROM users; END;',fixture+" INSERT INTO users VALUES('u','duplicate','','','','','',1);"]){
    writeFileSync(source,sql);assert.throws(()=>importExport(source,destination));assert.equal(existsSync(destination),false);
  }
});
test('SQL tokenizer preserves quotes and rejects unterminated strings',()=>{
  assert.equal(statements("-- start\nINSERT INTO x VALUES('a;b', 'it''s'); /* comment */ SELECT 1;").length,2);
  assert.throws(()=>statements("INSERT INTO x VALUES('bad"));
});
test('database persists after reopen and backup includes committed WAL records',t=>{
  const dir=workspace(t),source=join(dir,'source.sqlite'),backup=join(dir,'backup.sqlite');
  const db=openDatabase(source);
  db.connection.exec("CREATE TABLE events(id INTEGER PRIMARY KEY); INSERT INTO events VALUES(1);");
  const result=spawnSync(process.execPath,['scripts/backup-database.mjs',backup],{env:{...process.env,DATABASE_PATH:source},encoding:'utf8'});
  db.close(); assert.equal(result.status,0,result.stderr);
  const copy=new DatabaseSync(backup);try{assert.equal(copy.prepare('SELECT count(*) n FROM events').get().n,1);}finally{copy.close();}
  const reopened=openDatabase(source);try{assert.equal(reopened.connection.prepare('SELECT count(*) n FROM events').get().n,1);}finally{reopened.close();}
});
