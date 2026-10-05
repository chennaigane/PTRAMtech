import {db} from '@/db/raw';
import {authFailure} from '@/lib/auth-errors';
import {isSignupDepartment} from '@/lib/departments';
import {defaultProfile} from '@/lib/workforce-store';
import {ADMIN_PHONE,ensureSchema,findUserByPhone,hashPassword,normalizePhone,passwordProblem,sameOrigin} from '@/lib/auth';
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const body:any=await req.json().catch(()=>({}));
  const name=typeof body.name==='string'?body.name.trim():'';
  const phone=normalizePhone(body.phone);
  if(name.length<2||name.length>80)return Response.json({error:'Enter your full name.'},{status:400});
  if(!phone)return Response.json({error:'Enter a valid 10-digit Indian mobile number.'},{status:400});
  if(!['Manager','Employee'].includes(body.role))return Response.json({error:'Choose your role.'},{status:400});
  const department=body.department??body.team;
  if(!isSignupDepartment(department))return Response.json({error:'Choose your department.'},{status:400});
  const problem=passwordProblem(body.password);if(problem)return Response.json({error:problem},{status:400});
  if(phone===ADMIN_PHONE)return Response.json({error:'This number is reserved for the Admin. Use Admin setup instead.'},{status:400});
  await ensureSchema();
  if(await findUserByPhone(phone))return Response.json({error:'This mobile number is already registered. Log in instead, or contact the Admin.'},{status:409});
  const id=crypto.randomUUID();
  await db().batch([
    db().prepare(`INSERT INTO users (id, phone, name, role, team, password_hash, status, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(id,phone,name,body.role,department,await hashPassword(body.password),Date.now()),
    db().prepare('INSERT INTO workforce_profiles(employee,data) VALUES(?,?)')
      .bind(id,JSON.stringify({...defaultProfile,department,other:''})),
  ]);
  return Response.json({ok:true,message:'Registration received. You can log in once the Admin approves your account.'});
}catch(e:any){if(e?.code==='ER_DUP_ENTRY'||String(e?.message).includes('UNIQUE'))return Response.json({error:'This mobile number is already registered.'},{status:409});return authFailure(e,'Unable to register. Please retry.');}}
