import {getSessionUser,sameOrigin} from '@/lib/auth';
import {canView} from '@/lib/permissions';
import {db} from '@/db/raw';
import {resolveTripLocations} from '@/lib/trip-locations';
import {z} from 'zod';

// Explicit, one-trip retry/backfill; never runs a bulk history rewrite.
export async function POST(req:Request){
  try{
    const user=await getSessionUser(req);
    if(!user)return Response.json({error:'Sign in required.'},{status:401});
    if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
    const {id}=z.object({id:z.string().uuid()}).parse(await req.json());
    const row=await db().prepare("SELECT data FROM records WHERE id=? AND owner='ptraam' AND kind='trip'").bind(id).first<{data:string}>();
    if(!row)return Response.json({error:'Trip not found.'},{status:404});
    const data=JSON.parse(row.data);
    const owner=await db().prepare('SELECT id,role,team FROM users WHERE id=?').bind(data.employee).first<any>();
    if(!owner||!canView(user,owner))return Response.json({error:'Access denied.'},{status:403});
    return Response.json({id,data:await resolveTripLocations(id)||data},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Unable to resolve the saved locations. Retry shortly.'},{status:503});}
}
