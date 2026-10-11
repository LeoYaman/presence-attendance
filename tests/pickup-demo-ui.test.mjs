import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../pickup-demo.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

test('Leo and Anthony auto approve while other identified pairs require manual approval', async()=>{
  const h=harness(call=>call.path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):response({enabled:false,requests:[]}));
  await settle();h.nodes.get('workspace-video').dataset.active='true';h.window.dispatchEvent({type:'workspace:camera-start'});
  const observe=names=>h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',image:'jpeg',result:{matches:names.map(name=>({name,subjectId:name,identityMatched:true}))}}});
  assert.equal(h.nodes.get('pickup-pair-status').textContent,'No participants identified.');
  observe([]);assert.equal(h.nodes.get('pickup-pair-status').textContent,'No participants identified.');
  observe(['Olivia']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Cannot exit alone.');
  observe(['Leo']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Cannot exit alone.');
  observe(['Anthony']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Cannot exit alone.');
  observe(['Leo','Anthony']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Leo and Anthony were identified in the same frame.');
  observe(['Rebeca','Anthony']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Rebeca and Anthony identified. Manual demo approval required.');
  observe(['Leo','Rebeca']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Two participants identified. Manual demo approval required.');
  observe(['Olivia','Anthony']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'Two participants identified. Manual demo approval required.');
  observe(['Leo','Rebeca','Anthony']);assert.equal(h.nodes.get('pickup-pair-status').textContent,'More than two participants identified. No pickup approval.');
  h.nodes.get('workspace-video').dataset.active='';h.window.dispatchEvent({type:'workspace:camera-stop'});
  observe(['Leo','Anthony']);assert.match(h.nodes.get('pickup-pair-status').textContent,/Camera is off/);
  assert.equal(h.nodes.get('pickup-pair-status').textContent,'Camera is off.');
  await settle();
});

test('combined server recognition renders Approved immediately without a second inference request', async () => {
  const h = harness(call => call.path === '/api/me' ? response({user:{role:'teacher'},csrfToken:'csrf'}) : response(configuredData()));
  await settle();
  h.nodes.get('workspace-video').dataset.active='true';
  h.window.dispatchEvent({type:'workspace:camera-start'});
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',result:{matches:[]},pickupDecision:{state:'approved',reason:'Verified together',matchedNames:['Leo','Anthony']}}});
  assert.match(h.nodes.get('pickup-demo-result').textContent,/^Approved · Verified together · Matched: Leo, Anthony$/);
  assert.equal(h.calls.filter(c=>c.path==='/api/pickup-demo/decide').length,0);
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',result:{matches:[]},pickupDecision:{state:'blocked',reason:'Forbidden pair'}}});
  assert.match(h.nodes.get('pickup-demo-result').textContent,/^Blocked/);
  h.nodes.get('workspace-video').dataset.active='';
  h.window.dispatchEvent({type:'workspace:camera-stop'});
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',pickupDecision:{state:'approved'}}});
  assert.doesNotMatch(h.nodes.get('pickup-demo-result').textContent,/^Approved/);
  await settle();
});

test('combined decision immediately renders its named approval button and replaces the same request ID', async () => {
  const request={id:'request-pair',status:'pending',canApprove:true,createdAt:'2026-10-10T16:00:00Z',matchedNames:['Rebeca','Anthony'],reason:'Review this pair.'};
  const h=harness(call=>call.path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):response(configuredData({requests:[{...request,canApprove:false,matchedNames:['Anthony']}]})));
  await settle();
  h.nodes.get('workspace-video').dataset.active='true';h.window.dispatchEvent({type:'workspace:camera-start'});
  const getCount=h.calls.filter(call=>call.path==='/api/pickup-demo').length;
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',pickupDecision:{state:'pending',request,matchedNames:request.matchedNames}}});
  const list=h.nodes.get('pickup-demo-requests');
  assert.equal(list.children.length,1,'the incoming request replaces its previous version');
  assert.match(list.children[0].textContent,/Pickup for Rebeca \+ Anthony/);
  assert.equal(list.children[0].children[1]?.textContent,'Approve demo pickup','the button is visible synchronously with the recognition result');
  assert.equal(h.calls.filter(call=>call.path==='/api/pickup-demo').length,getCount,'rendering the decision does not need a GET request');
  assert.equal(h.calls.filter(call=>call.path==='/api/pickup-demo/decide').length,0);
});

test('a single participant never has a manual approval button or leaks a missing participant name',async()=>{
 const request={id:'solo',status:'pending',canApprove:true,matchedNames:['Rebbeca'],reason:'Anthony is not identified in this frame.'};
 const h=harness(call=>call.path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):response(configuredData({requests:[request]})));
 await settle();assert.equal(h.nodes.get('pickup-approval-attention').hidden,true);assert.equal(h.nodes.get('pickup-demo-requests').children[0].children.length,1);assert.match(h.nodes.get('pickup-demo-requests').textContent,/Cannot exit alone/);assert.doesNotMatch(h.nodes.get('pickup-demo-requests').textContent,/Anthony/);
 h.nodes.get('workspace-video').dataset.active='true';h.window.dispatchEvent({type:'workspace:camera-start'});
 h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',result:{matches:[{subjectId:'rebeca',name:'Rebbeca',identityMatched:true}]},pickupDecision:{state:'blocked',reason:'Cannot exit alone.',matchedNames:['Rebbeca']}}});
 assert.equal(h.nodes.get('pickup-pair-status').textContent,'Cannot exit alone.');assert.match(h.nodes.get('pickup-demo-result').textContent,/^Blocked.*Cannot exit alone\.$/);assert.equal(h.nodes.get('pickup-approval-attention').hidden,true);
});

test('an older polling response cannot remove the button rendered by a newer recognition decision', async () => {
  const poll=deferred();let gets=0;
  const h=harness(call=>call.path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):++gets===1?response(configuredData()):poll.promise);
  await settle();h.nodes.get('workspace-video').dataset.active='true';h.window.dispatchEvent({type:'workspace:camera-start'});
  h.intervals[0].callback();await settle();
  const request={id:'request-new',status:'pending',canApprove:true,matchedNames:['Rebeca','Anthony']};
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',pickupDecision:{state:'pending',request}}});
  poll.resolve(response(configuredData({requests:[]})));await settle();
  assert.match(h.nodes.get('pickup-demo-requests').textContent,/Pickup for Rebeca \+ Anthony/);
  assert.equal(h.nodes.get('pickup-demo-requests').children[0].children[1]?.textContent,'Approve demo pickup');
});

test('manual approval pauses recognition through events and retries a busy response before succeeding', async () => {
  let attempts=0;
  const h=harness(call=>{
    if(call.path==='/api/me')return response({user:{role:'teacher'},csrfToken:'csrf'});
    if(call.path==='/api/pickup-demo')return response(configuredData({requests:[{id:'request-1',status:'pending',canApprove:true,matchedNames:['Rebeca','Anthony']}]}));
    if(call.path.endsWith('/approve'))return ++attempts===1?response({error:{code:'pickup_busy',message:'Wait for recognition'}},429):response({state:'approved'});
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();
  const clicking=h.nodes.get('pickup-demo-requests').children[0].children[1].click();await settle();
  assert.equal(attempts,1);
  assert.equal(h.events.filter(event=>event.type==='pickup:approval-start').length,1);
  assert.equal(h.events.filter(event=>event.type==='pickup:approval-end').length,0,'recognition remains paused during the retry delay');
  assert.equal(h.retryTimers.length,1);
  h.retryTimers.shift()();await clicking;await settle();
  assert.equal(attempts,2);
  assert.equal(h.events.filter(event=>event.type==='pickup:approval-end').length,1);
  assert.match(h.nodes.get('pickup-demo-approval').textContent,/Demo pickup approved/);
});

test('stale changed-pair approval is never retried and always resumes recognition', async () => {
  let attempts=0;
  const h=harness(call=>{
    if(call.path==='/api/me')return response({user:{role:'teacher'},csrfToken:'csrf'});
    if(call.path==='/api/pickup-demo')return response(configuredData({requests:[{id:'request-1',status:'pending',canApprove:true,matchedNames:['Rebeca','Anthony']}]}));
    if(call.path.endsWith('/approve')){attempts++;return response({error:{code:'stale_approval',message:'Pair changed. Use a current pending request.'}},409);}
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();await h.nodes.get('pickup-demo-requests').children[0].children[1].click();await settle();
  assert.equal(attempts,1);assert.equal(h.retryTimers.length,0);
  assert.match(h.nodes.get('pickup-demo-approval').textContent,/Pair changed/);
  assert.deepEqual(h.events.filter(event=>event.type.startsWith('pickup:approval-')).map(event=>event.type),['pickup:approval-start','pickup:approval-end']);
});

test('busy approval stops after five attempts and releases the recognition pause', async () => {
  let attempts=0;
  const h=harness(call=>{
    if(call.path==='/api/me')return response({user:{role:'teacher'},csrfToken:'csrf'});
    if(call.path==='/api/pickup-demo')return response(configuredData({requests:[{id:'request-1',status:'pending',canApprove:true,matchedNames:['Rebeca','Anthony']}]}));
    if(call.path.endsWith('/approve')){attempts++;return response({error:{code:'pickup_busy',message:'Recognition is still busy.'}},429);}
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();
  const clicking=h.nodes.get('pickup-demo-requests').children[0].children[1].click();await settle();
  for(let attempt=1;attempt<5;attempt++){
    assert.equal(attempts,attempt);
    assert.equal(h.retryTimers.length,1);
    h.retryTimers.shift()();await settle();
  }
  await clicking;await settle();
  assert.equal(attempts,5);assert.equal(h.retryTimers.length,0);
  assert.match(h.nodes.get('pickup-demo-approval').textContent,/Recognition is still busy/);
  assert.deepEqual(h.events.filter(event=>event.type.startsWith('pickup:approval-')).map(event=>event.type),['pickup:approval-start','pickup:approval-end']);
});

test('a rate-limit error with another code does not retry approval', async () => {
  let attempts=0;
  const h=harness(call=>{
    if(call.path==='/api/me')return response({user:{role:'teacher'},csrfToken:'csrf'});
    if(call.path==='/api/pickup-demo')return response(configuredData({requests:[{id:'request-1',status:'pending',canApprove:true,matchedNames:['Rebeca','Anthony']}]}));
    if(call.path.endsWith('/approve')){attempts++;return response({error:{code:'rate_limited',message:'Try later.'}},429);}
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();await h.nodes.get('pickup-demo-requests').children[0].children[1].click();await settle();
  assert.equal(attempts,1);assert.equal(h.retryTimers.length,0);
  assert.match(h.nodes.get('pickup-demo-approval').textContent,/Try later/);
  assert.equal(h.events.filter(event=>event.type==='pickup:approval-end').length,1);
});

test('approved exit stays in history when the next frame identifies only Leo', async () => {
  const approvals=[{id:'event1',createdAt:'2026-10-10T16:00:00Z',matchedNames:['Leo','Anthony']}];
  const h=harness(call=>call.path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):response(configuredData({approvals})));
  await settle();h.nodes.get('workspace-video').dataset.active='true';h.window.dispatchEvent({type:'workspace:camera-start'});
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',pickupDecision:{state:'approved',approvals}}});
  assert.match(h.nodes.get('pickup-demo-history').textContent,/Leo and Anthony were seen together. Demo exit approved/);
  h.window.dispatchEvent({type:'subjects:recognition',detail:{app:'parent-child',pickupDecision:{state:'waiting',approvals,reason:'Anthony not visible'}}});
  assert.match(h.nodes.get('pickup-demo-result').textContent,/^Waiting/);
  assert.match(h.nodes.get('pickup-demo-history').textContent,/Approved — Leo and Anthony/);
});

function harness(fetcher, hash = '') {
  class Element {
    constructor(id = '') { this.id = id; this.dataset = {}; this.children = []; this.listeners = new Map(); this.disabled = false; this.text = ''; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    async click() { return this.listeners.get('click')?.({ type: 'click' }); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  }
  const ids = ['workspace-video', 'pickup-demo-result', 'pickup-demo-config', 'pickup-demo-requests', 'pickup-demo-refresh', 'pickup-demo-approval','pickup-pair-status','pickup-demo-history','pickup-approval-attention','pickup-attention-names','pickup-attention-approve'];
  const nodes = new Map(ids.map(id => [id, new Element(id)]));
  const windowListeners = new Map();
  const intervals = [];
  const retryTimers = [];
  const events = [];
  const calls = [];
  const window = {
    addEventListener(type, callback) { const list = windowListeners.get(type) || []; list.push(callback); windowListeners.set(type, list); },
    dispatchEvent(event) { events.push(event); for (const callback of windowListeners.get(event.type) || []) callback(event); },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; }
  };
  const document = {
    body: { dataset: { subjectsApp: 'parent-child' } },
    getElementById(id) { return nodes.get(id); },
    createElement() { return new Element(); }
  };
  const fetch = async (path, options = {}) => {
    const call = { path, options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return fetcher(call);
  };
  const context = vm.createContext({
    document, window, fetch, location: { hash }, URLSearchParams, AbortController,
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    setTimeout(callback, delay) { if(delay===200){retryTimers.push(callback);return {};}return setTimeout(callback,delay); },
    clearTimeout, console
  });
  vm.runInContext(source, context);
  return { nodes, window, calls, intervals, retryTimers, events };
}

function configuredData(overrides = {}) {
  return {
    enabled: true,
    configuration: { leoId: 'leo', rebecaId: 'rebeca', anthonyId: 'anthony' },
    mailConfigured: true,
    requests: [],
    latest: { state: 'approved', reason: 'An earlier request was approved.' },
    ...overrides
  };
}

test('pickup cards explain current requests and put obsolete requests in history', async () => {
  const h = harness(call => call.path === '/api/me' ? response({user:{role:'teacher'},csrfToken:'csrf'}) : response(configuredData({requests:[
    {id:'pending-id',status:'pending',canApprove:true,createdAt:'2026-10-10T23:36:48Z',matchedNames:['Rebeca','Anthony'],reason:'Manual demo approval is required.'},
    {id:'old-id',status:'superseded',canApprove:false,createdAt:'2026-10-10T23:36:46Z',reason:'Anthony is alone; Leo or manual demo approval is required.'}
  ]})));
  await settle();
  const list = h.nodes.get('pickup-demo-requests');
  assert.match(list.children[0].textContent,/Pickup for Rebeca \+ AnthonyPending approval/);
  assert.match(list.children[0].textContent,/Manual demo approval is required/);
  assert.doesNotMatch(list.textContent,/pending-id|old-id|Status: superseded/);
  const archive = list.children[1].children[0];
  assert.equal(archive.children[0].textContent,'Previous requests (1)');
  assert.match(archive.textContent,/No longer active/);
  assert.match(archive.textContent,/camera observation changed or ended/);
  const oldCard = archive.children[2].children[0];
  assert.equal(oldCard.children.length,1,'obsolete request has no approval button');
});

test('camera stop aborts an in-flight decision, resets server state, and ignores its late response', async () => {
  const decision = deferred();
  const h = harness(call => {
    if (call.path === '/api/me') return response({ user: { role: 'teacher' }, csrfToken: 'csrf' });
    if (call.path === '/api/pickup-demo') return response(configuredData());
    if (call.path === '/api/pickup-demo/decide') return decision.promise;
    if (call.path === '/api/pickup-demo/reset') return response({ state: 'reset' });
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();
  h.window.dispatchEvent({ type: 'workspace:camera-start' });
  h.nodes.get('workspace-video').dataset.active = 'true';
  h.window.dispatchEvent({ type: 'subjects:recognition', detail: { app: 'parent-child', image: 'jpeg-data' } });
  await settle();
  const decisionCall = h.calls.find(call => call.path === '/api/pickup-demo/decide');
  assert.ok(decisionCall);

  h.nodes.get('workspace-video').dataset.active = '';
  h.window.dispatchEvent({ type: 'workspace:camera-stop' });
  await settle();
  assert.equal(decisionCall.options.signal.aborted, true);
  assert.ok(h.calls.some(call => call.path === '/api/pickup-demo/reset' && call.options.method === 'POST' && JSON.stringify(call.body) === '{}'));
  assert.match(h.nodes.get('pickup-demo-result').textContent, /server pickup state was reset/i);

  decision.resolve(response({ state: 'approved', reason: 'late result' }));
  await settle();
  assert.match(h.nodes.get('pickup-demo-result').textContent, /server pickup state was reset/i);
});

test('polling updates request/config history without restoring an earlier latest decision', async () => {
  const h = harness(call => {
    if (call.path === '/api/me') return response({ user: { role: 'teacher' }, csrfToken: 'csrf' });
    if (call.path === '/api/pickup-demo') return response(configuredData());
    if (call.path === '/api/pickup-demo/decide') return response({ state: 'waiting', reason: 'Awaiting approval' });
    if (call.path === '/api/pickup-demo/reset') return response({ state: 'reset' });
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();
  h.nodes.get('workspace-video').dataset.active = 'true';
  h.window.dispatchEvent({ type: 'workspace:camera-start' });
  h.window.dispatchEvent({ type: 'subjects:recognition', detail: { app: 'parent-child', image: 'frame' } });
  await settle();
  assert.match(h.nodes.get('pickup-demo-result').textContent, /waiting · Awaiting approval/i);

  h.nodes.get('workspace-video').dataset.active = '';
  h.window.dispatchEvent({ type: 'workspace:camera-stop' });
  await settle();
  const stoppedText = h.nodes.get('pickup-demo-result').textContent;
  await h.intervals[0].callback();
  await settle();
  assert.equal(h.intervals[0].delay, 5000);
  assert.equal(h.nodes.get('pickup-demo-result').textContent, stoppedText);
  assert.doesNotMatch(h.nodes.get('pickup-demo-result').textContent, /earlier request|approved/i);
});

test('detail-free recognition error aborts work and resets server pickup state', async () => {
  const decision = deferred();
  const h = harness(call => {
    if (call.path === '/api/me') return response({ user: { role: 'teacher' }, csrfToken: 'csrf' });
    if (call.path === '/api/pickup-demo') return response(configuredData());
    if (call.path === '/api/pickup-demo/decide') return decision.promise;
    if (call.path === '/api/pickup-demo/reset') return response({ state: 'reset' });
    throw new Error(`Unexpected request: ${call.path}`);
  });
  await settle();
  h.nodes.get('workspace-video').dataset.active = 'true';
  h.window.dispatchEvent({ type: 'workspace:camera-start' });
  h.window.dispatchEvent({ type: 'subjects:recognition', detail: { app: 'parent-child', image: 'jpeg' } });
  await settle();
  const decisionCall = h.calls.find(call => call.path === '/api/pickup-demo/decide');
  h.window.dispatchEvent({ type: 'subjects:recognition-error' });
  await settle();
  assert.equal(decisionCall.options.signal.aborted, true);
  assert.ok(h.calls.some(call => call.path === '/api/pickup-demo/reset'));
  assert.match(h.nodes.get('pickup-demo-result').textContent, /recognition unavailable/i);
  decision.resolve(response({ state: 'approved', reason: 'stale' }));
  await settle();
  assert.doesNotMatch(h.nodes.get('pickup-demo-result').textContent, /approved|stale/i);
});

test('pickup decision failure updates only the pickup result and preserves recognized participant status', async () => {
  const h=harness(call=>call.path==='/api/me'
    ? response({user:{role:'teacher'},csrfToken:'csrf'})
    : response(configuredData()));
  await settle();
  h.nodes.get('pickup-pair-status').textContent='Cannot exit alone.';
  h.nodes.get('pickup-demo-result').textContent='Approved · Leo and Anthony were identified together.';
  h.window.dispatchEvent({type:'subjects:pickup-error',detail:{message:'Pickup service timed out.'}});
  assert.equal(h.nodes.get('pickup-demo-result').textContent,'Pickup decision unavailable: Pickup service timed out.');
  assert.equal(h.nodes.get('pickup-pair-status').textContent,'Cannot exit alone.');
  assert.equal(h.calls.some(call=>call.path==='/api/pickup-demo/reset'),false);
});

test('recognition submits only the JPEG image and manual approval sends POST only after a request button click', async () => {
  const h = harness(call => {
    if (call.path === '/api/me') return response({ user: { role: 'teacher' }, csrfToken: 'csrf' });
    if (call.path === '/api/pickup-demo') return response(configuredData({ requests: [{ id: 'request-1', status: 'pending', canApprove:true, matchedNames:['Rebeca','Anthony'] }] }));
    if (call.path === '/api/pickup-demo/decide') return response({ state: 'waiting', reason: 'Awaiting demo approval', matchedNames: ['Rebeca','Anthony'] });
    if (call.path === '/api/pickup-demo/requests/request-1/approve') return response({ state: 'approved', message: 'Approval recorded.' });
    throw new Error(`Unexpected request: ${call.path}`);
  }, '#pickup=request-1&token=secret-token');
  await settle();
  assert.equal(h.calls.some(call => call.path.includes('/approve')), false);

  h.nodes.get('workspace-video').dataset.active = 'true';
  h.window.dispatchEvent({ type: 'workspace:camera-start' });
  h.window.dispatchEvent({ type: 'subjects:recognition', detail: { app: 'parent-child', image: 'data:image/jpeg;base64,abc123' } });
  await settle();
  const decision = h.calls.find(call => call.path === '/api/pickup-demo/decide');
  assert.deepEqual(Object.keys(decision.body), ['image']);
  assert.equal(decision.body.image, 'abc123');

  const button = h.nodes.get('pickup-demo-requests').children[0].children[1];
  assert.ok(button);
  await button.click();
  await settle();
  const approval = h.calls.find(call => call.path.includes('/approve'));
  assert.equal(approval.options.method, 'POST');
  assert.deepEqual(approval.body, {});
  assert.match(h.nodes.get('pickup-demo-approval').textContent, /Demo pickup approved/);
});
