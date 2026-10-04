import {db} from '@/db/raw';
import {ADMIN_PHONE,ensureSchema,findUserByPhone,hashPassword,normalizePhone,passwordProblem,sameOrigin} from '@/lib/auth';
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const body:any=await req.json().catch(()=>({}));
  const name=typeof body.name==='string'?body.name.trim():'';
  const phone=normalizePhone(body.phone);
  if(name.length<2||name.length>80)return Response.json({error:'Enter your full name.'},{status:400});
  if(!phone)return Response.json({error:'Enter a valid 10-digit Indian mobile number.'},{status:400});
  if(!['Manager','Employee'].includes(body.role))return Response.json({error:'Choose your role.'},{status:400});
  if(!['Marketing','Sales'].includes(body.team))return Response.json({error:'Choose your team.'},{status:400});
  const problem=passwordProblem(body.password);if(problem)return Response.json({error:problem},{status:400});
  if(phone===ADMIN_PHONE)return Response.json({error:'This number is reserved for the Admin. Use Admin setup instead.'},{status:400});
  await ensureSchema();
  if(await findUserByPhone(phone))return Response.json({error:'This mobile number is already registered. Log in instead, or contact the Admin.'},{status:409});
  await db().prepare(`INSERT INTO users (id, phone, name, role, team, password_hash, status, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(crypto.randomUUID(),phone,name,body.role,body.team,await hashPassword(body.password),Date.now()).run();
  return Response.json({ok:true,message:'Registration received. You can log in once the Admin approves your account.'});
}catch(e:any){if(String(e?.message).includes('UNIQUE'))return Response.json({error:'This mobile number is already registered.'},{status:409});console.error(e);return Response.json({error:'Unable to register. Please retry.'},{status:503});}}
