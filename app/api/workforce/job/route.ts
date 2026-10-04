const env = process.env;
import {db} from '@/db/raw';
import {ensureSchema} from '@/lib/auth';
import {istDate,datesBetween} from '@/lib/workforce-rules';
import {reconcile} from '@/lib/workforce-service';
import {locked} from '@/lib/workforce-lock';
import {syncConfigured,syncSheets} from '@/lib/sheets-sync';
export async function POST(req:Request){
 if(!env.WORKFORCE_JOB_TOKEN||req.headers.get('authorization')!==`Bearer ${env.WORKFORCE_JOB_TOKEN}`)return Response.json({error:'Unauthorized.'},{status:401});
 try{await ensureSchema();return await locked('workforce',async()=>{
  const body=await req.json().catch(()=>({})) as {from?:string;to?:string};
  const previous=await db().prepare("SELECT value FROM settings WHERE key='workforce_last_job'").first<{value:string}>();
  const to=body.to||istDate(),from=body.from||(previous?istDate(Math.min(Date.parse(previous.value),Date.now()-7*86400000)):istDate());
  datesBetween(from,to);const count=await reconcile(from,to,'scheduled-job');
  await db().prepare("INSERT INTO settings(key,value) VALUES('workforce_last_job',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(to).run();
  if(syncConfigured())await syncSheets('scheduled-job');
  return Response.json({ok:true,count,sync:syncConfigured()?'completed':'not configured'});
 });}catch{return Response.json({error:'Reconciliation or sync failed. Check Admin sync status, calendar setup and retry.'},{status:503});}
}
