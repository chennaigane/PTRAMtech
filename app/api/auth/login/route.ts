import {adminExists,checkLogin,createSession,normalizePhone,publicUser,sameOrigin} from '@/lib/auth';
import {authFailure} from '@/lib/auth-errors';
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const body:any=await req.json().catch(()=>({}));
  const phone=normalizePhone(body.phone);
  if(!phone||typeof body.password!=='string'||!body.password)return Response.json({error:'Enter your mobile number and password.'},{status:400});
  if(!await adminExists())return Response.json({code:'ADMIN_SETUP_REQUIRED',error:'First-time Admin setup is required. The designated Admin must create a password before anyone can sign in.'},{status:409});
  const result=await checkLogin(phone,body.password);
  if('error' in result)return Response.json({error:result.error},{status:result.status});
  return Response.json({user:publicUser(result.user)},{headers:{'Set-Cookie':await createSession(req,result.user.id)}});
}catch(e){return authFailure(e,'Unable to sign in. Please retry.');}}
