import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../attendance-insights.js', import.meta.url), 'utf8');
const sessionId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const secondSessionId = '33333333-3333-4333-8333-333333333333';

class Element {
  constructor(tag = 'div') { this.tagName=tag; this.children=[]; this.listeners={}; this.value=''; this.textContent=''; this.files=[]; this.hidden=false; this.disabled=false; this.href=''; this.options=[]; }
  append(...children) { const isFirst=this.children.length===0; this.children.push(...children); this.options=this.children; if (isFirst && children.length && this.tagName==='select') this.value=children[0].value; }
  replaceChildren(...children) { this.children=[]; this.value=''; this.append(...children); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type, event={}) { for (const callback of this.listeners[type] || []) await callback({target:this,...event}); }
}
function response(body, status=200) { return {ok:status>=200&&status<300,status,json:async()=>body}; }
function presenceReport(id=sessionId, {total=0, synthetic=true}={}) {
  return {version:1,engine:'Presence Attendance',generated_at:'2026-10-11T16:30:00Z',synthetic,session:{id,class_code:'BIO-101',class_name:'Biology',starts_at:'2026-10-11T14:00:00Z',ends_at:'2026-10-11T15:00:00Z',closed_at:'2026-10-11T15:02:00Z'},classes:[{class_code:'BIO-101',total,attended:0,late:0,absent:total,attendance_rate:0,late_rate:0,suggestion:'No attendance records were recorded.'}]};
}
function sessionList(id=sessionId) {
  return {reports:[{id,group_id:groupId,class_code:'BIO-101',class_name:'Biology',starts_at:'2026-10-11T14:00:00Z',ends_at:'2026-10-11T15:00:00Z',closed_at:'2026-10-11T15:02:00Z',total:0,synthetic:true}]};
}
function deferred() { let resolve,reject; const promise=new Promise((r,j)=>{resolve=r;reject=j;}); return {promise,resolve,reject}; }
async function settle() { for(let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve)); }

function boot(fetcher) {
  const ids=['databricks-panel','analytics-report','analytics-file','analytics-status','analytics-list-status','analytics-results','analytics-clear','analytics-group','analytics-export','analytics-demo-download'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element(id==='analytics-report'||id==='analytics-group'?'select':'div')]));
  elements['analytics-report'].append(Object.assign(new Element('option'),{value:'',textContent:'Choose a report…'}),Object.assign(new Element('option'),{value:'demo',textContent:'Databricks demo report (synthetic)'}));
  const documentListeners={};
  const document={getElementById:id=>elements[id]||null,createElement:tag=>new Element(tag),addEventListener(type,callback){(documentListeners[type]||=[]).push(callback);},fire:async type=>{for(const callback of documentListeners[type]||[])await callback({type});}};
  const windowListeners={}; let intervalCallback;
  const window={addEventListener(type,callback){(windowListeners[type]||=[]).push(callback);},setInterval(callback){intervalCallback=callback;return 1;},clearInterval(){}};
  vm.runInNewContext(source,{document,window,fetch:fetcher,location:{href:''},setInterval:window.setInterval,clearInterval:window.clearInterval,Date,Intl,JSON,encodeURIComponent,Number,Array,Map,Error,Promise});
  return {elements,document,windowListeners,documentListeners,poll:()=>intervalCallback?.()};
}

test('selecting a finalized report renders session provenance and permits zero-record classes', async()=>{
  const calls=[];
  const ui=boot(async url=>{calls.push(url); if(url==='/api/me')return response({user:{role:'teacher'}}); if(url==='/api/attendance-insights/reports')return response(sessionList()); if(url.endsWith('/'+sessionId))return response(presenceReport()); if(url==='/api/groups')return response({groups:[]}); throw new Error(url);});
  await settle();
  assert.equal(ui.elements['analytics-results'].children.length,0,'initial results are blank');
  assert.equal(ui.elements['analytics-report'].options.length,3);
  assert.match(ui.elements['analytics-report'].options[2].textContent,/BIO-101.*Biology/);
  ui.elements['analytics-report'].value=sessionId;
  await ui.elements['analytics-report'].fire('change');
  await settle();
  assert.equal(ui.elements['analytics-results'].children.length,1);
  assert.match(ui.elements['analytics-status'].textContent,/finalized Presence Attendance session/);
  assert.match(ui.elements['analytics-status'].textContent,/Session date:/);
  assert.match(ui.elements['analytics-status'].textContent,/Times shown in/);
  assert.match(ui.elements['analytics-status'].textContent,/Synthetic data/);
  assert.equal(ui.elements['analytics-list-status'].textContent,'');
  assert.match(ui.elements['analytics-results'].children[0].children[1].textContent,/0 records/);
  assert.ok(calls.includes('/api/attendance-insights/reports/'+sessionId));
});

test('clear resets both selector and file input, and a later import remains explicit', async()=>{
  const ui=boot(async url=>url==='/api/me'?response({user:{role:'admin'}}):url==='/api/attendance-insights/reports'?response(sessionList()):url==='/api/groups'?response({groups:[]}):response({error:'missing'},404));
  await settle();
  const file=ui.elements['analytics-file']; file.value='picked.json'; file.files=[{size:5,text:async()=>'{"bad":true}'}];
  ui.elements['analytics-report'].value='demo';
  await ui.elements['analytics-clear'].fire('click');
  assert.equal(ui.elements['analytics-report'].value,'');
  assert.equal(file.value,'');
  assert.equal(ui.elements['analytics-results'].children.length,0);
  assert.match(ui.elements['analytics-status'].textContent,/Report cleared/);
});

test('a stale selection cannot replace a newer report and errors remove old results', async()=>{
  const first=deferred();
  let list=sessionList();
  const ui=boot(async url=>{
    if(url==='/api/me')return response({user:{role:'teacher'}});
    if(url==='/api/attendance-insights/reports')return response(list);
    if(url.endsWith('/'+sessionId))return first.promise;
    if(url.endsWith('/'+secondSessionId))return response(presenceReport(secondSessionId,{total:3,synthetic:false}));
    if(url==='/api/groups')return response({groups:[]});
    throw new Error(url);
  });
  await settle();
  ui.elements['analytics-report'].value=sessionId;
  const oldRequest=ui.elements['analytics-report'].fire('change');
  list={reports:[{...sessionList(secondSessionId).reports[0],total:3,synthetic:false}]};
  await ui.document.fire('presence:approved'); await settle();
  ui.elements['analytics-report'].value=secondSessionId;
  await ui.elements['analytics-report'].fire('change');
  await settle();
  first.resolve(response(presenceReport()));
  await oldRequest;
  assert.match(ui.elements['analytics-status'].textContent,/Session marked non-synthetic/);
  assert.match(ui.elements['analytics-results'].children[0].children[1].textContent,/3 records/);
  assert.equal(ui.documentListeners['presence:approved'].length,1);
});

test('demo selection loads the downloadable bundled artifact and labels it historical', async()=>{
  const demo={version:1,engine:'Databricks Spark',generated_at:'2026-10-10T12:00:00Z',synthetic:true,classes:[{class_code:'DEMO',total:1,attended:1,late:0,absent:0,attendance_rate:100,late_rate:0,suggestion:'Continue monitoring.'}]};
  const ui=boot(async url=>url==='/api/me'?response({user:{role:'teacher'}}):url==='/api/attendance-insights/reports'?response({reports:[]}):url==='/databricks/demo-results.json'?response(demo):url==='/api/groups'?response({groups:[]}):response({},404));
  await settle();
  ui.elements['analytics-report'].value='demo'; await ui.elements['analytics-report'].fire('change'); await settle();
  assert.equal(ui.elements['analytics-demo-download'].href,'/databricks/demo-results.json');
  assert.match(ui.elements['analytics-status'].textContent,/Historical report/);
  assert.match(ui.elements['analytics-status'].textContent,/does not run a live Databricks analysis/);
});

test('a selected-report API error clears previously displayed metrics', async()=>{
  const list={reports:[...sessionList().reports,{...sessionList(secondSessionId).reports[0],class_code:'BIO-102'}]};
  const ui=boot(async url=>{
    if(url==='/api/me')return response({user:{role:'teacher'}});
    if(url==='/api/attendance-insights/reports')return response(list);
    if(url.endsWith('/'+sessionId))return response(presenceReport());
    if(url.endsWith('/'+secondSessionId))return response({error:{message:'Report unavailable'}},404);
    if(url==='/api/groups')return response({groups:[]});
    return response({},404);
  });
  await settle();
  ui.elements['analytics-report'].value=sessionId; await ui.elements['analytics-report'].fire('change'); await settle();
  assert.equal(ui.elements['analytics-results'].children.length,1);
  ui.elements['analytics-report'].value=secondSessionId; await ui.elements['analytics-report'].fire('change'); await settle();
  assert.equal(ui.elements['analytics-results'].children.length,0);
  assert.match(ui.elements['analytics-status'].textContent,/Could not load the selected report: Report unavailable/);
});

test('a delayed failed background refresh preserves a newer selection or import', async t=>{
  const imported={version:1,engine:'Databricks Spark',generated_at:'2026-10-10T12:00:00Z',synthetic:false,classes:[{class_code:'IMPORTED',total:2,attended:1,late:0,absent:1,attendance_rate:50,late_rate:0,suggestion:'Imported summary.'}]};
  const demo={version:1,engine:'Databricks Spark',generated_at:'2026-10-10T12:00:00Z',synthetic:true,classes:[{class_code:'DEMO',total:1,attended:1,late:0,absent:0,attendance_rate:100,late_rate:0,suggestion:'Demo summary.'}]};
  for(const mode of ['demo','import','session']) await t.test(mode,async()=>{
    const failingList=deferred(); let shouldFailList=false;
    const ui=boot(async url=>{
      if(url==='/api/me')return response({user:{role:'teacher'}});
      if(url==='/api/attendance-insights/reports')return shouldFailList?failingList.promise:response(sessionList());
      if(url.endsWith('/'+sessionId))return response(presenceReport());
      if(url==='/databricks/demo-results.json')return response(demo);
      if(url==='/api/groups')return response({groups:[]});
      return response({},404);
    });
    await settle();
    shouldFailList=true; ui.poll(); await settle();
    if(mode==='demo'){
      ui.elements['analytics-report'].value='demo'; await ui.elements['analytics-report'].fire('change'); await settle();
    }else if(mode==='session'){
      ui.elements['analytics-report'].value=sessionId; await ui.elements['analytics-report'].fire('change'); await settle();
    }else{
      ui.elements['analytics-file'].files=[{size:JSON.stringify(imported).length,text:async()=>JSON.stringify(imported)}];
      await ui.elements['analytics-file'].fire('change'); await settle();
    }
    const visibleStatus=ui.elements['analytics-status'].textContent;
    const visibleCards=ui.elements['analytics-results'].children.map(card=>card.children[0].textContent);
    failingList.reject(new Error('temporary network failure')); await settle();
    assert.equal(ui.elements['analytics-status'].textContent,visibleStatus);
    assert.deepEqual(ui.elements['analytics-results'].children.map(card=>card.children[0].textContent),visibleCards);
    assert.match(ui.elements['analytics-list-status'].textContent,/temporary network failure/);
    assert.equal(ui.elements['analytics-report'].value,mode==='import'?'':mode==='demo'?'demo':sessionId);
  });
});

test('contradictory percentages are rejected before rendering an imported report', async()=>{
  const ui=boot(async url=>url==='/api/me'?response({user:{role:'teacher'}}):url==='/api/attendance-insights/reports'?response({reports:[]}):url==='/api/groups'?response({groups:[]}):response({},404));
  await settle();
  const invalid={version:1,engine:'Databricks Spark',generated_at:'2026-10-10T12:00:00Z',synthetic:true,classes:[{class_code:'BAD',total:2,attended:1,late:0,absent:1,attendance_rate:90,late_rate:0,suggestion:'Bad rates.'}]};
  ui.elements['analytics-file'].files=[{size:JSON.stringify(invalid).length,text:async()=>JSON.stringify(invalid)}];
  await ui.elements['analytics-file'].fire('change'); await settle();
  assert.equal(ui.elements['analytics-results'].children.length,0);
  assert.match(ui.elements['analytics-status'].textContent,/rates do not match counts/);
});
