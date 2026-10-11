import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../subjects-camera.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = value => ({ ok: true, status: 200, json: async () => value });

function harness(fetcher, app = 'subject-finder', options = {}) {
  const nodes = new Map();
  const encodes = [];
  const rectangles = [], clears = [], transforms = [], resizeCallbacks = [];
  let encodeIndex = 0;
  class Element {
    constructor(id = '') { this.id = id; this.style = {}; this.dataset = {}; this.children = []; this.listeners = new Map(); this.text = ''; this.readyState = 2; this.videoWidth = options.videoWidth || 640; this.videoHeight = options.videoHeight || 480; this.width = 0; this.height = 0; this.clientWidth = options.figureWidth || 960; this.clientHeight = options.figureHeight || 540; }
    set innerHTML(_value) {}
    setAttribute() {}
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); }
    dispatch(type) { for (const callback of this.listeners.get(type) || []) callback({ type }); }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    getContext() { return { drawImage() {}, setTransform(...args) { transforms.push(args); }, clearRect(...args) { clears.push(args); }, strokeRect(...args) { rectangles.push(args); } }; }
    toDataURL(_type, quality) { encodes.push({width:this.width,height:this.height,quality}); const size = options.encodedLengths?.[encodeIndex++] ?? 4; return 'data:image/jpeg;base64,' + 'A'.repeat(size); }
  }
  for (const id of ['subjects-status', 'subjects-list', 'subjects-match', 'subjects-match-note']) nodes.set(id, new Element(id));
  const video = new Element('workspace-video');
  const host = new Element('camera-col');
  const figure = new Element('camera-figure'); host.append(figure);
  const panel = new Element('subjects-panel');
  const docListeners = new Map();
  let groupId = 'course-a', contextVersion = 1;
  const document = {
    body: Object.assign(new Element('body'), { dataset: { subjectsApp: app }, classList: { contains: () => false } }),
    querySelector: selector => selector === '.camera-col' ? host : selector === 'figure.camera' ? figure : null,
    getElementById: id => ['workspace-video', 'camera-video'].includes(id) ? video : null,
    createElement: () => new Element(),
    addEventListener: (type, callback) => { const callbacks = docListeners.get(type) || []; callbacks.push(callback); docListeners.set(type, callbacks); },
    dispatchEvent: event => { for (const callback of docListeners.get(event.type) || []) callback(event); }
  };
  panel.querySelector = selector => nodes.get(selector.slice(1));
  const intervalCallbacks = [];
  const window = { devicePixelRatio: options.devicePixelRatio || 1, getComputedStyle: () => ({transform: options.transform || 'matrix(-1, 0, 0, 1, 0, 0)'}), addEventListener: (type, callback) => { window.listeners.set(type, callback); }, listeners: new Map(), dispatchEvent: event => window.listeners.get(event.type)?.(event) };
  const presence = { getContext: () => ({ groupId, version: contextVersion, teacher: true }) };
  window.Presence = presence;
  const fetch = (path, init) => path === '/api/pickup-demo' ? Promise.resolve(response({enabled:options.pickupEnabled === true})) : fetcher(path, init);
  const context = vm.createContext({ document, window, ResizeObserver: class { constructor(callback) { resizeCallbacks.push(callback); } observe() {} disconnect() {} }, fetch, Presence: presence, AbortController, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, setTimeout: () => 1, clearTimeout() {}, setInterval: callback => (intervalCallbacks.push(callback), intervalCallbacks.length), console });
  vm.runInContext(source, context);
  return { nodes, host, figure, video, window, document, intervalCallbacks, encodes, rectangles, clears, transforms, resizeCallbacks, changeCourse: id => { groupId = id; contextVersion++; } };
}

test('does not say Got you for an identity claim outside the API roster', async () => {
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 2 }] })
      : response({ version: 1, matches: [{ subjectId: 'unknown', name: 'Olivia', identityMatched: true }] }));
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.equal(h.nodes.get('subjects-match').textContent, 'No identity match');
});

test('enabled pickup keeps external target recognition independent from local pickup decisions on the same frame', async () => {
  const calls = [], target={version:1,matches:[{subjectId:'olivia',name:'Olivia',identityMatched:true,box:{x:0,y:0,width:.2,height:.2}}]}, decision = {state:'approved',reason:'Verified pair',recognition:{matches:[{subjectId:'leo',name:'Leo',identityMatched:true}]}};
  const h = harness(async (path, options) => {
    if (path === '/api/me') return response({user:{role:'teacher'},csrfToken:'csrf'});
    if (path.startsWith('/api/subjects?')) return response({version:1,subjects:[{id:'olivia',name:'Olivia'}]});
    calls.push({path,body:JSON.parse(options.body)});return response(path==='/api/subjects/detect'?target:decision);
  }, 'parent-child', {pickupEnabled:true});
  let event;h.window.addEventListener('subjects:recognition', value => {event=value;});
  await settle();h.window.dispatchEvent({type:'workspace:camera-start'});await settle();
  assert.equal(calls.length,2);assert.equal(calls[0].path,'/api/subjects/detect');assert.equal(calls[1].path,'/api/pickup-demo/decide');
  assert.equal(calls[0].body.image,calls[1].body.image);assert.deepEqual(Object.keys(calls[1].body),['image']);
  assert.equal(h.nodes.get('subjects-match').textContent,'Got you, Olivia');assert.equal(h.rectangles.length,1);
  assert.equal(event.detail.pickupDecision.state,'approved');assert.equal(event.detail.result,decision.recognition);
  assert.equal(event.detail.image,undefined);
});

test('shows Got you only for a backend-confirmed subject in the registered list', async () => {
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'olivia-id', name: 'Olivia', referenceCount: 2 }] })
      : response({ version: 1, matches: [{ subjectId: 'olivia-id', name: 'Olivia', identityMatched: true }] }));
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.equal(h.nodes.get('subjects-match').textContent, 'Got you, Olivia');
  assert.match(h.nodes.get('subjects-match-note').textContent, /does not verify any relationship/);
});

test('ignores a late detection response after camera stop', async () => {
  const detection = deferred();
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 1 }] })
      : detection.promise);
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  h.window.dispatchEvent({ type: 'workspace:camera-stop' });
  detection.resolve(response({ version: 1, matches: [{ subjectId: 'known', name: 'Olivia', identityMatched: true }] })); await settle();
  assert.equal(h.nodes.get('subjects-match').textContent, 'No identity match');
  assert.equal(h.nodes.get('subjects-match-note').textContent, 'Camera is off.');
});

test('ignores a detection response for the previous attendance course', async () => {
  const detection = deferred();
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 1 }] })
      : detection.promise, 'attendance');
  await settle(); h.document.dispatchEvent({ type: 'presence:camera-start' }); await settle();
  h.changeCourse('course-b');
  detection.resolve(response({ version: 1, matches: [{ subjectId: 'known', name: 'Olivia', identityMatched: true }] })); await settle();
  assert.equal(h.nodes.get('subjects-match').textContent, 'Checking identity…');
});

test('refreshes the API subject list while the camera is off', async () => {
  let version = 1;
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : response({ version, subjects: [{ id: 'known', name: `Version ${version}`, referenceCount: 1 }] }));
  await settle();
  assert.match(h.nodes.get('subjects-list').textContent, /Version 1/);
  version = 2; h.intervalCallbacks[0](); await settle();
  assert.match(h.nodes.get('subjects-list').textContent, /Version 2/);
});

test('keeps high-resolution frames within the worker image limits', async () => {
  let detectBody;
  const h = harness(async (path, options) => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 1 }] })
      : (detectBody = JSON.parse(options.body), response({ version: 1, registeredReferences: 1, matches: [] })),
  'subject-finder', {videoWidth:1920, videoHeight:1080});
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.deepEqual(h.encodes[0] && [h.encodes[0].width, h.encodes[0].height], [1280, 720]);
  assert.ok(detectBody.image.length <= 350000);
});

test('lowers JPEG quality and dimensions when an encoded frame exceeds the request budget', async () => {
  let detectBody;
  const h = harness(async (path, options) => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 1 }] })
      : (detectBody = JSON.parse(options.body), response({ version: 1, registeredReferences: 1, matches: [] })),
  'subject-finder', {videoWidth:1280, videoHeight:720, encodedLengths:[360000,355000,354000,300000]});
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.ok(detectBody.image.length <= 350000);
  assert.deepEqual(h.encodes.map(encode => encode.quality), [.78, .65, .5, .5]);
  assert.ok(h.encodes[3].width < 1280 && h.encodes[3].height < 720);
});

test('guides users closer when detected faces are below the worker minimum size', async () => {
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 1 }] })
      : response({ version: 1, registeredReferences: 1, matches: [{ subjectId: null, identityMatched: false, box: {x:.1,y:.1,width:.05,height:.1} }] }));
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.match(h.nodes.get('subjects-match-note').textContent, /move closer.*80 pixels/i);
});

test('reports when the app has no enrolled face references', async () => {
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'known', name: 'Olivia', referenceCount: 0 }] })
      : response({ version: 1, registeredReferences: 0, matches: [] }));
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.match(h.nodes.get('subjects-match-note').textContent, /no face references are enrolled/i);
});

test('shows all server-verified subjects that belong to the current roster', async () => {
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'one', name: 'Olivia' }, { id: 'two', name: 'Sam' }] })
      : response({ version: 1, registeredReferences: 2, matches: [
        { subjectId: 'one', name: 'Olivia', identityMatched: true },
        { subjectId: 'two', name: 'Sam', identityMatched: true },
        { subjectId: 'unknown', name: 'Intruder', identityMatched: true }
      ] }));
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.equal(h.nodes.get('subjects-match').textContent, 'Got you, Olivia, Sam');
});

test('parent-child shows all verified roster names above the camera and rejects other identity claims', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'one', name }, { id: 'two', name: 'Sam' }] })
      : response({ version: 1, matches: [
        { subjectId: 'one', name, identityMatched: true },
        { subjectId: 'two', name: 'Sam', identityMatched: true },
        { subjectId: 'unknown', name: 'Intruder', identityMatched: true },
        { subjectId: 'two', name: 'Wrong name', identityMatched: true }
      ] }), 'parent-child');
  await settle();
  const banner = h.host.children[0], message = banner.children[0];
  assert.equal(banner.className, 'match subjects-panel subjects-live-banner');
  assert.equal(h.host.children[1], h.figure);
  h.window.dispatchEvent({ type: 'workspace:camera-start' });
  assert.equal(message.textContent, 'Checking identity…');
  await settle();
  assert.equal(message.textContent, `Got you, ${name}, Sam`);
  assert.equal(message.children.length, 0, 'names are literal text, never markup');
  assert.equal(h.host.children.at(-1), h.figure, 'bottom roster and result panel are removed');
  h.window.dispatchEvent({ type: 'workspace:camera-stop' });
  assert.equal(message.textContent, 'No identity match');
  assert.equal(banner.children[1].textContent, 'Camera is off.');
});

test('parent-child clears the visible match when any matched roster identity becomes stale', async () => {
  let version = 1;
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version, subjects: version === 1 ? [{ id: 'one', name: 'Olivia' }, { id: 'two', name: 'Sam' }] : [{ id: 'one', name: 'Olivia' }] })
      : response({ version: 1, matches: [{ subjectId: 'one', name: 'Olivia', identityMatched: true }, { subjectId: 'two', name: 'Sam', identityMatched: true }] }), 'parent-child');
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  const banner = h.host.children[0];
  assert.equal(banner.children[0].textContent, 'Got you, Olivia, Sam');
  version = 2; h.intervalCallbacks[0](); await settle();
  assert.equal(banner.children[0].textContent, 'No identity match');
  assert.match(banner.children[1].textContent, /no longer in the registered list/);
});

test('parent-child visible banner ignores late detection after stop and surfaces camera errors', async () => {
  const detection = deferred();
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'one', name: 'Olivia' }] })
      : detection.promise, 'parent-child');
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  h.window.dispatchEvent({ type: 'workspace:camera-stop' });
  detection.resolve(response({ version: 1, matches: [{ subjectId: 'one', name: 'Olivia', identityMatched: true }] })); await settle();
  const banner = h.host.children[0];
  assert.equal(banner.children[0].textContent, 'No identity match');
  assert.equal(banner.children[1].textContent, 'Camera is off.');
  h.window.dispatchEvent({ type: 'workspace:camera-error', detail: { message: 'Camera permission denied.' } });
  assert.equal(banner.children[0].textContent, 'Camera unavailable');
  assert.equal(banner.children[1].textContent, 'Camera permission denied.');
});

test('parent-child visible banner surfaces detection failures without claiming an identity', async () => {
  const h = harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'one', name: 'Olivia' }] })
      : { ok: false, status: 503, json: async () => ({ error: { message: 'Recognition worker unavailable.' } }) }, 'parent-child');
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  const banner = h.host.children[0];
  assert.equal(banner.children[0].textContent, 'Recognition unavailable');
  assert.equal(banner.children[1].textContent, 'Recognition worker unavailable.');
});

function overlayHarness(matches, options = {}) {
  return harness(async path => path === '/api/me'
    ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
    : path.startsWith('/api/subjects?')
      ? response({ version: 1, subjects: [{ id: 'leo', name: 'Leo' }] })
      : response({ version: 1, matches }), 'parent-child', options);
}

test('projects verified face boxes onto the mirrored contain preview with horizontal letterboxing', async () => {
  const h = overlayHarness([{ subjectId: 'leo', name: 'Leo', identityMatched: true, box: { x: .1, y: .2, width: .25, height: .4 } }], { devicePixelRatio: 2 });
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.deepEqual(h.rectangles.at(-1), [588, 108, 180, 216]);
  const overlay = h.figure.children[0];
  assert.equal(overlay.className, 'subjects-face-overlay');
  assert.equal(overlay.style.pointerEvents, 'none');
  assert.deepEqual([overlay.width, overlay.height], [1920, 1080]);
  assert.deepEqual(h.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  assert.equal(h.encodes.length, 1, 'overlay never encodes or replaces the capture canvas');
});

test('projects unmirrored boxes with vertical letterboxing and redraws when the preview resizes', async () => {
  const h = overlayHarness([{ subjectId: 'leo', name: 'Leo', identityMatched: true, box: { x: .25, y: .25, width: .5, height: .5 } }], { videoWidth: 1920, videoHeight: 1080, figureWidth: 600, figureHeight: 600, transform: 'none' });
  await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
  assert.deepEqual(h.rectangles.at(-1), [150, 215.625, 300, 168.75]);
  h.figure.clientWidth = 1200; h.figure.clientHeight = 675; h.resizeCallbacks[0]();
  assert.deepEqual(h.rectangles.at(-1), [300, 168.75, 600, 337.5]);
  h.window.dispatchEvent({ type: 'workspace:camera-stop' });
  const count = h.rectangles.length;
  h.resizeCallbacks[0]();
  assert.equal(h.rectangles.length, count, 'resize cannot redraw a stopped match');
});

test('never draws green boxes for unverified identities, mismatched roster names, or invalid coordinates', async () => {
  for (const item of [
    { subjectId: 'other', name: 'Leo', identityMatched: true },
    { subjectId: 'other', identityMatched: true },
    { subjectId: 'leo', name: 'Other', identityMatched: true },
    { subjectId: 'leo', name: 'Leo', identityMatched: false },
    ...[ {x:NaN,y:0,width:.2,height:.2}, {x:-.1,y:0,width:.2,height:.2}, {x:.9,y:0,width:.2,height:.2}, {x:0,y:.9,width:.2,height:.2}, {x:0,y:0,width:0,height:.2}, {x:'0',y:0,width:.2,height:.2} ].map(box => ({subjectId:'leo',name:'Leo',identityMatched:true,box}))
  ]) {
    const h = overlayHarness([{ box: {x:0,y:0,width:.2,height:.2}, ...item }]);
    await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
    assert.equal(h.rectangles.length, 0);
  }
});

test('clears face boxes after roster removal and camera or recognition errors', async () => {
  for (const reason of ['roster', 'camera', 'recognition']) {
    let version = 1, fail = false;
    const h = harness(async path => path === '/api/me'
      ? response({ user: { role: 'teacher' }, csrfToken: 'csrf' })
      : path.startsWith('/api/subjects?')
        ? response({version, subjects: version === 1 ? [{id:'leo',name:'Leo'}] : []})
        : fail ? {ok:false,status:503,json:async()=>({})} : response({ version: 1, matches: [{subjectId:'leo',name:'Leo',identityMatched:true,box:{x:0,y:0,width:.2,height:.2}}] }), 'parent-child');
    await settle(); h.window.dispatchEvent({ type: 'workspace:camera-start' }); await settle();
    assert.equal(h.rectangles.length, 1);
    if (reason === 'roster') { version = 2; h.intervalCallbacks[0](); await settle(); }
    if (reason === 'camera') h.window.dispatchEvent({type:'workspace:camera-error'});
    if (reason === 'recognition') { fail = true; h.window.dispatchEvent({type:'workspace:camera-start'}); await settle(); }
    const count = h.rectangles.length;
    h.resizeCallbacks[0]();
    assert.equal(h.rectangles.length, count, `${reason} leaves no stored face boxes`);
    assert.deepEqual(h.clears.at(-1), [0, 0, 960, 540]);
  }
});

for (const app of ['subject-finder','attendance','parent-child']) test(app + ': verified Anthony has a fixed prominent alert; unknown and stop clear it', async () => {
  let known=true;
  const h=harness(async path=>path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):path.startsWith('/api/subjects?')?response({version:1,subjects:[{id:'anthony',name:'Anthony'}]}):response({version:1,matches:[{subjectId:known?'anthony':'other',name:'Anthony',identityMatched:true}]}),app);
  await settle();const events=app==='attendance'?h.document:h.window;const start=app==='attendance'?'presence:camera-start':'workspace:camera-start';
  events.dispatchEvent({type:start});await settle();
  const alert=h.document.body.children.find(n=>n.id==='subjects-detection-alert');
  assert.equal(alert.hidden,false);assert.match(alert.style.cssText,/position:fixed/);assert.match(alert.textContent,/Got you, Anthony/);
  events.dispatchEvent({type:app==='attendance'?'presence:camera-stop':'workspace:camera-stop'});assert.equal(alert.hidden,true);
  known=false;events.dispatchEvent({type:start});await settle();assert.equal(alert.hidden,true);assert.doesNotMatch(alert.textContent,/Got you/);
});

test('a failed pickup decision cannot hide a verified target alert', async()=>{
 const h=harness(async path=>path==='/api/me'?response({user:{role:'teacher'},csrfToken:'csrf'}):path.startsWith('/api/subjects?')?response({version:1,subjects:[{id:'anthony',name:'Anthony'}]}):path==='/api/subjects/detect'?response({version:1,matches:[{subjectId:'anthony',name:'Anthony',identityMatched:true}]}):{ok:false,status:503,json:async()=>({error:{message:'Decision unavailable'}})},'parent-child',{pickupEnabled:true});
 let pickupError;h.window.addEventListener('subjects:pickup-error',e=>pickupError=e.detail.message);
 await settle();h.window.dispatchEvent({type:'workspace:camera-start'});await settle();
 assert.equal(h.nodes.get('subjects-match').textContent,'Got you, Anthony');assert.equal(h.document.body.children.find(n=>n.id==='subjects-detection-alert').hidden,false);assert.equal(pickupError,'Decision unavailable');
});
