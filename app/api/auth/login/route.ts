import {checkLogin,createSession,normalizePhone,publicUser,sameOrigin} from '@/lib/auth';
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const body:any=await req.json().catch(()=>({}));
  const phone=normalizePhone(body.phone);
  if(!phone||typeof body.password!=='string'||!body.password)return Response.json({error:'Enter your mobile number and password.'},{status:400});
  const result=await checkLogin(phone,body.password);
  if('error' in result)return Response.json({error:result.error},{status:result.status});
  return Response.json({user:publicUser(result.user)},{headers:{'Set-Cookie':await createSession(req,result.user.id)}});
}catch(e){console.error(e);return Response.json({error:'Unable to sign in. Please retry.'},{status:503});}}
