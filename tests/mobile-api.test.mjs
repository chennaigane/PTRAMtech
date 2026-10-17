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
  assert.equal((await login('pending')).status,403,'pending');
  const adminAuth = await login('admin'); assert.equal(adminAuth.status,200,'admin');
  assert.equal(adminAuth.body.role, 'Admin');
  const managerAuth = await login('manager'); assert.equal(managerAuth.status,200,'manager');
  assert.equal(managerAuth.body.role, 'Manager');
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

test('final endpoint closes a round trip and survives lost upload/stop acknowledgements',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const start=await call('trips/start',{requestId:randomUUID(),fix:point()},token);
  assert.equal(start.status,200);const id=start.body.tripId,at=now;
  const points=[{seq:1,time:at+60000,elapsedMs:60000,lat:13.001,lng:80,accuracy:5},
    {seq:2,time:at+120000,elapsedMs:120000,lat:13,lng:80,accuracy:5}];
  now=at+240000; // offline queue is delivered later, inside the issued capture interval
  const read=()=>JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
  for(let i=0;i<2;i++)assert.equal((await call('trips/points',{tripId:id,points},token)).body.ackSeq,2);
  const stop={tripId:id,stoppedAt:at+120001,reason:'employee_stopped',endpoint:{status:'captured',seq:2}};
  const ack=await call('trips/stop',stop,token);assert.equal(ack.status,200,JSON.stringify(ack.body));
  assert.deepEqual(ack.body,{tripId:id,stoppedAt:at+120001,endpointStatus:'captured',finalSeq:2,
    journey:{format:'locality-v1',from:'Locality pending',to:'Locality pending'}});
  assert.equal(read().endVerified,true);assert.equal(read().endLocation.seq,2);
  assert.ok(read().km>0.22 && read().km<0.225,'final return segment included in cumulative distance');
  const original=read();
  assert.deepEqual((await call('trips/stop',stop,token)).body,ack.body);
  assert.deepEqual((await call('trips/stop',{...stop,reason:'endpoint_timeout',endpoint:{status:'unverified'}},token)).body,ack.body);
  assert.equal((await call('trips/points',{tripId:id,points},token)).body.ackSeq,2);
  assert.deepEqual(read(),original,'retries preserve endpoint, distance and stop time');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workforce_audit WHERE target=? AND action='mobile.trip.stop'").get(id).n,1);
});

test('timeout preserves recent ordinary GPS without claiming a verified destination',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const id=(await call('trips/start',{requestId:randomUUID(),fix:point()},token)).body.tripId;
  now+=60000;const p={seq:1,time:now,elapsedMs:60000,lat:13.001,lng:80,accuracy:5};
  assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).status,200);
  now+=1000;
  const stop={tripId:id,stoppedAt:now,reason:'endpoint_timeout',endpoint:{status:'unverified'}};
  const ack=await call('trips/stop',stop,token);assert.equal(ack.body.endpointStatus,'unverified');
  assert.deepEqual((await call('trips/stop',stop,token)).body,ack.body);
  assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).body.ackSeq,1);
  const data=JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
  assert.equal(data.endVerified,false);assert.equal(data.endLocation,null);
  assert.equal(data.points.length,2);assert.deepEqual(data.points.at(-1),p);assert.ok(data.km>0);
});

test('invalid final point and premature stop roll back without discarding GPS',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const id=(await call('trips/start',{requestId:randomUUID(),fix:point()},token)).body.tripId;
  now+=1000;const p={seq:1,time:now,elapsedMs:1000,lat:13,lng:80,accuracy:101};
  assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).status,400);
  const stop={tripId:id,stoppedAt:now,reason:'employee_stopped',endpoint:{status:'captured',seq:1}};
  assert.equal((await call('trips/stop',stop,token)).status,409,'cannot acknowledge an unuploaded final point');
  assert.equal(sqlite.prepare('SELECT stopped_at FROM mobile_trips WHERE id=?').get(id).stopped_at,null);
  p.accuracy=5;assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).status,200);
  sqlite.exec(`CREATE TEMP TRIGGER reject_endpoint_projection BEFORE UPDATE ON records
    WHEN NEW.id='${id}' AND json_extract(NEW.data,'$.end') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'test projection failure'); END`);
  try { assert.equal((await call('trips/stop',stop,token)).status,409); }
  finally { sqlite.exec('DROP TRIGGER reject_endpoint_projection'); }
  assert.equal(sqlite.prepare('SELECT stopped_at FROM mobile_trips WHERE id=?').get(id).stopped_at,null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mobile_points WHERE trip=?').get(id).n,1);
  assert.equal((await call('trips/stop',stop,token)).body.endpointStatus,'captured');
});

test('authorization loss cannot be upgraded to a verified endpoint by a later stop',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const id=(await call('trips/start',{requestId:randomUUID(),fix:point()},token)).body.tripId;
  now+=1000;const p={seq:1,time:now,elapsedMs:1000,lat:13,lng:80,accuracy:5};
  assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).status,200);
  sqlite.prepare('UPDATE workforce_profiles SET data=? WHERE employee=?').run(JSON.stringify({department:'Office Admin'}),ids.employee);
  assert.equal((await call('trips/lease',{tripId:id},token)).body.active,false);
  const ack=await call('trips/stop',{tripId:id,stoppedAt:now,reason:'employee_stopped',endpoint:{status:'captured',seq:1}},token);
  assert.equal(ack.status,200);assert.equal(ack.body.endpointStatus,'unverified');
  sqlite.prepare('UPDATE workforce_profiles SET data=? WHERE employee=?').run(JSON.stringify({department:'Sales'}),ids.employee);
  sqlite.prepare('UPDATE mobile_sessions SET expires=1 WHERE account=?').run(ids.employee);
  assert.equal((await call('trips/stop',{tripId:id,stoppedAt:now,reason:'employee_stopped'},token)).status,401);
});


test('legacy Pending, Approved and Paid endpoints and audit evidence survive duplicate GPS replay',async t=>{
  let now=Date.now()+900000;t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  for(const status of ['Pending','Approved','Paid']) {
    const id=(await call('trips/start',{requestId:randomUUID(),fix:point()},token)).body.tripId;
    now+=1000;const p={seq:1,time:now,elapsedMs:1000,lat:13.001,lng:80,accuracy:5};
    assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).status,200);
    now+=1000;
    assert.equal((await call('trips/stop',{tripId:id,stoppedAt:now,reason:'employee_stopped'},token)).status,200);
    const read=()=>sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data;
    const legacy={...JSON.parse(read()),status,endVerified:true,endLocation:p,captureNote:'Historical GPS evidence',approval:{by:ids.admin,at:now},payment:{reference:'historical-reference'}};
    delete legacy.endpoint;
    sqlite.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(legacy),id);
    const original=read(),audits=sqlite.prepare('SELECT * FROM workforce_audit WHERE target=? ORDER BY id').all(id);
    for(let attempt=0;attempt<2;attempt++) assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).body.ackSeq,1);
    assert.equal(read(),original,status+' replay is byte-preserving');
    assert.equal((await call('trips/points/endpoint-v1',{tripId:id,points:[p]},token)).body.ackSeq,1);
    assert.equal((await call('trips/points',{tripId:id,points:[{...p,lat:13.002}]},token)).status,409);
    const historicalStop=await call('trips/stop/endpoint-v1',{tripId:id,stoppedAt:now+60000,reason:'endpoint_timeout',endpoint:{version:1,status:'unverified'}},token);
    assert.equal(historicalStop.status,200);assert.equal(historicalStop.body.endpointStatus,'unverified');
    assert.equal(read(),original,status+' versioned retry, conflicting replay and stop retry preserve history');
    if(status==='Pending') {
      const next={...p,seq:2,time:now,elapsedMs:2000};
      assert.equal((await call('trips/points',{tripId:id,points:[next]},token)).status,200);
      const projected=JSON.parse(read());
      assert.equal(projected.endVerified,true);assert.deepEqual(projected.endLocation,p);
      assert.deepEqual(projected.approval,legacy.approval);assert.deepEqual(projected.payment,legacy.payment);
      // Simulate an existing approval, then replay the newly committed batch.
      projected.status='Approved';sqlite.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(projected),id);
      const approved=read();assert.equal((await call('trips/points',{tripId:id,points:[p,next]},token)).status,200);
      assert.equal(read(),approved);
    } else assert.equal((await call('trips/points',{tripId:id,points:[{...p,seq:2,time:now,elapsedMs:2000}]},token)).status,409);
    assert.deepEqual(sqlite.prepare('SELECT * FROM workforce_audit WHERE target=? ORDER BY id').all(id),audits);
  }
});

test('capabilities are authenticated and start contracts fail closed without breaking legacy clients',async t=>{
  let now=Date.now()+1800000;t.mock.method(Date,'now',()=>now);
  assert.equal((await call('capabilities')).status,401);
  const token=(await login('employee')).body.accessToken;
  assert.deepEqual((await call('capabilities',{},token)).body,{stopContract:1,structuredStopAcknowledgement:true,endpointVersion:1,startPath:'/trips/start/endpoint-v1',stopPath:'/trips/stop/endpoint-v1'});
  const before=sqlite.prepare('SELECT count(*) n FROM mobile_trips').get().n;
  assert.equal((await call('trips/start',{requestId:randomUUID(),fix:point(),stopContract:2},token)).status,409);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mobile_trips').get().n,before);
  const start=await call('trips/start',{requestId:randomUUID(),fix:point(),stopContract:1},token);
  assert.equal(start.status,200);
  assert.equal((await call('trips/stop',{tripId:start.body.tripId,stoppedAt:now,reason:'immediate_stop'},token)).status,200);
  sqlite.prepare('UPDATE mobile_sessions SET expires=1 WHERE account=?').run(ids.employee);
  assert.equal((await call('capabilities',{},token)).status,401);
});

test('freshness boundary snapshot survives delayed persistence, upload and stop retry',async t=>{
  let now=Date.now()+2700000;t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const id=(await call('trips/start',{requestId:randomUUID(),fix:point()},token)).body.tripId;
  now+=1000;const p={seq:1,time:now,elapsedMs:1000,lat:13.001,lng:80,accuracy:5};
  const validatedAt=p.time+10000;
  now=validatedAt+60000; // persistence/upload time must not redefine validation time
  assert.equal((await call('trips/points',{tripId:id,points:[p]},token)).status,200);
  const stop={tripId:id,stoppedAt:validatedAt,reason:'employee_stopped',endpoint:{version:1,status:'captured',seq:1}};
  assert.equal((await call('trips/stop',{...stop,stoppedAt:validatedAt+1},token)).status,409);
  const ack=await call('trips/stop',stop,token);assert.equal(ack.status,200);assert.equal(ack.body.endpointStatus,'captured');
  now+=60000;assert.deepEqual((await call('trips/stop',stop,token)).body,ack.body);
});


test('versioned start and cancellation recover lost responses without duplicate or late orphan trips',async t=>{
  let now=Date.now()+3600000;t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const path='trips/start/endpoint-v1',requestId=randomUUID(),body={requestId,fix:point(),stopContract:1};
  assert.equal((await call(path,body)).status,401);
  const first=await call(path,body,token);assert.equal(first.status,200);
  assert.equal((await call('trips/lease/endpoint-v1',{tripId:first.body.tripId},token)).body.active,true);
  assert.equal(first.body.startContract,'fieldora.endpoint.v1');assert.equal(first.body.requestId,requestId);assert.equal(first.body.accountId,ids.employee);
  const queuedPoint={seq:1,time:now,elapsedMs:1000,lat:13.001,lng:80,accuracy:5};
  assert.equal((await call('trips/points/endpoint-v1',{tripId:first.body.tripId,points:[queuedPoint]},token)).body.ackSeq,1);
  // The response was lost: the same ID must resolve to the same trip, even with a newer fix.
  now+=1000;assert.equal((await call(path,{...body,fix:point()},token)).body.tripId,first.body.tripId);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mobile_trips WHERE account=? AND request_id=?').get(ids.employee,requestId).n,1);
  const otherToken=(await login('other')).body.accessToken;
  assert.equal((await call(path+'/recover',{requestId},otherToken)).body.accountId,ids.other);
  assert.equal(sqlite.prepare('SELECT stopped_at FROM mobile_trips WHERE id=?').get(first.body.tripId).stopped_at,null,'another account cannot cancel this trip');
  assert.equal((await call(path,body,token)).body.tripId,first.body.tripId,'other-account tombstone cannot cancel this request');
  const recover=await call(path+'/recover',{requestId},token);
  assert.deepEqual(recover.body,{startContract:'fieldora.endpoint.v1',requestId,accountId:ids.employee,recovered:true});
  assert.notEqual(sqlite.prepare('SELECT stopped_at FROM mobile_trips WHERE id=?').get(first.body.tripId).stopped_at,null);
  assert.deepEqual((await call(path+'/recover',{requestId},token)).body,recover.body);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workforce_audit WHERE actor=? AND action='mobile.start.cancel' AND target=?").get(ids.employee,requestId).n,1);
  assert.equal((await call(path,body,token)).status,409,'late start cannot recreate a recovered trip');
  const absent=randomUUID();assert.equal((await call(path+'/recover',{requestId:absent},token)).status,200);
  assert.equal((await call(path,{...body,requestId:absent},token)).status,409,'recovery arriving before the original request leaves a tombstone');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mobile_trips WHERE account=? AND request_id=?').get(ids.employee,absent).n,0);
  const stop=await call('trips/stop/endpoint-v1',{tripId:first.body.tripId,stoppedAt:now,reason:'start_cancelled'},token);
  assert.equal(stop.body.endpointStatus,'unverified');assert.equal(stop.body.finalSeq,0);
});

test('mixed-revision routing fails closed on new start paths and retries recovery on compatible revision',async t=>{
  let now=Date.now()+4500000;t.mock.method(Date,'now',()=>now);
  const token=(await login('employee')).body.accessToken;
  const requestId=randomUUID(),path='trips/start/endpoint-v1';
  const before=sqlite.prepare('SELECT count(*) n FROM mobile_trips').get().n;
  // Previous revision knows /capabilities and legacy /trips/start, but not these exact paths.
  const route=(revision,p,b)=>revision==='old' && p.startsWith(path)
    ? Promise.resolve({status:404,body:{error:'Endpoint not found.'}}) : call(p,b,token);
  assert.equal((await route('new','capabilities',{})).body.stopContract,1);
  assert.equal((await route('old',path,{requestId,fix:point()})).status,404);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mobile_trips').get().n,before);
  const start=await route('new',path,{requestId,fix:point()});assert.equal(start.status,200);
  assert.equal((await route('old',path+'/recover',{requestId})).status,404,'lost response remains unresolved on old revision');
  assert.equal((await route('new',path+'/recover',{requestId})).body.recovered,true);
  assert.equal((await route('new',path,{requestId,fix:point()})).status,409);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mobile_trips WHERE request_id=?').get(requestId).n,1);
  // Older clients continue using their original route and response shape.
  const legacy=await call('trips/start',{requestId:randomUUID(),fix:point()},token);assert.equal(legacy.status,200);
  assert.equal(legacy.body.startContract,undefined);
  assert.equal((await call('trips/stop',{tripId:legacy.body.tripId,stoppedAt:now,reason:'immediate_stop'},token)).status,200);
});
