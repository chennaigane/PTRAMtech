import {profile,entry,dailyStatement,audit,policy} from '@/lib/workforce-store';
import {travelMode,checkTripFix,checkOfficeStart} from '@/lib/travel-modes';
import {istDate} from '@/lib/workforce-rules';
import {locked} from '@/lib/workforce-lock';
import {ensureSchema,getSessionUser,sameOrigin,type User} from '@/lib/auth';
import {can,canReview,canView,type Person} from '@/lib/permissions';
import {db} from '@/db/raw';
import {getRate} from '@/lib/settings';
import {distance,tripKm,type Point} from '@/lib/geo';
import {z} from 'zod';
// All approved members share one company workspace; each role sees only its permitted slice.
const WORKSPACE='ptraam';
const schemas:any={branch:z.object({name:z.string().min(2).max(80),address:z.string().max(200),lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),radius:z.number().min(30).max(2000)}),trip:z.object({from:z.string().trim().max(100),to:z.string().trim().max(100),points:z.array(z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),accuracy:z.number().min(0).max(5000),time:z.number()})).max(10000),status:z.enum(['Travelling','Pending','Approved','Paid']),extra:z.number().min(0).max(100000),note:z.string().max(500)}).passthrough(),attendance:z.object({branch:z.string().optional(),action:z.enum(['Check in','Check out']),lat:z.number(),lng:z.number(),accuracy:z.number().min(0).max(5000),time:z.number()}),incident:z.object({note:z.string().min(1).max(1000),lat:z.number().nullable(),lng:z.number().nullable(),status:z.enum(['Open','Acknowledged'])})};
const deny=(error:string)=>Response.json({error},{status:403});

/** Members whose work this user may see (id → person). Includes removed members so history keeps names. */
async function visiblePeople(u:User){const r=await db().prepare("SELECT id, name, role, team, phone, status FROM users WHERE status IN ('active','removed')").all<any>();return r.results.filter(p=>canView(u,p));}
async function person(id:string){return await db().prepare('SELECT id, role, team FROM users WHERE id = ?').bind(id).first<Person>();}

export async function GET(req:Request){try{const u=await getSessionUser(req);if(!u)return Response.json({error:'Sign in to load the workspace.'},{status:401});
  const people=await visiblePeople(u);const ids=new Set(people.map(p=>p.id));
  const r=await db().prepare('SELECT * FROM records WHERE owner = ? ORDER BY created DESC').bind(WORKSPACE).all();
  // Branches are visible to everyone (needed to check in); everything else only for permitted people.
  const records=r.results.map((x:any)=>({...x,data:JSON.parse(x.data)})).filter((x:any)=>x.kind==='branch'||(x.kind!=='employee'&&ids.has(x.data.employee)));
  if(!can.companyDashboard(u))for(const p of people)delete p.phone;
  return Response.json({records,people,settings:{rate:await getRate()}},{headers:{'Cache-Control':'no-store'}});
}catch(e){console.error(e);return Response.json({error:'Unable to load records. Please retry.'},{status:503});}}


async function saveRecord(req:Request){try{const u=await getSessionUser(req);if(!u)return Response.json({error:'Sign in required.'},{status:401});if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
await ensureSchema();
const body:any=await req.json();if(!schemas[body.kind])throw new Error('Unknown record type');let data=schemas[body.kind].parse(body.data);const id=body.id?z.string().uuid().parse(body.id):crypto.randomUUID();const current:any=await db().prepare('SELECT * FROM records WHERE id = ? AND owner = ?').bind(id,WORKSPACE).first();if(body.id&&!current)return Response.json({error:'Record not found'},{status:404});if(current&&current.kind!==body.kind)throw new Error('Record type mismatch');
const old=current?JSON.parse(current.data):null;
if(body.kind==='branch'){if(!can.configure(u))return deny('Only the Admin can configure branches.');}
else if(!current)data.employee=u.id; // new trips, check-ins and incidents are always your own
if(body.kind==='attendance'){if(travelMode((await profile(u.id)).department)!=='field')return deny('Branch arrival check-in is only for Marketing and Sales. Use Attendance & leave for your attendance.');const activeVisit=await db().prepare("SELECT id FROM records WHERE owner='ptraam' AND kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling'").bind(u.id).first<{id:string}>();if(!activeVisit)throw new Error('Start a trip before recording a branch visit.');data.tripId=activeVisit.id;if(Math.abs(Date.now()-data.time)>120000)throw new Error('A fresh GPS fix is required.');if(current)return deny('Attendance records cannot be changed.');const last:any=await db().prepare("SELECT data FROM records WHERE owner=? AND kind='attendance' AND json_extract(data,'$.employee')=? ORDER BY created DESC LIMIT 1").bind(WORKSPACE,u.id).first();const prior=last?JSON.parse(last.data):null;
  if(!await db().prepare("SELECT id FROM records WHERE owner=? AND kind='branch' LIMIT 1").bind(WORKSPACE).first())throw new Error('No branches have been set up yet. Ask the Admin to add branches before checking in.');
  if(data.accuracy>100)throw new Error(`Your location is only accurate to about ${Math.round(data.accuracy).toLocaleString('en-IN')} m; check-in needs 100 m or better. Use your phone with Location (GPS) on, ideally outdoors. Computers cannot give a precise enough location.`);
  // No branch chosen: check-out uses the branch you checked in to; check-in finds the branch geofence you are inside.
  if(!data.branch){if(data.action==='Check out'){if(!prior||prior.action!=='Check in')throw new Error('You are not checked in at any branch.');data.branch=prior.branch;}else{const all=await db().prepare("SELECT id, data FROM records WHERE owner=? AND kind='branch'").bind(WORKSPACE).all<any>();const inside=all.results.map((x:any)=>({id:x.id,d:distance(data,JSON.parse(x.data)),radius:JSON.parse(x.data).radius})).filter((x:any)=>Number.isFinite(x.d)&&x.d+data.accuracy<=x.radius).sort((a:any,b:any)=>a.d-b.d);if(!inside.length)throw new Error('You are not inside any branch geofence. Move closer to the branch or improve GPS accuracy.');data.branch=inside[0].id;}}
  const b:any=await db().prepare("SELECT data FROM records WHERE id = ? AND owner = ? AND kind = 'branch'").bind(data.branch,WORKSPACE).first();if(!b)throw new Error('Branch not found');const branch=JSON.parse(b.data);const d=distance(data,branch);if(!Number.isFinite(d)||d+data.accuracy>branch.radius)throw new Error('Location cannot confirm presence inside this branch geofence. Move closer or improve GPS accuracy.');if(data.action==='Check in'&&prior?.action==='Check in')throw new Error('Check out of the current branch first.');if(data.action==='Check out'&&(!prior||prior.action!=='Check in'||prior.branch!==data.branch))throw new Error('Check in at this branch first.');data.distance=Math.round(d);data.verified=true;data.deviceTime=data.time;data.time=Date.now();}
if(body.kind==='incident'){
  if(!current)data.status='Open';
  else{const owner=await person(old.employee);if(!owner||!canReview(u,owner))return deny('You cannot review this incident.');if(old.status!=='Open'||data.status!=='Acknowledged')throw new Error('Invalid incident status change');data={...old,status:'Acknowledged',acknowledgedBy:u.id};}}
if(body.kind==='trip'){
  if(current && old.source==='android' && old.status==='Travelling')return deny('Stop and synchronize this trip from the Android app before reviewing it.');
  if(!current){const mode=travelMode((await profile(u.id)).department);if(mode==='office')return deny('Trip tracking is not available for your department. Use office check-in and check-out in Attendance & leave.');const day=await entry(`daily:${u.id}:${istDate()}`);if(day?.data.endDay)throw new Error('Your day is closed. Request an attendance exception for corrections.');if(data.points.length!==1)throw new Error('Start with one fresh GPS fix.');const startFix=data.points[0];const officeDistance=mode==='driver'?checkOfficeStart(startFix,(await policy()).office):null;if(mode==='field')checkTripFix(startFix);const active=await db().prepare("SELECT id FROM records WHERE owner=? AND kind='trip' AND json_extract(data,'$.employee')=? AND json_extract(data,'$.status')='Travelling' LIMIT 1").bind(WORKSPACE,u.id).first();if(active)throw new Error('You already have an active trip');
    data={employee:u.id,mode,from:mode==='driver'?'Office':'',to:'',points:data.points,note:data.note,extra:0,rate:await getRate(),start:Date.now(),startVerified:true,startLocation:{lat:startFix.lat,lng:startFix.lng,accuracy:startFix.accuracy,deviceTime:startFix.time,time:Date.now(),...(officeDistance!==null?{officeDistance}:{})},end:null,status:'Travelling'};}
  else{const allowed:any={Travelling:['Travelling','Pending'],Pending:['Pending','Approved'],Approved:['Paid'],Paid:[]};if(!allowed[old.status]?.includes(data.status))throw new Error('Invalid claim status change');
    if(data.status===old.status||old.status==='Travelling'){
      // Recording GPS, ending the trip and editing expenses: the traveller only.
      if(old.employee!==u.id)return deny('Only the employee who made this trip can update it.');
      if(old.status==='Travelling'&&(data.points.length<old.points.length||old.points.some((p:any,i:number)=>{const q=data.points[i];return p.time!==q.time||p.lat!==q.lat||p.lng!==q.lng||p.accuracy!==q.accuracy;})))throw new Error('Recorded GPS points cannot be changed.');
      const ending=old.status==='Travelling'&&data.status==='Pending';if(old.status==='Travelling'){const extraPoints:Point[]=data.points.slice(old.points.length);if(extraPoints.some((p:Point,i:number)=>p.time<(i?extraPoints[i-1].time:old.points.at(-1)?.time||old.start)||p.time>Date.now()+5000||p.time<old.start-120000))throw new Error('GPS timestamps must follow the trip timeline.');}if(ending){const end=data.points.at(-1);if(!end)throw new Error('Get a fresh, accurate end location before stopping the trip.');checkTripFix(end);}if(ending&&data.to.length<2)throw new Error('Enter where you ended the trip.');
      data={...old,...(ending?{endVerified:true,endLocation:{...data.points.at(-1),deviceTime:data.points.at(-1).time,time:Date.now()},routeSummary:{samples:data.points.length,from:old.from,to:data.to,distanceKm:tripKm(data.points)}}:{}),to:ending?data.to:old.to,points:old.status==='Travelling'?data.points:old.points,extra:data.extra,note:data.note,status:data.status,end:old.status==='Travelling'&&data.status==='Pending'?Date.now():old.end};}
    else{
      // Approve / mark paid: Admin, or the Manager of the employee's team (never their own claim).
      const owner=await person(old.employee);if(!owner||!canReview(u,owner))return deny(old.employee===u.id?'You cannot approve your own claim.':'You cannot approve this claim.');
      data={...old,status:data.status,[data.status==='Approved'?'approvedBy':'paidBy']:u.id};}}
  data.km=tripKm(data.points);data.amount=+(data.km*data.rate+data.extra).toFixed(2);}
const statements=[db().prepare('INSERT INTO records (id,owner,kind,data,created) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(id,WORKSPACE,body.kind,JSON.stringify(data),current?.created??Date.now())];// A verified trip start (field anywhere, driver inside the office) is the day's Present evidence.
if(body.kind==='trip'&&!current)statements.push(dailyStatement(u.id,istDate(),{status:'Present',fieldStart:{tripId:id,mode:data.mode,time:data.start,location:data.startLocation},reconciled:false}),audit(u.id,'trip.start',id,{mode:data.mode,accuracy:data.startLocation.accuracy}));if(body.kind==='trip'&&current&&old.status!==data.status)statements.push(audit(u.id,'trip.'+data.status,id,{previous:old.status}));await db().batch(statements);return Response.json({id,data});}catch(e:any){return Response.json({error:e?.issues?'Please check the entered values.':e.message||'Unable to save. Please retry.'},{status:400});}}

// Delete a trip: the traveller (own trips) or the Admin (any trip), only while it is in progress or pending review.
// Approved and paid claims are kept as financial records.
export async function DELETE(req:Request){try{const u=await getSessionUser(req);if(!u)return Response.json({error:'Sign in required.'},{status:401});if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const id=z.string().uuid().parse(new URL(req.url).searchParams.get('id'));
  const row:any=await db().prepare("SELECT data FROM records WHERE id = ? AND owner = ? AND kind = 'trip'").bind(id,WORKSPACE).first();
  if(!row)return Response.json({error:'Trip not found.'},{status:404});
  const trip=JSON.parse(row.data);
  if(trip.startVerified)return deny('Verified trips are attendance evidence and cannot be deleted. Request an attendance exception instead.');
  if(trip.employee!==u.id&&u.role!=='Admin')return deny('You can delete only your own trips.');
  if(!['Travelling','Pending'].includes(trip.status))return deny(`${trip.status} claims cannot be deleted.`);
  await db().prepare('DELETE FROM records WHERE id = ? AND owner = ?').bind(id,WORKSPACE).run();
  return Response.json({ok:true});
}catch(e:any){if(e?.issues)return Response.json({error:'Invalid trip.'},{status:400});console.error(e);return Response.json({error:'Unable to delete the trip. Please retry.'},{status:503});}}

export async function POST(req:Request){await ensureSchema();try{return await locked('workforce',()=>saveRecord(req));}catch{return Response.json({error:'Another update is in progress. Retry shortly.'},{status:409});}}
