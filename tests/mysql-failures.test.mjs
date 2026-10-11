import {test} from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {db} from '../db/raw.ts';
import {openMySQL} from '../db/mysql.ts';
import {mysqlConfig} from '../db/mysql-config.ts';
import {DatabaseSetupError,DatabaseUnavailableError,databaseDiagnostic} from '../db/errors.ts';
import {authFailure} from '../lib/auth-errors.ts';
import {POST as setup} from '../app/api/auth/admin-setup/route.ts';
import {POST as login} from '../app/api/auth/login/route.ts';
import {ADMIN_PHONE} from '../lib/auth.ts';

const socketEnv={DATABASE_DRIVER:'mysql',DB_SOCKET_PATH:'/cloudsql/fieldora-testing:asia-south1:fieldora-mysql-staging',DB_NAME:'fieldora_staging',DB_USER:'test-user',DB_PASSWORD:'test-secret'};
function environment(t,values){
  const previous={...process.env};
  const store=globalThis.ptraamDatabase,path=globalThis.ptraamDatabasePath;
  t.after(()=>{process.env=previous;globalThis.ptraamDatabase=store;globalThis.ptraamDatabasePath=path;});
  for(const key of Object.keys(process.env))if(key.startsWith('DB_')||key==='DATABASE_DRIVER'||key==='DATABASE_PATH')delete process.env[key];
  delete globalThis.ptraamDatabase;delete globalThis.ptraamDatabasePath;
  Object.assign(process.env,values);
}

test('Explicit MySQL never falls back to SQLite, including both authentication routes',async t=>{
  environment(t,{DATABASE_DRIVER:'mysql',DATABASE_PATH:':memory:',NODE_ENV:'development',APP_ORIGIN:'https://fieldora.test'});
  t.mock.method(console,'error',()=>{});
  assert.throws(()=>db(),DatabaseSetupError);
  assert.equal(globalThis.ptraamDatabase,undefined);
  for(const handler of [setup,login]){
    const response=await handler(new Request('https://fieldora.test/api/auth/test',{method:'POST',headers:{origin:'https://fieldora.test','Content-Type':'application/json'},body:JSON.stringify({phone:ADMIN_PHONE,password:'Test-password1'})}));
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'DATABASE_NOT_CONFIGURED');
  }
  Object.assign(process.env,socketEnv);
  delete process.env.DB_PASSWORD;
  assert.throws(()=>db(),/DB_PASSWORD/);
  assert.equal(globalThis.ptraamDatabase,undefined);
});

test('Connection failure is retryable and never opens SQLite',async t=>{
  environment(t,{...socketEnv,DATABASE_PATH:':memory:'});
  let attempts=0;
  const connection={query:async()=>[[{acquired:1}]],release(){}};
  t.mock.method(mysql,'createPool',()=>({getConnection:async()=>{
    if(++attempts===1)throw Object.assign(new Error('sensitive driver message'),{code:'ENOENT'});
    return connection;
  },end:async()=>{}}));
  const store=db();
  await assert.rejects(store.initialize(),error=>error instanceof DatabaseUnavailableError&&error.cause.code==='ENOENT');
  assert.equal(store.dialect,'mysql');
  assert.equal(db(),store);
  await store.initialize();
  assert.equal(attempts,2);
});

test('Schema failure releases its lock and connection, then retries initialization',async t=>{
  let fail=true,released=0;
  const queries=[];
  const connection={query:async sql=>{
    queries.push(sql);
    if(fail&&sql.startsWith('CREATE TABLE')){fail=false;throw Object.assign(new Error('secret SQL'),{code:'ER_TABLEACCESS_DENIED_ERROR'});}
    return [[{acquired:1}]];
  },release(){released++;}};
  t.mock.method(mysql,'createPool',()=>({getConnection:async()=>connection,end:async()=>{}}));
  const store=openMySQL(mysqlConfig(socketEnv));
  await assert.rejects(store.initialize(),error=>error instanceof DatabaseUnavailableError&&error.cause.code==='ER_TABLEACCESS_DENIED_ERROR');
  assert.match(queries.at(-1),/RELEASE_LOCK/);
  assert.equal(released,1);
  await store.initialize();
  assert.equal(released,2);
  await store.initialize();
  assert.equal(released,2);
});

test('Authentication diagnostics retain safe codes without messages, SQL, secrets or account data',async t=>{
  environment(t,socketEnv);
  const logged=[];
  t.mock.method(console,'error',(...args)=>logged.push(args));
  const cause=Object.assign(new Error('test-secret test-user SELECT password_hash'),{code:'ER_ACCESS_DENIED_ERROR',sql:'secret SQL'});
  const error=new DatabaseUnavailableError('private detail',{cause});
  const response=authFailure(error,'Unable to sign in.');
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,'DATABASE_UNAVAILABLE');
  assert.equal(logged[0][1].code,'ER_ACCESS_DENIED_ERROR');
  assert.equal(logged[0][1].transport,'socket');
  assert.equal(logged[0][1].configured.DB_PASSWORD,true);
  assert.doesNotMatch(JSON.stringify(logged),/test-secret|test-user|password_hash|private detail|secret SQL|fieldora_staging/);
  assert.equal(databaseDiagnostic({code:'SECRET_VALUE'},socketEnv).code,undefined);
});
