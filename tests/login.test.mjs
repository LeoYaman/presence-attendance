import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = Object.fromEntries(['login', 'student'].map(name => [name, readFileSync(new URL(`../${name}.js`, import.meta.url), 'utf8')]));
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const settle = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
const teacher = { user: { id: 'demo-teacher', role: 'teacher' }, csrfToken: 'demo-csrf' };
const team = ['LEO', 'REBBECA', 'ANTHONY', 'OLIVIA'].map((code, index) => ({ id: `p${index}`, person_code: `PRESENCE-TEAM-${code}`, full_name: code }));
const profile = student => ({ profile: { ...student, notify_absence: false }, groups: [], history: [], summary: [] });

function harness(script, handler, { search = '', hostname = 'localhost' } = {}) {
  class Element {
    constructor() {
      this.listeners = {}; this.attributes = {}; this.dataset = {}; this.children = [];
      this.hidden = false; this.disabled = false; this.value = ''; this.text = '';
      this.classList = { add() {}, remove() {}, toggle() {} }; this.style = { setProperty() {} };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector(selector) { return node(selector); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    append(...children) { this.children.push(...children); }
    reset() { this.resetCount = (this.resetCount || 0) + 1; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { this.focused = true; }
  }
  const nodes = new Map();
  function node(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); }
  const roles = ['Professor', 'Student', 'Faculty', 'Security'].map(role => {
    const button = new Element(); button.dataset.loginRole = role; return button;
  });
  const requests = [], navigations = [], alerts = [], intervals = [], events = {};
  const context = vm.createContext({
    document: {
      documentElement: node('root'), hidden: false, querySelector: node,
      getElementById: id => node(`#${id}`), querySelectorAll: selector => selector === '[data-login-role]' ? roles : [],
      createElement: () => new Element(), createTextNode: text => { const value = new Element(); value.textContent = text; return value; },
      addEventListener: (name, callback) => { events[name] = callback; }
    },
    window: { location: { search, hostname, assign: path => navigations.push(path) }, alert: text => alerts.push(text), addEventListener() {} },
    fetch: async (path, options) => { requests.push({ path, options }); return handler(path, options); },
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }), setInterval: callback => intervals.push(callback),
    Intl, Date, URLSearchParams, console
  });
  vm.runInContext(sources[script] + (script === 'student' ? '\nglobalThis.testing={state,refreshAttendance};' : ''), context);
  return { node, roles, requests, navigations, alerts, intervals, events, ...context.testing };
}

test('enabled localhost demo enters each role without asking for a password', async () => {
  const destinations = ['/index.html', '/student.html?demo=1', '/parent-child.html', '/criminal-detection.html'];
  for (const [index, destination] of destinations.entries()) {
    const h = harness('login', path => response(path === '/api/presentation' ? { enabled: true } : teacher));
    await h.roles[index].listeners.click();
    assert.deepEqual(h.navigations, [destination]);
    assert.equal(h.node('#login-dialog').open, undefined);
    assert.deepEqual(h.requests.map(request => request.path), ['/api/presentation', '/api/presentation-login']);
    assert.equal(h.requests[0].options.credentials, 'same-origin');
    assert.equal(h.requests[0].options.cache, 'no-store');
    assert.equal(h.requests[1].options.method, 'POST');
    assert.equal(h.requests[1].options.credentials, 'same-origin');
  }
});

test('disabled or absent capability keeps normal authentication even on a RunPod hostname', async () => {
  for (const capability of [response({ enabled: false }), response({ error: { message: 'Not found' } }, 404)]) {
    const h = harness('login', path => {
      if (path === '/api/presentation') return capability;
      assert.equal(path, '/api/login'); return response({ user: { id: 's1', role: 'student' } });
    }, { hostname: 'example.proxy.runpod.net' });
    await h.roles[1].listeners.click();
    assert.equal(h.node('#login-dialog').open, true);
    assert.equal(h.node('#login-title').textContent, 'Student Sign In');
    assert.equal(h.roles[1].disabled, false);
    assert.equal(h.requests.length, 1);
    h.node('#email').value = ' student@example.edu '; h.node('#password').value = 'password';
    await h.node('#login-form').listeners.submit({ preventDefault() {} });
    assert.deepEqual(h.navigations, ['/student.html']);
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { email: 'student@example.edu', password: 'password' });
  }
});

test('unavailable capability falls back to the password dialog', async () => {
  const h = harness('login', () => { throw new TypeError('Offline'); });
  await h.roles[0].listeners.click();
  assert.equal(h.node('#login-dialog').open, true);
  assert.deepEqual(h.navigations, []);
});

test('demo failure or a non-teacher response cannot navigate and permits retry', async () => {
  for (const failure of [response({ error: { message: 'Demo unavailable' } }, 503), response({ user: { role: 'student' } })]) {
    let attempts = 0;
    const h = harness('login', path => path === '/api/presentation' ? response({ enabled: true }) : ++attempts === 1 ? failure : response(teacher));
    await h.roles[0].listeners.click();
    assert.deepEqual(h.navigations, []); assert.equal(h.alerts.length, 1); assert.equal(h.roles[0].disabled, false);
    await h.roles[0].listeners.click();
    assert.deepEqual(h.navigations, ['/index.html']);
    assert.equal(h.requests.filter(request => request.path === '/api/presentation').length, 1);
  }
});

test('concurrent role clicks share capability discovery and demo session creation', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('login', path => path === '/api/presentation' ? pending : response(teacher));
  const first = h.roles[0].listeners.click(), second = h.roles[1].listeners.click();
  release(response({ enabled: true })); await Promise.all([first, second]);
  assert.equal(h.requests.filter(request => request.path === '/api/presentation-login').length, 1);
  assert.deepEqual(h.navigations, ['/index.html', '/student.html?demo=1']);
});

test('student demo creates a session only when the server enables it', async () => {
  let signedIn = false;
  const h = harness('student', path => {
    if (path === '/api/presentation') return response({ enabled: true });
    if (path === '/api/me') return signedIn ? response(teacher) : response({ error: { message: 'Please sign in' } }, 401);
    if (path === '/api/presentation-login') { signedIn = true; return response(teacher); }
    if (path === '/api/student-preview') return response({ students: team });
    return response(profile(team.find(student => path.endsWith(`/${student.id}`))));
  }, { search: '?demo=1' });
  await settle();
  assert.equal(h.node('#profile-name').textContent, 'Leo');
  assert.equal(h.node('#preview-select').children.length, 4);
  assert.equal(h.state.preview, true);
  await h.refreshAttendance();
  assert.equal(h.requests.filter(request => request.path === '/api/presentation').length, 1);
  assert.equal(h.requests.filter(request => request.path === '/api/presentation-login').length, 1);
  signedIn = false;
  await h.refreshAttendance();
  assert.equal(h.requests.filter(request => request.path === '/api/presentation-login').length, 2);
  assert.equal(h.node('#profile-name').textContent, 'Leo');
});

test('disabled student demo never attempts password-free login', async () => {
  for (const capability of [response({ enabled: false }), response({}, 404)]) {
    const h = harness('student', path => {
      if (path === '/api/presentation') return capability;
      assert.equal(path, '/api/me'); return response({ error: { message: 'Please sign in' } }, 401);
    }, { search: '?demo=1', hostname: 'example.proxy.runpod.net' });
    await settle();
    assert.equal(h.state.profile, null);
    assert.equal(h.node('#student-signin').hidden, false);
    assert.equal(h.node('#preview-picker').hidden, true);
    assert.match(h.node('#attendance-state').textContent, /Please sign in/);
    assert.equal(h.requests.some(request => request.path === '/api/presentation-login'), false);
  }
});

test('student demo login failure cannot load protected attendance or repeat login on refresh', async () => {
  const h = harness('student', path => {
    if (path === '/api/presentation') return response({ enabled: true });
    if (path === '/api/me') return response({ error: { message: 'Please sign in' } }, 401);
    assert.equal(path, '/api/presentation-login'); return response({ error: { message: 'Demo unavailable' } }, 503);
  }, { search: '?demo=1' });
  await settle(); await h.refreshAttendance();
  assert.equal(h.requests.filter(request => request.path === '/api/presentation-login').length, 1);
  assert.equal(h.state.profile, null); assert.match(h.node('#attendance-state').textContent, /Demo unavailable/);
});

test('existing teacher preview session is preserved and normal student session uses its own profile', async () => {
  const preview = harness('student', path => {
    if (path === '/api/presentation') return response({ enabled: true });
    if (path === '/api/me') return response(teacher);
    if (path === '/api/student-preview') return response({ students: team });
    assert.ok(path.startsWith('/api/student-preview/')); return response(profile(team[0]));
  }, { search: '?demo=1' });
  await settle();
  assert.equal(preview.node('#profile-name').textContent, 'Leo');
  assert.equal(preview.requests.some(request => request.path === '/api/presentation-login'), false);
  const own = harness('student', path => {
    if (path === '/api/me') return response({ user: { id: 's1', role: 'student' }, csrfToken: 'student-csrf' });
    assert.equal(path, '/api/student-profile'); return response(profile({ id: 's1', person_code: 's1', full_name: 'Actual Student' }));
  });
  await settle();
  assert.equal(own.node('#profile-name').textContent, 'Actual Student');
  assert.deepEqual(own.requests.map(request => request.path), ['/api/me', '/api/student-profile']);
});

test('view=students and demo=select require an existing session', async () => {
  for (const search of ['?view=students', '?demo=select']) {
    const h = harness('student', path => {
      assert.equal(path, '/api/me'); return response({ error: { message: 'Please sign in' } }, 401);
    }, { search });
    await settle();
    assert.equal(h.requests.length, 1); assert.equal(h.state.profile, null);
  }
});
