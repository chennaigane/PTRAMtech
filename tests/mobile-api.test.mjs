import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqlite} from './cloudflare.mjs';
import {ensureSchema,hashPassword,createSession} from '../lib/auth.ts';
import {mobileRequest} from '../lib/mobile-api.ts';
import {POST as webPost, GET as webGet} from '../app/api/records/route.ts';
import {POST as userPost} from '../app/api/users/route.ts';
import {randomUUID} from 'node:crypto';

await ensureSchema();
const ids = Object.fromEntries(['employee','other','manager','admin','pending','office'].map(k => [k,randomUUID()]));
const hash = await hashPassword('TestOnly12345');
let i = 0;
const phones = {};
for (const [name,id] of Object.entries(ids)) {
  phones[name] = '+91900000000'+i++;
  sqlite.prepare('INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,phones[name],name,name==='admin'?'Admin':name==='manager'?'Manager':'Employee','Sales',hash,name==='pending'?'pending':'active',Date.now());
  sqlite.prepare('INSERT INTO workforce_profiles VALUES(?,?)').run(id,JSON.stringify({department:name==='office'?'Operations':'Sales',other:''}));
}
async function call(path,body={},token) {
  const response = await mobileRequest(new Request('https://ptraam.test/api/mobile/v1/'+path,{
    method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),
  }));
  return {status:response.status,body:await response.json()};
}
const login = name => call('session',{phone:phones[name],password:'TestOnly12345'});
const point = () => ({lat:13,lng:80,accuracy:5,time:Date.now()});
test('mobile account approval, role restrictions and independent token audience',async()=>{
  for(const name of ['pending','admin','manager']) assert.equal((await login(name)).status,403,name);
  assert.equal((await call('session',{phone:phones.employee,password:'wrong'})).status,401);
  const auth=await login('employee');assert.equal(auth.status,200);
  const token=auth.body.accessToken;assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(sqlite.prepare('SELECT token_hash FROM mobile_sessions WHERE token_hash=?').get(token),undefined);
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:point()})).status,401);
  const web=await webGet(new Request('https://ptraam.test/api/records',{headers:{cookie:'ptraam_session='+token}}));
  assert.equal(web.status,401,'mobile bearer cannot become a web session');
  const cookie=await createSession(new Request('https://ptraam.test'),ids.employee);
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:point()},cookie.split('=')[1].split(';')[0])).status,401);
  const denied=await userPost(new Request('https://ptraam.test/api/users',{method:'POST',headers:{cookie,origin:'https://ptraam.test','Content-Type':'application/json'},body:JSON.stringify({})}));
  assert.equal(denied.status,403,'employee cannot manage accounts');
});
test('native trip start, idempotency, ownership, atomic uploads, dashboard projection and stop',async()=>{
  const token=(await login('employee')).body.accessToken,other=(await login('other')).body.accessToken;
  const requestId=randomUUID(),start=await call('trips/start',{requestId,fix:point(),employee:ids.other},token);
  assert.equal(start.status,200,JSON.stringify(start.body));const id=start.body.tripId;
  assert.equal((await call('trips/start',{requestId,fix:point()},token)).body.tripId,id);
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:point()},token)).status,409);
  assert.equal(sqlite.prepare('SELECT account FROM mobile_trips WHERE id=?').get(id).account,ids.employee);
  for(const path of ['trips/lease','trips/points','trips/stop']) assert.equal((await call(path,{tripId:id,points:[],stoppedAt:Date.now(),reason:'test'},other)).status,404);
  const lease=await call('trips/lease',{tripId:id},token);assert.equal(lease.body.active,true);
  assert.ok(lease.body.leaseMs<=300000);
  const time=Date.now(),points=[{seq:1,time,elapsedMs:1000,lat:13.001,lng:80.001,accuracy:5},{seq:2,time:time+1,elapsedMs:2000,lat:13.002,lng:80.002,accuracy:5}];
  assert.equal((await call('trips/points',{tripId:id,points},token)).body.ackSeq,2);
  assert.equal((await call('trips/points',{tripId:id,points},token)).body.ackSeq,2);
  assert.equal((await call('trips/points',{tripId:id,points:[{...points[0],lat:14}]},token)).status,409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM mobile_points WHERE trip=?').get(id).n,2);
  const record=()=>JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
  assert.equal(record().points.length,3);assert.equal(record().employee,ids.employee);
  const cookie=await createSession(new Request('https://ptraam.test'),ids.employee);
  const web=await webPost(new Request('https://ptraam.test/api/records',{method:'POST',headers:{cookie,origin:'https://ptraam.test','Content-Type':'application/json'},body:JSON.stringify({id,kind:'trip',data:record()})}));
  assert.equal(web.status,403,'web cannot rewrite native capture');
  assert.equal((await call('trips/stop',{tripId:id,stoppedAt:Date.now()+999999,reason:'employee_stopped'},token)).status,200);
  assert.equal(record().status,'Pending');
  assert.equal((await call('trips/start',{requestId,fix:point()},token)).body.leaseMs,0);
  assert.equal((await call('trips/lease',{tripId:id},token)).body.active,false);
  assert.equal((await call('trips/stop',{tripId:id,stoppedAt:Date.now(),reason:'retry'},token)).status,200);
  assert.equal((await call('session/logout',{},token)).status,200);
  assert.equal((await call('trips/lease',{tripId:id},token)).status,401);
});
test('department, stale GPS, driver geofence, revocation, expiry and request limits',async()=>{
  const office=(await login('office')).body.accessToken;
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:point()},office)).status,403);
  const token=(await login('other')).body.accessToken;
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:{...point(),time:1}},token)).status,409);
  sqlite.prepare('UPDATE workforce_profiles SET data=? WHERE employee=?').run(JSON.stringify({department:'Driver'}),ids.other);
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:point()},token)).status,409,'driver requires office configuration');
  sqlite.prepare('UPDATE workforce_profiles SET data=? WHERE employee=?').run(JSON.stringify({department:'Sales'}),ids.other);
  const id=(await call('trips/start',{requestId:randomUUID(),fix:point()},token)).body.tripId;
  sqlite.prepare('UPDATE users SET status=? WHERE id=?').run('removed',ids.other);
  assert.equal((await call('trips/lease',{tripId:id},token)).status,403);
  sqlite.prepare('UPDATE users SET status=? WHERE id=?').run('active',ids.other);
  sqlite.prepare('UPDATE mobile_trips SET capture_until=started_at WHERE id=?').run(id);
  const ended=await call('trips/lease',{tripId:id},token);assert.equal(ended.body.active,false);
  assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data).endVerified,false);
  sqlite.prepare('UPDATE mobile_sessions SET expires=1 WHERE account=?').run(ids.other);
  assert.equal((await call('trips/lease',{tripId:id},token)).status,401);
  const oversized=await mobileRequest(new Request('https://ptraam.test/api/mobile/v1/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(66000)})}));
  assert.equal(oversized.status,413);
});
