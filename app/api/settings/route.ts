import {getSessionUser,sameOrigin} from '@/lib/auth';
import {can} from '@/lib/permissions';
import {setRate} from '@/lib/settings';
import {z} from 'zod';
// Reimbursement rate: Admin configures; applies to trips started afterwards.
export async function POST(req:Request){try{
  if(!sameOrigin(req))return Response.json({error:'Invalid origin'},{status:403});
  const u=await getSessionUser(req);if(!u)return Response.json({error:'Sign in required.'},{status:401});
  if(!can.configure(u))return Response.json({error:'Only the Admin can change reimbursement rates.'},{status:403});
  const {rate}=z.object({rate:z.number().min(0).max(100)}).parse(await req.json());
  await setRate(rate);
  return Response.json({ok:true,rate});
}catch(e:any){if(e?.issues)return Response.json({error:'Enter a rate between ₹0 and ₹100 per km.'},{status:400});console.error(e);return Response.json({error:'Unable to save the rate.'},{status:503});}}
