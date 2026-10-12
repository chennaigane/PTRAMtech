import {db} from '@/db/raw';
import {locked} from '@/lib/workforce-lock';
import {reverseGeocode,validCoordinates} from '@/lib/reverse-geocode';

// Legacy start samples are safe to recover. A destination requires end evidence;
// never substitute the departure or an arbitrary last sample for a missing end.
export function tripEndpoint(data:any,side:'start'|'end') {
  return side==='start'?(data.startLocation||data.points?.[0]):data.endLocation;
}
const same=(a:any,b:any)=>a?.lat===b?.lat&&a?.lng===b?.lng&&a?.time===b?.time;
async function read(id:string){
  const row=await db().prepare("SELECT data FROM records WHERE id=? AND owner='ptraam' AND kind='trip'").bind(id).first<{data:string}>();
  return row?JSON.parse(row.data):null;
}
// Called only AFTER the trip/points transaction commits. A provider outage must
// never roll back GPS evidence or turn a successful stop into a failed operation.
export async function resolveTripLocations(id:string){
  try{
    const original=await read(id);if(!original)return null;
    const updates:{side:'start'|'end';point:any;result:Awaited<ReturnType<typeof reverseGeocode>>}[]=[];
    for(const side of ['start','end'] as const){
      const point=tripEndpoint(original,side);
      if(!validCoordinates(point)||point.address?.formatted||point.geocoding?.retryAfter>Date.now())continue;
      updates.push({side,point,result:await reverseGeocode(point.lat,point.lng)});
    }
    if(!updates.length)return original;
    return await locked('workforce',async()=>{
      const data=await read(id);if(!data)return null;
      for(const {side,point,result} of updates){
        const current=tripEndpoint(data,side);
        if(!same(current,point)||current.address?.formatted)continue;
        data[side+'Location']={...current,geocoding:{status:result.status,...(result.status==='pending'?{reason:result.reason,retryAfter:Date.now()+30000}:{})},...(result.status==='resolved'?{address:result.address}:{})};
        if(result.status==='resolved'&&!data[side==='start'?'from':'to'])data[side==='start'?'from':'to']=result.address.name;
      }
      if(data.routeSummary)data.routeSummary={...data.routeSummary,from:data.startLocation?.address?.name||data.from,to:data.endLocation?.address?.name||data.to};
      await db().prepare('UPDATE records SET data=? WHERE id=?').bind(JSON.stringify(data),id).run();
      return data;
    });
  }catch{
    console.warn('Trip address enrichment deferred; saved GPS evidence is unchanged.');
    return null;
  }
}
