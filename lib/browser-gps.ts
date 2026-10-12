import {checkTripFix} from '@/lib/travel-modes';
import type {Point} from '@/lib/geo';

export function captureGps(geolocation:Geolocation|undefined=navigator.geolocation):Promise<Point>{
  return new Promise((resolve,reject)=>{
    if(!geolocation){reject(Error('GPS is unavailable in this browser.'));return;}
    let id:number|undefined,best:Point|undefined,done=false;
    const started=Date.now();
    const finish=(error?:Error)=>{
      if(done)return;done=true;clearTimeout(timer);
      if(id!==undefined)geolocation.clearWatch(id);
      if(error){reject(error);return;}
      try{if(!best)throw Error('No fresh GPS location. Turn on precise Location, move outdoors and retry.');checkTripFix(best);resolve(best);}catch(e){reject(e);}
    };
    const timer=setTimeout(()=>finish(),15000);
    try{
      id=geolocation.watchPosition(p=>{
        const point={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy,time:p.timestamp};
        if(point.time<started||point.time>Date.now()+5000||!Number.isFinite(point.accuracy)||point.accuracy<0)return;
        if(!best||point.accuracy<best.accuracy)best=point;
        if(point.accuracy<=30)finish();
      },e=>{
        if(e.code===1)finish(Error('Location permission denied. Allow precise location in browser settings and retry.'));
        else if(e.code===2)finish(Error('GPS is unavailable. Turn on Location, move outdoors and retry.'));
      },{enableHighAccuracy:true,maximumAge:0,timeout:15000});
      if(done)geolocation.clearWatch(id);
    }catch{finish(Error('Unable to request GPS. Check location permission and retry.'));}
  });
}
