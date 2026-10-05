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
import {tripKm, type Point} from '@/lib/geo';

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
  if (!user || user.status !== 'active' || user.role !== 'Employee') throw new PointError(403,'Approved employee access required.');
  return {user,hash,expires:Number(session.expires)};
}
async function tripFor(id: unknown, account: string): Promise<Trip> {
  const trip = (await storage().prepare('SELECT * FROM mobile_trips WHERE id=? AND account=?').get(uuid.parse(id), account)) as unknown as Trip;
  if (!trip) throw new PointError(404,'Trip not found.');
  return trip;
}
async function project(trip: Trip) {
  const c = storage();
  const row = (await c.prepare("SELECT data FROM records WHERE id=? AND kind='trip'").get(trip.id));
  if (!row) throw new PointError(409,'Trip record requires review.');
  const data = JSON.parse(String(row.data));
  const captured = (await c.prepare('SELECT payload FROM mobile_points WHERE trip=? ORDER BY seq').all(trip.id)).map(r => JSON.parse(String(r.payload)));
  data.points = [data.points[0], ...captured];
  data.km = tripKm(data.points); data.amount = +(data.km * data.rate + data.extra).toFixed(2);
  if (trip.stopped_at !== null) {
    const last: Point = data.points.at(-1);
    data.end = trip.stopped_at;
    data.status = data.status === 'Travelling' ? 'Pending' : data.status;
    data.endVerified = !!captured.length && Math.abs(trip.stopped_at - last.time) <= 120000;
    data.endLocation = data.endVerified ? last : null;
    data.captureNote = data.endVerified ? 'Native GPS; physical-device validation pending.' : 'No fresh endpoint. Review required; endpoint was not invented.';
  }
  (await c.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),trip.id));
}
async function stopTrip(trip: Trip, at: number, reason: string) {
  if (trip.stopped_at !== null) return;
  const c = storage();
  const cutoff = Math.max(trip.started_at, trip.last_time, Math.min(at, Date.now(), trip.capture_until));
  (await c.prepare('UPDATE mobile_trips SET stopped_at=?,capture_until=? WHERE id=?').run(cutoff,cutoff,trip.id));
  await project({...trip,stopped_at:cutoff,capture_until:cutoff});
  (await c.prepare('INSERT INTO workforce_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),trip.account,'mobile.trip.stop',trip.id,JSON.stringify({reason}),Date.now()));
}
async function atomic<T>(work:()=>Promise<T>):Promise<T>{return db().transaction!(work);}
async function operation(req: Request, path: string, b: Record<string,unknown>) {
  const c = storage(), now = Date.now();
  if (path === 'session') {
    await limit('login-global:all',300,60000);
    const phone = normalizePhone(b.phone);
    if (!phone || typeof b.password !== 'string' || !b.password || b.password.length > 128) throw new PointError(400,'Enter a valid phone number and password.');
    await limit('login-phone:' + digest(phone),10,900000);
    const result = await checkLogin(phone,b.password);
    if ('error' in result) throw new PointError(result.status,result.error);
    if (result.user.role !== 'Employee') throw new PointError(403,'Admin and Manager accounts use the web dashboard.');
    const token = randomBytes(32).toString('hex');
    (await c.prepare('DELETE FROM mobile_sessions WHERE expires<=?').run(now));
    (await c.prepare('INSERT INTO mobile_sessions VALUES(?,?,?)').run(digest(token),result.user.id,now+SESSION));
    return {accountId:result.user.id,accessToken:token,expiresAt:now+SESSION,name:result.user.name,role:result.user.role};
  }
  // Revalidate inside the workforce lock: an approval/role change cannot be hidden by the UI.
  const auth = await identity(req), account = auth.user.id;
  await limit('account:' + account,120,60000);
  if (path === 'session/logout') {
    await atomic(async () => {
      for (const t of (await c.prepare('SELECT * FROM mobile_trips WHERE session_hash=? AND stopped_at IS NULL').all(auth.hash))) await stopTrip(t as unknown as Trip,now,'logout');
      (await c.prepare('DELETE FROM mobile_sessions WHERE token_hash=?').run(auth.hash));
    });
    return {};
  }
  if (path === 'trips/start') {
    const requestId = uuid.parse(b.requestId);
    const old = (await c.prepare('SELECT * FROM mobile_trips WHERE account=? AND request_id=?').get(account,requestId)) as unknown as Trip | undefined;
    if (old) return {tripId:old.id,leaseMs:old.stopped_at === null && old.session_hash === auth.hash ? Math.max(0,Math.min(LEASE,old.capture_until-now,auth.expires-now)) : 0};
    for (const t of (await c.prepare('SELECT * FROM mobile_trips WHERE account=? AND stopped_at IS NULL AND capture_until<=?').all(account,now))) await atomic(async () => await stopTrip(t as unknown as Trip,Number(t.capture_until),'lease_expired'));
    const mode = travelMode((await profile(account)).department);
    if (mode === 'office') throw new PointError(403,'Your department uses office attendance, not trip tracking.');
    if ((await entry(`daily:${account}:${istDate()}`))?.data.endDay) throw new PointError(409,'Your day is already closed.');
    const point = fix.parse(b.fix); checkTripFix(point);
    const officeDistance = mode === 'driver' ? checkOfficeStart(point,(await policy()).office) : null;
    if ((await c.prepare("SELECT id FROM records WHERE kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling'").get(account))) throw new PointError(409,'An existing trip must be stopped or reviewed first.');
    const id = randomUUID(), deadline = Math.min(now+LEASE,auth.expires), rate = await getRate();
    const startLocation = {...point,deviceTime:point.time,time:now,...(officeDistance === null ? {} : {officeDistance})};
    const data = {employee:account,source:'android',mode,from:mode==='driver'?'Office':'',to:'',points:[point],note:'',extra:0,rate,start:now,startVerified:true,startLocation,end:null,status:'Travelling',km:0,amount:0};
    await db().batch([
      db().prepare('INSERT INTO mobile_trips(id,account,started_at,capture_until,upload_until,request_id,session_hash) VALUES(?,?,?,?,?,?,?)').bind(id,account,now,deadline,now+UPLOAD,requestId,auth.hash),
      db().prepare("INSERT INTO records VALUES(?,'ptraam','trip',?,?)").bind(id,JSON.stringify(data),now),
      dailyStatement(account,istDate(),{status:'Present',fieldStart:{tripId:id,mode,time:now,location:startLocation},reconciled:false}),
      audit(account,'mobile.trip.start',id,{mode}),
    ]);
    return {tripId:id,leaseMs:deadline-now};
  }
  if (!['trips/lease','trips/points','trips/stop'].includes(path)) throw new PointError(404,'Endpoint not found.');
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
  await atomic(async () => await stopTrip(trip,at,reason));
  return {};
}
export async function mobileRequest(req: Request): Promise<Response> {

  try {
    if (!sameOrigin(req)) throw new PointError(403,'Invalid origin.');
    const path = new URL(req.url).pathname.replace(/^\/api\/mobile\/v1\//,'');
    const b = await body(req);
    await ensureSchema();
    // Match the lock used by web trip starts and administrative workforce changes.
    const result = await locked('workforce',() => operation(req,path,b));
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(e) {
    const status = e instanceof PointError ? e.status : e instanceof z.ZodError ? 400 : 409;
    const error = e instanceof PointError ? e.message : e instanceof z.ZodError ? 'Check the request fields.' : 'Unable to complete this operation. Check your GPS, department policy and active trip, then retry.';
    return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
  }
}
