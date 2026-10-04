import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {POST as setup} from '../app/api/auth/admin-setup/route.ts';
import {POST as login} from '../app/api/auth/login/route.ts';
import {GET as me} from '../app/api/auth/me/route.ts';
import {ADMIN_PHONE} from '../lib/auth.ts';

const origin='https://ptraam.test';
const request=(path,body)=>new Request(origin+path,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});

test('database diagnostics and complete first-time Admin setup, logout-free login and repeat-setup protection',async t=>{
  const previous={NODE_ENV:process.env.NODE_ENV,DATABASE_PATH:process.env.DATABASE_PATH,APP_ORIGIN:process.env.APP_ORIGIN};
  t.after(()=>{globalThis.ptraamDatabase?.close();delete globalThis.ptraamDatabase;delete globalThis.ptraamDatabasePath;for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  process.env.NODE_ENV='production';process.env.APP_ORIGIN=origin;delete process.env.DATABASE_PATH;
  const password='Test1-'+randomUUID();
  const credentials={phone:ADMIN_PHONE,password};
  for(const response of [await login(request('/api/auth/login',credentials)),await setup(request('/api/auth/admin-setup',credentials)),await me(new Request(origin+'/api/auth/me'))]){
    assert.equal(response.status,503);assert.equal((await response.json()).code,'DATABASE_NOT_CONFIGURED');
  }
  process.env.DATABASE_PATH='invalid-relative-path.sqlite';
  const unavailable=await login(request('/api/auth/login',credentials));
  assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).code,'DATABASE_UNAVAILABLE');
  process.env.DATABASE_PATH=':memory:';
  assert.equal((await (await me(new Request(origin+'/api/auth/me'))).json()).adminSetupNeeded,true);
  const firstLogin=await login(request('/api/auth/login',credentials));
  assert.equal(firstLogin.status,409);assert.equal((await firstLogin.json()).code,'ADMIN_SETUP_REQUIRED');
  assert.equal((await setup(request('/api/auth/admin-setup',{...credentials,phone:'9876543210'}))).status,403);
  assert.equal((await setup(request('/api/auth/admin-setup',{...credentials,password:'short'}))).status,400);
  const created=await setup(request('/api/auth/admin-setup',credentials));
  assert.equal(created.status,200);assert.match(created.headers.get('set-cookie'),/HttpOnly; SameSite=Lax.*; Secure/);
  const signedIn=await (await me(new Request(origin+'/api/auth/me',{headers:{cookie:created.headers.get('set-cookie')}}))).json();
  assert.equal(signedIn.user.role,'Admin');assert.equal(signedIn.user.phone,ADMIN_PHONE);assert.equal(signedIn.adminSetupNeeded,false);
  assert.equal((await setup(request('/api/auth/admin-setup',credentials))).status,409);
  const signedInAgain=await login(request('/api/auth/login',credentials));
  assert.equal(signedInAgain.status,200);assert.ok(signedInAgain.headers.get('set-cookie'));
  assert.equal((await login(request('/api/auth/login',{...credentials,password:'WrongPassword123'}))).status,401);
});
