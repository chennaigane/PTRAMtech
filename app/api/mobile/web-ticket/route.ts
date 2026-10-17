import {ensureSchema} from '@/lib/auth';
import {locked} from '@/lib/workforce-lock';
import {issueWebTicket} from '@/lib/web-native-session';
import {PointError} from '../../../../lib/mobile-point-ingest.mjs';
export const runtime='nodejs';
export async function POST(req:Request){
 try{
  if(!req.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'JSON required'},{status:415});
  // Bound the body independently of an untrusted Content-Length.
  const reader=req.body?.getReader();let raw='',size=0;if(!reader)throw new PointError(400,'JSON required');
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024){await reader.cancel();throw new PointError(413,'Request too large');}raw+=new TextDecoder().decode(value);}}finally{reader.releaseLock();}
  const body=JSON.parse(raw);await ensureSchema();
  return Response.json(await locked('workforce',()=>issueWebTicket(req,body)),{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:e instanceof PointError?e.message:'Unable to authorize native session.'},{status:e instanceof PointError?e.status:400,headers:{'Cache-Control':'no-store'}});}
}
