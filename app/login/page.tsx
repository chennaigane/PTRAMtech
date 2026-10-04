'use client';
import {useEffect,useState} from 'react';
import {ArrowRight,ShieldCheck,MapPin,Route,LockKeyhole,Info,CheckCircle2} from 'lucide-react';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
type Mode='login'|'signup'|'admin';
const copy:Record<Mode,{title:string,caption:string,button:string}>={
  login:{title:'Welcome back.',caption:'Sign in with your mobile number and password.',button:'Log in'},
  signup:{title:'Join your team.',caption:'Register with your mobile number and create a password. The Admin approves your access.',button:'Request access'},
  admin:{title:'Admin setup.',caption:'First-time setup for the designated Admin number. Create the Admin password.',button:'Create Admin password'},
};
export default function Login(){const[mode,setMode]=useState<Mode>('login');const[adminSetup,setAdminSetup]=useState(false);const[phone,setPhone]=useState('');const[name,setName]=useState('');const[role,setRole]=useState('');const[team,setTeam]=useState('');const[password,setPassword]=useState('');const[confirm,setConfirm]=useState('');const[message,setMessage]=useState('');const[done,setDone]=useState('');const[busy,setBusy]=useState(false);
useEffect(()=>{fetch('/api/auth/me').then(r=>r.json()).then((d:any)=>{if(d.user)location.replace('/dashboard');else setAdminSetup(!!d.adminSetupNeeded);}).catch(()=>{});},[]);
function switchMode(m:Mode){setMode(m);setMessage('');setDone('');setPassword('');setConfirm('');}
async function submit(e:React.FormEvent){e.preventDefault();setMessage('');
  if(!/^[6-9]\d{9}$/.test(phone)){setMessage('Enter a valid 10-digit Indian mobile number.');return;}
  if(mode==='signup'&&(!name.trim()||!role||!team)){setMessage('Enter your name and choose your role and team.');return;}
  if(mode!=='login'&&password!==confirm){setMessage('Passwords do not match.');return;}
  setBusy(true);try{
    const url=mode==='login'?'/api/auth/login':mode==='signup'?'/api/auth/signup':'/api/auth/admin-setup';
    const body=mode==='signup'?{name,phone,role,team,password}:{phone,password};
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d:any=await r.json();
    if(!r.ok)throw Error(d.error||'Something went wrong. Please retry.');
    if(mode==='signup'){setDone(d.message);setName('');setRole('');setTeam('');setPhone('');setPassword('');setConfirm('');}
    else location.replace('/dashboard');
  }catch(err:any){setMessage(err.message);}finally{setBusy(false);}}
const c=copy[mode];
return <div className="auth-shell"><aside className="auth-brand"><div className="auth-story"><img src="/ptraam-logo.png" alt="PT Ramkumaar Enterprises" width="230" height="193"/><p className="auth-kicker">YOUR WORK. YOUR JOURNEY.</p><h1>Every visit.<br/>Every kilometre.<br/><em>Accounted for.</em></h1><p className="auth-intro">One place for your branch visits, work travel and expenses.</p><div className="auth-benefits"><span><MapPin size={18}/> Branch attendance</span><span><Route size={18}/> Travel & reimbursements</span><span><ShieldCheck size={18}/> Employee safety</span></div></div><small>FIELD OPERATIONS · PTRAAM ENTERPRISES</small></aside><section className="auth-main"><div className="auth-mobile-brand"><img src="/ptraam-logo.png" alt="PTRAAM Enterprises" width="100" height="84"/></div><div className="auth-card"><div className="auth-lock"><LockKeyhole size={23}/></div><p className="auth-kicker">PTRAAM TEAM ACCESS</p><h2>{c.title}</h2><p className="auth-caption">{c.caption}</p>
{mode!=='admin'&&<Tabs value={mode} onValueChange={v=>switchMode(v as Mode)}><TabsList className="auth-tabs"><TabsTrigger value="login">Log in</TabsTrigger><TabsTrigger value="signup">Sign up</TabsTrigger></TabsList></Tabs>}
{done?<div className="auth-success" role="status"><CheckCircle2 size={20}/><div><b>Request sent</b><p>{done}</p></div></div>:
<form onSubmit={submit}>
{mode==='signup'&&<><label className="field">Full name<input autoComplete="name" required maxLength={80} placeholder="Enter your full name" value={name} onChange={e=>setName(e.target.value)}/></label>
<div className="auth-row"><label className="field">Role<Select value={role} onValueChange={setRole}><SelectTrigger aria-label="Role"><SelectValue placeholder="Select role"/></SelectTrigger><SelectContent><SelectItem value="Manager">Manager</SelectItem><SelectItem value="Employee">Employee</SelectItem></SelectContent></Select></label>
<label className="field">Team<Select value={team} onValueChange={setTeam}><SelectTrigger aria-label="Team"><SelectValue placeholder="Select team"/></SelectTrigger><SelectContent><SelectItem value="Marketing">Marketing</SelectItem><SelectItem value="Sales">Sales</SelectItem></SelectContent></Select></label></div></>}
<label className="field" htmlFor="auth-phone">Mobile number</label><div className="auth-phone"><span>IN <b>+91</b></span><input id="auth-phone" type="tel" autoComplete="tel-national" inputMode="numeric" pattern="[6-9][0-9]{9}" title="Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9" maxLength={10} required placeholder="Enter 10-digit number" value={phone} onChange={e=>{setPhone(e.target.value.replace(/\D/g,''));setMessage('')}}/></div>
<label className="field">{mode==='login'?'Password':'Create password'}<input type="password" required minLength={mode==='login'?1:8} maxLength={128} autoComplete={mode==='login'?'current-password':'new-password'} placeholder={mode==='login'?'Enter your password':'At least 8 characters, with a letter and a number'} value={password} onChange={e=>setPassword(e.target.value)}/></label>
{mode!=='login'&&<label className="field">Confirm password<input type="password" required maxLength={128} autoComplete="new-password" placeholder="Re-enter password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>}
<button className="button auth-submit" type="submit" disabled={busy}>{busy?'Please wait…':c.button}<ArrowRight size={18}/></button>{message&&<div className="auth-message" role="alert">{message}</div>}</form>}
{mode==='signup'&&<div className="auth-notice"><Info size={18}/><div><b>Admin approval required</b><p>You can log in only after the Admin approves your registration.</p></div></div>}
{mode==='admin'?<p className="auth-switch"><button type="button" onClick={()=>switchMode('login')}>Back to log in</button></p>:adminSetup&&<p className="auth-switch">Designated Admin, first time here? <button type="button" onClick={()=>switchMode('admin')}>Set up Admin password</button></p>}
</div><footer>Developed &amp; maintained by <b>Ganalytix</b></footer></section></div>}
