export const departments = ['Marketing','Sales','Operations','Office Admin','Driver','HR','Finance','Other'] as const;
export type Department = typeof departments[number];
export type Fix = {lat:number;lng:number;accuracy:number;time:number};
export type Fence = {lat:number;lng:number;radius:number;maxAccuracy:number};
export type Policy = {office:Fence|null;workdays:number[];start:string;end:string;holidays:{date:string;name:string;working:boolean}[];confirmedYears:number[];leaveTypes:{name:string;paid:boolean;annual:number}[]};
export const initialPolicy:Policy = {office:null,workdays:[],start:'09:30',end:'18:30',holidays:[],confirmedYears:[],leaveTypes:[]};
export const istDate = (time:number=Date.now()) => new Date(time+19800000).toISOString().slice(0,10);
export const atIST = (date:string,time:string) => Date.parse(`${date}T${time}:00+05:30`);
export function datesBetween(from:string,to:string) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||new Date(from).toISOString().slice(0,10)!==from||new Date(to).toISOString().slice(0,10)!==to||to<from) throw Error('Enter a valid date range.');
  const result:string[]=[];
  for(let t=Date.parse(from);t<=Date.parse(to);t+=86400000){if(result.length>=366)throw Error('Choose at most 366 days.');result.push(new Date(t).toISOString().slice(0,10));}
  return result;
}
export const fieldDepartment = (d:string) => d==='Marketing'||d==='Sales';
export function workingDay(date:string,p:Policy) {
  if(!p.confirmedYears.includes(Number(date.slice(0,4))))throw Error('Admin must confirm the holiday calendar for this year.');
  const special=p.holidays.find(h=>h.date===date);
  return special?special.working:p.workdays.includes(new Date(date+'T00:00:00Z').getUTCDay());
}
export function verifyFix(p:Fix,f:Fence,now=Date.now()) {
  if(![p.lat,p.lng,p.accuracy,p.time].every(Number.isFinite)||Math.abs(p.lat)>90||Math.abs(p.lng)>180||p.accuracy<0)throw Error('No usable GPS location was received. Turn on Location (GPS), allow precise location for this site and try again.');
  if(p.accuracy>f.maxAccuracy)throw Error(`GPS is only accurate to about ${Math.round(p.accuracy)} m; the office requires ${f.maxAccuracy} m or better. Wait for a clearer signal, or request an attendance exception.`);
  if(Math.abs(now-p.time)>120000)throw Error('A fresh GPS fix is required.');
  const r=Math.PI/180,v=Math.sin((p.lat-f.lat)*r/2)**2+Math.cos(f.lat*r)*Math.cos(p.lat*r)*Math.sin((p.lng-f.lng)*r/2)**2;
  const metres=6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));
  if(metres+p.accuracy>f.radius)throw Error(`GPS cannot confirm you are inside the office geofence: you are about ${Math.round(metres)} m from the office (±${Math.round(p.accuracy)} m) and the geofence is ${f.radius} m. Move closer or request an attendance exception.`);
  return Math.round(metres);
}
export function overtimeHours(intervals:{start:number;end:number}[],date:string) {
  const threshold=atIST(date,'18:30'),limit=atIST(date,'23:59')+60000;
  const parts=intervals.map(i=>({start:Math.max(i.start,threshold),end:Math.min(i.end,limit)})).filter(i=>i.end>i.start).sort((a,b)=>a.start-b.start);
  let total=0,end=threshold;for(const p of parts){total+=Math.max(0,p.end-Math.max(end,p.start));end=Math.max(end,p.end);}
  return Math.round(total/36000)/100;
}
export function payroll(salary:number|null,divisor:number|null,unpaidDays:number,hours:number,rate:number|null,multiplier:number|null) {
  return {salary,divisor,unpaidDays,hours,rate,multiplier,lop:salary!==null&&divisor!==null&&divisor>0?Math.round(salary/divisor*unpaidDays*100)/100:null,overtime:rate!==null&&multiplier!==null?Math.round(hours*rate*multiplier*100)/100:null,formula:'LOP = monthly salary / configured working-day divisor × unpaid days; overtime = approved hours × hourly rate × multiplier'};
}
