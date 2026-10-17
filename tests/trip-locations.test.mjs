import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sqlite} from './cloudflare.mjs';
import {ensureSchema,createSession,hashPassword} from '../lib/auth.ts';
import {POST as save,GET as records} from '../app/api/records/route.ts';
import {POST as retry} from '../app/api/trips/resolve/route.ts';
import {reverseGeocode,parseAddress} from '../lib/reverse-geocode.ts';
import {tripLocationLabel} from '../lib/trip-labels.ts';
import {mobileRequest} from '../lib/mobile-api.ts';
import {captureGps} from '../lib/browser-gps.ts';

await ensureSchema();
const employee=randomUUID(),other=randomUUID(),origin='https://ptraam.test';
const password=await hashPassword('Test-password1');
for(const [id,phone] of [[employee,'+919000000001'],[other,'+919000000002']]){
 sqlite.prepare('INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,?,?)').run(id,phone,'Test','Employee','Sales',password,'active',Date.now());
 sqlite.prepare('INSERT INTO workforce_profiles VALUES(?,?)').run(id,JSON.stringify({department:'Sales'}));
}
const cookie=await createSession(new Request(origin),employee),otherCookie=await createSession(new Request(origin),other);
const request=(path,body,session=cookie)=>new Request(origin+path,{method:'POST',headers:{cookie:session,origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const point=(lat,lng,time=Date.now())=>({lat,lng,time,accuracy:8});
const response=(locality,city,country)=>Response.json({features:[{properties:{suburb:locality,city,state:'Provider state',country,formatted:[locality,city,country].join(', '),datasource:{attribution:'© OpenStreetMap contributors'}}}]});
async function start(p){const r=await save(request('/api/records',{kind:'trip',data:{from:'',to:'',points:[p],status:'Travelling',extra:0,note:''}}));assert.equal(r.status,200,await r.clone().text());return r.json();}
async function stop(t,p){return save(request('/api/records',{id:t.id,kind:'trip',data:{...t.data,to:'',points:[...t.data.points,p],status:'Pending'}}));}
const stored=id=>JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
beforeEach(()=>{
 sqlite.exec('DELETE FROM records');sqlite.prepare('DELETE FROM settings WHERE key=?').run('geocode_budget');
 process.env.GEOCODING_PROVIDER='geoapify';process.env.GEOCODING_API_KEY='test-only-key';
 process.env.GEOCODING_REQUESTS_PER_SECOND='50';process.env.GEOCODING_REQUESTS_PER_DAY='2500';
});

test('worldwide start and stop persist distinct addresses, coordinates and labels after reload',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async url=>new URL(url).searchParams.get('lat')==='48.85'?response('Provider locality A','City A','Country A'):response('Provider locality B','City B','Country B'));
 const trip=await start(point(48.85,2.35));
 assert.equal(trip.data.from,'Provider locality A');
 assert.equal(tripLocationLabel(trip.data,'end'),'Travelling');
 now+=3600000;const end=point(51.5,-0.12);
 const stopped=await stop(trip,end);assert.equal(stopped.status,200);
 const saved=stored(trip.id);assert.equal(saved.to,'Provider locality B');
 assert.equal(saved.startLocation.lat,48.85);assert.equal(saved.endLocation.lat,51.5);
 assert.equal(saved.endLocation.accuracy,8);assert.equal(saved.endLocation.deviceTime,end.time);
 assert.equal(saved.points.at(-1).lng,-0.12);assert.equal(saved.status,'Pending');
 const refreshed=await (await records(new Request(origin+'/api/records',{headers:{cookie}}))).json();
 assert.equal(tripLocationLabel(refreshed.records[0].data,'end'),'Provider locality B');
});

test('same-locality endpoints remain separate fixes and use cached provider results',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return response('District','City','Country');});
 const trip=await start(point(-33.86,151.2));now+=5000;
 assert.equal((await stop(trip,point(-33.86,151.2))).status,200);
 assert.equal(calls,1);const data=stored(trip.id);assert.equal(data.from,data.to);assert.notEqual(data.startLocation.time,data.endLocation.time);
});

test('outage preserves GPS and completion; explicit retry fills only missing addresses',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>{throw Error('network');});
 const trip=await start(point(35.68,139.69));now+=10000;
 const end=point(35.69,139.7);assert.equal((await stop(trip,end)).status,200);
 const before=stored(trip.id);assert.equal(before.points.length,2);assert.equal(before.to,'');assert.equal(tripLocationLabel(before,'end'),'Locality pending');
 now+=31000;t.mock.method(globalThis,'fetch',async()=>response('Resolved district','Resolved city','Country'));
 assert.equal((await retry(request('/api/trips/resolve',{id:trip.id},otherCookie))).status,403);
 assert.equal((await retry(request('/api/trips/resolve',{id:trip.id}))).status,200);
 const after=stored(trip.id);assert.deepEqual(after.points,before.points);assert.equal(after.km,before.km);assert.equal(after.end,before.end);assert.equal(after.status,before.status);assert.equal(after.to,'Resolved district');
});

test('new stop requires an additional fresh accurate fix, never the departure',async t=>{
 delete process.env.GEOCODING_API_KEY;
 const trip=await start(point(10,20));
 for(const bad of [trip.data.points[0],point(11,21,1),{...point(11,21),accuracy:101}])assert.equal((await stop(trip,bad)).status,400);
 assert.equal(stored(trip.id).status,'Travelling');
});

test('optional backfill retains old labels, history and missing endpoint evidence',async t=>{
 t.mock.method(globalThis,'fetch',async()=>response('Recovered','City','Country'));
 const id=randomUUID(),data={employee,from:'Legacy branch',to:'Legacy destination',start:1,end:2,status:'Approved',points:[point(40,30,1)],km:10,amount:50};
 sqlite.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(id,'ptraam','trip',JSON.stringify(data),1);
 assert.equal((await retry(request('/api/trips/resolve',{id}))).status,200);
 const after=stored(id);assert.equal(after.from,data.from);assert.equal(after.to,data.to);assert.equal(after.endLocation,undefined);assert.deepEqual(after.points,data.points);assert.equal(after.status,'Approved');
});

test('provider errors, missing configuration, invalid coordinates and global quota degrade safely',async t=>{
 delete process.env.GEOCODING_API_KEY;assert.equal((await reverseGeocode(1,1)).reason,'not_configured');
 process.env.GEOCODING_API_KEY='test-only-key';assert.equal((await reverseGeocode(100,1)).reason,'invalid_coordinates');
 process.env.GEOCODING_REQUESTS_PER_DAY='1';let count=0;
 t.mock.method(globalThis,'fetch',async()=>{count++;return Response.json({features:[]});});
 assert.equal((await reverseGeocode(2,2)).reason,'not_found');
 assert.equal((await reverseGeocode(3,3)).reason,'rate_limited');assert.equal(count,1);
 assert.equal(parseAddress({features:[]}),null);
});

test('Android queued endpoint uploads before stop; names survive duplicate uploads and retry',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async url=>Number(new URL(url).searchParams.get('lat'))===12?response('Native start','A','Country'):response('Native stop','B','Country'));
 const call=async(path,body,token)=>{const r=await mobileRequest(new Request(origin+'/api/mobile/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
 const token=(await call('session',{phone:'+919000000001',password:'Test-password1'})).body.accessToken;
 const started=await call('trips/start',{requestId:randomUUID(),fix:point(12,77)},token);
 assert.deepEqual(started.body.journey,{format:'locality-v1',from:'Native start',to:'Travelling'});
 const id=started.body.tripId;
 assert.equal(stored(id).from,'Native start');now+=60000;
 const endpoint={...point(12.01,77.01),seq:1,elapsedMs:5000};
 assert.equal((await call('trips/stop',{tripId:id,stoppedAt:now,reason:'employee_stopped',endpointSeq:1},token)).status,409);
 now+=20000; // offline sample arrives later, still within its authorized interval
 assert.equal((await call('trips/points',{tripId:id,points:[endpoint]},token)).body.ackSeq,1);
 const stopped=await call('trips/stop',{tripId:id,stoppedAt:endpoint.time,reason:'employee_stopped',endpointSeq:1},token);
 assert.equal(stopped.status,200);assert.deepEqual(stopped.body.journey,{format:'locality-v1',from:'Native start',to:'Native stop'});
 assert.equal(stored(id).to,'Native stop');assert.equal(stored(id).endLocation.time,endpoint.time);
 assert.equal((await call('trips/points',{tripId:id,points:[endpoint]},token)).body.ackSeq,1);
 assert.equal(stored(id).to,'Native stop');assert.equal(stored(id).points.length,2);
});

test('browser permission denied, missing GPS and weak signal show retryable errors',async t=>{
 await assert.rejects(captureGps(null),/unavailable/);
 let cleared=0;
 await assert.rejects(captureGps({watchPosition(ok,fail){fail({code:1});return 7;},clearWatch(){cleared++;}}),/permission denied/);
 assert.equal(cleared,1);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=captureGps({watchPosition(ok){ok({coords:{latitude:1,longitude:2,accuracy:300},timestamp:Date.now()});return 1;},clearWatch(){}});
 t.mock.timers.tick(15000);await assert.rejects(pending,/100 m or better/);
});

test('Phase 1A versioned ACKs include locality without rewriting approved replay history',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async url=>Number(new URL(url).searchParams.get('lat'))===21?response('Start area','City','Country'):response('End area','City','Country'));
 const call=async(path,body,token)=>{const r=await mobileRequest(new Request(origin+'/api/mobile/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
 const token=(await call('session',{phone:'+919000000001',password:'Test-password1'})).body.accessToken;
 const capabilities=await call('capabilities',{},token);assert.equal(capabilities.body.structuredStopAcknowledgement,true);
 const requestId=randomUUID(),started=await call('trips/start/endpoint-v1',{requestId,fix:point(21,71),stopContract:1},token);
 assert.equal(started.body.startContract,'fieldora.endpoint.v1');assert.equal(started.body.requestId,requestId);
 assert.equal(started.body.journey.from,'Start area');const id=started.body.tripId;now+=1000;
 const endpoint={...point(21.01,71.01),seq:1,elapsedMs:1000};
 assert.equal((await call('trips/points/endpoint-v1',{tripId:id,points:[endpoint]},token)).body.ackSeq,1);
 const stop={tripId:id,stoppedAt:now,reason:'employee_stopped',endpoint:{version:1,status:'captured',seq:1}};
 const stopped=await call('trips/stop/endpoint-v1',stop,token);
 assert.deepEqual(stopped.body,{tripId:id,stoppedAt:now,endpointStatus:'captured',finalSeq:1,journey:{format:'locality-v1',from:'Start area',to:'End area'}});
 const data=stored(id);data.status='Paid';data.approval={by:employee};data.payment={reference:'existing'};
 sqlite.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),id);
 const before=sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data;
 const audits=sqlite.prepare('SELECT * FROM workforce_audit WHERE target=? ORDER BY id').all(id);
 now+=60000;
 assert.equal((await call('trips/points/endpoint-v1',{tripId:id,points:[endpoint]},token)).body.ackSeq,1);
 assert.deepEqual((await call('trips/stop/endpoint-v1',stop,token)).body,stopped.body);
 assert.equal(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data,before);
 assert.deepEqual(sqlite.prepare('SELECT * FROM workforce_audit WHERE target=? ORDER BY id').all(id),audits);
});

test('geocoding outage cannot weaken versioned final sequence acknowledgement or rewrite retries',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>{throw Error('offline provider');});
 const call=async(path,body,token)=>{const r=await mobileRequest(new Request(origin+'/api/mobile/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}));return {status:r.status,body:await r.json()};};
 const token=(await call('session',{phone:'+919000000001',password:'Test-password1'})).body.accessToken;
 const start=await call('trips/start/endpoint-v1',{requestId:randomUUID(),fix:point(22,72)},token),id=start.body.tripId;now+=1000;
 const endpoint={...point(22.01,72.01),seq:1,elapsedMs:1000};
 assert.equal((await call('trips/points/endpoint-v1',{tripId:id,points:[endpoint]},token)).body.ackSeq,1);
 const stop={tripId:id,stoppedAt:now,reason:'employee_stopped',endpoint:{status:'captured',seq:2}};
 assert.equal((await call('trips/stop/endpoint-v1',stop,token)).status,409);
 stop.endpoint.seq=1;const ack=await call('trips/stop/endpoint-v1',stop,token);
 assert.equal(ack.status,200);assert.equal(ack.body.finalSeq,1);assert.equal(ack.body.endpointStatus,'captured');
 assert.equal(ack.body.journey.to,'Locality pending');const before=stored(id);now+=60000;
 assert.deepEqual((await call('trips/stop/endpoint-v1',stop,token)).body,ack.body);
 assert.deepEqual(stored(id),before);
});

test('browser discards stale fixes and preserves actual device timestamp',async()=>{
 let callback;
 const captured=captureGps({watchPosition(ok){callback=ok;return 1;},clearWatch(){}});
 callback({coords:{latitude:5,longitude:6,accuracy:5},timestamp:1});
 const time=Date.now();callback({coords:{latitude:7,longitude:8,accuracy:5},timestamp:time});
 assert.deepEqual(await captured,{lat:7,lng:8,accuracy:5,time});
});
