import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../student.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../student.html',import.meta.url),'utf8');
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const settle=async()=>{for(let i=0;i<80;i++) await Promise.resolve();};
const group={id:'g1',name:'Database Class',course_code:'DB101',time_zone:'America/New_York',term_ends_on:'2026-12-12',allowed_absences:10};
function payload(id='p1',name='Database Student') {
  return {profile:{id,person_code:id,full_name:name,notify_absence:false},groups:[group],history:[{group_id:'g1',starts_at:'2026-10-09T13:00:00Z',ends_at:'2026-10-09T14:00:00Z',status:'late',session_status:'closed',checked_in_at:'2026-10-09T13:14:00Z'}],summary:[{group_id:'g1',allowed_absences:10,used_absences:4,remaining_absences:6,term_ends_on:'2026-12-12'}]};
}
function harness(handler,role='student') {
  class Element {
    constructor(){this.children=[];this.listeners={};this.attributes={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.text='';}
    set textContent(value){this.text=String(value);this.children=[];}
    get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.text='';this.children=children;}
    setAttribute(key,value){this.attributes[key]=value;}
    getAttribute(key){return this.attributes[key];}
    addEventListener(name,callback){this.listeners[name]=callback;}
    querySelector(selector){return element(selector);}
    focus(){}
  }
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>['#'+match[1],new Element()]));
  for(const selector of ['root','.history','tbody','.uni-switch','.course-picker:not(#preview-picker)','meta[name="theme-color"]']) nodes.set(selector,new Element());
  function element(selector){assert.ok(nodes.has(selector),`Missing selector ${selector}`);return nodes.get(selector);}
  const events={},requests=[],intervals=[];
  const document={documentElement:element('root'),hidden:false,querySelector:element,querySelectorAll:()=>[],createElement:()=>new Element(),createTextNode:value=>{const node=new Element();node.textContent=value;return node;},addEventListener:(name,callback)=>events[name]=callback};
  const context=vm.createContext({document,Intl,Date,console,localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:false}),getComputedStyle:()=>({getPropertyValue:()=>''}),setInterval:(callback,ms)=>intervals.push({callback,ms}),fetch:async(path,options)=>{requests.push({path,options});return path==='/api/me'?response({user:{id:'u1',role},csrfToken:'csrf-token'}):handler(path,options);}});
  vm.runInContext(source+'\nglobalThis.testing={state,refreshAttendance};',context);
  return {...context.testing,nodes,element,requests,document,events,intervals};
}

test('student renders server profile, course-local timestamps and authoritative allowance',async()=>{
  const h=harness(path=>{assert.equal(path,'/api/student-profile');return response(payload('p1','<script>Student</script>'));});await settle();
  assert.equal(h.element('#profile-name').textContent,'<script>Student</script>');
  assert.equal(h.element('#remaining-count').textContent,'6');
  assert.equal(h.element('#session-count').textContent,'1 session');
  assert.match(h.element('tbody').textContent,/9:00 AM–10:00 AM.*Late.*9:14 AM/);
  assert.equal(h.element('#preview-picker').hidden,true);
  assert.equal(h.element('#email-notifications').disabled,false);
  assert.equal(h.requests.some(request=>request.path.includes('student-preview')),false);
  assert.equal(h.intervals[0].ms,15000);
});

test('teacher uses explicitly read-only managed student preview and disables preferences',async()=>{
  const h=harness(path=>response(path==='/api/student-preview'?{students:[{id:'p1',person_code:'001',full_name:'Managed Student'}]}:payload()),'teacher');await settle();
  assert.equal(h.element('#preview-picker').hidden,false);
  assert.match(h.element('#profile-id').textContent,/Read-only preview/);
  assert.equal(h.element('#email-notifications').disabled,true);
  assert.equal(h.requests.some(request=>request.path==='/api/student-profile'),false);
  assert.ok(h.requests.some(request=>request.path==='/api/student-preview/p1'));
  h.element('#email-notifications').checked=true;await h.element('#email-notifications').listeners.change();
  assert.equal(h.requests.some(request=>request.path==='/api/preferences'),false);
});

test('own notification preference saves with CSRF and rolls back on failure',async()=>{
  let fail=false;
  const h=harness((path,options)=>path==='/api/preferences'?response(fail?{error:{message:'Save failed'}}:{notify_absence:JSON.parse(options.body).notify_absence},fail?503:200):response(payload()));await settle();
  const toggle=h.element('#email-notifications');toggle.checked=true;await toggle.listeners.change();
  assert.equal(toggle.checked,true);assert.equal(h.state.profile.notify_absence,true);
  const request=h.requests.find(request=>request.path==='/api/preferences');
  assert.equal(request.options.headers['X-CSRF-Token'],'csrf-token');
  assert.deepEqual(JSON.parse(request.options.body),{notify_absence:true});
  assert.match(h.element('#email-help').textContent,/Email delivery is not configured/);
  fail=true;toggle.checked=false;await toggle.listeners.change();assert.equal(toggle.checked,true);
  assert.match(h.element('#email-help').textContent,/Save failed/);
});

test('late response from previously selected preview cannot replace current student',async()=>{
  let release;
  const delayed=new Promise(resolve=>release=resolve);
  const h=harness(path=>path==='/api/student-preview'?response({students:[{id:'p1',person_code:'001',full_name:'First'},{id:'p2',person_code:'002',full_name:'Second'}]}):path.endsWith('/p1')?delayed:response(payload('p2','Second')),'teacher');await settle();
  h.element('#preview-select').value='p2';h.element('#preview-select').listeners.change();await settle();
  assert.equal(h.element('#profile-name').textContent,'Second');
  release(response(payload('p1','First')));await settle();
  assert.equal(h.element('#profile-name').textContent,'Second');assert.equal(h.state.personId,'p2');
});

test('signed-out and empty classes never show sample records',async()=>{
  const h=harness(()=>response({error:{message:'Please sign in'}},401));await settle();
  assert.equal(h.element('#student-signin').hidden,false);
  assert.match(h.element('tbody').textContent,/Sign in/);
  assert.equal(h.element('#attendance-summary').hidden,true);
  const empty=harness(()=>response({...payload(),groups:[],history:[],summary:[]}));await settle();
  assert.match(empty.element('tbody').textContent,/No classes/);
  assert.equal(empty.element('#fact-code').textContent,'—');
  assert.doesNotMatch(html,/Alex Morgan|cs101|Oct 9, 2026|7 left/);
});

test('refresh is paused while hidden and clears records when authorization fails',async()=>{
  let forbidden=false;
  const h=harness(()=>response(forbidden?{error:{message:'Student access required'}}:payload(),forbidden?403:200));await settle();
  const count=h.requests.length;h.document.hidden=true;h.intervals[0].callback();await settle();assert.equal(h.requests.length,count);
  forbidden=true;h.document.hidden=false;h.events.visibilitychange();await settle();
  assert.equal(h.state.profile,null);assert.equal(h.element('#attendance-summary').hidden,true);
  assert.match(h.element('#attendance-state').textContent,/Student access required/);
});

test('losing the last assigned class clears prior allowance and sidebar facts',async()=>{
  let data=payload();const h=harness(()=>response(data));await settle();
  assert.equal(h.element('#fact-code').textContent,'DB101');
  data={...payload(),groups:[],history:[],summary:[]};await h.refreshAttendance();
  assert.equal(h.element('#fact-code').textContent,'—');assert.equal(h.element('#allowance-lead').textContent,'Allowance unavailable');
  assert.equal(h.element('#profile-name').textContent,'Database Student');
});

test('manual refresh cannot discard a pending preference save acknowledgment',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const h=harness(path=>path==='/api/preferences'?gate:response(payload()));await settle();
  const toggle=h.element('#email-notifications');toggle.checked=true;const saving=toggle.listeners.change();await settle();
  const count=h.requests.length;await h.refreshAttendance();assert.equal(h.requests.length,count);assert.equal(h.element('#refresh-attendance').disabled,true);
  release(response({notify_absence:true}));await saving;
  assert.equal(h.state.profile.notify_absence,true);assert.equal(h.element('#refresh-attendance').disabled,false);
});
