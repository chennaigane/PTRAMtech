import {test} from 'node:test';
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
  assert.equal((await mobile('trips/stop',{tripId,stoppedAt:Date.now(),reason:'test'},token)).status,200);
  const projected=JSON.parse((await other.prepare('SELECT data FROM records WHERE id=?').bind(tripId).first()).data);assert.equal(projected.points.length,2);assert.equal(projected.status,'Pending');
  assert.equal((await mobile('session/logout',{},token)).status,200);
  assert.equal((await mobile('trips/lease',{tripId},token)).status,401);
});
