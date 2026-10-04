import {audit} from '@/lib/workforce-store';
import {db} from '@/db/raw';
import {getSessionUser,sameOrigin} from '@/lib/auth';
import {z} from 'zod';
// Admin-only member management: approve, reject, remove (and re-approve), change role / team.
async function requireAdmin(req:Request){const u=await getSessionUser(req);if(!u)return {res:Response.json({error:'Sign in required.'},{status:401})};if(u.role!=='Admin')return {res:Response.json({error:'Only the Admin can manage member access.'},{status:403})};return {admin:u};}
export async function GET(req:Request){try{
  const a=await requireAdmin(req);if(a.res)return a.res;
  const r=await db().prepare('SELECT id, phone, name, role, team, status, created, reviewed_at FROM users ORDER BY created DESC').all();
  return Response.json({users:r.results},{headers:{'Cache-Control':'no-store'}});
}catch(e){console.error(e);return Response.json({error:'Unable to load members.'},{status:503});}}
const transitions:Record<string,{from:string[],to:string}>={approve:{from:['pending','rejected','removed'],to:'active'},reject:{from:['pending'],to:'rejected'},remove:{from:['active'],to:'removed'}};
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const a=await requireAdmin(req);if(a.res)return a.res;
  const body=z.object({id:z.string().uuid(),action:z.enum(['approve','reject','remove','update']),role:z.enum(['Manager','Employee']).optional(),team:z.string().trim().min(1).max(80).optional()}).parse(await req.json());
  const target:any=await db().prepare('SELECT id, role, status FROM users WHERE id = ?').bind(body.id).first();
  if(!target)return Response.json({error:'Member not found.'},{status:404});
  if(target.role==='Admin')return Response.json({error:'The Admin account cannot be changed here.'},{status:400});
  if(body.action==='update'){if(!body.role||!body.team)return Response.json({error:'Choose a role and a team.'},{status:400});await db().prepare('UPDATE users SET role = ?, team = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').bind(body.role,body.team,a.admin!.id,Date.now(),body.id).run();await audit(a.admin!.id,'employee.access.update',body.id,{role:body.role,team:body.team}).run();return Response.json({ok:true});}
  const t=transitions[body.action];
  if(!t.from.includes(target.status))return Response.json({error:`Cannot ${body.action} a member who is ${target.status}.`},{status:400});
  const stmts=[db().prepare('UPDATE users SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').bind(t.to,a.admin!.id,Date.now(),body.id)];
  if(t.to!=='active')stmts.push(db().prepare('DELETE FROM sessions WHERE user_id = ?').bind(body.id));
  stmts.push(audit(a.admin!.id,'employee.'+body.action,body.id,{status:t.to}));
  await db().batch(stmts);
  return Response.json({ok:true,status:t.to});
}catch(e:any){if(e?.issues)return Response.json({error:'Invalid request.'},{status:400});console.error(e);return Response.json({error:'Unable to update member.'},{status:503});}}
