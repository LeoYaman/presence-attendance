import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workspaceSource = readFileSync(new URL('../usecase-workspace.js', import.meta.url), 'utf8');
const passengerSource = readFileSync(new URL('../passenger-camera.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const response = value => ({ ok: true, status: 200, json: async () => value });

function harness({ camera = async () => stream(), request = async () => response({}) } = {}) {
  class Element {
    constructor() { this.dataset = {}; this.listeners = {}; this.children = []; this.text = ''; this.disabled = false; this.value = ''; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.text = ''; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = value; this.children = []; }
    getBoundingClientRect() { return { width: 640, height: 400 }; }
    getContext() { return { setTransform() {}, strokeRect() {}, fillRect() {}, fillText() {}, drawImage() {}, measureText: text => ({ width: text.length * 7 }) }; }
    toDataURL() { return 'data:image/jpeg;base64,AAAA'; }
  }
  const ids = ['workspace-video', 'start-camera', 'stop-camera', 'camera-state-text', 'workspace-search', 'workspace-records', 'workspace-status', 'passenger-reference-status'];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const video = nodes.get('workspace-video');
  video.parentElement = new Element(); video.readyState = 2; video.videoWidth = 640; video.videoHeight = 400;
  const events = [], listeners = new Map(), timers = new Map(); let timerId = 0;
  const window = {
    devicePixelRatio: 1,
    addEventListener(type, listener) { const list = listeners.get(type) || []; list.push(listener); listeners.set(type, list); },
    dispatchEvent(event) { events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); }
  };
  const document = {
    documentElement: new Element(), body: { classList: { contains: name => name === 'criminal-page' } },
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === '#workspace-records .student' ? nodes.get('workspace-records').children.filter(node => node.className?.includes('student')) : [],
    createElement: () => new Element()
  };
  const context = vm.createContext({
    document, window, navigator: { mediaDevices: { getUserMedia: camera } },
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }),
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    ResizeObserver: class { observe() {} }, AbortController, fetch: request,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(workspaceSource, context);
  return { nodes, events, window, timers, start: () => nodes.get('start-camera').listeners.click(), stop: () => nodes.get('stop-camera').listeners.click(), loadPassenger: () => vm.runInContext(passengerSource, context) };
}
function stream() {
  const track = { stops: 0, listeners: {}, stop() { this.stops++; }, addEventListener(type, listener) { this.listeners[type] = listener; } };
  return { track, getTracks: () => [track] };
}

test('stop during camera permission request discards and closes the late stream', async () => {
  const pending = deferred(), media = stream();
  const h = harness({ camera: () => pending.promise });
  const starting = h.start(); h.stop(); pending.resolve(media); await starting;
  assert.equal(media.track.stops, 1);
  assert.equal(h.nodes.get('workspace-video').srcObject, null);
  assert.equal(h.nodes.get('start-camera').disabled, false);
  assert.equal(h.nodes.get('stop-camera').disabled, true);
  assert.equal(h.events.filter(event => event.type === 'workspace:camera-start').length, 0);
});

test('camera track ending stops the workspace and informs passenger recognition', async () => {
  const media = stream(), h = harness({ camera: async () => media });
  await h.start();
  assert.equal(h.events.at(-1).type, 'workspace:camera-start');
  assert.equal(h.events.at(-1).detail.video, h.nodes.get('workspace-video'));
  media.track.listeners.ended();
  assert.equal(h.events.at(-1).type, 'workspace:camera-stop');
  assert.equal(media.track.stops, 1);
  assert.equal(h.nodes.get('workspace-video').srcObject, null);
});

test('a delayed passenger detection response cannot restore matches after camera stop', async () => {
  const detection = deferred(); let detectionStarted = false;
  const h = harness({ request: async path => {
    if (path === '/api/me') return response({ user: { role: 'teacher' }, csrfToken: 'csrf' });
    if (path === '/api/passengers') return response({ passengers: [{ id: 'p1', name: 'Test passenger', role: 'passenger' }] });
    if (path === '/api/passengers/detect') { detectionStarted = true; return detection.promise; }
    throw new Error(`Unexpected path ${path}`);
  } });
  h.loadPassenger(); await settle(); await h.start(); await settle();
  assert.equal(detectionStarted, true);
  h.stop();
  detection.resolve(response({ matches: [{ passengerId: 'p1', identityMatched: true, role: 'passenger', similarity: 0.99, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] }));
  await settle();
  assert.equal(h.nodes.get('workspace-records').textContent, 'Camera stopped. No current passenger matches.');
  assert.equal(h.nodes.get('workspace-status').textContent, 'Camera off · Recognition stopped.');
  assert.equal(h.timers.size, 0);
});

test('verified passenger matches use the GitHub roster and respect an existing search', async () => {
  let detectionOptions;
  const h = harness({ request: async (path, options) => {
    if (path === '/api/me') return response({ user: { role: 'teacher' }, csrfToken: 'csrf' });
    if (path === '/api/passengers') return response({ passengers: [{ id: 'p1', name: 'Test passenger', role: 'passenger' }] });
    detectionOptions = options;
    return response({ matches: [
      { passengerId: 'p1', identityMatched: true, role: 'passenger', similarity: 0.99 },
      { passengerId: 'unknown', identityMatched: true, role: 'passenger', similarity: 0.99 }
    ] });
  } });
  h.nodes.get('workspace-search').value = 'another name';
  h.loadPassenger(); await settle(); await h.start(); await settle();
  const rows = h.nodes.get('workspace-records').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].textContent, 'Test passengerPassengerFace similarity: 0.99');
  assert.equal(rows[0].hidden, true);
  assert.equal(rows[0].children[0].className, 'student__info');
  assert.equal(detectionOptions.headers['X-CSRF-Token'], 'csrf');
  assert.equal(h.nodes.get('workspace-status').textContent, 'Recognition active · 1 passenger matched.');
  h.stop();
});
