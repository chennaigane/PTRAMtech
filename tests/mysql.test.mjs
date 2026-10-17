import {test} from 'node:test';
import mysql from 'mysql2/promise';
import {mysqlSchema,mysqlBackfill} from '../db/mysql-schema.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {db} from '../db/raw.ts';
import {openMySQL} from '../db/mysql.ts';
import {mysqlConfig,mysqlConfigured} from '../db/mysql-config.ts';
import {mysqlSql} from '../db/mysql-sql.ts';
import {ensureSchema,ADMIN_PHONE} from '../lib/auth.ts';
import {POST as setup} from '../app/api/auth/admin-setup/route.ts';
import {POST as signup} from '../app/api/auth/signup/route.ts';
import {POST as login} from '../app/api/auth/login/route.ts';
import {GET as me} from '../app/api/auth/me/route.ts';
import {POST as users} from '../app/api/users/route.ts';
import {POST as records,GET as recordList} from '../app/api/records/route.ts';
import {POST as workforce,GET as workforceList} from '../app/api/workforce/route.ts';
import {mobileRequest} from '../lib/mobile-api.ts';
import {ingestMySQLPoints} from '../lib/mobile-mysql-points.ts';
import {locked} from '../lib/workforce-lock.ts';
import {dailyStatement} from '../lib/workforce-store.ts';
import {initialPolicy,istDate} from '../lib/workforce-rules.ts';

test('MySQL configuration rejects partial credentials and preserves parameterized JSON/upsert queries',()=>{
  assert.equal(mysqlConfigured({}),false);
  assert.equal(mysqlConfigured({DB_HOST:'db'}),true);
  assert.throws(()=>mysqlConfig({DB_HOST:'db'}),/DB_PORT/);
  const env={DB_HOST:'db',DB_PORT:'3306',DB_NAME:'app',DB_USER:'user',DB_PASSWORD:'secret'};
  assert.equal(mysqlConfig(env).password,'secret');
  assert.throws(()=>mysqlConfig({...env,DB_PORT:'invalid'}),/DB_PORT/);
  assert.equal(mysqlConfig({...env,DB_SSL:'true'}).ssl.rejectUnauthorized,true);
  assert.equal(mysqlSql("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),'INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)');
  assert.equal(mysqlSql("SELECT json_extract(data,'$.employee') FROM records WHERE kind='key'"),"SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.employee')) FROM records WHERE kind='key'");
  assert.throws(()=>mysqlSql('INSERT INTO workforce_locks VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token WHERE expires<?'),/explicit MySQL/);
});

const socketEnv={DATABASE_DRIVER:'mysql',DB_SOCKET_PATH:'/cloudsql/project:region:instance',DB_NAME:'app',DB_USER:'user',DB_PASSWORD:'test-secret'};

test('MySQL socket configuration requires credentials and ignores TCP settings',()=>{
  assert.equal(mysqlConfigured({DB_SOCKET_PATH:socketEnv.DB_SOCKET_PATH}),true);
  const config=mysqlConfig({...socketEnv,DB_HOST:'ignored',DB_PORT:'invalid'});
  assert.equal(config.socketPath,socketEnv.DB_SOCKET_PATH);
  assert.equal('host' in config,false);
  assert.equal('port' in config,false);
  assert.equal(config.database,'app');
  assert.equal(config.user,'user');
  assert.equal(config.password,'test-secret');
  for(const key of ['DB_NAME','DB_USER','DB_PASSWORD']){
    assert.throws(()=>mysqlConfig({...socketEnv,[key]:''}),error=>error.message.includes(key)&&!error.message.includes('test-secret'));
  }
});

test('MySQL TCP configuration retains required host/port and verified TLS',()=>{
  const env={DB_SOCKET_PATH:'',DB_HOST:'db',DB_PORT:'3307',DB_NAME:'app',DB_USER:'user',DB_PASSWORD:'test-secret'};
  const config=mysqlConfig(env);
  assert.equal(config.host,'db');assert.equal(config.port,3307);
  assert.equal('socketPath' in config,false);
  assert.equal(config.ssl,undefined);
  assert.equal(mysqlConfig({...env,DB_SSL:'false'}).ssl,undefined);
  assert.deepEqual(mysqlConfig({...env,DB_SSL:'true',DB_SSL_CA:'first\\nsecond'}).ssl,{rejectUnauthorized:true,ca:'first\nsecond'});
  for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])assert.throws(()=>mysqlConfig({...env,[key]:''}),new RegExp(key));
  for(const port of ['0','65536','1.5','invalid'])assert.throws(()=>mysqlConfig({...env,DB_PORT:port}),/DB_PORT/);
  assert.throws(()=>mysqlConfig({...env,DB_SSL:'invalid'}),/DB_SSL/);
});

test('Socket pool receives configuration, initializes schema once, and rejects socket changes',async t=>{
  const previousEnv={...process.env};
  const previousDatabase=globalThis.ptraamDatabase,previousPath=globalThis.ptraamDatabasePath;
  const queries=[];let released=0,closed=0,received;
  const connection={query:async(sql)=>{queries.push(sql);return [[{acquired:1}]];},release:()=>released++};
  t.mock.method(mysql,'createPool',options=>{received=options;return {getConnection:async()=>connection,end:async()=>{closed++;}};});
  t.after(()=>{process.env=previousEnv;globalThis.ptraamDatabase=previousDatabase;globalThis.ptraamDatabasePath=previousPath;});
  delete globalThis.ptraamDatabase;delete globalThis.ptraamDatabasePath;
  Object.assign(process.env,socketEnv);
  const store=db();
  assert.equal(received.socketPath,socketEnv.DB_SOCKET_PATH);
  assert.equal('host' in received,false);assert.equal('port' in received,false);
  await Promise.all([store.initialize(),store.initialize()]);
  assert.deepEqual(queries.slice(1,1+mysqlSchema.length),mysqlSchema);
  assert.equal(queries[1+mysqlSchema.length],mysqlBackfill);
  assert.ok(queries.includes("UPDATE users SET role='Employee' WHERE role='Representative'"));
  assert.match(queries.at(-1),/RELEASE_LOCK/);assert.equal(released,1);
  assert.equal(db(),store);
  process.env.DB_SOCKET_PATH='/cloudsql/project:region:other';
  assert.throws(()=>db(),/Restart the process/);
  await store.close();assert.equal(closed,1);
});

test('MySQL integration: Admin, approvals, attendance, GPS, rollback, locks and persistence',{skip:process.env.MYSQL_INTEGRATION!=='1'},async t=>{
  assert.match(process.env.DB_NAME||'',/^fieldora_(integration|test_\w+)$/,'Use a dedicated test database only');
  const origin='https://fieldora.test';process.env.APP_ORIGIN=origin;
  const store=db();assert.equal(store.dialect,'mysql');
  t.after(async()=>{await store.close();});
  await ensureSchema();
  const tables=['mobile_points','mobile_trips','mobile_sessions','mobile_limits','sessions','workforce_entries','workforce_profiles','workforce_audit','workforce_locks','records','settings','users'];
  for(const table of tables)await store.exec(`DELETE FROM ${table}`);
  const request=(path,body,cookie)=>new Request(origin+path,{method:'POST',headers:{origin,'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
  const call=async(handler,path,body,cookie)=>{const r=await handler(request(path,body,cookie));return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};};
  const password='Test1-'+randomUUID();
  const admin=await call(setup,'/api/auth/admin-setup',{phone:ADMIN_PHONE,password});assert.equal(admin.status,200,JSON.stringify(admin.body));
  assert.equal((await call(setup,'/api/auth/admin-setup',{phone:ADMIN_PHONE,password})).status,409);
  assert.equal((await call(login,'/api/auth/login',{phone:ADMIN_PHONE,password})).status,200);
  assert.equal((await (await me(new Request(origin+'/api/auth/me',{headers:{cookie:admin.cookie}}))).json()).user.role,'Admin');
  const employees={};let n=0;
  for(const department of ['Marketing','Sales','Driver','Office Admin','Finance','HR']){
    const phone='988880000'+n++;const registered=await call(signup,'/api/auth/signup',{name:department,role:'Employee',department,phone,password});assert.equal(registered.status,200,JSON.stringify(registered.body));
    assert.equal((await call(login,'/api/auth/login',{phone,password})).status,403);
    const user=await store.prepare('SELECT id FROM users WHERE phone=?').bind('+91'+phone).first();
    assert.equal((await call(users,'/api/users',{id:user.id,action:'approve'},admin.cookie)).status,200);
    const logged=await call(login,'/api/auth/login',{phone,password});assert.equal(logged.status,200);
    employees[department]={id:user.id,cookie:logged.cookie,phone};
    const identity=await (await me(new Request(origin+'/api/auth/me',{headers:{cookie:logged.cookie}}))).json();assert.equal(identity.user.department,department);
  }
  const policy={...initialPolicy,workdays:[0,1,2,3,4,5,6],confirmedYears:[Number(istDate().slice(0,4))],office:{lat:13,lng:80,radius:150,maxAccuracy:50},leaveTypes:[{name:'Annual',paid:true,annual:12}]};
  const configured=await call(workforce,'/api/workforce',{action:'policy',policy,confirm:true},admin.cookie);assert.equal(configured.status,200,JSON.stringify(configured.body));
  const fix=()=>({lat:13,lng:80,accuracy:5,time:Date.now()});
  const trip=()=>({kind:'trip',data:{from:'',to:'',points:[fix()],status:'Travelling',extra:0,note:''}});
  for(const dept of ['Office Admin','Finance','HR']){
    assert.equal((await call(records,'/api/records',trip(),employees[dept].cookie)).status,403);
    const attendance=await call(workforce,'/api/workforce',{action:'checkIn',fix:fix()},employees[dept].cookie);assert.equal(attendance.status,200,JSON.stringify(attendance.body));
    assert.equal((await call(workforce,'/api/workforce',{action:'checkOut',fix:fix()},employees[dept].cookie)).status,200);
  }
  const started=await call(records,'/api/records',trip(),employees.Marketing.cookie);assert.equal(started.status,200,JSON.stringify(started.body));
  assert.equal((await call(records,'/api/records',trip(),employees.Marketing.cookie)).status,400,'duplicate active trip blocked');
  assert.equal((await call(records,'/api/records',trip(),employees.Driver.cookie)).status,200);
  const listed=await (await recordList(new Request(origin+'/api/records',{headers:{cookie:employees.Finance.cookie}}))).json();assert.equal(listed.records.some(r=>r.kind==='trip'),false);
  assert.equal((await workforceList(new Request(origin+'/api/workforce',{headers:{cookie:admin.cookie}}))).status,200);
  const leave=await call(workforce,'/api/workforce',{action:'requestLeave',from:istDate(),to:istDate(),type:'Annual',reason:'Test leave'},employees.Finance.cookie);
  assert.equal(leave.status,200,JSON.stringify(leave.body));
  const leaveRow=await store.prepare("SELECT id FROM workforce_entries WHERE kind='leave' AND employee=?").bind(employees.Finance.id).first();
  const reviewed=await call(workforce,'/api/workforce',{action:'review',id:leaveRow.id,status:'Approved',reason:'Approved test'},admin.cookie);assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));
  assert.equal((await call(workforce,'/api/workforce',{action:'review',id:leaveRow.id,status:'Approved',reason:'Repeated review'},admin.cookie)).status,400);
  const now=new Date(),previousMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString().slice(0,7);
  const payroll=await call(workforce,'/api/workforce',{action:'payroll',month:previousMonth},admin.cookie);assert.equal(payroll.status,200,JSON.stringify(payroll.body));
  assert.ok(payroll.body.rows.length>=6);
  // JSON merge updates retain earlier attendance evidence and preserve booleans.
  await dailyStatement(employees.Marketing.id,istDate(),{endDay:123}).run();
  const merged=JSON.parse((await store.prepare('SELECT data FROM workforce_entries WHERE id=?').bind(`daily:${employees.Marketing.id}:${istDate()}`).first()).data);
  assert.equal(merged.endDay,123);assert.ok(merged.fieldStart);assert.equal(merged.reconciled,false);
  await assert.rejects(store.batch([store.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind('rollback','one'),store.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind('rollback','two')]));
  assert.equal(await store.prepare('SELECT value FROM settings WHERE key=?').bind('rollback').first(),null);
  const other=openMySQL(mysqlConfig());t.after(()=>other.close());await other.initialize();
  await locked('test',async()=>{await assert.rejects(other.withLock('test',async()=>{}),/Another update/);});
  await other.withLock('test',async()=>{});
  // Native GPS: no changes to authentication, leases, retries or route projection.
  const mobile=async(path,body,token)=>{const r=await mobileRequest(new Request(origin+'/api/mobile/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
  const native=await mobile('session',{phone:employees.Sales.phone,password});assert.equal(native.status,200,JSON.stringify(native.body));const token=native.body.accessToken;
  const requestId=randomUUID(),nativeStart=await mobile('trips/start',{requestId,fix:fix()},token);assert.equal(nativeStart.status,200,JSON.stringify(nativeStart.body));const tripId=nativeStart.body.tripId;
  assert.equal((await mobile('trips/start',{requestId,fix:fix()},token)).body.tripId,tripId);
  const point={seq:1,time:Date.now(),elapsedMs:1000,lat:13.001,lng:80.001,accuracy:5};
  await assert.rejects(ingestMySQLPoints(employees.Sales.id,tripId,[point],Date.now(),async()=>{throw Error('projection failed');}),/projection failed/);
  assert.equal((await store.prepare('SELECT last_seq FROM mobile_trips WHERE id=?').bind(tripId).first()).last_seq,0);
  const uploaded=await mobile('trips/points',{tripId,points:[point]},token);assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));assert.equal(uploaded.body.ackSeq,1);
  assert.equal((await mobile('trips/points',{tripId,points:[point]},token)).body.ackSeq,1);
  assert.equal((await mobile('trips/points',{tripId,points:[{...point,lat:14}]},token)).status,409);
  assert.equal((await mobile('trips/lease',{tripId},token)).body.active,true);
  const stop={tripId,stoppedAt:Date.now(),reason:'employee_stopped',endpoint:{status:'captured',seq:1}};
  const stopped=await mobile('trips/stop',stop,token);assert.equal(stopped.status,200,JSON.stringify(stopped.body));
  assert.equal(stopped.body.endpointStatus,'captured');assert.equal(stopped.body.finalSeq,1);
  assert.deepEqual((await mobile('trips/stop',stop,token)).body,stopped.body);
  assert.equal((await mobile('trips/points',{tripId,points:[point]},token)).body.ackSeq,1);
  const projected=JSON.parse((await other.prepare('SELECT data FROM records WHERE id=?').bind(tripId).first()).data);assert.equal(projected.points.length,2);assert.equal(projected.status,'Pending');
  assert.equal(projected.endVerified,true);assert.equal(projected.endLocation.seq,1);
  assert.equal((await mobile('capabilities',{})).status,401);
  assert.deepEqual((await mobile('capabilities',{},token)).body,{stopContract:1,structuredStopAcknowledgement:true,endpointVersion:1,startPath:'/trips/start/endpoint-v1',stopPath:'/trips/stop/endpoint-v1'});
  assert.equal((await mobile('trips/start',{requestId:randomUUID(),fix:fix(),stopContract:2},token)).status,409);
  const auditBefore=(await store.prepare('SELECT * FROM workforce_audit WHERE target=? ORDER BY id').bind(tripId).all()).results;
  for(const status of ['Pending','Approved','Paid']) {
    const historical={...projected,status,approval:{by:employees.Sales.id},payment:{reference:'historical-test'}};
    delete historical.endpoint;
    const exact=JSON.stringify(historical);
    await store.prepare('UPDATE records SET data=? WHERE id=?').bind(exact,tripId).run();
    for(let attempt=0;attempt<2;attempt++) assert.equal((await mobile('trips/points',{tripId,points:[point]},token)).body.ackSeq,1);
    assert.equal((await mobile('trips/points/endpoint-v1',{tripId,points:[point]},token)).body.ackSeq,1);
    assert.equal((await mobile('trips/points',{tripId,points:[{...point,lat:14}]},token)).status,409);
    assert.equal((await mobile('trips/stop/endpoint-v1',{...stop,reason:'endpoint_timeout',endpoint:{version:1,status:'unverified'}},token)).body.endpointStatus,'unverified');
    assert.equal((await store.prepare('SELECT data FROM records WHERE id=?').bind(tripId).first()).data,exact);
  }
  assert.deepEqual((await store.prepare('SELECT * FROM workforce_audit WHERE target=? ORDER BY id').bind(tripId).all()).results,auditBefore);
  const v1path='trips/start/endpoint-v1',v1request=randomUUID();
  const v1start=await mobile(v1path,{requestId:v1request,fix:fix()},token);
  assert.equal(v1start.status,200);assert.equal(v1start.body.startContract,'fieldora.endpoint.v1');
  assert.equal((await mobile(v1path,{requestId:v1request,fix:fix()},token)).body.tripId,v1start.body.tripId);
  assert.equal((await mobile(v1path+'/recover',{requestId:v1request},token)).body.recovered,true);
  assert.equal((await mobile(v1path,{requestId:v1request,fix:fix()},token)).status,409);
  const absentRequest=randomUUID();
  assert.equal((await mobile(v1path+'/recover',{requestId:absentRequest},token)).body.recovered,true);
  assert.equal((await mobile(v1path,{requestId:absentRequest,fix:fix()},token)).status,409);
  assert.equal((await mobile('session/logout',{},token)).status,200);
  assert.equal((await mobile('trips/lease',{tripId},token)).status,401);
});
