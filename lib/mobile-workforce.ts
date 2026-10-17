import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {db} from '@/db/raw';
import {PointError} from './mobile-point-ingest.mjs';
import {audit,dailyStatement,entries,entry,policy,profile,put} from '@/lib/workforce-store';
import {datesBetween,istDate,verifyFix,workingDay} from '@/lib/workforce-rules';
import {travelMode} from '@/lib/travel-modes';
import type {User} from '@/lib/auth';
import {canView,canReview,canPay} from '@/lib/permissions';
import {review,ReviewDeniedError} from '@/lib/workforce-service';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return datesBetween(value,value).length===1;}catch{return false;}});
const fix=z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),accuracy:z.number().positive().max(100),time:z.number().int().positive()});

const denied = () => new PointError(403,'You cannot perform this review.');
async function reviewer(account:string):Promise<User> {
 const u=await db().prepare('SELECT id,phone,name,role,team,status,created FROM users WHERE id=?').bind(account).first<User>();
 if(!u || u.status!=='active' || !['Admin','Manager'].includes(u.role))throw denied();
 return u;
}
async function reviewOwner(u:User,employee:unknown) {
 if(typeof employee!=='string')throw denied();
 const owner=await db().prepare('SELECT id,role,team FROM users WHERE id=?').bind(employee).first<{id:string;role:string;team:string|null}>();
 if(!owner || !canReview(u,owner))throw denied();
 return owner;
}

async function state(account:string){
 const u = await db().prepare('SELECT id,name,role,team FROM users WHERE id=?').bind(account).first<{id:string;name:string;role:string;team:string|null}>();
 const p=await policy(),pr=await profile(account),day=await entry(`daily:${account}:${istDate()}`);
 const allLeave=await entries('leave');
 const leave=allLeave.filter(e=>e.employee===account).slice(-20).reverse().map(e=>({id:e.id,from:e.date,to:e.data.to,type:e.data.type,status:e.data.status}));
 const rows=await db().prepare("SELECT id,data,created FROM records WHERE owner='ptraam' AND kind='trip' ORDER BY created DESC LIMIT 100").all<{id:string;data:string;created:number}>();
 const allTrips=rows.results.map(r=>({id:r.id,data:JSON.parse(r.data),created:r.created}));
 const trips=allTrips.filter(r=>r.data.employee===account).slice(0,20).map(r=>({id:r.id,status:r.data.status,start:r.data.start||r.created,km:r.data.km||0,extra:r.data.extra||0,amount:r.data.amount||0,note:r.data.note||''}));

 let summary: { teamMembers: number; activeTrips: number; pendingExpenses: number; pendingLeave: number } | null = null;
 if (u && (u.role === 'Admin' || u.role === 'Manager')) {
   const users = (await db().prepare("SELECT id, role, team, status FROM users WHERE status='active'").all<{id:string;role:string;team:string|null;status:string}>()).results;
   const scopedUsers = users.filter(usr => canView(u,usr));
   const scopedIds = new Set(scopedUsers.map(usr => usr.id));
   const activeTrips = allTrips.filter(t => scopedIds.has(t.data.employee) && t.data.status === 'Travelling').length;
   const pendingExpenses = allTrips.filter(t => scopedIds.has(t.data.employee) && t.data.status === 'Pending').length;
   const pendingLeave = allLeave.filter(e => scopedIds.has(e.employee) && e.data.status === 'Pending').length;
   summary = { teamMembers: scopedUsers.length, activeTrips, pendingExpenses, pendingLeave };
 }

 return {
  role: u?.role || 'Employee',
  name: u?.name || '',
  team: u?.team || null,
  department: pr.department,
  travelMode: travelMode(pr.department),
  attendance: day ? {
   status: day.data.checkOut ? 'Checked Out' : day.data.checkIn ? 'Checked In' : day.data.status || 'Not Checked In',
   checkIn: day.data.checkIn?.time || null,
   checkOut: day.data.checkOut?.time || null,
   endDay: !!day.data.endDay
  } : { status: 'Not Checked In', checkIn: null, checkOut: null, endDay: false },
  leaveTypes: p.leaveTypes.map(t => t.name),
  leave,
  trips,
  summary
 };
}

export async function mobileWorkforce(account:string,path:string,b:Record<string,unknown>){
 if(path==='workforce/state')return state(account);
 if(path==='attendance'){
  const action=z.enum(['checkIn','checkOut']).parse(b.action),point=fix.parse(b.fix),p=await policy(),pr=await profile(account),d=istDate();
  if(travelMode(pr.department)!=='office')throw new PointError(403,'Your attendance is recorded through the field trip workflow.');
  if(!p.office)throw new PointError(409,'Admin must configure the office geofence.');
  if(!workingDay(d,p))throw new PointError(409,'This date is not a configured working day.');
  verifyFix(point,p.office);const old=await entry(`daily:${account}:${d}`);
  if(old?.data.endDay)throw new PointError(409,'Your day is already closed.');
  if(action==='checkIn'&&old?.data.checkIn)throw new PointError(409,'Already checked in today.');
  if(action==='checkOut'&&(!old?.data.checkIn||old?.data.checkOut))throw new PointError(409,'An open check-in is required.');
  const evidence={...point,time:Date.now(),deviceTime:point.time,verified:true};
  await db().batch([dailyStatement(account,d,{[action]:evidence,status:action==='checkOut'?'Present':'Pending',reconciled:false}),audit(account,'mobile.office.'+action,`daily:${account}:${d}`,{verified:true})]);
  return state(account);
 }
 if(path==='workforce/endDay'){
  const d=istDate(),active=await db().prepare("SELECT id FROM records WHERE owner='ptraam' AND kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling'").bind(account).first();
  if(active)throw new PointError(409,'Stop your active trip before ending the day.');
  const old=await entry(`daily:${account}:${d}`);
  if(!old)throw new PointError(409,'No attendance recorded today.');
  if(old.data.checkIn&&!old.data.checkOut)throw new PointError(409,'Check out before ending the day.');
  await db().batch([dailyStatement(account,d,{endDay:Date.now()}),audit(account,'mobile.day.end',old.id,{})]);
  return state(account);
 }
 if(path==='reviews/pending'){
  const u = await reviewer(account);
  const users = (await db().prepare("SELECT id,name,role,team FROM users").all<{id:string;name:string;role:string;team:string|null}>()).results;
  const scopedUsers = users.filter(usr => canReview(u,usr));
  const scopedIds = new Set(scopedUsers.map(usr => usr.id));
  const allLeave = await entries('leave');
  const pendingLeave = allLeave.filter(e => scopedIds.has(e.employee) && e.data.status === 'Pending')
   .map(e => ({ id: e.id, employeeId: e.employee, employeeName: users.find(usr => usr.id === e.employee)?.name || e.employee, kind: 'leave', from: e.date, to: e.data.to, type: e.data.type, reason: e.data.reason }));
  const rows = await db().prepare("SELECT id,data,created FROM records WHERE owner='ptraam' AND kind='trip' ORDER BY created DESC LIMIT 100").all<{id:string;data:string;created:number}>();
  const pendingTrips = rows.results.map(r => ({id: r.id, data: JSON.parse(r.data), created: r.created}))
   .filter(t => scopedIds.has(t.data.employee) && t.data.status === 'Pending')
   .map(t => ({ id: t.id, employeeId: t.data.employee, employeeName: users.find(usr => usr.id === t.data.employee)?.name || t.data.employee, kind: 'trip', amount: t.data.amount, km: t.data.km, extra: t.data.extra, note: t.data.note }));
  return { pendingLeave, pendingTrips };
 }
 if(path==='reviews/decide'){
  // Both mobile adapters hold the workforce lock across these trusted reads and writes.
  const u = await reviewer(account);
  const parsed = z.object({ id:z.string().min(1).max(200), kind:z.enum(['leave','trip']), status:z.enum(['Approved','Rejected','Paid']), reason:z.string().trim().max(1000).optional() }).strict().safeParse(b);
  if(!parsed.success)throw denied();
  const value=parsed.data;
  if (value.kind === 'leave') {
    const target = await entry(value.id);
    if (!target) throw denied();
    const owner=await reviewOwner(u,target.employee);
    if(value.status==='Paid' && !canPay(u,owner,target.kind))throw denied();
    if(target.kind!=='leave' || target.data.status!=='Pending' || value.status==='Paid' || !value.reason || value.reason.length<3)throw denied();
    try { await review(u,target.id,value.status,value.reason); }
    catch(error) { if(error instanceof ReviewDeniedError)throw denied();throw error; }
    return { success: true };
  } else {
    const row = await db().prepare("SELECT data FROM records WHERE id=? AND owner='ptraam' AND kind='trip'").bind(value.id).first<{data:string}>();
    if (!row) throw denied();
    const trip = JSON.parse(row.data);
    const owner=await reviewOwner(u,trip.employee);
    if(value.status==='Paid' && !canPay(u,owner,'trip'))throw denied();
    // Match the web claim lifecycle: Pending -> Approved -> Paid. Never review
    // an active native capture, reject a claim into an unsupported state, or reopen Paid.
    if(!((trip.status==='Pending' && value.status==='Approved') || (trip.status==='Approved' && value.status==='Paid')))throw denied();
    const previous = trip.status;
    trip.status = value.status;
    trip[value.status==='Approved'?'approvedBy':'paidBy']=u.id;
    // Conditional on the status checked above (defense in depth beside the workforce lock).
    await db().batch([db().prepare("UPDATE records SET data=? WHERE id=? AND owner='ptraam' AND kind='trip' AND json_extract(data,'$.status')=?").bind(JSON.stringify(trip), value.id, previous), audit(account, 'mobile.trip.review', value.id, { decision: value.status })]);
    return { success: true };
  }
 }
 if(path==='leave/request'){
  const value=z.object({from:date,to:date,type:z.string(),reason:z.string().trim().min(3).max(1000)}).parse(b),p=await policy(),type=p.leaveTypes.find(t=>t.name===value.type);
  if(!type)throw new PointError(400,'Choose a configured leave type.');
  if(value.from.slice(0,4)!==value.to.slice(0,4))throw new PointError(400,'Submit separate requests for each calendar year.');
  const days=datesBetween(value.from,value.to).filter(d=>workingDay(d,p));if(!days.length)throw new PointError(400,'No working days in this range.');
  const existing=(await entries('leave')).filter(e=>e.employee===account&&['Pending','Approved'].includes(e.data.status));
  if(existing.some(e=>e.data.days.some((d:string)=>days.includes(d))))throw new PointError(409,'A leave request already covers these dates.');
  const used=existing.filter(e=>e.data.type===type.name&&e.date.slice(0,4)===value.from.slice(0,4)).reduce((n,e)=>n+e.data.days.length,0);
  if(type.paid&&used+days.length>type.annual)throw new PointError(409,'Insufficient available leave balance.');
  const record={id:randomUUID(),employee:account,kind:'leave',date:value.from,data:{...value,days,paid:type.paid,status:'Pending'}};
  await db().batch([put(record),audit(account,'mobile.leave.request',record.id,{days,type:type.name})]);return state(account);
 }
 if(path==='expenses/submit'){
  const value=z.object({tripId:z.string().uuid(),extra:z.number().min(0).max(100000),note:z.string().trim().max(500)}).parse(b);
  const row=await db().prepare("SELECT data FROM records WHERE id=? AND owner='ptraam' AND kind='trip'").bind(value.tripId).first<{data:string}>();
  if(!row)throw new PointError(404,'Trip not found.');const trip=JSON.parse(row.data);
  if(trip.employee!==account)throw new PointError(403,'You can update only your own trip expense.');
  if(!['Travelling','Pending'].includes(trip.status))throw new PointError(409,`${trip.status} trips cannot be edited.`);
  trip.extra=value.extra;trip.note=value.note;trip.amount=+(Number(trip.km||0)*Number(trip.rate||0)+value.extra).toFixed(2);
  await db().batch([db().prepare('UPDATE records SET data=? WHERE id=?').bind(JSON.stringify(trip),value.tripId),audit(account,'mobile.trip.expense',value.tripId,{extra:value.extra})]);
  return {tripId:value.tripId,extra:trip.extra,amount:trip.amount,status:trip.status};
 }
 return null;
}
