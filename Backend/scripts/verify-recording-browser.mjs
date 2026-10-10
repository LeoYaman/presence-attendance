// Isolated integration/performance probe. Never opens the live database or a user's browser profile.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,access,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openLocalDatabase} from './local-demo.mjs';
import {seedDemo,demo} from './seed-demo.mjs';
import {transaction} from '../src/database.mjs';
import {importTeamReferences,loadTeamReferenceManifest,teamReferences} from './import-team-references.mjs';
import {createApp} from '../src/server.mjs';
import {createRecordingStore} from '../src/recording-store.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const scratch=join(root,'.tmp');
await mkdir(scratch,{recursive:true});
const directory=await mkdtemp(join(scratch,'recording-browser-'));
const password='Isolated-browser-recording-2026';
let local,server,browser,store;
try {
  const playwrightPath=process.env.PLAYWRIGHT_MODULE||'C:/Users/XC-831/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  const {chromium}=await import(pathToFileURL(playwrightPath));
  let executable=process.env.BROWSER_EXECUTABLE;
  if(!executable) for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
    try {await access(candidate);executable=candidate;break;} catch {}
  }
  local=await openLocalDatabase(join(directory,'database'));
  await transaction(local.pool,db=>seedDemo(db,password));
  const manifest=await loadTeamReferenceManifest();
  await importTeamReferences(local.pool,manifest);
  const reserved=createServer();
  await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));
  const port=reserved.address().port;
  await new Promise(resolve=>reserved.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  store=createRecordingStore({root:join(directory,'recordings')});
  server=createApp({pool:local.pool,publicOrigin:origin,recordingStore:store});
  const handler=server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    if(req.url==='/recording-fixture') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end('<!doctype html><meta charset="utf-8"><title>Isolated recording verification</title><p id="recording-state"></p><p id="recording-error" hidden></p><div id="recording-list"></div><video id="recording-player" controls hidden></video><div id="recording-jumps"></div><video id="camera" muted></video>');
    } else if(req.url==='/fixture-photo.jpg') {
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});res.end(manifest.references[0].bytes);
    } else handler(req,res);
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:executable,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext();
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/recording-fixture');
  await page.evaluate(async ({groupId,members,email,password})=>{
    const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const auth=await login.json();
    if(!login.ok)throw new Error(JSON.stringify(auth));
    window.fixture={requests:[],measurements:[],context:{mode:'live',groupId,teacher:true,sessionId:'isolated-browser-fixture',version:1},uploaded:0};
    const request=async(path,options={})=>{
      const method=options.method||'GET',headers={};
      if(method!=='GET')headers['X-CSRF-Token']=auth.csrfToken;
      if(options.rawBody)headers['Content-Type']=options.contentType;
      else if(method!=='GET')headers['Content-Type']='application/json';
      const log={path,method,start:performance.now(),bytes:options.rawBody?.byteLength||0};
      window.fixture.requests.push(log);
      const responsePromise=fetch('/api'+path,{method,headers,...(method!=='GET'?{body:options.rawBody||JSON.stringify(options.body||{})}:{})});
      if(method==='PUT'&&window.fixture.measureOnUpload) {
        window.fixture.measureOnUpload=false;
        window.fixture.uploadMeasurement=window.fixture.measure('during-upload');
      }
      const response=await responsePromise,result=await response.json();
      log.end=performance.now();log.status=response.status;
      if(method==='PUT')window.fixture.uploaded++;
      if(!response.ok)throw new Error(JSON.stringify(result));
      return result;
    };
    window.Presence={getContext:()=>window.fixture.context,getVideo:()=>document.querySelector('#camera'),getRoster:()=>members,recordingRequest:request};
    const image=new Image();image.src='/fixture-photo.jpg';await image.decode();
    const scale=Math.min(1,640/image.width,480/image.height),canvas=document.createElement('canvas');
    canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    const drawing=canvas.getContext('2d');
    const draw=()=>{drawing.drawImage(image,0,0,canvas.width,canvas.height);drawing.fillStyle='white';drawing.fillText(String(Date.now()),4,canvas.height-5);};
    draw();window.fixture.drawTimer=setInterval(draw,1000/15);window.fixture.canvas=canvas;
    const video=document.querySelector('#camera');video.srcObject=canvas.captureStream(15);await video.play();
    window.fixture.measure=async(label)=>{
      const start=performance.now(),frame=canvas.toDataURL('image/jpeg',0.8).split(',')[1];
      const detection=await request(`/groups/${groupId}/faces/detect`,{method:'POST',body:{image:frame}});
      const detected=performance.now(),match=detection.matches.find(item=>item.identityMatched&&item.similarity>0.55);
      if(!match)throw new Error('Reference frame did not qualify at the unchanged 0.55 threshold');
      const saved=await request(`/groups/${groupId}/checkins`,{method:'POST',body:{personId:match.studentId}});
      const end=performance.now();
      if(!['present','late'].includes(saved.record.status))throw new Error('Attendance was not acknowledged');
      const row={label,recognitionMs:Math.round(detected-start),recognitionAndNewSessionSaveMs:Math.round(end-start),withPollingBudgetMs:Math.round(end-start+100),similarity:match.similarity,sessionId:saved.session.id,checkedInAt:saved.record.checked_in_at,start,end};
      window.fixture.measurements.push(row);
      document.dispatchEvent(new CustomEvent('presence:checkin',{detail:{sessionId:window.fixture.context.sessionId,studentId:match.studentId,studentName:members.find(item=>item.id===match.studentId)?.name,time:saved.record.checked_in_at}}));
      await request(`/sessions/${saved.session.id}/close`,{method:'POST',body:{}});
      return row;
    };
  },{groupId:teamReferences.groupId,members:teamReferences.members.map(item=>({id:item.personId,name:item.name})),email:demo.teacherEmail,password});
  const clientResponse=page.waitForResponse(origin+'/recording-client.js');
  await page.addScriptTag({type:'module',url:origin+'/recording-client.js'});
  const loadedClientSha256=createHash('sha256').update(await (await clientResponse).body()).digest('hex');
  await page.evaluate(async()=>{
    await window.fixture.measure('cold-before-recording');
    for(let i=1;i<=3;i++)await window.fixture.measure(`warm-before-recording-${i}`);
    window.fixture.measureOnUpload=true;
    document.dispatchEvent(new CustomEvent('presence:camera-start',{detail:{video:document.querySelector('#camera')}}));
  });
  await page.waitForFunction(()=>document.querySelector('#recording-state').textContent.startsWith('Recording ·'));
  await page.evaluate(async()=>{for(let i=1;i<=3;i++)await window.fixture.measure(`during-recording-${i}`);});
  await page.waitForFunction(()=>window.fixture.uploaded>=2,{},{timeout:30_000});
  await page.evaluate(async()=>{
    await window.fixture.uploadMeasurement;
    document.dispatchEvent(new CustomEvent('presence:camera-stop'));
  });
  await page.waitForFunction(()=>document.querySelector('#recording-state').textContent==='Recording saved',{},{timeout:30_000});
  const recording=await page.evaluate(async groupId=>(await window.Presence.recordingRequest(`/groups/${groupId}/recordings`)).recordings[0],teamReferences.groupId);
  assert.equal(recording.status,'finished');assert.equal(recording.seekable,true);assert.ok(recording.chunkCount>=2);
  await page.getByRole('button',{name:'Play recording'}).click();
  await page.waitForFunction(()=>{const video=document.querySelector('#recording-player');return video.readyState>=1&&Number.isFinite(video.duration)&&video.duration>0;},{},{timeout:15_000});
  const playback=await page.evaluate(async()=>{
    const video=document.querySelector('#recording-player');video.pause();
    const duration=video.duration,target=duration/2;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native seek timed out')),5000);video.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});video.currentTime=target;});
    const response=await fetch(video.src,{headers:{Range:'bytes=10-29'}}),bytes=await response.arrayBuffer();
    return {src:video.getAttribute('src'),durationSeconds:duration,seekTargetSeconds:target,seekResultSeconds:video.currentTime,rangeStatus:response.status,contentRange:response.headers.get('Content-Range'),rangeBytes:bytes.byteLength,jumpButtons:document.querySelectorAll('#recording-jumps button').length,playerError:video.error?.message||null,uiError:document.querySelector('#recording-error').hidden?null:document.querySelector('#recording-error').textContent};
  });
  assert.ok(playback.src.startsWith('/api/recordings/'),'Native video must use authenticated API URL');
  assert.ok(Math.abs(playback.seekResultSeconds-playback.seekTargetSeconds)<0.1);
  assert.equal(playback.rangeStatus,206);assert.equal(playback.rangeBytes,20);assert.equal(playback.playerError,null);assert.equal(playback.uiError,null);assert.deepEqual(errors,[]);
  assert.equal(playback.jumpButtons,1,'Repeated check-ins for the same student must produce one jump button');
  const jump=await page.evaluate(async recording=>{
    const video=document.querySelector('#recording-player');
    const mark=window.fixture.measurements.at(-1);
    const expected=Math.max(0,(Date.parse(mark.checkedInAt)-Date.parse(recording.startedAt))/1000-3);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Check-in jump did not seek')),5000);
      video.addEventListener('seeked',()=>{clearTimeout(timer);video.pause();resolve();},{once:true});
      document.querySelector('#recording-jumps button').click();
    });
    return {expectedSeconds:expected,actualSeconds:video.currentTime};
  },recording);
  assert.ok(Math.abs(jump.expectedSeconds-jump.actualSeconds)<0.1,'Check-in jump must seek with its three-second lead-in');
  const data=await page.evaluate(()=>({measurements:window.fixture.measurements,uploads:window.fixture.requests.filter(row=>row.method==='PUT')}));
  assert.equal(new Set(data.measurements.map(row=>row.sessionId)).size,data.measurements.length,'Every timing must include creation of a fresh attendance session');
  const overlap=data.measurements.find(row=>row.label==='during-upload');
  assert.ok(data.uploads.some(upload=>upload.start<=overlap.start&&upload.end>=overlap.start),'Measurement must start while an actual upload is in flight');
  const warm=data.measurements.filter(row=>!row.label.startsWith('cold'));
  await new Promise(resolve=>server.close(resolve));
  await local.pool.end();
  local=await openLocalDatabase(join(directory,'database'));
  const persisted=(await local.pool.query('SELECT session_id,status FROM attendance.attendance_records WHERE session_id=ANY($1::uuid[]) AND person_id=$2',[data.measurements.map(row=>row.sessionId),teamReferences.members[0].personId])).rows;
  assert.equal(persisted.length,data.measurements.length);assert.ok(persisted.every(row=>['present','late'].includes(row.status)));
  assert.equal(loadedClientSha256,createHash('sha256').update(await readFile(join(root,'recording-client.js'))).digest('hex'),'Client source must remain frozen during final verification');
  console.log(JSON.stringify({fixture:'Headless Chrome, real MediaRecorder and Python face worker, canvas photo stream at 15 fps, isolated persistent PGlite. Measures new-session creation and durable attendance acknowledgement; actual webcam latency is not measured.',browser:await browser.version(),loadedClientSha256,recording,playback,checkinJump:jump,persistedCheckinsAfterDatabaseReopen:persisted.length,measurements:data.measurements.map(({start,end,...row})=>row),uploads:data.uploads.map(({start,end,...row})=>({...row,durationMs:Math.round(end-start)})),maximumWarmWithPollingBudgetMs:Math.max(...warm.map(row=>row.withPollingBudgetMs)),warmSubsecond:warm.every(row=>row.withPollingBudgetMs<1000)},null,2));
} finally {
  await browser?.close();
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  await store?.close();
  await local?.pool.end();
  assert.ok(resolve(directory).startsWith(resolve(scratch)+sep));
  // The directory is mkdtemp-created within the workspace scratch root.
  await rm(directory,{recursive:true,force:true});
}
