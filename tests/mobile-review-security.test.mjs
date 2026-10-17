import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {sqlite} from './cloudflare.mjs';
import {ensureSchema} from '../lib/auth.ts';
import {POST} from '../app/api/mobile/v1/[...path]/route.ts';
import {canPay} from '../lib/permissions.ts';
import {initialPolicy} from '../lib/workforce-rules.ts';

// Production HTTP entry point; the production SQLite adapter uses :memory: only.
process.env.DATABASE_DRIVER='sqlite';
await ensureSchema();
const users={},tokens={};
const definitions={admin:['Admin','A'],manager:['Manager','A'],employee:['Employee','A'],
 other:['Employee','B'],peer:['Manager','A'],adminPeer:['Admin','A'],
 unassigned:['Manager',null],noTeam:['Employee',null]};
for(const name of Object.keys(definitions)){users[name]=randomUUID();tokens[name]=createHash('sha256').update(name).digest('hex');}
async function call(actor,body,path='reviews/decide') {
 const response=await POST(new Request('https://ptraam.test/api/mobile/v1/'+path,{method:'POST',
  headers:{'Content-Type':'application/json',Authorization:'Bearer '+tokens[actor]},body:JSON.stringify(body)}));
 return {status:response.status,body:await response.json()};
}
// Initialize mobile tables through the same route without creating real sessions.
await call('manager',{},'capabilities');
beforeEach(()=>{
 for(const table of ['users','mobile_sessions','mobile_limits','records','workforce_entries','workforce_profiles','workforce_audit','settings'])sqlite.exec(`DELETE FROM ${table}`);
 let n=0;
 for(const [name,[role,team]] of Object.entries(definitions)){
  sqlite.prepare('INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,?,?)')
   .run(users[name],'+91900000000'+n++,name,role,team,'unused','active',Date.now());
  sqlite.prepare('INSERT INTO mobile_sessions VALUES(?,?,?)').run(createHash('sha256').update(tokens[name]).digest('hex'),users[name],Date.now()+3600000);
 }
});
function leave(owner='employee',kind='leave',status='Pending'){
 const id=randomUUID();sqlite.prepare('INSERT INTO workforce_entries(id,kind,employee,date,data,updated) VALUES(?,?,?,?,?,?)')
  .run(id,kind,users[owner]||owner,'2099-01-05',JSON.stringify({status,to:'2099-01-05',days:['2099-01-05'],paid:false,type:'Unpaid',evidence:'retain'}),1);return id;
}
function trip(owner='employee',status='Approved',workspace='ptraam'){
 const id=randomUUID();sqlite.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(id,workspace,'trip',JSON.stringify({employee:users[owner]||owner,status,source:'android',points:[{lat:13,lng:80,time:1}],amount:100,km:2,extra:0,rate:50}),1);return id;
}
const decision=(id,kind='leave',status='Approved')=>({id,kind,status,reason:'Reviewed evidence'});
function snapshot(){return ['users','records','workforce_entries','workforce_profiles','workforce_audit','settings','mobile_sessions','mobile_trips','mobile_points'].map(table=>sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());}
async function denied(actor,body,path){
 const before=snapshot(),response=await call(actor,body,path);
 assert.equal(response.status,403,JSON.stringify(response));
 assert.deepEqual(snapshot(),before,'denial must preserve every business record and audit row');
}

for(const actor of ['admin','manager'])for(const status of ['Approved','Rejected'])test(`${actor} can ${status} authorized leave with review metadata`,async()=>{
 const id=leave(actor==='admin'?'other':'employee');
 assert.equal((await call(actor,decision(id,'leave',status))).status,200);
 const data=JSON.parse(sqlite.prepare('SELECT data FROM workforce_entries WHERE id=?').get(id).data);
 assert.equal(data.status,status);assert.equal(data.reviewedBy,users[actor]);assert.ok(data.reviewedAt);assert.equal(data.reviewReason,'Reviewed evidence');
});
for(const actor of ['admin','manager'])test(`${actor} can approve then pay a scoped completed trip without changing GPS`,async()=>{
 const id=trip(actor==='admin'?'other':'employee','Pending');
 const original=JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
 assert.equal((await call(actor,decision(id,'trip','Approved'))).status,200);
 assert.equal((await call(actor,decision(id,'trip','Paid'))).status,200);
 const data=JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
 assert.deepEqual(data,{...original,status:'Paid',approvedBy:users[actor],paidBy:users[actor]});
});
for(const status of ['Approved','Rejected'])test(`cross-team Manager leave ${status} denied unchanged`,async()=>denied('manager',decision(leave('other'),'leave',status)));
for(const owner of ['peer','adminPeer','manager'])test(`Manager cannot review ${owner} leave`,async()=>denied('manager',decision(leave(owner))));
test('Manager with no assigned team cannot review null-team employee',async()=>denied('unassigned',decision(leave('noTeam'))));
for(const actor of ['manager','admin'])for(const kind of ['daily','leave','payroll'])test(`${actor} cannot pay ${kind} through leave review`,async()=>denied(actor,decision(leave('employee',kind),'leave','Paid')));
test('dedicated payment policy fails closed outside trip claims',()=>{
 for(const resource of ['attendance','daily','leave','payroll','unknown'])for(const role of ['Admin','Manager','Employee'])assert.equal(canPay({id:'a',role,team:'A'},{id:'e',role:'Employee',team:'A'},resource),false);
});
test('Manager cross-team approved trip payment denied unchanged',async()=>denied('manager',decision(trip('other'),'trip','Paid')));
test('Manager cross-team trip approval denied unchanged',async()=>denied('manager',decision(trip('other','Pending'),'trip','Approved')));
for(const actor of ['admin','manager'])for(const status of ['Approved','Paid'])test(`${actor} cannot ${status} active Android trip`,async()=>denied(actor,decision(trip('employee','Travelling'),'trip',status)));
for(const [old,next] of [['Pending','Paid'],['Paid','Approved'],['Paid','Paid'],['Approved','Rejected'],['Pending','Rejected']])test(`trip transition ${old} -> ${next} denied unchanged`,async()=>denied('admin',decision(trip('employee',old),'trip',next)));
for(const kind of ['leave','trip'])test(`Employee cannot review ${kind}`,async()=>denied('employee',decision(kind==='leave'?leave('other'):trip('other','Pending'),kind)));
for(const status of ['pending','rejected','removed'])for(const actor of ['manager','admin'])test(`${status} ${actor} token cannot mutate or list reviews`,async()=>{
 const id=leave();sqlite.prepare('UPDATE users SET status=? WHERE id=?').run(status,users[actor]);
 await denied(actor,decision(id));await denied(actor,{},'reviews/pending');
});
for(const kind of ['daily','payroll','exception'])test(`wrong workforce record kind ${kind} cannot be approved as leave`,async()=>denied('admin',decision(leave('employee',kind))));
for(const kind of ['leave','trip'])test(`nonexistent ${kind} returns 403 without disclosure or mutation`,async()=>denied('admin',decision(randomUUID(),kind)));
for(const body of [{id:17,kind:'leave',status:'Paid'},{id:'',kind:'trip',status:'Paid'},{id:'invalid',kind:'attendance',status:'Paid'}])test(`invalid review input ${JSON.stringify(body)}`,async()=>denied('manager',body));
test('client-supplied scope and roles cannot authorize a cross-team payment',async()=>denied('manager',{...decision(trip('other'),'trip','Paid'),employee:users.employee,team:'A',role:'Admin'}));
test('current database role and target team override previously issued session access',async()=>{
 const id=leave();sqlite.prepare('UPDATE users SET team=? WHERE id=?').run('B',users.employee);
 await denied('manager',decision(id));
 sqlite.prepare('UPDATE users SET team=? WHERE id=?').run('A',users.employee);
 sqlite.prepare('UPDATE users SET role=? WHERE id=?').run('Employee',users.manager);
 await denied('manager',decision(id));await denied('manager',{},'reviews/pending');
});
test('missing owner cannot authorize trip payment',async()=>denied('admin',decision(trip(randomUUID()),'trip','Paid')));
test('other workspace trip is not reviewable',async()=>denied('admin',decision(trip('employee','Approved','other-workspace'),'trip','Paid')));
test('already reviewed leave cannot be overwritten',async()=>denied('admin',decision(leave('employee','leave','Approved'),'leave','Rejected')));
test('paid leave approval preserves the existing allowance checks before mutation',async()=>{
 const id=leave();const data=JSON.parse(sqlite.prepare('SELECT data FROM workforce_entries WHERE id=?').get(id).data);
 sqlite.prepare('UPDATE workforce_entries SET data=? WHERE id=?').run(JSON.stringify({...data,paid:true,type:'Annual'}),id);
 sqlite.prepare('INSERT INTO settings VALUES(?,?)').run('workforce_policy',JSON.stringify({...initialPolicy,leaveTypes:[{name:'Annual',paid:true,annual:0}]}));
 await denied('manager',decision(id));
 sqlite.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({...initialPolicy,leaveTypes:[{name:'Annual',paid:true,annual:1}]}),'workforce_policy');
 assert.equal((await call('manager',decision(id))).status,200);
});
test('Admin retains the existing web policy for own claim review',async()=>{
 assert.equal((await call('admin',decision(leave('admin')))).status,200);
 assert.equal((await call('admin',decision(trip('admin'),'trip','Paid'))).status,200);
});
test('pending list and summary use trusted Employee scope, not team equality alone',async()=>{
 const visible=leave(),hidden=[leave('other'),leave('peer'),leave('adminPeer'),leave('manager')];
 const ownTrip=trip('employee','Pending');trip('other','Pending');trip('peer','Pending');
 const result=await call('manager',{},'reviews/pending');assert.equal(result.status,200);
 assert.deepEqual(result.body.pendingLeave.map(e=>e.id),[visible]);assert.deepEqual(result.body.pendingTrips.map(e=>e.id),[ownTrip]);
 assert.ok(hidden.every(id=>!result.body.pendingLeave.some(e=>e.id===id)));
 const state=await call('manager',{},'workforce/state');assert.equal(state.status,200);
 assert.equal(state.body.summary.teamMembers,2,'own identity plus Employee, not peer Manager/Admin');
 const noTeam=await call('unassigned',{},'reviews/pending');assert.equal(noTeam.status,200);assert.deepEqual(noTeam.body,{pendingLeave:[],pendingTrips:[]});
 await denied('employee',{},'reviews/pending');
});
for(const kind of ['attendance','trip'])test(`Employee cannot mark ${kind} Paid`,async()=>{
 const id=kind==='attendance'?leave('employee','daily'):trip('employee');
 await denied('employee',decision(id,kind==='attendance'?'leave':'trip','Paid'));
});
for(const tokenState of ['expired','revoked','invalid'])test(`${tokenState} bearer token cannot review or mutate records`,async()=>{
 const id=leave(),originalToken=tokens.manager;
 if(tokenState==='expired')sqlite.prepare('UPDATE mobile_sessions SET expires=1 WHERE account=?').run(users.manager);
 if(tokenState==='revoked')sqlite.prepare('DELETE FROM mobile_sessions WHERE account=?').run(users.manager);
 if(tokenState==='invalid')tokens.manager='not-a-valid-token';
 try {
  const before=snapshot();
  for(const path of ['reviews/decide','reviews/pending']){
   assert.equal((await call('manager',path==='reviews/decide'?decision(id):{},path)).status,401);
   assert.deepEqual(snapshot(),before,'authentication rejection must preserve business records');
  }
 } finally {tokens.manager=originalToken;}
});
