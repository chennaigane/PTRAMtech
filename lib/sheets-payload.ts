export type Cell = string|number|boolean|null|undefined;
// Replace each managed tab in a single atomic batch. The same snapshot always
// targets the same cells; shrinking datasets clear obsolete rows as well.
export function sheetUpdate(sheetId:number,rows:Cell[][],existingRows:number,existingColumns:number){
 const rowCount=Math.max(existingRows,rows.length),columnCount=Math.max(existingColumns,...rows.map(r=>r.length));
 return [
  {updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount,columnCount}},fields:'gridProperties.rowCount,gridProperties.columnCount'}},
  {updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:rowCount,startColumnIndex:0,endColumnIndex:columnCount},rows:rows.map(row=>({values:row.map(v=>({userEnteredValue:typeof v==='number'?{numberValue:v}:typeof v==='boolean'?{boolValue:v}:{stringValue:v==null?'':String(v)}}))})),fields:'userEnteredValue'}}
 ];
}
export const attendanceHeader=['S.no','Date','Name','Attendance (Present / Absent)'];
export function attendanceRows(rows:{id:string;date:string;name:string;status:string;reconciled:boolean}[]):Cell[][]{
 return [attendanceHeader,...rows.filter(r=>r.reconciled&&['Present','Absent'].includes(r.status)).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id)).map((r,i)=>[i+1,r.date,r.name,r.status])];
}
// Travel Log: one row per trip id, ordered by the caller's stable (created,id) order, so a
// re-sync rewrites the same cells instead of appending duplicates.
export const travelHeader=['Trip ID','Employee','Date (IST)','Trip type','Start point (GPS)','Destination','End point (GPS)','Start (IST)','End (IST)','Start GPS verified','End GPS verified','Distance km','Expenses INR','Reimbursement INR','Approval status','Incomplete'];
type Loc={lat:number;lng:number;accuracy?:number}|null|undefined;
const gpsLabel=(p:Loc)=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)?`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${Number.isFinite(p.accuracy)?` (±${Math.round(p.accuracy as number)} m)`:''}`:'';
const istTime=(t:number|null|undefined)=>t?new Date(t).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}):'';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- trip JSON comes from D1 and includes legacy shapes.
export function travelRows(trips:{id:string;data:Record<string,any>}[],name:(id:string)=>string|undefined,branch:(id:string)=>string):Cell[][]{
 const seen=new Set<string>(),rows:Cell[][]=[travelHeader];
 for(const {id,data:t} of trips){if(seen.has(id))continue;seen.add(id);
  // Legacy trips started from a chosen branch; new trips start from the captured GPS fix.
  const start=t.startLocation?gpsLabel(t.startLocation):t.from?branch(t.from):'';
  rows.push([id,name(t.employee),new Date(t.start+19800000).toISOString().slice(0,10),t.mode==='driver'?'Driver (office start)':t.mode==='field'?'Field':'Field (legacy branch start)',start,t.to?branch(t.to):'',gpsLabel(t.endLocation),istTime(t.start),istTime(t.end),!!t.startVerified,!!t.endVerified,t.km,t.extra,t.amount,t.status,t.status==='Travelling']);}
 return rows;
}
