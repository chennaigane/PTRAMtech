import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {db} from '@/db/raw';
import {getSessionUser,sameOrigin,type User} from '@/lib/auth';
import {profile} from '@/lib/workforce-store';
import {travelMode} from '@/lib/travel-modes';
import {PointError} from './mobile-point-ingest.mjs';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
// Uses existing audit/session tables; no new schema or migration. Call under workforce lock.
export async function issueWebTicket(req:Request,b:Record<string,unknown>){
 if(!req.headers.get('origin')||!sameOrigin(req))throw new PointError(403,'Invalid origin.');
 const u=await getSessionUser(req);
 if(!u||!['Admin','Manager','Employee'].includes(u.role))throw new PointError(401,'Sign in required.');
 if(!valid(b.challenge))throw new PointError(400,'Invalid native challenge.');
 const recent=await db().prepare("SELECT COUNT(*) AS count FROM workforce_audit WHERE actor=? AND action='mobile.web.ticket' AND created>?").bind(u.id,Date.now()-60000).first<{count:number}>();
 if(Number(recent?.count)>9)throw new PointError(429,'Wait before reconnecting.');
 const cookie=(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ptraam_session='));
 const webSessionHash=hash(decodeURIComponent(cookie!.slice('ptraam_session='.length)));
 const code=randomBytes(32).toString('hex');
 await db().prepare('INSERT INTO workforce_audit(id,actor,action,target,details,created) VALUES(?,?,?,?,?,?)').bind(randomUUID(),u.id,'mobile.web.ticket',hash(code),JSON.stringify({challenge:b.challenge,webSessionHash,expires:Date.now()+60000,used:false}),Date.now()).run();
 return {code,expiresIn:60};
}
export async function redeemWebTicket(req:Request,b:Record<string,unknown>){
 if(!valid(b.code)||!valid(b.verifier))throw new PointError(400,'Invalid native handoff.');
 const ticket=await db().prepare("SELECT id,actor,details FROM workforce_audit WHERE action='mobile.web.ticket' AND target=?").bind(hash(b.code)).first<{id:string;actor:string;details:string}>();
 if(!ticket)throw new PointError(403,'Native handoff expired or already used.');
 const d=JSON.parse(ticket.details);
 if(d.used||d.expires<=Date.now()||!valid(d.challenge)||!timingSafeEqual(Buffer.from(hash(b.verifier)),Buffer.from(d.challenge)))throw new PointError(403,'Native handoff expired or already used.');
 const webSession=valid(d.webSessionHash)?await db().prepare('SELECT user_id,expires FROM sessions WHERE token_hash=?').bind(d.webSessionHash).first<{user_id:string;expires:number}>():null;
 if(!webSession||webSession.user_id!==ticket.actor||Number(webSession.expires)<=Date.now())throw new PointError(403,'Web session expired. Sign in again.');
 const u=await db().prepare("SELECT id,name,role,team,status FROM users WHERE id=? AND status='active'").bind(ticket.actor).first<User>();
 if(!u||!['Admin','Manager','Employee'].includes(u.role))throw new PointError(403,'Approved account access required.');
 const old=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 const existing=old?await db().prepare('SELECT account,expires FROM mobile_sessions WHERE token_hash=?').bind(hash(old)).first<{account:string;expires:number}>():null;
 const reuse=!!old&&existing?.account===u.id&&Number(existing.expires)>Date.now();
 const accessToken=reuse?old!:randomBytes(32).toString('hex'),expiresAt=reuse?Number(existing!.expires):Date.now()+3600000;
 const statements=[db().prepare('UPDATE workforce_audit SET details=? WHERE id=?').bind(JSON.stringify({...d,used:true}),ticket.id)];
 if(!reuse)statements.push(db().prepare('INSERT INTO mobile_sessions(token_hash,account,expires) VALUES(?,?,?)').bind(hash(accessToken),u.id,expiresAt));
 await db().batch(statements);
 const department=(await profile(u.id)).department;
 return {accountId:u.id,accessToken,expiresAt,name:u.name,role:u.role,department,travelMode:travelMode(department)};
}
