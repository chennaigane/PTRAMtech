import type {Cell} from './sheets-payload';

export type ReportPermission={type:string;role:string;emailAddress?:string;deleted?:boolean};
export function sharingIssues(permissions:ReportPermission[],integration:string,viewers:string[],copyRestricted:boolean){
 const issues:string[]=[],email=(s:string)=>s.toLowerCase();
 const allowed=new Set(viewers.map(email));
 if(copyRestricted)issues.push('Enable copying and downloading for viewers.');
 if(!permissions.some(p=>p.type==='user'&&email(p.emailAddress||'')===email(integration)&&p.role==='writer'))issues.push('Give the server integration account Editor access.');
 for(const p of permissions){
  if(p.deleted)continue;
  if(p.role==='owner')continue; // Google owners retain control.
  const address=email(p.emailAddress||'');
  if(p.type==='user'&&address===email(integration)&&p.role==='writer')continue;
  if(p.type==='user'&&allowed.has(address)&&p.role==='reader')continue;
  issues.push('Remove unapproved access or change approved Admin/Manager access to Viewer.');
 }
 for(const address of allowed)if(!permissions.some(p=>!p.deleted&&p.type==='user'&&email(p.emailAddress||'')===address&&['reader','owner'].includes(p.role)))issues.push('An approved Admin/Manager is missing Viewer access.');
 return [...new Set(issues)];
}

// Ignore only trailing empty cells, which the values API omits. Types and formulas matter.
export function canonicalCells(rows:Cell[][]):string{
 const normalized=rows.map(row=>{const cells=row.map(v=>v??'');while(cells.length&&cells.at(-1)==='')cells.pop();return cells;});
 while(normalized.length&&!normalized.at(-1)!.length)normalized.pop();
 return JSON.stringify(normalized);
}
