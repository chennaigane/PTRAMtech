import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {db} from '@/db/raw';
import {checkLogin, ensureSchema, normalizePhone, sameOrigin, type User} from '@/lib/auth';
import {mobileSchema, ingestPoints, PointError} from './mobile-point-ingest.mjs';
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
let ready = false;
function schema() {
  if (ready) return;
  const c = db().connection;
  mobileSchema(c);
  const columns = new Set(c.prepare('PRAGMA table_info(mobile_trips)').all().map(r => r.name));
  for (const [name, type] of [['request_id','TEXT'],['session_hash','TEXT'],['stopped_at','INTEGER']]) {
    if (!columns.has(name)) c.exec(`ALTER TABLE mobile_trips ADD COLUMN ${name} ${type}`);
  }
  c.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mobile_request ON mobile_trips(account,request_id);
    CREATE TABLE IF NOT EXISTS mobile_sessions(token_hash TEXT PRIMARY KEY,account TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
  ready = true;
}
function limit(key: string, max: number, duration: number) {
  const c = db().connection, now = Date.now(), window = Math.floor(now / duration);
  c.prepare('DELETE FROM mobile_limits WHERE window < ? AND key LIKE ?').run(window - 1, key.split(':')[0] + ':%');
  const row = c.prepare(`INSERT INTO mobile_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET
    window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END RETURNING count`).get(key,window)!;
  if (Number(row.count) > max) throw new PointError(429, 'Too many requests. Try again later.');
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
function identity(req: Request): Identity {
  const token = req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new PointError(401,'Sign in required.');
  const hash = digest(token), c = db().connection;
  const session = c.prepare('SELECT account,expires FROM mobile_sessions WHERE token_hash=?').get(hash);
  if (!session || Number(session.expires) <= Date.now()) throw new PointError(401,'Session expired. Sign in again to sync.');
  const user = c.prepare('SELECT id,phone,name,role,team,status,created FROM users WHERE id=?').get(session.account!) as unknown as User;
  if (!user || user.status !== 'active' || user.role !== 'Employee') throw new PointError(403,'Approved employee access required.');
  return {user,hash,expires:Number(session.expires)};
}
function tripFor(id: unknown, account: string): Trip {
  const trip = db().connection.prepare('SELECT * FROM mobile_trips WHERE id=? AND account=?').get(uuid.parse(id), account) as unknown as Trip;
  if (!trip) throw new PointError(404,'Trip not found.');
  return trip;
}
function project(trip: Trip) {
  const c = db().connection;
  const row = c.prepare("SELECT data FROM records WHERE id=? AND kind='trip'").get(trip.id);
  if (!row) throw new PointError(409,'Trip record requires review.');
  const data = JSON.parse(String(row.data));
  const captured = c.prepare('SELECT payload FROM mobile_points WHERE trip=? ORDER BY seq').all(trip.id).map(r => JSON.parse(String(r.payload)));
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
  c.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),trip.id);
}
function stopTrip(trip: Trip, at: number, reason: string) {
  if (trip.stopped_at !== null) return;
  const c = db().connection;
  const cutoff = Math.max(trip.started_at, trip.last_time, Math.min(at, Date.now(), trip.capture_until));
  c.prepare('UPDATE mobile_trips SET stopped_at=?,capture_until=? WHERE id=?').run(cutoff,cutoff,trip.id);
  project({...trip,stopped_at:cutoff,capture_until:cutoff});
  c.prepare('INSERT INTO workforce_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),trip.account,'mobile.trip.stop',trip.id,JSON.stringify({reason}),Date.now());
}
function atomic<T>(work: () => T): T {
  const c = db().connection; c.exec('BEGIN IMMEDIATE');
  try { const result = work(); c.exec('COMMIT'); return result; }
  catch(e) { c.exec('ROLLBACK'); throw e; }
}
async function operation(req: Request, path: string, b: Record<string,unknown>) {
  const c = db().connection, now = Date.now();
  if (path === 'session') {
    limit('login-global:all',300,60000);
    const phone = normalizePhone(b.phone);
    if (!phone || typeof b.password !== 'string' || !b.password || b.password.length > 128) throw new PointError(400,'Enter a valid phone number and password.');
    limit('login-phone:' + digest(phone),10,900000);
    const result = await checkLogin(phone,b.password);
    if ('error' in result) throw new PointError(result.status,result.error);
    if (result.user.role !== 'Employee') throw new PointError(403,'Admin and Manager accounts use the web dashboard.');
    const token = randomBytes(32).toString('hex');
    c.prepare('DELETE FROM mobile_sessions WHERE expires<=?').run(now);
    c.prepare('INSERT INTO mobile_sessions VALUES(?,?,?)').run(digest(token),result.user.id,now+SESSION);
    return {accountId:result.user.id,accessToken:token,expiresAt:now+SESSION,name:result.user.name,role:result.user.role};
  }
  // Revalidate inside the workforce lock: an approval/role change cannot be hidden by the UI.
  const auth = identity(req), account = auth.user.id;
  limit('account:' + account,120,60000);
  if (path === 'session/logout') {
    atomic(() => {
      for (const t of c.prepare('SELECT * FROM mobile_trips WHERE session_hash=? AND stopped_at IS NULL').all(auth.hash)) stopTrip(t as unknown as Trip,now,'logout');
      c.prepare('DELETE FROM mobile_sessions WHERE token_hash=?').run(auth.hash);
    });
    return {};
  }
  if (path === 'trips/start') {
    const requestId = uuid.parse(b.requestId);
    const old = c.prepare('SELECT * FROM mobile_trips WHERE account=? AND request_id=?').get(account,requestId) as unknown as Trip | undefined;
    if (old) return {tripId:old.id,leaseMs:old.stopped_at === null && old.session_hash === auth.hash ? Math.max(0,Math.min(LEASE,old.capture_until-now,auth.expires-now)) : 0};
    for (const t of c.prepare('SELECT * FROM mobile_trips WHERE account=? AND stopped_at IS NULL AND capture_until<=?').all(account,now)) atomic(() => stopTrip(t as unknown as Trip,Number(t.capture_until),'lease_expired'));
    const mode = travelMode((await profile(account)).department);
    if (mode === 'office') throw new PointError(403,'Your department uses office attendance, not trip tracking.');
    if ((await entry(`daily:${account}:${istDate()}`))?.data.endDay) throw new PointError(409,'Your day is already closed.');
    const point = fix.parse(b.fix); checkTripFix(point);
    const officeDistance = mode === 'driver' ? checkOfficeStart(point,(await policy()).office) : null;
    if (c.prepare("SELECT id FROM records WHERE kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling'").get(account)) throw new PointError(409,'An existing trip must be stopped or reviewed first.');
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
  const trip = tripFor(b.tripId,account);
  if (path === 'trips/lease') {
    const mode = travelMode((await profile(account)).department);
    const record = c.prepare('SELECT data FROM records WHERE id=?').get(trip.id);
    const originalMode = record ? JSON.parse(String(record.data)).mode : null;
    if (trip.stopped_at !== null || trip.capture_until<=now || trip.session_hash!==auth.hash || now-trip.started_at>=12*3600000 || mode==='office' || mode!==originalMode) {
      atomic(() => stopTrip(trip,Math.min(now,trip.capture_until),'authorization_ended'));
      return {active:false,leaseMs:0};
    }
    const deadline = Math.min(now+LEASE,auth.expires,trip.started_at+12*3600000);
    c.prepare('UPDATE mobile_trips SET capture_until=? WHERE id=?').run(deadline,trip.id);
    return {active:true,leaseMs:deadline-now};
  }
  if (path === 'trips/points') {
    const record = c.prepare('SELECT data FROM records WHERE id=?').get(trip.id);
    const status = record ? JSON.parse(String(record.data)).status : null;
    if (!['Travelling','Pending'].includes(status) && Array.isArray(b.points) && b.points.some(p => p && typeof p==='object' && 'seq' in p && Number(p.seq)>trip.last_seq)) throw new PointError(409,'Reviewed trips cannot accept new points. Contact Admin.');
    if (trip.stopped_at !== null && now>trip.upload_until) throw new PointError(410,'Upload window ended. Contact Admin for queue review.');
    if (Array.isArray(b.points) && b.points.some(p => p && typeof p==='object' && 'seq' in p && Number(p.seq)>10000)) throw new PointError(409,'Trip point limit reached. Stop and sync this trip.');
    return ingestPoints(c,account,trip.id,b.points,now,() => project(trip));
  }
  const at = z.number().int().positive().parse(b.stoppedAt), reason = z.string().max(100).parse(b.reason);
  atomic(() => stopTrip(trip,at,reason));
  return {};
}
export async function mobileRequest(req: Request): Promise<Response> {
  try {
    if (!sameOrigin(req)) throw new PointError(403,'Invalid origin.');
    const path = new URL(req.url).pathname.replace(/^\/api\/mobile\/v1\//,'');
    const b = await body(req);
    await ensureSchema(); schema();
    // Match the lock used by web trip starts and administrative workforce changes.
    const result = await locked('workforce',() => operation(req,path,b));
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(e) {
    const status = e instanceof PointError ? e.status : e instanceof z.ZodError ? 400 : 409;
    const error = e instanceof PointError ? e.message : e instanceof z.ZodError ? 'Check the request fields.' : 'Unable to complete this operation. Check your GPS, department policy and active trip, then retry.';
    return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
  }
}
