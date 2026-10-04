const env = process.env;
import {reportViewers} from '@/lib/report-viewers';
import {locked} from '@/lib/workforce-lock';
import {canonicalCells,sharingIssues,type ReportPermission} from '@/lib/sheets-policy';
import {db} from '@/db/raw';
import {audit,entries} from '@/lib/workforce-store';
import {people} from '@/lib/workforce-service';
import {attendanceRows,travelRows,sheetUpdate,type Cell} from '@/lib/sheets-payload';
const secrets=()=>({email:env.GOOGLE_CLIENT_EMAIL,key:env.GOOGLE_PRIVATE_KEY,spreadsheet:env.GOOGLE_SPREADSHEET_ID,title:env.GOOGLE_SPREADSHEET_TITLE||'PTRAAM Enterprises'});
export function syncConfigured(){const s=secrets();return Boolean(s.email&&s.key&&s.spreadsheet);}
const b64=(b:Uint8Array)=>btoa(Array.from(b,x=>String.fromCharCode(x)).join('')).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const encode=(s:string)=>b64(new TextEncoder().encode(s));
async function token(){
 const s=secrets();if(!syncConfigured())throw Error('Sheets credentials and spreadsheet ID are not configured.');
 const now=Math.floor(Date.now()/1000),unsigned=encode(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+encode(JSON.stringify({iss:s.email,scope:'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
 const pem=s.key!.replace(/\\n/g,'\n').replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
 const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+b64(new Uint8Array(signature))}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`Google authentication failed (${r.status}).`);const body=await r.json() as {access_token:string};return body.access_token;
}
async function google(access:string,path:string,body?:unknown){
 for(let attempt=0;attempt<3;attempt++){
  let r:Response;try{r=await fetch('https://sheets.googleapis.com/v4/spreadsheets/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}catch{if(attempt===2)throw Error('Google Sheets network timeout after 3 attempts.');await new Promise(r=>setTimeout(r,500*2**attempt));continue;}
  if(r.ok)return await r.json();
  if((r.status===429||r.status>=500)&&attempt<2){await new Promise(r=>setTimeout(r,500*2**attempt));continue;}
  throw Error(`Google Sheets request failed (${r.status}); check API access, sharing and spreadsheet configuration.`);
 }throw Error('Google Sheets retry limit reached.');
}
async function verifySharing(access:string,id:string){
 let mapping:Record<string,string|string[]>;
 try{mapping=JSON.parse(env.GOOGLE_REPORT_VIEWERS||JSON.stringify(reportViewers));if(!mapping||Array.isArray(mapping)||typeof mapping!=='object')throw Error();}catch{throw Error('Sheets sharing: configure GOOGLE_REPORT_VIEWERS as an app user ID or normalized phone to Google email map.');}
 const users=(await db().prepare('SELECT id,phone,role,status FROM users').all<{id:string;phone:string;role:string;status:string}>()).results,viewers:string[]=[];
 for(const [userId,value] of Object.entries(mapping)){
  const user=users.find(u=>u.id===userId||u.phone===userId);
  const emails=Array.isArray(value)?value:[value];
  if(!user||user.status!=='active'||!['Admin','Manager'].includes(user.role)||emails.length===0||emails.some(email=>typeof email!=='string'||!email.includes('@')))throw Error('Sheets sharing: viewer mapping must contain only active Admins and Managers.');
  viewers.push(...emails);
 }
 const read=async(path:string)=>{const r=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+path,{headers:{Authorization:'Bearer '+access},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Sheets sharing verification failed. Enable Drive API and check access.');return r.json();};
 const file=await read('?fields=copyRequiresWriterPermission') as {copyRequiresWriterPermission?:boolean};
 const permissions:ReportPermission[]=[];let page='';
 do{const result=await read('/permissions?fields=nextPageToken,permissions(type,role,emailAddress,deleted)&pageSize=100'+(page?'&pageToken='+encodeURIComponent(page):'')) as {permissions:ReportPermission[];nextPageToken?:string};permissions.push(...result.permissions);page=result.nextPageToken||'';}while(page);
 const issues=sharingIssues(permissions,secrets().email!,viewers,file.copyRequiresWriterPermission===true);
 if(issues.length)throw Error('Sheets sharing: '+issues.join(' '));
}
async function writeBook(access:string,id:string,title:string,tabs:Record<string,Cell[][]>,actor:string){
 const meta=await google(access,encodeURIComponent(id)+'?fields=properties(title),sheets(properties)') as {properties:{title:string};sheets:{properties:{title:string;sheetId:number;gridProperties:{rowCount:number;columnCount:number}}}[]};
 if(meta.properties.title!==title)throw Error('Spreadsheet title does not match GOOGLE_SPREADSHEET_TITLE.');
 const requests=[],snapshots:{key:string;value:string}[]=[];
 for(const [name,rows] of Object.entries(tabs)){
  const tab=meta.sheets.find(s=>s.properties.title===name);if(!tab)throw Error(`Missing report tab: ${name}.`);
  const range="'"+tab.properties.title.replace(/'/g,"''")+"'";
  const actual=await google(access,encodeURIComponent(id)+'/values/'+encodeURIComponent(range)+'?valueRenderOption=FORMULA') as {values?:Cell[][]};
  const key='sheets_snapshot:'+id+':'+tab.properties.sheetId;
  const previous=await db().prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{value:string}>();
  const current=canonicalCells(actual.values||[]),expected=canonicalCells(rows);
  // Compare against the last successfully published DB snapshot, so pending app
  // updates are not mistaken for manual edits. First sync checks current DB rows.
  if(current!==(previous?.value||expected)&&current!==expected){
   const alert={spreadsheet:id,tab:tab.properties.title,detected:Date.now(),message:'Report cells differ from application records. Restoring the database snapshot.'};
   await db().batch([audit(actor,'sheets.drift',id,alert),db().prepare("INSERT INTO settings(key,value) VALUES('sheets_alert',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(alert))]);
  }
  snapshots.push({key,value:expected});
  requests.push(...sheetUpdate(tab.properties.sheetId,rows,tab.properties.gridProperties.rowCount,tab.properties.gridProperties.columnCount));
 }
 await google(access,encodeURIComponent(id)+':batchUpdate',{requests});
 await db().batch(snapshots.map(s=>db().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(s.key,s.value)));
}
async function status(value:unknown){await db().prepare("INSERT INTO settings(key,value) VALUES('sheets_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(value)).run();}
export async function syncSheets(actor:string){return locked('sheets',()=>runSync(actor));}
async function runSync(actor:string){
 const started=Date.now();await status({status:'Syncing',started});
 try{
  if(!syncConfigured())throw Error('Live sync is inactive: configure GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY and GOOGLE_SPREADSHEET_ID as server-side secrets.');
  const access=await token(),s=secrets(),all=await entries(),names=new Map((await people()).map(p=>[p.id,p.name]));
  await verifySharing(access,s.spreadsheet!);
  const raw=(await db().prepare("SELECT id,kind,data FROM records WHERE owner='ptraam' AND kind IN ('trip','branch') ORDER BY created,id").all<{id:string;kind:string;data:string}>()).results.map(r=>({...r,data:JSON.parse(r.data)}));
  const branch=(id:string)=>raw.find(r=>r.kind==='branch'&&r.id===id)?.data.name||id;
  const time=(t:number|null)=>t?new Date(t).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}):'';
  const attendance=attendanceRows(all.filter(e=>e.kind==='daily'&&e.data.eligible!==false).map(e=>({id:e.id,date:e.date,name:names.get(e.employee)||e.employee,status:e.data.status,reconciled:e.data.reconciled})));
  const travel=travelRows(raw.filter(r=>r.kind==='trip'),id=>names.get(id),branch);
  const leave:Cell[][]=[['Record ID','Employee','From','To','Leave type','Working days','Paid','Reason','Status','Reviewed by','Reviewed at (IST)']];
  for(const e of all.filter(e=>e.kind==='leave'))leave.push([e.id,names.get(e.employee),e.date,e.data.to,e.data.type,e.data.days.length,e.data.paid,e.data.reason,e.data.status,names.get(e.data.reviewedBy),time(e.data.reviewedAt)]);
  const monthly:Cell[][]=[['Record ID','Employee','Month','Salary INR','Divisor','Unpaid days','LOP INR','Approved overtime hours','Overtime rate INR','Multiplier','Overtime INR','Formula']];
  for(const e of all.filter(e=>e.kind==='payroll')){const p=e.data;monthly.push([e.id,names.get(e.employee),e.date,p.salary,p.divisor,p.unpaidDays,p.lop,p.hours,p.rate,p.multiplier,p.overtime,p.formula]);}
  await writeBook(access,s.spreadsheet!,s.title,{'Attendance':attendance,'Travel Log':travel,'Leave Tracker':leave,'Payroll':monthly},actor);
  await status({status:'Synced',started,finished:Date.now()});await audit(actor,'sheets.success','reports',{}).run();
 }catch(e){const message=e instanceof Error&&/^(Google |Sheets |Live |Spreadsheet |Attendance |Missing )/.test(e.message)?e.message:'Sheets sync failed. Check server-side credentials and configuration.';await status({status:'Failed',started,finished:Date.now(),error:message});await audit(actor,'sheets.failure','reports',{message}).run();throw Error(message);}
}
