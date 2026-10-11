import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startLocalDemo,openLocalDatabase} from '../scripts/local-demo.mjs';
import {createApp} from '../src/server.mjs';
import {localDatabase} from './local-fixture.mjs';

const scratch=fileURLToPath(new URL('../../.tmp/',import.meta.url));
const faceWorker={start(){},close(){},request(){throw new Error('Camera is not used by this test');}};
async function port(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const value=socket.address().port;await new Promise(r=>socket.close(r));return value;}
test('presentation starts at use cases and creates a session only with valid same-origin empty POST',async()=>{
  await mkdir(scratch,{recursive:true});const dir=await mkdtemp(join(scratch,'presentation-api-'));let runtime;
  try{
    const number=await port();runtime=await startLocalDemo({env:{LOCAL_DEMO_PORT:String(number)},dataDir:dir,faceWorker});
    const origin=`http://localhost:${number}`;
    const landing=await fetch(origin,{redirect:'manual'});assert.equal(landing.status,303);assert.equal(landing.headers.get('location'),'/login.html');
    const capability=await fetch(origin+'/api/presentation');assert.deepEqual(await capability.json(),{enabled:true});assert.equal(capability.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(origin+'/api/me')).status,401);
    const login=(body='{}',headers={})=>fetch(origin+'/api/presentation-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body});
    assert.equal((await login('{}',{Origin:'https://untrusted.example'})).status,403);
    assert.equal((await login('{}',{'Content-Type':'text/plain'})).status,415);
    assert.equal((await login('{')).status,400);
    assert.equal((await login('{"role":"admin"}')).status,400);
    assert.equal((await login(JSON.stringify({data:'a'.repeat(65)}))).status,413);
    const response=await login(),auth=await response.json();assert.equal(response.status,200);assert.equal(auth.user.role,'teacher');assert.match(auth.csrfToken,/^[a-f0-9]{64}$/);
    const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    const me=await fetch(origin+'/api/me',{headers:{Cookie:cookie.split(';')[0]}});assert.equal(me.status,200);assert.equal((await me.json()).user.id,auth.user.id);
    const wrongHost=await fetch(`http://127.0.0.1:${number}/api/presentation`);assert.equal(wrongHost.status,403);
    await runtime.close();runtime=null;
    runtime=await startLocalDemo({env:{LOCAL_DEMO_PORT:String(number)},dataDir:dir,faceWorker});
    assert.equal((await fetch(origin+'/api/me',{headers:{Cookie:cookie.split(';')[0]}})).status,200,'server sessions survive restart');
  }finally{await runtime?.close();await rm(dir,{recursive:true,force:true});}
});
test('ordinary API never exposes password-free presentation entry',async()=>{
  const local=await localDatabase(),server=createApp({pool:local.pool,faceWorker});
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin+'/api/presentation')).status,401);
    assert.notEqual((await fetch(origin+'/api/presentation-login',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:'{}'})).status,200);
    await assert.rejects(startLocalDemo({env:{NODE_ENV:'production'}}),/forbidden/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await local.engine.close();}
});
test('attendance snapshot rejects a second owner before changing disk bytes',async()=>{
  await mkdir(scratch,{recursive:true});const dir=await mkdtemp(join(scratch,'attendance-lock-'));let local;
  try{
    local=await openLocalDatabase(dir);const before=await readFile(join(dir,'database.tar'));
    await assert.rejects(openLocalDatabase(dir),/already open/);assert.deepEqual(await readFile(join(dir,'database.tar')),before);
    await local.pool.end();local=null;local=await openLocalDatabase(dir);
  }finally{await local?.pool.end();await rm(dir,{recursive:true,force:true});}
});
