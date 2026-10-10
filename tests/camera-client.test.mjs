import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../camera-client.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness() {
  const nodes = new Map(), documentListeners = new Map(), timers = new Map(), requests = [], recognized = [], recognitionContexts = [];
  let nextTimer = 1, requestHandler = async () => ({ matches: [], sampleCounts: {} });
  function element(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', checked: false, disabled: false, dataset: {}, textContent: '',
      listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
      replaceChildren(...children) { this.children = children; },
    });
    return nodes.get(selector);
  }
  const video = { readyState: 2, videoWidth: 640, videoHeight: 480 };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,ZmFrZQ==',
  };
  const document = {
    querySelector: element,
    createElement: tag => tag === 'canvas' ? canvas : element(tag),
    addEventListener(name, callback) { documentListeners.set(name, callback); },
  };
  const context = { mode: 'live', teacher: true, groupId: 'group-a', version: 1 };
  const roster = [{ id: 'person-a', name: 'Student A' }];
  const presence = {
    faceRequest(groupId, action, body) { requests.push({ groupId, action, body }); return requestHandler(groupId, action, body); },
    getContext: () => ({ ...context }),
    getRoster: () => roster,
    getVideo: () => video,
    recognize: (result, serverContext) => { recognized.push(result); recognitionContexts.push(serverContext); },
  };
  const setTimeoutFake = (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; };
  const clearTimeoutFake = id => timers.delete(id);
  vm.runInNewContext(source, {
    document, window: { Presence: presence }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, setInterval: () => 1, console,
  });
  return {
    nodes, documentListeners, timers, requests, recognized, recognitionContexts, context, presence, roster,
    setRequestHandler(handler) { requestHandler = handler; },
    start() { documentListeners.get('presence:camera-start')(); },
    stop() { documentListeners.get('presence:camera-stop')(); },
    async runTimer(delay) {
      const item = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(item, `expected a ${delay}ms timer`);
      timers.delete(item[0]);
      item[1].callback();
      await settle();
    },
  };
}

test('transient 429 face service errors schedule a short retry', async () => {
  const h = harness();
  h.setRequestHandler(async () => { throw Object.assign(new Error('busy'), { code: 'face_service_busy' }); });
  h.start(); await settle();
  assert.equal(h.requests.length, 1);
  assert.match(h.nodes.get('#face-service-status').textContent, /Retrying shortly/);
  assert.ok([...h.timers.values()].some(timer => timer.delay === 2500));
});

test('service unavailable pauses retries until the camera is restarted', async () => {
  const h = harness(); let attempts = 0;
  h.setRequestHandler(async () => {
    if (++attempts === 1) throw Object.assign(new Error('setup required'), { code: 'face_service_unavailable' });
    return { matches: [], sampleCounts: {} };
  });
  h.start(); await settle();
  assert.equal(h.requests.length, 1);
  assert.match(h.nodes.get('#face-service-status').textContent, /Stop and start the camera/);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 2500), false);
  h.start(); await settle();
  assert.equal(h.requests.length, 2);
});

test('face service status reports saved GitHub references separately from temporary registrations', async () => {
  const h = harness();
  h.setRequestHandler(async () => ({ matches: [], sampleCounts: {}, registeredReferences: 4 }));
  h.start(); await settle();
  assert.match(h.nodes.get('#face-service-status').textContent, /4 saved reference faces/);
  assert.match(h.nodes.get('#face-service-status').textContent, /0 temporary registrations/);
  assert.match(h.nodes.get('#face-service-status').textContent, /above 0.55 save attendance automatically/);
});

test('successful server recognition carries the captured group and context for automatic attendance', async () => {
  const h = harness();
  h.setRequestHandler(async () => ({ matches: [{ studentId: 'person-a', confidence: .95, recognitionMethod: 'sface', similarity: .56, identityMatched: true }], sampleCounts: {} }));
  h.start(); await settle();
  assert.equal(h.recognized[0][0].suggestion, true);
  assert.deepEqual({ ...h.recognitionContexts[0] }, { trustedServer: true, groupId: 'group-a', version: 1 });
});

test('camera stop and group changes discard late recognition results', async () => {
  for (const invalidate of ['stop', 'group']) {
    const h = harness(), gate = deferred();
    h.setRequestHandler(() => gate.promise);
    h.start(); await settle();
    if (invalidate === 'stop') h.stop();
    else { h.context.groupId = 'group-b'; h.context.version++; }
    gate.resolve({ matches: [{ studentId: 'person-a', confidence: 0.9 }], sampleCounts: {} });
    await settle();
    assert.deepEqual(h.recognized, [], `${invalidate} must invalidate the outstanding response`);
  }
});

test('enrollment is consent gated and submits exactly five samples for the selected student', async () => {
  const h = harness();
  h.start(); await settle();
  const picker = h.nodes.get('#enroll-student'), enroll = h.nodes.get('#enroll-face'), consent = h.nodes.get('#face-consent');
  picker.value = 'person-a'; picker.listeners.change();
  assert.equal(enroll.disabled, true);
  enroll.listeners.click(); await settle();
  assert.equal(h.requests.filter(request => request.action === 'enroll').length, 0);

  consent.checked = true; consent.listeners.change();
  assert.equal(enroll.disabled, false);
  const enrolling = enroll.listeners.click(); await settle();
  for (let sample = 0; sample < 4; sample++) { await h.runTimer(800); }
  await enrolling;
  const enrollRequests = h.requests.filter(request => request.action === 'enroll');
  assert.equal(enrollRequests.length, 5);
  assert.ok(enrollRequests.every(request => request.groupId === 'group-a' && request.body.personId === 'person-a'));
  assert.equal(consent.checked, false);
});

test('session rollover discards the old frame and continues detection without restarting the camera', async () => {
  const h = harness(), gate = deferred(); let calls = 0;
  const match = { studentId:'person-a', confidence:.95, recognitionMethod:'sface', similarity:.80, identityMatched:true };
  h.setRequestHandler(() => ++calls === 1 ? gate.promise : Promise.resolve({matches:[match],sampleCounts:{}}));
  h.start(); await settle();
  h.context.version++;
  gate.resolve({matches:[match],sampleCounts:{}}); await settle();
  assert.deepEqual(h.recognized, []);
  assert.equal(h.timers.size, 1);
  await h.runTimer(650);
  assert.equal(h.requests.length, 2);
  assert.equal(h.recognized.length, 1);
  assert.equal(h.recognitionContexts[0].version, 2);
  assert.equal(h.context.mode, 'live');
});
