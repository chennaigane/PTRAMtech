import {db} from '@/db/raw';
import {type User} from '@/lib/auth';
import {canView,canReview} from '@/lib/permissions';
import {atIST,datesBetween,istDate,workingDay,overtimeHours,payroll} from '@/lib/workforce-rules';
import {audit,entries,entry,policy,profile,put,invalidatePayroll,type Entry} from '@/lib/workforce-store';
export async function people(){return (await db().prepare('SELECT id,name,role,team,status,created FROM users').all<User>()).results;}
export async function allowed(u:User,id:string,review=false){const p=(await people()).find(p=>p.id===id);if(!p||!(review?canReview(u,p):canView(u,p)))throw Error('Permission denied for this employee.');return p;}
// Payroll is available to Admins and Managers by role. Managers still see only
// records for employees in their assigned team through the canView filter.
export async function payrollAllowed(u:User){return u.role==='Admin'||u.role==='Manager';}
export async function reconcile(from:string,to:string,actor:string){
 const p=await policy(),users=(await people()).filter(u=>u.status==='active'),all=await entries();
 const raw=(await db().prepare("SELECT id,data,created FROM records WHERE owner='ptraam' AND kind='trip'").all<{id:string;data:string;created:number}>()).results.map(t=>({...JSON.parse(t.data),id:t.id}));
 let count=0;
 for(const date of datesBetween(from,to)){
  if(date>istDate())continue;
  const eligible=workingDay(date,p);
  if(!eligible){for(const old of all.filter(e=>e.kind==='daily'&&e.date===date)){if(old.data.eligible!==false)await invalidatePayroll();await put({...old,data:{...old.data,eligible:false,reconciled:false}}).run();}continue;}
  for(const u of users){
   if(istDate(u.created)>date)continue;
   const id=`daily:${u.id}:${date}`,old=all.find(e=>e.id===id),data={...(old?.data||{})};
   data.eligible=true;
   const trips=raw.filter(t=>t.employee===u.id&&istDate(t.start)===date);
   const leave=all.find(e=>e.kind==='leave'&&e.employee===u.id&&e.data.status==='Approved'&&e.data.days.includes(date));
   const open=trips.some(t=>t.status==='Travelling')||!!(data.checkIn&&!data.checkOut);
   data.incomplete=open;
   data.leave=leave?.id||null;
   // Verified field starts remain Present; office presence requires both verified endpoints.
   const present=!!data.fieldStart||!!(data.checkIn&&data.checkOut)||data.exception==='Present';
   if(data.exception==='Absent')data.status=Date.now()>atIST(date,p.end)?'Absent':'Pending';
   else if(present&&!leave)data.status='Present';
   else if(Date.now()>atIST(date,p.end)&&(!open||data.exception))data.status='Absent';
   else data.status='Pending';
   data.reconciled=Date.now()>atIST(date,p.end)&&(!open||!!data.exception);
   const intervals:{start:number;end:number}[]=trips.filter(t=>t.startVerified&&t.endVerified&&t.end).map(t=>({start:t.start,end:t.end}));
   if(data.checkIn&&data.checkOut)intervals.push({start:data.checkIn.time,end:data.checkOut.time});
   data.verifiedOvertimeHours=overtimeHours(intervals,date);
   const changed=!old||['status','reconciled','leave','verifiedOvertimeHours','eligible'].some(key=>JSON.stringify(old.data[key])!==JSON.stringify(data[key]));if(changed)await invalidatePayroll();await put({id,kind:'daily',employee:u.id,date,data}).run();count++;
  }
 }
 await audit(actor,'attendance.reconcile',from,{to,count}).run();return count;
}
export async function monthlyPayroll(month:string,u:User){
 if(!await payrollAllowed(u))throw Error('Payroll permission required.');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Choose a valid month.');
 const last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
 const p=await policy(),all=await entries(),rows:Entry[]=[];
 if(istDate()<=last)throw Error('Payroll is available after the month has ended.');
 for(const person of (await people()).filter(person=>person.status==='active'&&canView(u,person))){
  const days=datesBetween(month+'-01',last).filter(d=>d>=istDate(person.created)&&workingDay(d,p));
  const daily=all.filter(e=>e.kind==='daily'&&e.employee===person.id&&days.includes(e.date));
  if(days.some(d=>!daily.find(e=>e.date===d&&e.data.reconciled)))throw Error('Reconcile every working day and resolve incomplete attendance before payroll.');
  let unpaid=0;
  for(const d of daily){if(d.data.status==='Absent'){const l=all.find(e=>e.id===d.data.leave);if(!l?.data.paid)unpaid++;}}
  const hours=all.filter(e=>e.kind==='overtime'&&e.employee===person.id&&days.includes(e.date)&&e.data.status==='Approved').reduce((s,e)=>s+Math.min(e.data.hours,daily.find(d=>d.date===e.date)?.data.verifiedOvertimeHours||0),0);
  const pr=await profile(person.id),data={...payroll(pr.salary,pr.divisor,unpaid,hours,pr.otRate,pr.otMultiplier),name:person.name,workingDays:days.length,generatedBy:u.id};
  const row={id:`payroll:${person.id}:${month}`,kind:'payroll',employee:person.id,date:month,data};
  await db().batch([put(row),audit(u.id,'payroll.calculate',row.id,data)]);rows.push({...row,updated:Date.now()});
 }
 return rows;
}
export async function review(u:User,id:string,status:'Approved'|'Rejected',reason:string){
 const e=await entry(id);if(!e||!['leave','exception','overtime'].includes(e.kind))throw Error('Request not found.');
 await allowed(u,e.employee,true);if(e.data.status!=='Pending')throw Error('This request was already reviewed.');
 const data={...e.data,status,reviewedBy:u.id,reviewedAt:Date.now(),reviewReason:reason};
 if(e.kind==='leave'&&status==='Approved'&&e.data.paid){
  const p=await policy(),type=p.leaveTypes.find(t=>t.name===e.data.type);if(!type)throw Error('Leave type is no longer configured.');
  const used=(await entries('leave')).filter(l=>l.id!==id&&l.employee===e.employee&&l.data.type===e.data.type&&l.data.status==='Approved'&&l.date.slice(0,4)===e.date.slice(0,4)).reduce((n,l)=>n+l.data.days.length,0);
  if(used+e.data.days.length>type.annual)throw Error('Insufficient leave balance.');
 }
 const update=db().prepare("UPDATE workforce_entries SET data=?,updated=? WHERE id=? AND json_extract(data,'$.status')='Pending'").bind(JSON.stringify(data),Date.now(),id);
 const statements=[update,audit(u.id,e.kind+'.'+status,id,{reason})];
 if(e.kind==='exception'&&status==='Approved'){
  const day=await entry(`daily:${e.employee}:${e.date}`);
  statements.push(put({id:`daily:${e.employee}:${e.date}`,kind:'daily',employee:e.employee,date:e.date,data:{...day?.data,exception:e.data.requested,exceptionId:e.id,status:e.data.requested,reconciled:false}}));
 }
 await invalidatePayroll();await db().batch(statements);
 await reconcile(e.date,e.kind==='leave'?e.data.to:e.date,u.id);
}
