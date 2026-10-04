import {adminExists,ensureSchema,getSessionUser,publicUser} from '@/lib/auth';
import {profile} from '@/lib/workforce-store';
import {travelMode} from '@/lib/travel-modes';
import {authFailure} from '@/lib/auth-errors';
export async function GET(req:Request){try{
  const user=await getSessionUser(req);
  // Department decides which attendance / travel features the dashboard shows. The API enforces the same rules.
  let department:string|null=null;if(user){await ensureSchema();department=(await profile(user.id)).department;}
  return Response.json({user:user?{...publicUser(user),department,travelMode:travelMode(department)}:null,adminSetupNeeded:!await adminExists()},{headers:{'Cache-Control':'no-store'}});
}catch(e){return authFailure(e,'Unable to check sign-in. Please retry.');}}
