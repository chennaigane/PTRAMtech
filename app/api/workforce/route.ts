import {z} from 'zod';
import {db} from '@/db/raw';
import {getSessionUser,sameOrigin,hashPassword,normalizePhone,passwordProblem,type User} from '@/lib/auth';
import {canView} from '@/lib/permissions';
import {departments,datesBetween,istDate,workingDay,verifyFix} from '@/lib/workforce-rules';
import {travelMode} from '@/lib/travel-modes';
import {audit,entries,entry,policy,profile,put,dailyStatement,invalidatePayroll} from '@/lib/workforce-store';
import {allowed,people,payrollAllowed,reconcile,review,monthlyPayroll} from '@/lib/workforce-service';
import {locked} from '@/lib/workforce-lock';
import {syncSheets,syncConfigured} from '@/lib/sheets-sync';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d=>{try{return datesBetween(d,d).length===1;}catch{return false;}});
const fix=z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),accuracy:z.number().min(0),time:z.number()});
const fence=z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),radius:z.number().min(30).max(2000),maxAccuracy:z.number().positive().max(100)});
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const policySchema=z.object({office:fence.nullable(),workdays:z.array(z.number().int().min(0).max(6)).min(1).max(7),start:time,end:time,holidays:z.array(z.object({date,name:z.string().trim().min(1).max(100),working:z.boolean()})).max(1000),confirmedYears:z.array(z.number().int().min(2020).max(2100)),leaveTypes:z.array(z.object({name:z.string().trim().min(1).max(60),paid:z.boolean(),annual:z.number().min(0).max(366)})).max(30)}).refine(p=>p.start<p.end&&new Set(p.holidays.map(h=>h.date)).size===p.holidays.length&&new Set(p.leaveTypes.map(t=>t.name)).size===p.leaveTypes.length,'Check working hours and duplicate holidays/leave types.');
const profileSchema=z.object({department:z.enum(departments),other:z.string().trim().max(80),salary:z.number().min(0).nullable(),divisor:z.number().positive().max(31).nullable(),otRate:z.number().min(0).nullable(),otMultiplier:z.number().positive().nullable(),payrollAccess:z.boolean()}).refine(p=>p.department!=='Other'||p.other.length>0,'Enter the department name.');
const admin=(u:User)=>{if(u.role!=='Admin')throw Error('Admin permission required.');};
export async function GET(req:Request){try{
 const u=await getSessionUser(req);if(!u)return Response.json({error:'Sign in required.'},{status:401});
 const ps=(await people()).filter(p=>canView(u,p)),ids=new Set(ps.map(p=>p.id)),pay=await payrollAllowed(u),p=await policy();
 const all=(await entries()).filter(e=>ids.has(e.employee)&&(e.kind!=='payroll'||pay));
 const profiles=await Promise.all(ps.map(async person=>{const pr=await profile(person.id);return {employee:person.id,...(pay?pr:{department:pr.department,other:pr.other})};}));
 const logs=u.role==='Admin'?(await db().prepare('SELECT actor,action,target,details,created FROM workforce_audit ORDER BY created DESC LIMIT 50').all()).results:[];
 const alert=u.role==='Admin'?await db().prepare("SELECT value FROM settings WHERE key='sheets_alert'").first<{value:string}>():null;
 const sync=u.role==='Admin'?await db().prepare("SELECT value FROM settings WHERE key='sheets_sync'").first<{value:string}>():null;
 return Response.json({people:ps,profiles,policy:p,entries:all,payrollAccess:pay,audit:logs,sync:u.role==='Admin'?{alert:alert?JSON.parse(alert.value):null,configured:syncConfigured(),...(sync?JSON.parse(sync.value):{status:'Not synced'})}:null},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Unable to load workforce records. Retry shortly.'},{status:503});}}
export async function POST(req:Request){try{
 const u=await getSessionUser(req);if(!u)return Response.json({error:'Sign in required.'},{status:401});
 if(!sameOrigin(req))return Response.json({error:'Invalid origin.'},{status:403});
 const b=z.record(z.unknown()).parse(await req.json());
 const result=await locked('workforce',async()=>{
  if(b.action==='policy'){
   admin(u);const p=policySchema.parse(b.policy);if(b.confirm!==true)throw Error('Explicitly confirm the holiday calendar before saving.');
   await invalidatePayroll();await db().batch([db().prepare("INSERT INTO settings(key,value) VALUES('workforce_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(p)),audit(u.id,'policy.update','company',{before:await policy(),after:p})]);return {};
  }
  if(b.action==='profile'){
   admin(u);const employee=z.string().uuid().parse(b.employee);await allowed(u,employee);const pr=profileSchema.parse(b.profile);
   await invalidatePayroll();await db().batch([db().prepare('INSERT INTO workforce_profiles(employee,data) VALUES(?,?) ON CONFLICT(employee) DO UPDATE SET data=excluded.data').bind(employee,JSON.stringify(pr)),audit(u.id,'profile.update',employee,{before:await profile(employee),after:pr})]);return {};
  }
  if(b.action==='addEmployee'){
   admin(u);const v=z.object({name:z.string().trim().min(2).max(80),phone:z.string(),password:z.string(),role:z.enum(['Employee','Manager']),team:z.string().trim().max(80)}).parse(b);
   const phone=normalizePhone(v.phone),problem=passwordProblem(v.password);if(!phone||problem)throw Error(problem||'Invalid mobile number.');const id=crypto.randomUUID();
   await db().batch([db().prepare("INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,'active',?)").bind(id,phone,v.name,v.role,v.team,await hashPassword(v.password),Date.now()),audit(u.id,'employee.create',id,{name:v.name,role:v.role})]);return {id};
  }
  if(b.action==='checkIn'||b.action==='checkOut'){
   const p=await policy(),pr=await profile(u.id),d=istDate();const mode=travelMode(pr.department);if(mode==='field')throw Error('Marketing and Sales attendance starts with Start Trip in Travel log.');if(mode==='driver')throw Error('Drivers mark attendance by starting a trip inside the office geofence (Travel log → Start trip).');if(!p.office)throw Error('Admin must configure the office geofence.');if(!workingDay(d,p))throw Error('This date is not a configured working day.');
   const point=fix.parse(b.fix);verifyFix(point,p.office);const old=await entry(`daily:${u.id}:${d}`);
   if(old?.data.endDay)throw Error('Your day is already closed. Request an exception for corrections.');
   if(b.action==='checkIn'&&old?.data.checkIn)throw Error('Already checked in today.');
   if(b.action==='checkOut'&&(!old?.data.checkIn||old?.data.checkOut))throw Error('An open check-in is required.');
   const evidence={...point,time:Date.now(),deviceTime:point.time,verified:true};
   await db().batch([dailyStatement(u.id,d,{[b.action]:evidence,status:b.action==='checkOut'?'Present':'Pending',reconciled:false}),audit(u.id,'office.'+b.action,`daily:${u.id}:${d}`,{verified:true})]);return {};
  }
  if(b.action==='endDay'){
   const d=istDate(),active=await db().prepare("SELECT id FROM records WHERE owner='ptraam' AND kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling'").bind(u.id).first();
   if(active)throw Error('Stop your active trip before ending the day.');const old=await entry(`daily:${u.id}:${d}`);if(!old)throw Error('No attendance recorded today.');if(old.data.checkIn&&!old.data.checkOut)throw Error('Check out before ending the day.');
   await db().batch([dailyStatement(u.id,d,{endDay:Date.now()}),audit(u.id,'day.end',old.id,{})]);return {};
  }
  if(b.action==='requestLeave'){
   const v=z.object({from:date,to:date,type:z.string(),reason:z.string().trim().min(3).max(1000)}).parse(b),p=await policy(),type=p.leaveTypes.find(t=>t.name===v.type);if(!type)throw Error('Choose a configured leave type.');if(v.from.slice(0,4)!==v.to.slice(0,4))throw Error('Submit separate requests for each calendar year.');
   const days=datesBetween(v.from,v.to).filter(d=>workingDay(d,p));if(!days.length)throw Error('No working days in this range.');
   const leaves=(await entries('leave')).filter(e=>e.employee===u.id&&['Pending','Approved'].includes(e.data.status));if(leaves.some(e=>e.data.days.some((d:string)=>days.includes(d))))throw Error('A leave request already covers these dates.');
   const used=leaves.filter(e=>e.data.type===type.name&&e.date.slice(0,4)===v.from.slice(0,4)).reduce((n,e)=>n+e.data.days.length,0);if(type.paid&&used+days.length>type.annual)throw Error('Insufficient available leave balance.');
   const e={id:crypto.randomUUID(),employee:u.id,kind:'leave',date:v.from,data:{...v,days,paid:type.paid,status:'Pending'}};await db().batch([put(e),audit(u.id,'leave.request',e.id,{days,type:type.name})]);return {};
  }
  if(b.action==='requestException'||b.action==='requestOvertime'){
   const d=date.parse(b.date),reason=z.string().trim().min(3).max(1000).parse(b.reason),p=await policy();if(d>istDate()||!workingDay(d,p))throw Error('Choose a past or current working day.');
   const kind=b.action==='requestException'?'exception':'overtime';const id=kind==='overtime'?`overtime:${u.id}:${d}`:crypto.randomUUID();
   let data:Record<string,unknown>={reason,status:'Pending'};
   if(kind==='exception')data.requested=z.enum(['Present','Absent']).parse(b.requested);
   else{await reconcile(d,d,u.id);const day=await entry(`daily:${u.id}:${d}`);if(!day?.data.reconciled||!day.data.verifiedOvertimeHours)throw Error('Reconciled, completed GPS records after 6:30 PM are required.');if(await entry(id))throw Error('An overtime request already exists for this date.');data={...data,hours:day.data.verifiedOvertimeHours};}
   await db().batch([put({id,kind,employee:u.id,date:d,data}),audit(u.id,kind+'.request',id,{reason})]);return {};
  }
  if(b.action==='review'){await review(u,z.string().parse(b.id),z.enum(['Approved','Rejected']).parse(b.status),z.string().trim().min(3).max(1000).parse(b.reason));return {};}
  if(b.action==='reconcile'){admin(u);return {count:await reconcile(date.parse(b.from),date.parse(b.to),u.id)};}
  if(b.action==='payroll'){return {rows:await monthlyPayroll(z.string().parse(b.month),u)};}
  if(b.action==='sync'){admin(u);await syncSheets(u.id);return {};}
  throw Error('Unknown action.');
 });return Response.json({ok:true,...result});
 }catch(e){const message=e instanceof z.ZodError?'Please check the entered values.':e instanceof Error?e.message:'Unable to save.';return Response.json({error:message.includes('UNIQUE')?'This account already exists.':message},{status:/permission|denied/i.test(message)?403:400});}}
