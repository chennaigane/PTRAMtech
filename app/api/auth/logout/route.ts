import {destroySession,sameOrigin} from '@/lib/auth';
export async function POST(req:Request){
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  return Response.json({ok:true},{headers:{'Set-Cookie':await destroySession(req)}});
}
