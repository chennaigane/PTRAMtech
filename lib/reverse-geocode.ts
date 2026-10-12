import {localityName} from '@/lib/trip-labels';
import {db} from '@/db/raw';
import {locked} from '@/lib/workforce-lock';

export type Address = {locality:string;town:string;village:string;district:string;city:string;state:string;country:string;formatted:string;name:string;provider:'geoapify';attribution:string};
type Resolution = {status:'resolved';address:Address}|{status:'pending';reason:'not_configured'|'rate_limited'|'unavailable'|'not_found'|'invalid_coordinates'};
const cache=new Map<string,{expires:number;result:Resolution}>();
const pending=new Map<string,Promise<Resolution>>();
const text=(v:unknown)=>typeof v==='string'?v.trim().slice(0,500):'';
export function validCoordinates(p:any):boolean {
  return Number.isFinite(p?.lat)&&Number.isFinite(p?.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
}
export function parseAddress(value:any):Address|null {
  const p=value?.features?.[0]?.properties;
  if(!p||!text(p.formatted))return null;
  const locality=text(p.suburb)||text(p.neighbourhood)||text(p.neighborhood);
  const town=text(p.town),village=text(p.village),district=text(p.district);
  const city=text(p.city)||text(p.town)||text(p.village);
  const state=text(p.state),country=text(p.country),formatted=text(p.formatted);
  const name=localityName({locality,town,village,city,district});
  return {locality,town,village,district,city,state,country,formatted,name,provider:'geoapify',attribution:text(p.datasource?.attribution)||'© OpenStreetMap contributors'};
}
const quota=(value:string|undefined,fallback:number,max:number)=>{
  const n=Number(value);return Number.isInteger(n)&&n>0?Math.min(n,max):fallback;
};
// Shared database budget: multiple Cloud Run instances cannot each spend the quota.
async function reserve():Promise<boolean>{
  return locked('geocode-budget',async()=>{
    const now=Date.now(),second=Math.floor(now/1000),day=Math.floor(now/86400000);
    const row=await db().prepare('SELECT value FROM settings WHERE key=?').bind('geocode_budget').first<{value:string}>();
    const old=row?JSON.parse(row.value):{};
    const count=old.second===second?old.count:0,total=old.day===day?old.total:0;
    if(count>=quota(process.env.GEOCODING_REQUESTS_PER_SECOND,2,50)||total>=quota(process.env.GEOCODING_REQUESTS_PER_DAY,2500,1000000))return false;
    await db().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .bind('geocode_budget',JSON.stringify({second,day,count:count+1,total:total+1})).run();
    return true;
  });
}
export async function reverseGeocode(lat:number,lng:number):Promise<Resolution>{
  if(!validCoordinates({lat,lng}))return {status:'pending',reason:'invalid_coordinates'};
  if(process.env.GEOCODING_PROVIDER!=='geoapify'||!process.env.GEOCODING_API_KEY)return {status:'pending',reason:'not_configured'};
  const key=lat+','+lng,hit=cache.get(key);
  if(hit&&hit.expires>Date.now())return hit.result;
  if(pending.has(key))return pending.get(key)!;
  const request=(async():Promise<Resolution>=>{
    try{
      if(!await reserve())return {status:'pending',reason:'rate_limited'};
      const url=new URL('https://api.geoapify.com/v1/geocode/reverse');
      url.search=new URLSearchParams({lat:String(lat),lon:String(lng),apiKey:process.env.GEOCODING_API_KEY!}).toString();
      const response=await fetch(url,{signal:AbortSignal.timeout(3000),cache:'no-store',redirect:'error'});
      if(!response.ok)return {status:'pending',reason:response.status===429?'rate_limited':'unavailable'};
      const address=parseAddress(await response.json());
      return address?{status:'resolved',address}:{status:'pending',reason:'not_found'};
    }catch{
      // Never log the URL, API key, raw provider response or employee coordinates.
      console.warn('Reverse geocoding unavailable; trip coordinates retained.');
      return {status:'pending',reason:'unavailable'};
    }
  })();
  pending.set(key,request);
  try{
    const result=await request;
    if(cache.size>=512)cache.delete(cache.keys().next().value!);
    cache.set(key,{result,expires:Date.now()+(result.status==='resolved'?86400000:30000)});
    return result;
  }finally{pending.delete(key);}
}
