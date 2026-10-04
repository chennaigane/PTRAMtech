import {db} from '@/db/raw';
import {authFailure} from '@/lib/auth-errors';
import {ADMIN_PHONE,adminExists,createSession,hashPassword,normalizePhone,passwordProblem,sameOrigin} from '@/lib/auth';
// One-time: the designated Admin number creates its own password. Disabled once an Admin exists.
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const body:any=await req.json().catch(()=>({}));
  if(await adminExists())return Response.json({error:'Admin setup is already complete. Log in instead.'},{status:409});
  if(normalizePhone(body.phone)!==ADMIN_PHONE)return Response.json({error:'This number is not the designated Admin number.'},{status:403});
  const problem=passwordProblem(body.password);if(problem)return Response.json({error:problem},{status:400});
  const id=crypto.randomUUID();
  await db().prepare(`INSERT INTO users (id, phone, name, role, team, password_hash, status, created) VALUES (?, ?, 'Admin', 'Admin', NULL, ?, 'active', ?)`)
    .bind(id,ADMIN_PHONE,await hashPassword(body.password),Date.now()).run();
  return Response.json({ok:true},{headers:{'Set-Cookie':await createSession(req,id)}});
}catch(e:any){if(String(e?.message).includes('UNIQUE'))return Response.json({error:'Admin setup is already complete. Log in instead.'},{status:409});return authFailure(e,'Unable to complete Admin setup. Please retry.');}}
