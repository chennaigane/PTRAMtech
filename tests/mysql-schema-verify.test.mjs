import {test} from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {requiredColumns,requiredUnique,verifyMySQLSchema} from '../db/mysql-schema-verify.ts';
import {openMySQL} from '../db/mysql.ts';
function fixture(){return {tables:Object.keys(requiredColumns).map(TABLE_NAME=>({TABLE_NAME,ENGINE:'InnoDB'})),columns:Object.entries(requiredColumns).flatMap(([TABLE_NAME,names])=>names.map(COLUMN_NAME=>({TABLE_NAME,COLUMN_NAME}))),indexes:Object.entries(requiredUnique).flatMap(([TABLE_NAME,keys])=>keys.flatMap((columns,n)=>columns.map((COLUMN_NAME,i)=>({TABLE_NAME,INDEX_NAME:'key'+n,NON_UNIQUE:0,SEQ_IN_INDEX:i+1,COLUMN_NAME,SUB_PART:null}))))};}
function connection(f,queries=[]){return {query:async(sql)=>{queries.push(sql);assert.match(sql,/^SELECT /);return [sql.includes('information_schema.TABLES')?f.tables:sql.includes('information_schema.COLUMNS')?f.columns:f.indexes];},release(){}};}
test('metadata-only schema check accepts the expected existing schema',async()=>{const queries=[];await verifyMySQLSchema(connection(fixture(),queries));assert.equal(queries.length,3);});
for(const kind of ['missing-column','missing-table','wrong-engine','missing-unique','prefix-unique'])test('schema verification rejects '+kind+' without repair',async()=>{const f=fixture();if(kind==='missing-column')f.columns=f.columns.filter(c=>c.COLUMN_NAME!=='session_hash');if(kind==='missing-table')f.tables=f.tables.filter(t=>t.TABLE_NAME!=='mobile_sessions');if(kind==='wrong-engine')f.tables[0].ENGINE='MyISAM';if(kind==='missing-unique')f.indexes=f.indexes.filter(i=>i.TABLE_NAME!=='mobile_points');if(kind==='prefix-unique')f.indexes.filter(i=>i.TABLE_NAME==='mobile_points').forEach(i=>i.SUB_PART=4);await assert.rejects(verifyMySQLSchema(connection(f)),/no migration was attempted/);});
test('verify mode initialization performs no DDL, backfill or role normalization',async t=>{const old=process.env.DB_SCHEMA_MODE;process.env.DB_SCHEMA_MODE='verify';t.after(()=>{if(old===undefined)delete process.env.DB_SCHEMA_MODE;else process.env.DB_SCHEMA_MODE=old;});const queries=[];t.mock.method(mysql,'createPool',()=>({getConnection:async()=>connection(fixture(),queries),end:async()=>{}}));const store=openMySQL({database:'test'});await store.initialize();await store.initialize();assert.equal(queries.length,3);assert.ok(queries.every(q=>q.startsWith('SELECT ')));await store.close();});
test('invalid schema mode fails closed before pool connection',()=>{const old=process.env.DB_SCHEMA_MODE;process.env.DB_SCHEMA_MODE='typo';try{assert.throws(()=>openMySQL({}),/DB_SCHEMA_MODE/);}finally{if(old===undefined)delete process.env.DB_SCHEMA_MODE;else process.env.DB_SCHEMA_MODE=old;}});

test('workforce lock pins one connection, rejects contention and releases after rollback',async t=>{
 const old=process.env.DB_SCHEMA_MODE;process.env.DB_SCHEMA_MODE='verify';t.after(()=>{if(old===undefined)delete process.env.DB_SCHEMA_MODE;else process.env.DB_SCHEMA_MODE=old;});
 const f=fixture(),owners=new Map(),events=[];let sequence=0;
 t.mock.method(mysql,'createPool',()=>({end:async()=>{},getConnection:async()=>{
 const id=++sequence;
 return {query:async(sql,args)=>{
 events.push({id,sql,args});
 if(sql.includes('information_schema.TABLES'))return [f.tables];if(sql.includes('information_schema.COLUMNS'))return [f.columns];if(sql.includes('information_schema.STATISTICS'))return [f.indexes];
 if(sql.includes('GET_LOCK')){assert.match(args[0],/^[a-f0-9]{64}$/);const acquired=!owners.has(args[0]);if(acquired)owners.set(args[0],id);return [[{acquired:acquired?1:0}]];}
 if(sql.includes('RELEASE_LOCK')){assert.equal(owners.get(args[0]),id);owners.delete(args[0]);return [[{released:1}]];}
 return [{affectedRows:1}];
 },beginTransaction:async()=>events.push({id,sql:'BEGIN'}),commit:async()=>events.push({id,sql:'COMMIT'}),rollback:async()=>events.push({id,sql:'ROLLBACK'}),release(){assert.ok(![...owners.values()].includes(id),'connection must not return to pool while holding lock');events.push({id,sql:'POOL_RELEASE'});}};
 }}));
 const first=openMySQL({database:'fieldora_test'}),second=openMySQL({database:'fieldora_test'});
 await first.initialize();await second.initialize();events.length=0;
 await assert.rejects(first.withLock('workforce',async()=>{
 await first.prepare('UPDATE example SET value=?').bind(1).run();
 await assert.rejects(second.withLock('workforce',async()=>assert.fail('contender entered')),/Another update/);
 await first.batch([first.prepare('UPDATE example SET value=?').bind(2)]);
 await first.transaction(async()=>{await first.prepare('UPDATE example SET value=?').bind(3).run();throw Error('forced rollback');});
 }),/forced rollback/);
 const holder=events.find(e=>e.sql.includes('GET_LOCK')).id;
 assert.ok(events.filter(e=>e.sql.startsWith('UPDATE')||['BEGIN','COMMIT','ROLLBACK'].includes(e.sql)).every(e=>e.id===holder));
 const own=events.filter(e=>e.id===holder).map(e=>e.sql);assert.deepEqual(own.slice(-3),['ROLLBACK','SELECT RELEASE_LOCK(?)','POOL_RELEASE']);assert.equal(owners.size,0);
 await second.withLock('workforce',async()=>{});await first.close();await second.close();
});
