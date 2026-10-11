import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../recording-client.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function emitter(extra = {}) {
  const listeners = {};
  return { ...extra, addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }, dispatch(name, event = {}) { for (const fn of listeners[name] || []) fn(event); }, listeners };
}
function harness() {
  const nodes = new Map(), documentListeners = new Map(), calls = [], intervals = [];
  let clock = Date.parse('2026-10-10T10:00:00Z'), createGate = null, uploadGate = null, finishGate = null, recordings = [], roster = [{ id: 'p1', name: 'Student One', status: 'pending', time: null }];
  const longTimers = new Map(); let nextLongTimer = 1;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, emitter({ selector, dataset: {}, hidden: false, textContent: '', className: '', value: '', children: [],
      replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); },
      play() { return Promise.resolve(); }, set src(value) { this._src = value; }, get src() { return this._src; },
    }));
    return nodes.get(selector);
  }
  const document = { querySelector: node, createElement: tag => emitter({ tag, dataset: {}, children: [], append(...items) { this.children.push(...items); } }), addEventListener(name, fn) { documentListeners.set(name, fn); } };
  const ctx = { mode: 'live', teacher: true, groupId: 'g-1', sessionId: 's-1', sessionStartsAt: '2026-10-10T10:00:00Z', sessionEndsAt: '2026-10-10T11:00:00Z' };
  const stream = {};
  const video = { srcObject: stream };
  const recorderInstances = [];
  class FakeRecorder extends EventTarget {
    static isTypeSupported(type) { return type === 'video/webm;codecs=vp8,opus'; }
    constructor(input, options) { super(); this.stream = input; this.options = options; this.state = 'inactive'; recorderInstances.push(this); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
    stop() { this.state = 'inactive'; clock += 1000; this.dispatchEvent(new Event('stop')); }
    data(blob) { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob })); }
  }
  const presence = {
    getContext: () => ({ ...ctx }), getVideo: () => video, getRoster: () => roster,
    async recordingRequest(path, options) {
      calls.push({ path, options });
      if (path.endsWith('/recordings') && options.method === 'POST') { if (createGate) await createGate.promise; return { recording: { id: 'r1', startedAt: options.body.startedAt } }; }
      if (path.includes('/finish')) { if (finishGate) await finishGate.promise; return { recording: { id: 'r1', status: 'finished', seekable: true, startedAt: '2026-10-10T10:00:00Z', endedAt: options.body.endedAt } }; }
      if (options.method === 'GET') return { recordings };
      if (options.method === 'PUT' && uploadGate) await uploadGate.promise;
      return { recording: { id: 'r1' } };
    },
  };
  vm.runInNewContext(source, {
    document, window: { Presence: presence, addEventListener() {} }, MediaRecorder: FakeRecorder,
    setTimeout: (fn, ms) => { if (ms > 100000) { const id = nextLongTimer++; longTimers.set(id, fn); return id; } return globalThis.setTimeout(fn, ms); },
    clearTimeout: id => longTimers.has(id) ? longTimers.delete(id) : globalThis.clearTimeout(id),
    setInterval: fn => { intervals.push(fn); return intervals.length; }, Date: ClockDate, Promise, console,
  });
  return { nodes, documentListeners, calls, ctx, stream, recorderInstances,
    advance(ms) { clock += ms; }, setCreateGate(gate) { createGate = gate; }, setUploadGate(gate) { uploadGate = gate; }, setFinishGate(gate) { finishGate = gate; }, fireDuration() { const [id, fn] = longTimers.entries().next().value || []; assert.ok(fn, 'a recording duration timer should be armed'); longTimers.delete(id); fn(); }, setRecordings(items) { recordings = items; }, setRoster(items) { roster = items; },
    start() { documentListeners.get('presence:camera-start')({ detail: { video } }); },
    stop() { documentListeners.get('presence:camera-stop')(); },
    poll() { intervals.at(-1)(); },
  };
}

test('only a live camera event creates a recording; chunks upload and finish in order after stop', async () => {
  const h = harness();
  h.ctx.mode = 'demo'; h.start(); await settle();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);

  h.ctx.mode = 'live'; h.start(); await settle();
  assert.equal(h.recorderInstances.length, 1);
  const recorder = h.recorderInstances[0];
  assert.equal(recorder.stream, h.stream);
  assert.equal(recorder.timeslice, 5000);
  assert.equal(recorder.options.videoBitsPerSecond, 1_000_000);
  recorder.data(new Blob(['chunk-one'], { type: 'video/webm' }));
  recorder.data(new Blob(['chunk-two'], { type: 'video/webm' }));
  await settle();
  h.stop(); await settle();
  const writes = h.calls.filter(call => call.options.method === 'PUT');
  assert.deepEqual(writes.map(call => call.path), ['/recordings/r1/chunks/0', '/recordings/r1/chunks/1']);
  assert.ok(writes.every(call => call.options.rawBody instanceof ArrayBuffer));
  const finish = h.calls.findIndex(call => call.path.endsWith('/finish'));
  assert.ok(finish > h.calls.indexOf(writes.at(-1)), 'finish follows every chunk upload');
  assert.match(h.nodes.get('#recording-state').textContent, /saved/i);
});

test('session rollover keeps the same live recording continuous', async () => {
  const h = harness(); h.start(); await settle();
  const before = h.calls.filter(call => call.options.method === 'POST' && call.path.endsWith('/recordings')).length;
  h.ctx.sessionId = 's-2'; h.ctx.sessionStartsAt = '2026-10-10T11:00:00Z';
  h.poll();
  await settle();
  assert.equal(h.calls.some(call => call.path.endsWith('/finish')), false);
  assert.equal(h.calls.filter(call => call.options.method === 'POST' && call.path.endsWith('/recordings')).length, before);
  assert.equal(before, 1);
  h.stop(); await settle();
});

test('course changes stop the old recording without reassigning the camera to the new course', async () => {
  const h = harness(); h.start(); await settle();
  h.ctx.groupId = 'g-2'; h.poll(); await settle();
  assert.ok(h.calls.some(call => call.path.endsWith('/finish')));
  assert.equal(h.calls.filter(call => call.options.method === 'POST' && call.path.endsWith('/recordings')).length, 1);
});

test('the first poll catching up with the same course does not stop a new recording', async () => {
  const h = harness();
  h.ctx.groupId = null; h.poll();
  h.ctx.groupId = 'g-1'; h.start(); await settle();
  h.poll(); await settle();
  assert.equal(h.calls.some(call => call.path.endsWith('/finish')), false);
  assert.equal(h.recorderInstances[0].state, 'recording');
  h.stop(); await settle();
});

test('a queued chunk survives stop and restart and finish uses the actual stop timestamp', async () => {
  const h = harness(), gate = {};
  gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  h.setUploadGate(gate); h.start(); await settle();
  const recorder = h.recorderInstances[0], startedAt = h.calls.find(call => call.options.method === 'POST' && call.path.endsWith('/recordings')).options.body.startedAt;
  assert.equal(startedAt, new Date('2026-10-10T10:00:00Z').toISOString());
  recorder.data(new Blob(['pending'], { type: 'video/webm' })); await settle();
  h.stop(); await settle();
  assert.equal(h.calls.some(call => call.path.endsWith('/finish')), false);
  const endedAtAtStop = new Date('2026-10-10T10:00:01Z').toISOString();
  h.advance(60 * 60 * 1000); gate.resolve(); await settle();
  const finish = h.calls.find(call => call.path.endsWith('/finish'));
  assert.equal(finish.options.body.endedAt, endedAtAtStop);
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('chunks captured while recording creation is delayed wait for and use the returned recording ID', async () => {
  const h = harness(), gate = {};
  gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  h.setCreateGate(gate); h.start(); await settle();
  const recorder = h.recorderInstances[0];
  assert.equal(recorder.state, 'recording');
  recorder.data(new Blob(['early-chunk'], { type: 'video/webm' })); await settle();
  assert.equal(h.calls.some(call => call.options.method === 'PUT'), false);
  gate.resolve(); await settle();
  const write = h.calls.find(call => call.options.method === 'PUT');
  assert.equal(write.path, '/recordings/r1/chunks/0');
  h.stop(); await settle();
});

test('an early stop with no chunks waits for recording creation before finalizing', async () => {
  const h = harness(), gate = {};
  gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  h.setCreateGate(gate); h.start(); await settle();
  const recorder = h.recorderInstances[0];
  recorder.stop(); await settle();
  assert.equal(h.calls.some(call => call.path.endsWith('/finish')), false);
  gate.resolve(); await settle();
  const finish = h.calls.find(call => call.path.endsWith('/finish'));
  assert.equal(finish.path, '/recordings/r1/finish');
});

test('only finished seekable recordings expose a play button and use the authenticated API video URL', async () => {
  const h = harness();
  h.setRecordings([
    { id: 'uploading', status: 'recording', seekable: false, startedAt: '2026-10-10T10:00:00Z' },
    { id: 'bad', status: 'processing_failed', seekable: false, endedAt: '2026-10-10T10:10:00Z' },
    { id: 'ready', status: 'finished', seekable: true, startedAt: '2026-10-10T10:00:00Z', endedAt: '2026-10-10T10:10:00Z' },
  ]);
  h.ctx.groupId = 'g-2'; h.poll(); await settle();
  const items = h.nodes.get('#recording-list').children;
  assert.equal(items.length, 3);
  assert.match(items[0].children[0].textContent, /uploading/);
  assert.match(items[1].children[0].textContent, /processing failed/);
  assert.equal(items[0].children.length, 1);
  assert.equal(items[1].children.length, 2);
  assert.equal(items[1].children[1].textContent, 'Retry saving');
  items[1].children[1].listeners.click[0](); await settle();
  assert.ok(h.calls.some(call => call.path === '/recordings/bad/finish' && call.options.body.endedAt === '2026-10-10T10:10:00Z'));
  items[2].children[1].listeners.click[0]();
  assert.equal(h.nodes.get('#recording-player').src, '/api/recordings/ready/video');
});

test('saved roster timestamps create a jump button that seeks three seconds before check-in', async () => {
  const h = harness();
  h.setRecordings([{ id: 'ready', status: 'finished', seekable: true, startedAt: '2026-10-10T10:00:00Z', endedAt: '2026-10-10T10:10:00Z' }]);
  h.setRoster([{ id: 'p1', name: 'Student One', status: 'present', time: '2026-10-10T10:00:20Z' }]);
  h.ctx.groupId = 'g-2'; h.poll(); await settle();
  h.nodes.get('#recording-list').children[0].children[1].listeners.click[0]();
  const jump = h.nodes.get('#recording-jumps').children[0];
  assert.match(jump.textContent, /Student One/);
  jump.listeners.click[0]();
  const player = h.nodes.get('#recording-player'); player.duration = 600; player.dispatch('loadedmetadata');
  assert.equal(player.currentTime, 17);
});

test('sign-out immediately clears the saved recording list and active playback', async () => {
  const h = harness();
  h.setRecordings([{ id: 'ready', status: 'finished', seekable: true, startedAt: '2026-10-10T10:00:00Z' }]);
  h.ctx.groupId = 'g-2'; h.poll(); await settle();
  h.nodes.get('#recording-list').children[0].children[1].listeners.click[0]();
  const player = h.nodes.get('#recording-player'); assert.equal(player.hidden, false);
  h.ctx.teacher = false; h.poll();
  assert.equal(player.hidden, true);
  assert.equal(h.nodes.get('#recording-list').children.length, 0);
});

test('long attendance recordings split while the previous segment is still finishing', async () => {
  const h = harness(), finishGate = {};
  finishGate.promise = new Promise(resolve => { finishGate.resolve = resolve; });
  h.setFinishGate(finishGate); h.start(); await settle();
  const first = h.recorderInstances[0]; first.data(new Blob(['segment-one'], { type: 'video/webm' })); await settle();
  h.fireDuration(); await settle();
  assert.equal(first.state, 'inactive');
  assert.equal(h.recorderInstances.length, 2, 'next capture starts without waiting for the earlier segment finish');
  assert.equal(h.recorderInstances[1].state, 'recording');
  finishGate.resolve(); await settle();
  assert.match(h.nodes.get('#recording-state').textContent, /Recording ·/);
  h.stop(); await settle();
});
