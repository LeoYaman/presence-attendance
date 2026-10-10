import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';

test('fictional demo API enforces authentication, role, Origin, CSRF and input boundaries',async()=>{
  const csrf='a'.repeat(64);
  let role='teacher', calls=0;
  const pool={query:async()=>({rows:[{id:'test',role,csrf_token:csrf}]})};
  const demoAlerts={list:async()=>({synthetic:true,records:[]}),simulate:async id=>{calls++;return id==='demo-removed'?null:{synthetic:true,notificationSent:false};}};
  const server=createApp({pool,publicOrigin:'http://localhost',demoAlerts,faceWorker:{close(){}},recordingStore:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={Cookie:'presence_session='+'b'.repeat(64),'X-CSRF-Token':csrf,Origin:'http://localhost','Content-Type':'application/json'};
  const call=(path,body,extra={})=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    assert.equal((await call('/api/demo-alerts',undefined,{Cookie:''})).status,401);
    role='student';assert.equal((await call('/api/demo-alerts')).status,403);role='teacher';
    assert.equal((await call('/api/demo-alerts')).status,200);
    assert.equal((await call('/api/demo-alerts/simulate',{id:'demo-one'},{Origin:'https://example.test'})).status,403);
    assert.equal((await call('/api/demo-alerts/simulate',{id:'demo-one'},{'X-CSRF-Token':''})).status,403);
    assert.equal((await call('/api/demo-alerts/simulate',{id:'demo-one',face:'image'})).status,400);
    assert.equal((await call('/api/demo-alerts/simulate',{id:'real-person'})).status,400);
    assert.equal(calls,0);
    const result=await call('/api/demo-alerts/simulate',{id:'demo-one'});
    assert.equal(result.status,200);assert.equal((await result.json()).notificationSent,false);
    assert.equal((await call('/api/demo-alerts/simulate',{id:'demo-removed'})).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
