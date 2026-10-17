// Web-route parity for the Phase 2A mobile review repairs: the same cross-team
// leave approval and trip payment attempts must be refused by the cookie-session
// web endpoints. In-memory SQLite only; no staging or production database.
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {sqlite} from './cloudflare.mjs';
import {ensureSchema} from '../lib/auth.ts';
import {POST as workforcePost} from '../app/api/workforce/route.ts';
import {POST as recordPost} from '../app/api/records/route.ts';
import {initialPolicy} from '../lib/workforce-rules.ts';

process.env.DATABASE_DRIVER='sqlite';
await ensureSchema();
const definitions={admin:['Admin','A'],manager:['Manager','A'],employee:['Employee','A'],other:['Employee','B']};
const users={},cookies={};
for(const name of Object.keys(definitions)){users[name]=randomUUID();cookies[name]=createHash('sha256').update('web-'+name).digest('hex');}
const headers=actor=>({cookie:`ptraam_session=${cookies[actor]}`,origin:'https://ptraam.test','Content-Type':'application/json'});
async function json(response){return {status:response.status,body:await response.json()};}
const workforce=(actor,body)=>workforcePost(new Request('https://ptraam.test/api/workforce',{method:'POST',headers:headers(actor),body:JSON.stringify(body)})).then(json);
const record=(actor,body)=>recordPost(new Request('https://ptraam.test/api/records',{method:'POST',headers:headers(actor),body:JSON.stringify(body)})).then(json);

beforeEach(()=>{
 for(const table of ['users','sessions','settings','records','workforce_entries','workforce_profiles','workforce_audit','workforce_locks'])sqlite.exec(`DELETE FROM ${table}`);
 let n=0;
 for(const [name,[role,team]] of Object.entries(definitions)){
  sqlite.prepare('INSERT INTO users(id,phone,name,role,team,password_hash,status,created) VALUES(?,?,?,?,?,?,?,?)').run(users[name],'+91910000000'+n++,name,role,team,'unused','active',Date.now());
  sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(cookies[name]).digest('hex'),users[name],Date.now()+3600000);
 }
 sqlite.prepare('INSERT INTO settings VALUES(?,?)').run('workforce_policy',JSON.stringify({...initialPolicy,leaveTypes:[{name:'Unpaid',paid:false,annual:0}]}));
});
function leave(owner){
 const id=randomUUID();
 sqlite.prepare('INSERT INTO workforce_entries(id,kind,employee,date,data,updated) VALUES(?,?,?,?,?,?)')
  .run(id,'leave',users[owner],'2099-01-05',JSON.stringify({status:'Pending',to:'2099-01-05',days:['2099-01-05'],paid:false,type:'Unpaid',reason:'Family'}),1);
 return id;
}
const tripPoints=[{lat:13,lng:80,accuracy:10,time:1},{lat:13.01,lng:80.01,accuracy:10,time:2}];
function trip(owner,status,source='android'){
 const id=randomUUID();
 sqlite.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(id,'ptraam','trip',JSON.stringify({employee:users[owner],status,source,from:'Office',to:'Client',points:tripPoints,km:1.56,rate:5,extra:0,amount:7.8,note:''}),1);
 return id;
}
const tripChange=(id,status)=>({kind:'trip',id,data:{from:'Office',to:'Client',points:tripPoints,status,extra:0,note:''}});
const tripData=id=>JSON.parse(sqlite.prepare('SELECT data FROM records WHERE id=?').get(id).data);
function snapshot(){return ['users','sessions','records','workforce_entries','workforce_profiles','workforce_audit','settings'].map(t=>sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());}
async function refused(request,expected=[403]){
 const before=snapshot(),response=await request();
 assert.ok(expected.includes(response.status),JSON.stringify(response));
 assert.deepEqual(snapshot(),before,'a refused web request must leave every business record unchanged');
}

test('web: Manager approves own-team leave',async()=>{
 const id=leave('employee');
 assert.equal((await workforce('manager',{action:'review',id,status:'Approved',reason:'Reviewed'})).status,200);
 assert.equal(JSON.parse(sqlite.prepare('SELECT data FROM workforce_entries WHERE id=?').get(id).data).status,'Approved');
});
for(const status of ['Approved','Rejected'])test(`web: Manager cross-team leave ${status} is 403 and unchanged`,async()=>{
 const id=leave('other');await refused(()=>workforce('manager',{action:'review',id,status,reason:'Not my team'}));
});
test('web: Employee cannot approve leave',async()=>{const id=leave('other');await refused(()=>workforce('employee',{action:'review',id,status:'Approved',reason:'Peer'}));});
for(const actor of ['admin','manager'])test(`web: ${actor} approves then marks paid a scoped trip, GPS retained`,async()=>{
 const owner=actor==='admin'?'other':'employee',id=trip(owner,'Pending'),original=tripData(id);
 assert.equal((await record(actor,tripChange(id,'Approved'))).status,200);
 assert.equal((await record(actor,tripChange(id,'Paid'))).status,200);
 const data=tripData(id);
 assert.equal(data.status,'Paid');assert.equal(data.paidBy,users[actor]);assert.deepEqual(data.points,original.points);assert.equal(data.employee,original.employee);
});
test('web: Manager cross-team trip approval is 403 and unchanged',async()=>{const id=trip('other','Pending');await refused(()=>record('manager',tripChange(id,'Approved')));});
test('web: Manager cross-team trip payment is 403 and unchanged',async()=>{const id=trip('other','Approved');await refused(()=>record('manager',tripChange(id,'Paid')));});
for(const owner of ['employee','other'])test(`web: Employee cannot mark ${owner==='employee'?'own':'another'} trip Paid`,async()=>{
 const id=trip(owner,'Approved');await refused(()=>record('employee',tripChange(id,'Paid')));
});
for(const actor of ['admin','manager'])test(`web: ${actor} cannot review an active Android trip`,async()=>{
 const id=trip('employee','Travelling');await refused(()=>record(actor,tripChange(id,'Pending')));
});
for(const status of ['pending','rejected','removed'])test(`web: ${status} Manager session cannot approve or pay`,async()=>{
 const leaveId=leave('employee'),tripId=trip('employee','Approved');
 sqlite.prepare('UPDATE users SET status=? WHERE id=?').run(status,users.manager);
 await refused(()=>workforce('manager',{action:'review',id:leaveId,status:'Approved',reason:'Reviewed'}),[401,403]);
 await refused(()=>record('manager',tripChange(tripId,'Paid')),[401,403]);
});
test('web: expired Manager session cannot approve or pay',async()=>{
 const leaveId=leave('employee'),tripId=trip('employee','Approved');
 sqlite.prepare('UPDATE sessions SET expires=1 WHERE user_id=?').run(users.manager);
 await refused(()=>workforce('manager',{action:'review',id:leaveId,status:'Approved',reason:'Reviewed'}),[401]);
 await refused(()=>record('manager',tripChange(tripId,'Paid')),[401]);
});
