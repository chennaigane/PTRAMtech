import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {istDate,atIST,verifyFix,workingDay,initialPolicy,payroll,overtimeHours,datesBetween} from '../lib/workforce-rules.ts';
import {can,canView,canReview} from '../lib/permissions.ts';
import {sheetUpdate,attendanceRows,travelRows} from '../lib/sheets-payload.ts';
import {tripUi,visibleTabs} from '../lib/travel-modes.ts';
import {GET as meGet} from '../app/api/auth/me/route.ts';
import {ensureSchema} from '../lib/auth.ts';
import {POST,GET} from '../app/api/workforce/route.ts';
import {POST as recordPost,GET as recordGet} from '../app/api/records/route.ts';
import {env,sqlite} from './cloudflare.mjs';
import {syncSheets} from '../lib/sheets-sync.ts';
const realNow=Date.now;let now=atIST('2026-10-05','10:00');Date.now=()=>now;
await ensureSchema();
const ids={admin:'00000000-0000-4000-8000-000000000001',manager:'00000000-0000-4000-8000-000000000002',employee:'00000000-0000-4000-8000-000000000003',other:'00000000-0000-4000-8000-000000000004'};
const cookies={};
const policy={...initialPolicy,office:{lat:13,lng:80,radius:150,maxAccuracy:50},workdays:[1,2,3,4,5],confirmedYears:[2026],leaveTypes:[{name:'Annual',paid:true,annual:2},{name:'Unpaid',paid:false,annual:0}]};
const pr={department:'Operations',other:'',salary:null,divisor:null,otRate:null,otMultiplier:null,payrollAccess:false};
function sql(q,...args){return sqlite.prepare(q).run(...args);}
async function call(action,body={},actor='employee',method='POST'){
 const req=new Request('https://ptraam.test/api/workforce',{method,headers:{cookie:`ptraam_session=${cookies[actor]}`,'Content-Type':'application/json',origin:'https://ptraam.test'},...(method==='POST'?{body:JSON.stringify({action,...body})}:{})});
 const r=await (method==='GET'?GET:POST)(req);return {status:r.status,body:await r.json()};
}
async function records(data,actor='employee'){
 const r=await recordPost(new Request('https://ptraam.test/api/records',{method:'POST',headers:{cookie:`ptraam_session=${cookies[actor]}`,origin:'https://ptraam.test','Content-Type':'application/json'},body:JSON.stringify(data)}));return {status:r.status,body:await r.json()};
}
const fix=()=>({lat:13,lng:80,accuracy:10,time:now});
function daily(employee=ids.employee,date='2026-10-05'){const r=sqlite.prepare("SELECT data FROM workforce_entries WHERE id=?").get(`daily:${employee}:${date}`);return r?JSON.parse(r.data):null;}
beforeEach(async()=>{
 now=atIST('2026-10-05','10:00');for(const table of ['users','sessions','settings','records','workforce_entries','workforce_profiles','workforce_audit','workforce_locks'])sqlite.exec(`DELETE FROM ${table}`);
 for(const [i,[name,id]] of Object.entries(ids).entries()){
  sql('INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,?,?)',id,'+91900000000'+i,name,name==='admin'?'Admin':name==='manager'?'Manager':'Employee',name==='other'?'B':'A','unused','active',atIST('2026-01-01','00:00'));
  const raw=(i+1).toString().repeat(64);cookies[name]=raw;const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))).toString('hex');sql('INSERT INTO sessions VALUES(?,?,?)',hash,id,atIST('2027-01-01','00:00'));
  sql('INSERT INTO workforce_profiles VALUES(?,?)',id,JSON.stringify(pr));
 }
 sql('INSERT INTO settings VALUES(?,?)','workforce_policy',JSON.stringify(policy));
});
test('IST day boundary and invalid calendar dates',()=>{assert.equal(istDate(Date.parse('2026-10-04T18:30:00Z')),'2026-10-05');assert.throws(()=>datesBetween('2026-02-30','2026-03-01'));});
test('geofence checks uncertainty circle, stale and invalid fixes',()=>{assert.equal(verifyFix(fix(),policy.office,now),0);for(const p of [{...fix(),accuracy:151},{...fix(),lat:14},{...fix(),time:now-121000},{...fix(),accuracy:-1}])assert.throws(()=>verifyFix(p,policy.office,now));});
test('confirmed holidays excluded and explicit working overrides included',()=>{assert.throws(()=>workingDay('2027-01-01',policy));assert.equal(workingDay('2026-10-10',policy),false);assert.equal(workingDay('2026-10-05',{...policy,holidays:[{date:'2026-10-05',name:'Company holiday',working:false}]}),false);assert.equal(workingDay('2026-10-10',{...policy,holidays:[{date:'2026-10-10',name:'Working Saturday',working:true}]}),true);});
test('LOP and overtime expose formulas without invented inputs',()=>{assert.equal(payroll(null,null,3,2,null,null).lop,null);assert.equal(payroll(30000,25,2,3,100,1.5).lop,2400);assert.equal(payroll(30000,25,2,3,100,1.5).overtime,450);assert.equal(payroll(30000,25,2,3,null,1).overtime,null);});
test('overtime merges overlapping verified intervals and starts at 18:30',()=>{assert.equal(overtimeHours([{start:atIST('2026-10-05','17:00'),end:atIST('2026-10-05','20:00')},{start:atIST('2026-10-05','19:00'),end:atIST('2026-10-05','21:00')}],'2026-10-05'),2.5);});
test('employee cannot see company dashboard or another employee; manager is scoped',()=>{const emp={id:'e',role:'Employee',team:'A'},mgr={id:'m',role:'Manager',team:'A'};assert.equal(can.companyDashboard(emp),false);assert.equal(can.companyDashboard({...emp,role:'unknown'}),false);assert.equal(canView(emp,{...emp,id:'other'}),false);assert.equal(canReview(mgr,emp),true);assert.equal(canReview(mgr,mgr),false);assert.equal(canReview(mgr,{...emp,team:'B'}),false);});
test('office check-in alone remains Pending; verified checkout marks Present',async()=>{assert.equal((await call('checkIn',{fix:fix()})).status,200);assert.equal(daily().status,'Pending');now=atIST('2026-10-05','18:40');assert.equal((await call('checkOut',{fix:fix()})).status,200);assert.equal(daily().status,'Present');assert.equal((await call('checkOut',{fix:fix()})).status,400);});
test('failed office geofence does not create attendance',async()=>{assert.equal((await call('checkIn',{fix:{...fix(),lat:14}})).status,400);assert.equal(daily(),null);});
test('absence appears only after workday; retry creates no duplicates',async()=>{await call('reconcile',{from:'2026-10-05',to:'2026-10-05'},'admin');assert.equal(daily().status,'Pending');now=atIST('2026-10-05','19:00');await call('reconcile',{from:'2026-10-05',to:'2026-10-05'},'admin');await call('reconcile',{from:'2026-10-05',to:'2026-10-05'},'admin');assert.equal(daily().status,'Absent');assert.equal(sqlite.prepare("SELECT count(*) AS n FROM workforce_entries WHERE kind='daily'").get().n,4);});
test('open office attendance stays incomplete until a reviewed exception',async()=>{await call('checkIn',{fix:fix()});now=atIST('2026-10-05','20:00');await call('reconcile',{from:'2026-10-05',to:'2026-10-05'},'admin');assert.equal(daily().reconciled,false);await call('requestException',{date:'2026-10-05',reason:'Device lost GPS at checkout',requested:'Present'});const id=sqlite.prepare("SELECT id FROM workforce_entries WHERE kind='exception'").get().id;assert.equal((await call('review',{id,status:'Approved',reason:'Reviewed with employee'},'manager')).status,200);assert.equal(daily().status,'Present');assert.equal(daily().checkOut,undefined);assert.equal(daily().reconciled,true);});
test('approved paid leave is Absent in summary and retains paid treatment',async()=>{await call('requestLeave',{from:'2026-10-05',to:'2026-10-05',type:'Annual',reason:'Personal leave'});const id=sqlite.prepare("SELECT id FROM workforce_entries WHERE kind='leave'").get().id;now=atIST('2026-10-05','20:00');assert.equal((await call('review',{id,status:'Approved',reason:'Leave approved'},'manager')).status,200);assert.equal(daily().status,'Absent');assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM workforce_entries WHERE id=?').get(id).data).paid,true);assert.equal((await call('review',{id,status:'Approved',reason:'Second review'},'admin')).status,400);});
test('leave overlap, annual limit and non-team approvals are rejected',async()=>{assert.equal((await call('requestLeave',{from:'2026-10-05',to:'2026-10-07',type:'Annual',reason:'Three days'})).status,400);await call('requestLeave',{from:'2026-10-05',to:'2026-10-05',type:'Annual',reason:'One day'});assert.equal((await call('requestLeave',{from:'2026-10-05',to:'2026-10-05',type:'Annual',reason:'Duplicate'})).status,400);const id=sqlite.prepare("SELECT id FROM workforce_entries WHERE kind='leave'").get().id;assert.equal((await call('review',{id,status:'Approved',reason:'Not authorized'},'other')).status,403);});
test('payroll is available to Admin and Manager, and hidden from representatives',async()=>{sql('UPDATE workforce_profiles SET data=? WHERE employee=?',JSON.stringify({...pr,salary:35000}),ids.employee);sql('INSERT INTO workforce_entries VALUES(?,?,?,?,?,?)','payroll:test','payroll',ids.employee,'2026-09',JSON.stringify({salary:35000}),now);const employee=await call('',{},'employee','GET');assert.equal(employee.status,200);assert.equal(employee.body.profiles.find(p=>p.employee===ids.employee).salary,undefined);assert.equal(employee.body.entries.some(e=>e.kind==='payroll'),false);const manager=await call('',{},'manager','GET');assert.equal(manager.status,200);assert.equal(manager.body.profiles.find(p=>p.employee===ids.employee).salary,35000);assert.equal(manager.body.entries.some(e=>e.kind==='payroll'),true);});
test('employee records endpoint does not expose other employee travel',async()=>{sql('INSERT INTO records VALUES(?,?,?,?,?)','foreign','ptraam','trip',JSON.stringify({employee:ids.other,points:[fix()]}),now);const r=await recordGet(new Request('https://ptraam.test/api/records',{headers:{cookie:`ptraam_session=${cookies.employee}`}}));assert.equal((await r.json()).records.length,0);});
const setDept=(department,who='employee')=>sql('UPDATE workforce_profiles SET data=? WHERE employee=?',JSON.stringify({...pr,department}),ids[who]);
const tripStart=(point=fix(),extra={})=>({kind:'trip',data:{from:'',to:'',points:[point],extra:0,note:'Client visit',status:'Travelling',...extra}});
const tripCount=()=>sqlite.prepare("SELECT count(*) AS n FROM records WHERE kind='trip'").get().n;
const stopTrip=(t,to='Customer site',end=fix())=>records({kind:'trip',id:t.id,data:{...t.data,points:[...t.data.points,end],to,status:'Pending'}});
test('Marketing/Sales UI has no Origin branch selector and Start Trip needs no branch',()=>{
 for(const d of ['Marketing','Sales']){const ui=tripUi(d);assert.equal(ui.mode,'field');assert.equal(ui.originBranchSelector,false);assert.equal(ui.startTrip,true);assert.equal(ui.branchArrivalCheckIn,true);}
 const page=readFileSync('app/dashboard/page.tsx','utf8');
 assert.equal(/Origin branch/i.test(page),false,'dashboard must not render an Origin branch selector');
 assert.equal(/form\.from/.test(page),false,'Start Trip must not read a chosen origin');
});
test('Marketing/Sales Start Trip saves the phone GPS fix as the start point and marks Present',async()=>{
 setDept('Marketing');
 // No branches configured and far from the office: start is still allowed, from the captured fix.
 const here={lat:13.2,lng:80.3,accuracy:18,time:now-5000};
 assert.equal(daily(),null);
 const a=await records(tripStart(here));assert.equal(a.status,200,JSON.stringify(a.body));
 assert.equal(a.body.data.from,'');assert.equal(a.body.data.mode,'field');assert.equal(a.body.data.startVerified,true);
 assert.deepEqual({lat:a.body.data.startLocation.lat,lng:a.body.data.startLocation.lng,accuracy:a.body.data.startLocation.accuracy,deviceTime:a.body.data.startLocation.deviceTime},{lat:13.2,lng:80.3,accuracy:18,deviceTime:now-5000});
 assert.equal(a.body.data.startLocation.time,now);assert.equal(a.body.data.start,now);
 assert.equal(daily().status,'Present');assert.equal(daily().fieldStart.tripId,a.body.id);assert.equal(daily().fieldStart.location.lat,13.2);
});
test('Marketing/Sales Start Trip rejects inaccurate, stale or missing GPS without marking Present',async()=>{
 setDept('Sales');
 const bad=[[{...fix(),accuracy:150},/accurate to about 150 m/],[{...fix(),time:now-121000},/out of date/],[{...fix(),lat:Number.NaN},/check the entered values|No usable GPS/i]];
 for(const [p,msg] of bad){const r=await records(tripStart(p));assert.equal(r.status,400);assert.match(r.body.error,msg);}
 assert.equal(tripCount(),0);assert.equal(daily(),null);
});
test('Marketing/Sales: Stop Trip records end time and location; multiple trips and branch arrivals per day',async()=>{
 setDept('Sales');const branch='10000000-0000-4000-8000-000000000001';sql('INSERT INTO records VALUES(?,?,?,?,?)',branch,'ptraam','branch',JSON.stringify({name:'Velachery',address:'',lat:13.1,lng:80.1,radius:150}),now);
 const a=await records(tripStart());assert.equal(a.status,200);assert.equal((await records(tripStart())).status,400,'only one active trip at a time');
 assert.equal((await call('endDay')).status,400,'an active trip blocks End Day');
 // Arrival at a branch is still confirmed by its geofence.
 now+=1800000;const arrive=await records({kind:'attendance',data:{action:'Check in',lat:13.1,lng:80.1,accuracy:10,time:now}});assert.equal(arrive.status,200,JSON.stringify(arrive.body));assert.equal(arrive.body.data.branch,branch);assert.equal(arrive.body.data.tripId,a.body.id);
 assert.equal((await records({kind:'attendance',data:{action:'Check in',lat:13.3,lng:80.1,accuracy:10,time:now}})).status,400,'outside every branch geofence');
 now+=1800000;const stopAt=now;const stop=await stopTrip(a.body,'Velachery branch',{lat:13.1,lng:80.1,accuracy:12,time:now});assert.equal(stop.status,200);
 assert.equal(stop.body.data.end,stopAt);assert.equal(stop.body.data.endVerified,true);assert.equal(stop.body.data.endLocation.lat,13.1);assert.equal(stop.body.data.endLocation.accuracy,12);assert.equal(stop.body.data.endLocation.time,stopAt);assert.equal(stop.body.data.status,'Pending');
 const b=await records(tripStart({lat:13.1,lng:80.1,accuracy:10,time:now}));assert.equal(b.status,200,'second trip the same day');now+=600000;
 assert.equal((await stopTrip(b.body,'Office',{...fix(),accuracy:150})).status,400,'inaccurate end fix is rejected');
 assert.equal((await stopTrip(b.body)).status,200);assert.equal(tripCount(),2);assert.equal(daily().status,'Present');
 assert.equal((await call('endDay')).status,200);assert.equal((await records(tripStart())).status,400,'no trips after End Day');
});
test('Drivers can start a trip only inside the office geofence',async()=>{
 setDept('Driver');assert.equal(tripUi('Driver').mode,'driver');assert.equal(tripUi('Driver').startTrip,true);assert.equal(tripUi('Driver').originBranchSelector,false);
 // Office not configured yet.
 sql("UPDATE settings SET value=? WHERE key='workforce_policy'",JSON.stringify({...policy,office:null}));
 let r=await records(tripStart());assert.equal(r.status,400);assert.match(r.body.error,/office location/);
 sql("UPDATE settings SET value=? WHERE key='workforce_policy'",JSON.stringify(policy));
 // ~1.1 km away, and just outside once GPS uncertainty is counted.
 r=await records(tripStart({...fix(),lat:13.01}));assert.equal(r.status,400);assert.match(r.body.error,/about 1112 m from the office.*150 m office geofence/);
 r=await records(tripStart({...fix(),lat:13.0012,accuracy:20}));assert.equal(r.status,400,'centre inside but accuracy circle crosses the fence');
 r=await records(tripStart({...fix(),accuracy:60}));assert.equal(r.status,400);assert.match(r.body.error,/office requires 50 m/);
 r=await records(tripStart({...fix(),time:now-200000}));assert.equal(r.status,400);assert.match(r.body.error,/out of date/);
 assert.equal(tripCount(),0);assert.equal(daily(),null,'no Present without a valid office start');
 r=await records(tripStart({...fix(),lat:13.0005,accuracy:15}));assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(r.body.data.mode,'driver');assert.equal(r.body.data.from,'Office');assert.equal(r.body.data.startLocation.officeDistance,56);assert.equal(r.body.data.start,now);
 assert.equal(daily().status,'Present');assert.equal(daily().fieldStart.mode,'driver');
 now+=3600000;const stop=await stopTrip(r.body,'Depot',{lat:13.2,lng:80.2,accuracy:10,time:now});assert.equal(stop.status,200);assert.equal(stop.body.data.endLocation.lat,13.2);assert.equal(stop.body.data.end,now);assert.ok(stop.body.data.km>0);
 // Drivers do not use office check-in; their office start is the attendance evidence.
 const c=await call('checkIn',{fix:fix()});assert.equal(c.status,400);assert.match(c.body.error,/Drivers mark attendance/);
 now=atIST('2026-10-05','19:00');await call('reconcile',{from:'2026-10-05',to:'2026-10-05'},'admin');assert.equal(daily().status,'Present');assert.equal(daily().reconciled,true);
});
test('other departments cannot access trip tracking and need office check-in and check-out',async()=>{
 for(const d of ['Operations','Office Admin','HR','Finance','Other']){const ui=tripUi(d);assert.equal(ui.mode,'office');assert.equal(ui.startTrip||ui.stopTrip||ui.routeMap||ui.branchArrivalCheckIn,false);assert.equal(ui.officeCheckInOut,true);
  const tabs=visibleTabs({role:'Employee'},d);for(const t of ['Travel log','Reimbursements','Attendance','Overview'])assert.equal(tabs.includes(t),false,`${d} must not see ${t}`);assert.ok(tabs.includes('Attendance & leave'));}
 for(const d of ['Marketing','Sales','Driver'])assert.ok(visibleTabs({role:'Employee'},d).includes('Travel log'));
 assert.equal(visibleTabs({role:'Employee'},'Driver').includes('Attendance'),false,'branch arrival check-in is field-only');
 // Admin / Manager keep company oversight even when their own department does not travel, but get no Start Trip.
 assert.ok(visibleTabs({role:'Manager'},'Operations').includes('Travel log'));assert.equal(tripUi('Operations').startTrip,false);
 setDept('Operations');
 const r=await records(tripStart());assert.equal(r.status,403);assert.match(r.body.error,/not available for your department/);
 const arrive=await records({kind:'attendance',data:{action:'Check in',lat:13,lng:80,accuracy:10,time:now}});assert.equal(arrive.status,403);
 assert.equal(tripCount(),0);assert.equal(daily(),null);
 const out=await call('checkIn',{fix:{...fix(),lat:13.01}});assert.equal(out.status,400);assert.match(out.body.error,/about 1112 m from the office/);
 const blurry=await call('checkIn',{fix:{...fix(),accuracy:80}});assert.equal(blurry.status,400);assert.match(blurry.body.error,/only accurate to about 80 m/);
 assert.equal(daily(),null);
 assert.equal((await call('checkIn',{fix:fix()})).status,200);assert.equal(daily().status,'Pending','check-in alone is not Present');
 now=atIST('2026-10-05','18:40');assert.equal((await call('checkOut',{fix:{...fix(),lat:13.01}})).status,400);assert.equal(daily().status,'Pending');
 assert.equal((await call('checkOut',{fix:fix()})).status,200);assert.equal(daily().status,'Present');
});
test('employees see only their own records; Admin and Manager review exceptions',async()=>{
 setDept('Sales','employee');setDept('Sales','other');
 const mine=await records(tripStart());const theirs=await records(tripStart(),'other');assert.equal(mine.status,200);assert.equal(theirs.status,200);
 const list=async(actor)=>(await (await recordGet(new Request('https://ptraam.test/api/records',{headers:{cookie:`ptraam_session=${cookies[actor]}`}}))).json()).records.filter(r=>r.kind==='trip').map(r=>r.data.employee).sort();
 assert.deepEqual(await list('employee'),[ids.employee]);assert.deepEqual(await list('other'),[ids.other]);
 assert.deepEqual(await list('admin'),[ids.employee,ids.other].sort());
 const w=await call('',{},'employee','GET');assert.deepEqual(w.body.people.map(p=>p.id),[ids.employee]);assert.ok(w.body.entries.every(e=>e.employee===ids.employee));
 // Another employee cannot stop or edit someone else's trip.
 assert.equal((await stopTrip(theirs.body)).status,403);
 await call('requestException',{date:'2026-10-05',reason:'GPS failed at the office',requested:'Present'},'other');
 const id=sqlite.prepare("SELECT id FROM workforce_entries WHERE kind='exception'").get().id;
 assert.equal((await call('review',{id,status:'Approved',reason:'Self'},'other')).status,403,'no self-approval');
 assert.equal((await call('review',{id,status:'Approved',reason:'Peer'},'employee')).status,403,'employees cannot approve');
 assert.equal((await call('review',{id,status:'Approved',reason:'Checked with employee'},'admin')).status,200);
});
test('sign-in response carries department so the dashboard hides trip tools',async()=>{
 setDept('Driver');const r=await meGet(new Request('https://ptraam.test/api/auth/me',{headers:{cookie:`ptraam_session=${cookies.employee}`}}));const b=await r.json();
 assert.equal(b.user.department,'Driver');assert.equal(b.user.travelMode,'driver');
 const o=await (await meGet(new Request('https://ptraam.test/api/auth/me',{headers:{cookie:`ptraam_session=${cookies.manager}`}}))).json();assert.equal(o.user.travelMode,'office');
});
test('Sheets travel log: GPS start/end points, one row per trip, deterministic retries',()=>{
 const trips=[{id:'t2',data:{employee:'e',mode:'driver',from:'Office',to:'Depot',start:atIST('2026-10-05','09:00'),end:atIST('2026-10-05','10:00'),startVerified:true,endVerified:true,startLocation:{lat:13,lng:80,accuracy:9.6},endLocation:{lat:13.2,lng:80.2,accuracy:12},km:22.1,extra:0,amount:66.3,status:'Pending'}},
  {id:'t1',data:{employee:'e',from:'b1',to:'',start:atIST('2026-10-04','09:00'),end:null,points:[],km:0,extra:0,amount:0,status:'Travelling'}}];
 const rows=travelRows([...trips,trips[0]],()=>'Esha',id=>id==='b1'?'Anna Nagar':id);
 assert.equal(rows.length,3,'duplicate trip ids are written once');assert.equal(rows[0].includes('Origin branch'),false);
 const h=rows[0];const col=n=>h.indexOf(n);
 assert.equal(rows[1][col('Start point (GPS)')],'13.00000, 80.00000 (±10 m)');assert.equal(rows[1][col('End point (GPS)')],'13.20000, 80.20000 (±12 m)');assert.equal(rows[1][col('Trip type')],'Driver (office start)');
 assert.equal(rows[2][col('Start point (GPS)')],'Anna Nagar','legacy branch-start trips keep their branch');assert.equal(rows[2][col('Incomplete')],true);
 assert.ok(rows.every(r=>r.length===h.length));assert.deepEqual(rows,travelRows([...trips,trips[0]],()=>'Esha',id=>id==='b1'?'Anna Nagar':id));
});
test('overtime requires completed verified records and one authorized approval',async()=>{await call('checkIn',{fix:fix()});now=atIST('2026-10-05','20:00');await call('checkOut',{fix:fix()});assert.equal((await call('requestOvertime',{date:'2026-10-05',reason:'Approved work assignment'})).status,200);const e=sqlite.prepare("SELECT id,data FROM workforce_entries WHERE kind='overtime'").get();assert.equal(JSON.parse(e.data).hours,1.5);assert.equal((await call('review',{id:e.id,status:'Approved',reason:'Time verified'},'manager')).status,200);assert.equal((await call('requestOvertime',{date:'2026-10-05',reason:'Duplicate request'})).status,400);});
test('sheet snapshots have exactly four attendance columns and deterministic retries',()=>{const rows=[{id:'b',date:'2026-10-05',name:'B',status:'Absent',reconciled:true},{id:'a',date:'2026-10-05',name:'A',status:'Present',reconciled:true},{id:'c',date:'2026-10-05',name:'C',status:'Pending',reconciled:false}];const a=attendanceRows(rows);assert.deepEqual(a[0],['S.no','Date','Name','Attendance (Present / Absent)']);assert.equal(a.length,3);assert.deepEqual(a,attendanceRows([...rows].reverse()));assert.ok(a.every(r=>r.length===4));const payload=sheetUpdate(1,a,100,26);assert.equal(payload[1].updateCells.range.endRowIndex,100);assert.deepEqual(payload,sheetUpdate(1,a,100,26));assert.equal(sheetUpdate(1,[['=malicious()']],10,4)[1].updateCells.rows[0].values[0].userEnteredValue.stringValue,'=malicious()');});
test('unconfigured Sheets fails visibly and logs no secrets',async()=>{await assert.rejects(()=>syncSheets(ids.admin),/inactive/);const s=JSON.parse(sqlite.prepare("SELECT value FROM settings WHERE key='sheets_sync'").get().value);assert.equal(s.status,'Failed');assert.equal(sqlite.prepare("SELECT count(*) AS n FROM workforce_audit WHERE action='sheets.failure'").get().n,1);});
test('migration can be retried and preserves existing user and trip records',()=>{const d=new DatabaseSync(':memory:');d.exec(readFileSync('drizzle/0000_friendly_mattie_franklin.sql','utf8'));const migration=readFileSync('drizzle/0001_uneven_marten_broadcloak.sql','utf8');d.exec(migration);d.prepare('INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,?,?)').run('legacy','+919123456789','Legacy','Representative','Sales','hash','active',1);d.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run('trip','ptraam','trip','{"employee":"legacy"}',1);d.exec(migration);d.exec(migration);assert.equal(d.prepare('SELECT role FROM users').get().role,'Employee');assert.equal(JSON.parse(d.prepare('SELECT data FROM workforce_profiles').get().data).department,'Sales');assert.equal(d.prepare('SELECT count(*) AS n FROM records').get().n,1);d.close();});
process.on('exit',()=>{Date.now=realNow;});

test('Sheets detects drift, restores DB rows, retries identically and blocks unsafe sharing',async()=>{
 const originalFetch=globalThis.fetch;
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 Object.assign(env,{GOOGLE_CLIENT_EMAIL:'integration@example.com',GOOGLE_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----',GOOGLE_SPREADSHEET_ID:'ptraam',GOOGLE_SPREADSHEET_TITLE:'PTRAAM Enterprises',GOOGLE_REPORT_VIEWERS:JSON.stringify({[ids.admin]:'admin@example.com',[ids.manager]:['mohanagane08@gmail.com','chennaigane@gmail.com']})});
 const cells=new Map(),writes=[];let unsafe=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input),json=data=>Response.json(data);
  if(url.hostname==='oauth2.googleapis.com')return json({access_token:'test'});
  if(url.hostname==='www.googleapis.com')return json(url.pathname.endsWith('/permissions')?{permissions:[{type:'user',role:'writer',emailAddress:env.GOOGLE_CLIENT_EMAIL},{type:'user',role:'reader',emailAddress:'admin@example.com'},{type:'user',role:unsafe?'writer':'reader',emailAddress:'mohanagane08@gmail.com'},{type:'user',role:'reader',emailAddress:'chennaigane@gmail.com'}]}:{copyRequiresWriterPermission:false});
  const book='ptraam',titles=['Attendance','Travel Log','Leave Tracker','Payroll'];
  if(url.pathname.endsWith(':batchUpdate')){const body=JSON.parse(init.body);writes.push(body);for(const r of body.requests){if(r.updateCells){const u=r.updateCells;cells.set(book+':'+titles[u.range.sheetId],u.rows.map(r=>r.values.map(c=>Object.values(c.userEnteredValue)[0])));}}return json({});}
  if(url.pathname.includes('/values/')){const title=decodeURIComponent(url.pathname.split('/values/')[1]).slice(1,-1);return json({values:cells.get(book+':'+title)||[]});}
  return json({properties:{title:'PTRAAM Enterprises'},sheets:titles.map((title,sheetId)=>({properties:{title,sheetId,gridProperties:{rowCount:100,columnCount:26}}}))});
 };
 try{
  await syncSheets(ids.admin);const first=structuredClone(writes);for(const title of ['Attendance','Travel Log','Leave Tracker','Payroll'])assert.ok(cells.has('ptraam:'+title));assert.equal(writes.length,1);
  sql("DELETE FROM workforce_audit WHERE action='sheets.drift'");
  await syncSheets(ids.admin);assert.deepEqual(writes.slice(1),first);assert.equal(sqlite.prepare("SELECT count(*) AS n FROM workforce_audit WHERE action='sheets.drift'").get().n,0);
  cells.set('ptraam:Attendance',[['manual edit']]);await syncSheets(ids.admin);
  assert.equal(cells.get('ptraam:Attendance')[0][0],'S.no');assert.equal(sqlite.prepare("SELECT count(*) AS n FROM workforce_audit WHERE action='sheets.drift'").get().n,1);
  const admin=await call('',{},'admin','GET');assert.ok(admin.body.sync.alert);assert.equal((await call('',{},'employee','GET')).body.sync,null);
  unsafe=true;const count=writes.length;await assert.rejects(()=>syncSheets(ids.admin),/Sheets sharing/);assert.equal(writes.length,count);
 }finally{globalThis.fetch=originalFetch;for(const key of ['GOOGLE_CLIENT_EMAIL','GOOGLE_PRIVATE_KEY','GOOGLE_SPREADSHEET_ID','GOOGLE_SPREADSHEET_TITLE','GOOGLE_REPORT_VIEWERS'])delete env[key];}
});
