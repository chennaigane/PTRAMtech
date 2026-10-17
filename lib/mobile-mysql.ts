import {redeemWebTicket} from '@/lib/web-native-session';
import {resolveTripLocations} from '@/lib/trip-locations';
import {tripLocationLabel} from '@/lib/trip-labels';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {db} from '@/db/raw';
import {checkLogin, ensureSchema, normalizePhone, sameOrigin, type User} from '@/lib/auth';
import {PointError} from './mobile-point-ingest.mjs';
import {ingestMySQLPoints} from '@/lib/mobile-mysql-points';
import {locked} from '@/lib/workforce-lock';
import {profile, policy, entry, dailyStatement, audit} from '@/lib/workforce-store';
import {travelMode, checkTripFix, checkOfficeStart} from '@/lib/travel-modes';
import {istDate} from '@/lib/workforce-rules';
import {getRate} from '@/lib/settings';
import {tripKm} from '@/lib/geo';
import {MOBILE_CONTRACT, stopEndpoint, projectEndpoint, stopAcknowledgement, legacyStopEvidence, type Endpoint} from '@/lib/mobile-endpoint';
import {mobileWorkforce} from '@/lib/mobile-workforce';

const LEASE = 300000, SESSION = 60 * 60 * 1000, UPLOAD = 7 * 86400000;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const uuid = z.string().uuid();
const fix = z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),accuracy:z.number().positive().max(100),time:z.number().int().positive()});
type Identity = {user: User; hash: string; expires: number};
type Trip = {id:string;account:string;started_at:number;capture_until:number;upload_until:number;last_seq:number;last_time:number;last_elapsed:number;stopped_at:number|null;session_hash:string};
const storage=()=>({prepare:(sql:string)=>({
  get:async(...values:any[])=>await db().prepare(sql).bind(...values).first<any>(),
  all:async(...values:any[])=>(await db().prepare(sql).bind(...values).all<any>()).results,
  run:async(...values:any[])=>await db().prepare(sql).bind(...values).run(),
})});
async function limit(key:string,max:number,duration:number){
 const c=storage(),now=Date.now(),window=Math.floor(now/duration);
 await c.prepare('DELETE FROM mobile_limits WHERE window < ? AND key LIKE ?').run(window-1,key.split(':')[0]+':%');
 await db().transaction!(async()=>{
  await c.prepare('INSERT INTO mobile_limits VALUES(?,?,1) ON DUPLICATE KEY UPDATE count=IF(window=VALUES(window),count+1,1),window=VALUES(window)').run(key,window);
  const row=await c.prepare('SELECT count FROM mobile_limits WHERE key=?').get(key);
  if(Number(row.count)>max)throw new PointError(429,'Too many requests. Try again later.');
 });
}
async function body(req: Request) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new PointError(415,'JSON required.');
  const reader = req.body?.getReader();
  if (!reader) throw new PointError(400,'JSON required.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new PointError(413,'Request too large.'); }
      chunks.push(value);
    }
    try { return z.record(z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new PointError(400,'Invalid JSON object.'); }
  } finally { reader.releaseLock(); }
}
async function identity(req: Request): Promise<Identity> {
  const token = req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new PointError(401,'Sign in required.');
  const hash = digest(token), c = storage();
  const session = (await c.prepare('SELECT account,expires FROM mobile_sessions WHERE token_hash=?').get(hash));
  if (!session || Number(session.expires) <= Date.now()) throw new PointError(401,'Session expired. Sign in again to sync.');
  const user = (await c.prepare('SELECT id,phone,name,role,team,status,created FROM users WHERE id=?').get(session.account!)) as unknown as User;
  if (!user || user.status !== 'active' || !['Admin','Manager','Employee'].includes(user.role)) throw new PointError(403,'Approved account access required.');
  return {user,hash,expires:Number(session.expires)};
}
async function tripFor(id: unknown, account: string): Promise<Trip> {
  const trip = (await storage().prepare('SELECT * FROM mobile_trips WHERE id=? AND account=?').get(uuid.parse(id), account)) as unknown as Trip;
  if (!trip) throw new PointError(404,'Trip not found.');
  return trip;
}
async function project(trip: Trip, endpoint?:Endpoint) {
  const c = storage();
  const row = (await c.prepare("SELECT data FROM records WHERE id=? AND kind='trip'").get(trip.id));
  if (!row) throw new PointError(409,'Trip record requires review.');
  const data = JSON.parse(String(row.data));
  const captured = (await c.prepare('SELECT payload FROM mobile_points WHERE trip=? ORDER BY seq').all(trip.id)).map(r => JSON.parse(String(r.payload)));
  data.points = [data.points[0], ...captured];
  data.km = tripKm(data.points); data.amount = +(data.km * data.rate + data.extra).toFixed(2);
  if (endpoint) data.endpoint = endpoint;
  if (trip.stopped_at !== null) projectEndpoint(data,captured,trip.stopped_at);
  (await c.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),trip.id));
}
async function stopTrip(trip: Trip, at: number, reason: string, input?:unknown) {
  if (trip.stopped_at !== null) return;
  const c = storage();
  const cutoff = Math.max(trip.started_at, trip.last_time, Math.min(at, Date.now(), trip.capture_until));
  const last = await c.prepare('SELECT payload FROM mobile_points WHERE trip=? ORDER BY seq DESC LIMIT 1').get(trip.id);
  const endpoint = stopEndpoint(input,reason,at,cutoff,last ? JSON.parse(String(last.payload)) : undefined);
  (await c.prepare('UPDATE mobile_trips SET stopped_at=?,capture_until=? WHERE id=?').run(cutoff,cutoff,trip.id));
  await project({...trip,stopped_at:cutoff,capture_until:cutoff},endpoint);
  (await c.prepare('INSERT INTO workforce_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),trip.account,'mobile.trip.stop',trip.id,JSON.stringify({reason,endpoint}),Date.now()));
}
async function atomic<T>(work:()=>Promise<T>):Promise<T>{return db().transaction!(work);}
async function operation(req: Request, path: string, b: Record<string,unknown>, enrich:(id:string)=>void) {
  const c = storage(), now = Date.now();
  if (path === 'session/web') return redeemWebTicket(req,b);
  if (path === 'session') {
    await limit('login-global:all',300,60000);
    const phone = normalizePhone(b.phone);
    if (!phone || typeof b.password !== 'string' || !b.password || b.password.length > 128) throw new PointError(400,'Enter a valid phone number and password.');
    await limit('login-phone:' + digest(phone),10,900000);
    const result = await checkLogin(phone,b.password);
    if ('error' in result) throw new PointError(result.status,result.error);
    if (!['Admin','Manager','Employee'].includes(result.user.role)) throw new PointError(403,'Approved account access required.');
    const token = randomBytes(32).toString('hex');
    (await c.prepare('DELETE FROM mobile_sessions WHERE expires<=?').run(now));
    (await c.prepare('INSERT INTO mobile_sessions VALUES(?,?,?)').run(digest(token),result.user.id,now+SESSION));
    const department=(await profile(result.user.id)).department;
    return {accountId:result.user.id,accessToken:token,expiresAt:now+SESSION,name:result.user.name,role:result.user.role,department,travelMode:travelMode(department)};
  }
  // Revalidate inside the workforce lock: an approval/role change cannot be hidden by the UI.
  const auth = await identity(req), account = auth.user.id;
  await limit('account:' + account,120,60000);
  if (path === 'capabilities') return MOBILE_CONTRACT;
  if (path === 'session/logout') {
    await atomic(async () => {
      for (const t of (await c.prepare('SELECT * FROM mobile_trips WHERE session_hash=? AND stopped_at IS NULL').all(auth.hash))) await stopTrip(t as unknown as Trip,now,'logout');
      (await c.prepare('DELETE FROM mobile_sessions WHERE token_hash=?').run(auth.hash));
    });
    return {};
  }
  const versionedStart = path === 'trips/start/endpoint-v1';
  const startContract = 'fieldora.endpoint.v1';
  if (path === 'trips/start/endpoint-v1/recover') {
    const requestId = uuid.parse(b.requestId);
    const old = await c.prepare('SELECT * FROM mobile_trips WHERE account=? AND request_id=?').get(account,requestId) as Trip | undefined;
    await atomic(async () => {
      const cancelled = await c.prepare("SELECT id FROM workforce_audit WHERE actor=? AND action='mobile.start.cancel' AND target=?").get(account,requestId);
      if (!cancelled) await c.prepare('INSERT INTO workforce_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),account,'mobile.start.cancel',requestId,'{}',now);
      if (old) await stopTrip(old,now,'start_cancelled');
    });
    return {startContract,requestId,accountId:account,recovered:true};
  }
  const workforce=await mobileWorkforce(account,path,b);if(workforce)return workforce;
  if (path === 'trips/start' || versionedStart) {
    if (b.stopContract !== undefined && b.stopContract !== MOBILE_CONTRACT.stopContract) throw new PointError(409,'Unsupported mobile stop contract. Update Fieldora before starting a trip.');
    const requestId = uuid.parse(b.requestId);
    if (versionedStart && (await c.prepare("SELECT id FROM workforce_audit WHERE actor=? AND action='mobile.start.cancel' AND target=?").get(account,requestId))) throw new PointError(409,'This start request was cancelled. Use a new request ID.');
    const contract = versionedStart ? {startContract,requestId,accountId:account} : {};
    const old = (await c.prepare('SELECT * FROM mobile_trips WHERE account=? AND request_id=?').get(account,requestId)) as unknown as Trip | undefined;
    if (old) return {...contract,tripId:old.id,leaseMs:old.stopped_at === null && old.session_hash === auth.hash ? Math.max(0,Math.min(LEASE,old.capture_until-now,auth.expires-now)) : 0};
    for (const t of (await c.prepare('SELECT * FROM mobile_trips WHERE account=? AND stopped_at IS NULL AND capture_until<=?').all(account,now))) await atomic(async () => await stopTrip(t as unknown as Trip,Number(t.capture_until),'lease_expired'));
    const mode = travelMode((await profile(account)).department);
    if (mode === 'office') throw new PointError(403,'Your department uses office attendance, not trip tracking.');
    if ((await entry(`daily:${account}:${istDate()}`))?.data.endDay) throw new PointError(409,'Your day is already closed.');
    const point = fix.parse(b.fix); checkTripFix(point);
    const officeDistance = mode === 'driver' ? checkOfficeStart(point,(await policy()).office) : null;
    if ((await c.prepare("SELECT id FROM records WHERE kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling'").get(account))) throw new PointError(409,'An existing trip must be stopped or reviewed first.');
    const id = randomUUID(), deadline = Math.min(now+LEASE,auth.expires), rate = await getRate();
    const startLocation = {...point,deviceTime:point.time,time:now,...(officeDistance === null ? {} : {officeDistance})};
    const data = {employee:account,source:'android',mode,from:mode==='driver'?'Office':'',to:'',points:[point],note:z.string().trim().max(500).optional().parse(b.note)||'',extra:0,rate,start:now,startVerified:true,startLocation,end:null,status:'Travelling',km:0,amount:0};
    await db().batch([
      db().prepare('INSERT INTO mobile_trips(id,account,started_at,capture_until,upload_until,request_id,session_hash) VALUES(?,?,?,?,?,?,?)').bind(id,account,now,deadline,now+UPLOAD,requestId,auth.hash),
      db().prepare("INSERT INTO records VALUES(?,'ptraam','trip',?,?)").bind(id,JSON.stringify(data),now),
      dailyStatement(account,istDate(),{status:'Present',fieldStart:{tripId:id,mode,time:now,location:startLocation},reconciled:false}),
      audit(account,'mobile.trip.start',id,{mode}),
    ]);
    enrich(id);
    return {...contract,tripId:id,leaseMs:deadline-now};
  }
  if (path === 'trips/points/endpoint-v1') path = 'trips/points';
  if (path === 'trips/lease/endpoint-v1') path = 'trips/lease';
  if (!['trips/lease','trips/points','trips/stop','trips/stop/endpoint-v1'].includes(path)) throw new PointError(404,'Endpoint not found.');
  const trip = await tripFor(b.tripId,account);
  if (path === 'trips/lease') {
    const mode = travelMode((await profile(account)).department);
    const record = (await c.prepare('SELECT data FROM records WHERE id=?').get(trip.id));
    const originalMode = record ? JSON.parse(String(record.data)).mode : null;
    if (trip.stopped_at !== null || trip.capture_until<=now || trip.session_hash!==auth.hash || now-trip.started_at>=12*3600000 || mode==='office' || mode!==originalMode) {
      await atomic(async () => await stopTrip(trip,Math.min(now,trip.capture_until),'authorization_ended'));
      return {active:false,leaseMs:0};
    }
    const deadline = Math.min(now+LEASE,auth.expires,trip.started_at+12*3600000);
    (await c.prepare('UPDATE mobile_trips SET capture_until=? WHERE id=?').run(deadline,trip.id));
    return {active:true,leaseMs:deadline-now};
  }
  if (path === 'trips/points') {
    const record = (await c.prepare('SELECT data FROM records WHERE id=?').get(trip.id));
    const status = record ? JSON.parse(String(record.data)).status : null;
    if (!['Travelling','Pending'].includes(status) && Array.isArray(b.points) && b.points.some(p => p && typeof p==='object' && 'seq' in p && Number(p.seq)>trip.last_seq)) throw new PointError(409,'Reviewed trips cannot accept new points. Contact Admin.');
    if (trip.stopped_at !== null && now>trip.upload_until) throw new PointError(410,'Upload window ended. Contact Admin for queue review.');
    if (Array.isArray(b.points) && b.points.some(p => p && typeof p==='object' && 'seq' in p && Number(p.seq)>10000)) throw new PointError(409,'Trip point limit reached. Stop and sync this trip.');
    return ingestMySQLPoints(account,trip.id,b.points,now,() => project(trip));
  }
  const at = z.number().int().positive().parse(b.stoppedAt), reason = z.string().max(100).parse(b.reason);
  const evidence = trip.stopped_at === null ? legacyStopEvidence(path,b.endpoint,b.endpointSeq,reason,at,trip.last_seq,trip.last_time) : {reason,endpoint:b.endpoint};
  await atomic(async () => await stopTrip(trip,at,evidence.reason,evidence.endpoint));
  if (trip.stopped_at === null) enrich(trip.id);
  const stopped = await c.prepare('SELECT data FROM records WHERE id=?').get(trip.id);
  return stopAcknowledgement(trip.id,JSON.parse(String(stopped!.data)));
}
export async function mobileRequest(req: Request): Promise<Response> {

  try {
    if (!sameOrigin(req)) throw new PointError(403,'Invalid origin.');
    const path = new URL(req.url).pathname.replace(/^\/api\/mobile\/v1\//,'');
    const b = await body(req);
    await ensureSchema();
    // Match the lock used by web trip starts and administrative workforce changes.
    let enrichId:string|undefined;
    const result = await locked('workforce',() => operation(req,path,b,id=>{enrichId=id;}));
    // Enrich after commit so provider failures never affect point ACKs.
    const route=path.replace(/\/endpoint-v1$/,'');
    const tripId=route==='trips/start'?(result as {tripId?:string}).tripId:b.tripId;
    if(typeof tripId==='string'&&['trips/start','trips/stop','trips/points'].includes(route)){
      const data=await resolveTripLocations(tripId,tripId===enrichId);
      if(data)return Response.json({...result,journey:{format:'locality-v1',from:tripLocationLabel(data,'start'),to:tripLocationLabel(data,'end')}},{headers:{'Cache-Control':'no-store'}});
    }
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(e) {
    const status = e instanceof PointError ? e.status : e instanceof z.ZodError ? 400 : 409;
    const error = e instanceof PointError ? e.message : e instanceof z.ZodError ? 'Check the request fields.' : 'Unable to complete this operation. Check your GPS, department policy and active trip, then retry.';
    return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
  }
}
