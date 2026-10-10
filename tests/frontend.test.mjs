import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function harness({ mediaDevices } = {}) {
  const nodes = new Map(), events = [], requests = [];
  let now = Date.parse('2026-10-10T12:01:00Z');
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  function element(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, getAttribute() {}, play: async () => {}, getBoundingClientRect: () => ({ width: 0, height: 0 }), getContext: () => ({ clearRect() {}, setTransform() {}, strokeRect() {}, fillText() {} }) });
    const node = nodes.get(selector);
    if (['#checkin-student', '#camera-device', '#session-select'].includes(selector) && !node.options) {
      let html = '', value = '';
      node.options = [];
      Object.defineProperty(node, 'innerHTML', { get: () => html, set: next => { html = next; node.options = [...html.matchAll(/<option value="([^"]*)"/g)].map(match => ({ value: match[1] })); if (!node.options.some(option => option.value === value)) value = ''; } });
      Object.defineProperty(node, 'value', { get: () => value, set: next => { value = node.options.some(option => option.value === String(next)) ? String(next) : ''; } });
    }
    return node;
  }
  const document = { documentElement: element('root'), hidden: false, activeElement: null, querySelector: element, querySelectorAll: () => [], addEventListener() {}, dispatchEvent: event => events.push(event) };
  let handler = () => new Promise(() => {});
  const context = vm.createContext({ document, window: {}, localStorage: { setItem() {}, getItem() { return null; } }, navigator: { mediaDevices }, ResizeObserver: class { observe() {} }, devicePixelRatio: 1, setInterval() {}, setTimeout() {}, clearTimeout() {}, Intl, Date: ClockDate, console, prompt: () => 'Verified correction', confirm: () => true, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }, fetch: async (path, options) => { requests.push({ path, options }); return handler(path, options); } });
  vm.runInContext(`${source}\nglobalThis.testing = { state, cam, cameraDevices, startCamera, stopCamera, refreshCameraDevices, checkIn, confirmAttendance, chooseGroup, chooseSession, changeSession, approveAndNext, refresh, showSignedOut, startDemo, recognize, render, getContext: window.Presence.getContext };`, context);
  const testing = context.testing;
  Object.assign(testing.state, { user: { role: 'teacher' }, csrf: 'token', group: { id: 'g1', code: 'DEMO', time_zone: 'America/New_York' }, session: { id: 's1', status: 'open', starts_at: '2026-10-10T12:00:00Z', late_after_minutes: 10 }, students: [{ id: 'p1', name: 'Test Student', number: '001', status: 'pending', recordId: 'r1', time: null }], dashboard: null });
  testing.render();
  const dashboard = (status = 'present', sessionStatus = 'open') => ({ session: { ...testing.state.session, status: sessionStatus }, roster: [{ person_id: 'p1', person_code: '001', full_name: 'Test Student', record_id: 'r1', status, checked_in_at: ['present', 'late'].includes(status) ? '2026-10-10T12:01:00Z' : null, source: 'teacher' }], distribution: { present: status === 'present' ? 1 : 0, late: status === 'late' ? 1 : 0, absent: status === 'absent' ? 1 : 0, pending: status === 'pending' ? 1 : 0, total: 1 }, arrivals: [], daily: [] });
  const record = { id: 'r1', status: 'present', checked_in_at: '2026-10-10T12:01:00Z', method: 'manual' };
  return { ...testing, events, requests, nodes, element, dashboard, record, handle: callback => { handler = callback; }, ask: callback => { context.prompt = callback; }, advance: milliseconds => { now += milliseconds; }, recognizeServer: results => testing.recognize(results, { trustedServer: true, groupId: testing.state.group?.id, version: vm.runInContext('contextVersion', context) }) };
}

test('failed check-in never changes attendance or emits a success event', async () => {
  const h = harness(); h.handle(() => response({ error: { message: 'Database unavailable' } }, 503));
  await assert.rejects(h.checkIn('p1'), /Database unavailable/);
  assert.equal(h.state.students[0].status, 'pending');
  assert.equal(h.events.filter(e => e.type === 'presence:checkin').length, 0);
});

test('duplicate in-flight check-ins submit once and emit only after acknowledgement', async () => {
  const h = harness(), gate = deferred();
  h.handle(path => path.endsWith('/checkins') ? gate.promise : response(h.dashboard()));
  const first = h.checkIn('p1'), second = h.checkIn('p1'); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
  assert.equal(h.state.students[0].status, 'pending'); assert.equal(h.events.length, 0);
  gate.resolve(response({ record: h.record })); await Promise.all([first, second]);
  assert.equal(h.state.students[0].status, 'present');
  assert.equal(h.events.filter(e => e.type === 'presence:checkin').length, 1);
  assert.equal(h.events[0].detail.source, 'teacher');
  const body = JSON.parse(h.requests.find(r => r.path.endsWith('/checkins')).options.body);
  assert.deepEqual(body, { personId: 'p1', source: 'teacher' });
});

test('approval is shown only after persisted close and refreshed absent totals', async () => {
  const h = harness(), gate = deferred();
  h.handle(path => path.endsWith('/close') ? gate.promise : response(h.dashboard('absent', 'closed')));
  const closing = h.changeSession('close'); await settle();
  assert.equal(h.state.approved, false); assert.equal(h.events.length, 0);
  gate.resolve(response({ session: { ...h.state.session, status: 'closed', closed_at: '2026-10-10T12:02:00Z' } })); await closing;
  assert.equal(h.state.approved, true); assert.equal(h.state.students[0].status, 'absent');
  assert.equal(h.events.filter(e => e.type === 'presence:approved').length, 1);
});

test('failed close leaves the session open with no approval event', async () => {
  const h = harness(); h.handle(() => response({ error: { message: 'Close failed' } }, 503));
  await assert.rejects(h.changeSession('close'), /Close failed/);
  assert.equal(h.state.approved, false); assert.equal(h.state.session.status, 'open'); assert.equal(h.events.length, 0);
});

function rollover(h) {
  return {
    approvedSession: { ...h.state.session, status: 'closed', closed_at: '2026-10-10T12:02:00Z' },
    approvedRoster: [{ person_id: 'p1', person_code: '001', full_name: 'Test Student', record_id: 'r1', status: 'present', checked_in_at: h.record.checked_in_at, source: 'teacher' }, { person_id: 'p2', person_code: '002', full_name: 'Second Student', record_id: 'r2', status: 'absent', checked_in_at: null }],
    session: { id: 's2', group_id: 'g1', status: 'open', starts_at: '2026-10-10T12:02:00Z', ends_at: '2026-10-10T13:02:00Z', late_after_minutes: 10 },
    roster: [{ person_id: 'p1', person_code: '001', full_name: 'Test Student', status: 'pending' }, { person_id: 'p2', person_code: '002', full_name: 'Second Student', status: 'pending' }],
  };
}

test('Approve waits for acknowledgement, then opens a fresh roster without interrupting the selected camera', async () => {
  const { h, media } = mediaHarness(), approvalGate = deferred(), dashboardGate = deferred(); await settle();
  h.element('#camera-device').value = 'back'; await h.element('#camera-device').listeners.change(); await h.startCamera();
  h.state.students[0].status = 'present'; h.state.sessions = [h.state.session]; h.render();
  h.cam.results = [sface()]; h.cam.match = sface(); h.cam.attempted.add('s1:p1'); h.cam.manualSelection = true; h.cam.automaticError = 'Old failure';
  h.element('#checkin-student').value = 'p1'; h.state.filter = 'present'; h.state.query = 'Test';
  const payload = rollover(h), initial = h.getContext(), stream = h.cam.stream, oldStudents = h.state.students, eventCount = h.events.length;
  h.handle(path => path.endsWith('/approve-next') ? approvalGate.promise : dashboardGate.promise);
  const approving = h.element('#approve-btn').listeners.click(); await settle();
  assert.equal(h.state.session.id, 's1'); assert.equal(h.state.students, oldStudents); assert.equal(h.cam.match.studentId, 'p1');
  assert.equal(h.element('#approve-btn').disabled, true); assert.equal(h.events.length, eventCount);
  assert.match(h.element('#dialog-text').textContent, /fresh one-hour session.*camera keeps running/);
  approvalGate.resolve(response(payload)); await settle();
  assert.equal(h.state.session.id, 's2'); assert.equal(h.state.session.status, 'open'); assert.equal(h.state.approved, false);
  assert.ok(h.state.students.every(student => student.status === 'pending' && !student.time && !student.recordId));
  assert.equal(h.element('#session-select').value, 's2'); assert.match(h.element('#session-select').innerHTML, /s1.*closed/);
  assert.equal(h.state.filter, 'all'); assert.equal(h.state.query, ''); assert.equal(h.element('#checkin-student').value, '');
  assert.equal(h.cam.mode, 'live'); assert.equal(h.cam.stream, stream); assert.equal(h.element('#camera-video').srcObject, stream);
  assert.equal(h.cameraDevices.selectedId, 'back'); assert.equal(h.cameraDevices.activeId, 'back'); assert.equal(media.calls.length, 1); assert.equal(stream.track.stopped, 0);
  assert.equal(h.getContext().version, initial.version + 1); assert.equal(h.cam.match, null); assert.equal(h.cam.results.length, 0); assert.equal(h.cam.attempted.size, 0); assert.equal(h.cam.manualSelection, false); assert.equal(h.cam.automaticError, '');
  assert.equal(h.events.filter(event => event.type === 'presence:camera-stop').length, 0); assert.equal(h.events.filter(event => event.type === 'presence:camera-start').length, 1);
  const approved = h.events.find(event => event.type === 'presence:approved').detail;
  assert.equal(approved.sessionId, 's1'); assert.equal(approved.approvedAt, payload.approvedSession.closed_at); assert.equal(approved.sessionStart, payload.approvedSession.starts_at);
  assert.deepEqual(Array.from(approved.students, student => student.status), ['present', 'absent']);
  h.state.students[0].status = 'late'; assert.equal(approved.students[0].status, 'present');
  dashboardGate.resolve(response({ error: { message: 'Dashboard unavailable' } }, 503)); await approving;
  assert.equal(h.state.session.id, 's2'); assert.match(h.element('#toast-text').textContent, /fresh one-hour session is open/);
});

test('duplicate approvals share the full rollover operation and emit one saved approval', async () => {
  const h = harness(), gate = deferred(), payload = rollover(h);
  h.handle(path => path.endsWith('/approve-next') ? gate.promise : response(h.dashboard('pending')));
  const first = h.approveAndNext(), second = h.approveAndNext(); await settle();
  assert.equal(h.requests.filter(request => request.path.endsWith('/approve-next')).length, 1);
  gate.resolve(response(payload)); await Promise.all([first, second]);
  assert.equal(h.events.filter(event => event.type === 'presence:approved').length, 1); assert.equal(h.state.session.id, 's2');
  assert.deepEqual(JSON.parse(h.requests.find(request => request.path.endsWith('/approve-next')).options.body), {});
  assert.equal(h.requests.filter(request => request.path.endsWith('/close') || request.path.endsWith('/open') || request.path === '/api/groups/g1/sessions').length, 0);
});

test('the live camera stays active while approval holds new automatic and manual writes', async () => {
  const h = harness(), gate = deferred(), payload = rollover(h); h.cam.mode = 'live'; h.state.group.code = 'PRESENCE-TEAM-REFERENCES';
  h.handle(path => path.endsWith('/approve-next') ? gate.promise : response(h.dashboard('pending')));
  const approving = h.approveAndNext(); await settle(); h.recognizeServer([sface()]); await settle();
  assert.equal(await h.checkIn('p1'), false); assert.equal(await h.confirmAttendance('p1'), false);
  assert.equal(h.requests.filter(request => request.path.endsWith('/checkins')).length, 0); assert.equal(h.cam.mode, 'live'); assert.equal(h.state.students[0].status, 'pending');
  gate.resolve(response(payload)); await approving; assert.equal(h.state.session.id, 's2'); assert.equal(h.cam.mode, 'live');
});

test('failed approval retains the old roster and camera, gives a retry message, and permits retry', async () => {
  const h = harness(); h.cam.mode = 'live'; const stream = cameraStream('back'); h.cam.stream = stream; h.state.students[0].status = 'present';
  const students = h.state.students; h.handle(() => response({ error: { message: 'Database unavailable' } }, 503));
  await h.element('#approve-btn').listeners.click();
  assert.equal(h.state.session.id, 's1'); assert.equal(h.state.session.status, 'open'); assert.equal(h.state.students, students); assert.equal(h.state.students[0].status, 'present');
  assert.equal(h.cam.stream, stream); assert.equal(stream.track.stopped, 0); assert.equal(h.events.length, 0); assert.equal(h.element('#approve-btn').disabled, false);
  assert.match(h.element('#toast-text').textContent, /Database unavailable.*Retry Approve attendance/);
  const payload = rollover(h); h.handle(path => path.endsWith('/approve-next') ? response(payload) : response(h.dashboard('pending')));
  await h.element('#approve-btn').listeners.click(); assert.equal(h.state.session.id, 's2');
});

test('old dashboards, face frames, and in-flight attendance cannot overwrite the fresh session', async () => {
  const h = harness(), oldDashboard = deferred(), oldCheckin = deferred(); h.cam.mode = 'live';
  const initial = h.getContext(), stale = h.dashboard('present'), payload = rollover(h); let dashboards = 0;
  h.handle(path => path.endsWith('/approve-next') ? response(payload) : path.endsWith('/checkins') ? oldCheckin.promise : ++dashboards === 1 ? oldDashboard.promise : response(h.dashboard('pending')));
  const refreshing = h.refresh(), saving = h.checkIn('p1'); await settle(); await h.approveAndNext();
  oldDashboard.resolve(response(stale)); oldCheckin.resolve(response({ record: h.record })); await Promise.all([refreshing, saving]);
  h.recognize([sface()], { trustedServer: true, groupId: initial.groupId, version: initial.version }); await settle();
  assert.equal(h.state.session.id, 's2'); assert.equal(h.state.students[0].status, 'pending'); assert.equal(h.cam.match, null); assert.equal(h.cam.results.length, 0);
  assert.equal(h.events.filter(event => event.type === 'presence:checkin').length, 0); assert.equal(h.requests.filter(request => request.path === '/api/sessions/s2/checkins').length, 0);
});

test('the same saved face above 0.55 can check in automatically in the fresh session', async () => {
  const h = harness(); h.cam.mode = 'live'; h.state.group.code = 'PRESENCE-TEAM-REFERENCES';
  h.handle(path => path.endsWith('/checkins') ? response({ record: h.record }) : response(h.dashboard()));
  h.recognizeServer([sface()]); await settle(); assert.equal(h.state.students[0].status, 'present');
  const payload = rollover(h); h.handle(path => path.endsWith('/approve-next') ? response(payload) : path.endsWith('/checkins') ? response({ record: { ...h.record, id: 'next-record' } }) : response(h.dashboard(h.requests.some(request => request.path === '/api/sessions/s2/checkins') ? 'present' : 'pending')));
  await h.approveAndNext(); h.recognizeServer([sface({ similarity: .55 })]); await settle();
  assert.equal(h.requests.filter(request => request.path === '/api/sessions/s2/checkins').length, 0);
  h.recognizeServer([sface({ similarity: .56 })]); await settle(); h.recognizeServer([sface()]); await settle();
  assert.equal(h.requests.filter(request => request.path === '/api/sessions/s2/checkins').length, 1); assert.equal(h.state.students[0].status, 'present');
});

for (const change of ['course change', 'sign out']) {
  test(`an approval response after ${change} cannot switch context or emit an approval event`, async () => {
    const h = harness(), gate = deferred(), payload = rollover(h); h.handle(() => gate.promise);
    const approving = h.approveAndNext(); await settle();
    if (change === 'course change') await h.chooseGroup('unknown-group'); else h.showSignedOut();
    const version = h.getContext().version; gate.resolve(response(payload)); await approving;
    assert.equal(h.state.session, null); assert.equal(h.state.students.length, 0); assert.equal(h.getContext().version, version);
    assert.equal(h.events.filter(event => event.type === 'presence:approved').length, 0); assert.equal(h.requests.filter(request => request.path === '/api/sessions/s2/dashboard').length, 0);
  });
}

test('an approval dialog opened for a previous context cannot approve the newly selected session', async () => {
  const h = harness(); h.element('#approve-dialog').showModal = () => {};
  h.element('#approve-btn').listeners.click(); await h.chooseGroup('unknown-group');
  h.state.group = { id: 'g2', code: 'NEW', time_zone: 'UTC' }; h.state.session = { id: 'other', status: 'open' };
  h.element('#approve-dialog').returnValue = 'approve'; await h.element('#approve-dialog').listeners.close();
  assert.equal(h.requests.filter(request => request.path.endsWith('/approve-next')).length, 0);
});

test('a pre-write dashboard response cannot overwrite acknowledged attendance', async () => {
  const h = harness(), stale = deferred(); let dashboards = 0;
  h.handle(path => path.endsWith('/dashboard') ? (++dashboards === 1 ? stale.promise : response(h.dashboard())) : response({ record: h.record }));
  const refresh = h.refresh(); await settle(); const saved = h.checkIn('p1'); await saved;
  assert.equal(h.state.students[0].status, 'present');
  stale.resolve(response(h.dashboard('pending'))); await refresh;
  assert.equal(h.state.students[0].status, 'present'); assert.equal(dashboards, 2);
});

test('logout discards an outstanding dashboard response', async () => {
  const h = harness(), stale = deferred(); h.handle(() => stale.promise);
  const refresh = h.refresh(); await settle(); h.showSignedOut();
  stale.resolve(response(h.dashboard())); await refresh;
  assert.equal(h.state.user, null); assert.equal(h.state.students.length, 0);
});

test('visual demo writes nothing; opted-in synthetic database demo uses API acknowledgement', async () => {
  const h = harness(); h.state.group.code = 'PRESENCE-DEMO-SYNTHETIC'; h.state.capabilities = { syntheticCamera: true };
  h.handle(path => path.endsWith('/checkins') ? response({ record: { ...h.record, method: 'face' } }) : response(h.dashboard()));
  h.startDemo(false); await settle(); assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 0);
  h.startDemo(true); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
  assert.equal(h.events.find(e => e.type === 'presence:checkin').detail.source, 'camera');
  assert.equal(h.state.students[0].status, 'present');
});

test('untrusted camera results do not write attendance', async () => {
  const h = harness(); h.cam.mode = 'live'; h.handle(() => response({ error: { message: 'Trusted camera adapter required' } }, 403));
  h.recognize([{ studentId: 'p1', confidence: .99 }]); await settle();
  h.recognize([{ studentId: 'p1', confidence: .99 }]); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 0);
  assert.equal(h.state.students[0].status, 'pending'); assert.equal(h.events.length, 0);
});

function correctionEvent(status) {
  const select = { value: status, closest: () => ({ dataset: { id: 'p1' } }) };
  return { target: { closest: () => select } };
}

test('closed-session absence correction sends the teacher-chosen original time and reason', async () => {
  const h = harness(), chosenTime = '2026-10-10T08:04:00-04:00';
  h.state.session.status = 'closed'; h.state.session.opened_at = '2026-10-10T12:00:00Z'; h.state.students[0].status = 'absent';
  h.ask(message => message.startsWith('Reason') ? 'Original attendance was omitted' : chosenTime);
  h.handle(path => path.endsWith('/correction') ? response({ record: h.record }) : response(h.dashboard('present', 'closed')));
  await h.element('#student-list').listeners.change(correctionEvent('present'));
  const request = h.requests.find(r => r.path.endsWith('/correction'));
  assert.deepEqual(JSON.parse(request.options.body), { status: 'present', reason: 'Original attendance was omitted', checkedInAt: '2026-10-10T12:04:00.000Z' });
  assert.equal(h.state.students[0].status, 'present');
});

test('cancelled correction retains the saved absence without submitting a request', async () => {
  const h = harness(); h.state.students[0].status = 'absent';
  h.ask(message => message.startsWith('Reason') ? 'Correct attendance' : null);
  await h.element('#student-list').listeners.change(correctionEvent('present'));
  assert.equal(h.requests.filter(r => r.path.endsWith('/correction')).length, 0);
  assert.equal(h.state.students[0].status, 'absent');
});

test('a concurrent saved absence is never reported as a successful check-in', async () => {
  const h = harness();
  h.handle(path => path.endsWith('/checkins') ? response({ record: { ...h.record, status: 'absent', checked_in_at: null } }) : response(h.dashboard('absent')));
  assert.equal(await h.checkIn('p1'), false);
  assert.equal(h.state.students[0].status, 'absent');
  assert.equal(h.events.filter(e => e.type === 'presence:checkin').length, 0);
  assert.match(h.element('#toast-text').textContent, /requires a correction/);
  assert.equal(await h.checkIn('p1'), false);
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
});

test('untrusted SFace suggestions show cosine similarity without automatic saving', async () => {
  const h = harness(); h.cam.mode = 'live';
  h.recognize([{ studentId: 'p1', confidence: .91, similarity: .73, recognitionMethod: 'sface', identityMatched: true, suggestion: true, box: { x: .1, y: .1, width: .3, height: .3 } }]);
  await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 0);
  assert.equal(h.state.students[0].status, 'pending');
  assert.equal(h.nodes.get('#checkin-student').value, 'p1');
  assert.equal(h.nodes.get('#confidence-value').textContent, 'Similarity 0.73');
  h.handle(path => path.endsWith('/checkins') ? response({ record: h.record }) : response(h.dashboard()));
  await h.checkIn('p1');
  assert.equal(h.state.students[0].status, 'present');
  const body = JSON.parse(h.requests.find(r => r.path.endsWith('/checkins')).options.body);
  assert.equal(body.source, 'teacher');
});

test('a teacher manual selection survives later camera suggestions', async () => {
  const h = harness(); h.cam.mode = 'live';
  h.state.students.push({ id: 'p2', name: 'Second Student', status: 'pending' });
  h.render();
  h.nodes.get('#checkin-student').value = 'p2';
  h.nodes.get('#checkin-student').listeners.change();
  h.recognize([{ studentId: 'p1', confidence: .99, identityMatched: true, suggestion: true }]);
  await settle();
  assert.equal(h.nodes.get('#checkin-student').value, 'p2');
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 0);
});

test('one confirm click creates and opens a session before saving attendance; duplicate clicks share it', async () => {
  const h = harness(), gate = deferred(); h.state.session = null; h.cam.mode = 'live'; h.render();
  h.recognize([{ studentId: 'p1', confidence: .91, identityMatched: true, suggestion: true }]);
  await settle(); assert.equal(h.requests.length, 1); // Initial reconnect only.
  assert.equal(h.element('#checkin-confirm').disabled, false);
  h.handle(path => path === '/api/groups/g1/sessions' ? gate.promise : path.endsWith('/open') ? response({ session: { ...h.state.session, status: 'open' } }) : path.endsWith('/checkins') ? response({ record: h.record }) : response(h.dashboard(path.endsWith('/dashboard') && h.requests.some(r => r.path.endsWith('/checkins')) ? 'present' : 'pending')));
  const first = h.element('#checkin-confirm').listeners.click(), second = h.element('#checkin-confirm').listeners.click(); await settle();
  assert.equal(h.requests.filter(r => r.path === '/api/groups/g1/sessions').length, 1);
  assert.equal(h.element('#checkin-confirm').disabled, true);
  const body = JSON.parse(h.requests.find(r => r.path === '/api/groups/g1/sessions').options.body);
  assert.equal(Date.parse(body.endsAt) - Date.parse(body.startsAt), 60 * 60000); assert.equal(body.lateAfterMinutes, 15);
  gate.resolve(response({ session: { id: 'new-session', status: 'planned', starts_at: body.startsAt, late_after_minutes: 15 } }));
  await Promise.all([first, second]);
  assert.equal(h.requests.filter(r => r.path.endsWith('/open')).length, 1);
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
  assert.deepEqual(JSON.parse(h.requests.find(r => r.path.endsWith('/checkins')).options.body), { personId: 'p1', source: 'teacher' });
  assert.equal(h.state.students[0].status, 'present'); assert.equal(h.cam.mode, 'live');
  assert.equal(h.element('#match-level').textContent, 'Present · saved');
  assert.equal(h.element('#checkin-confirm').textContent, 'Attendance saved'); assert.equal(h.element('#checkin-confirm').disabled, true);
  h.recognize([{ studentId: 'p1', confidence: .95, identityMatched: true, suggestion: true }]); await settle();
  assert.equal(h.element('#checkin-student').value, 'p1');
  assert.equal(h.element('#match-level').textContent, 'Present · saved');
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
});

test('failed confirmation retains pending selection and retries, then displays saved late attendance', async () => {
  const h = harness(); h.element('#checkin-student').value = 'p1'; h.element('#checkin-student').listeners.change();
  h.handle(() => response({ error: { message: 'Save failed' } }, 503));
  await h.element('#checkin-confirm').listeners.click();
  assert.equal(h.state.students[0].status, 'pending'); assert.equal(h.element('#checkin-student').value, 'p1');
  assert.equal(h.element('#checkin-confirm').disabled, false); assert.equal(h.element('#checkin-confirm').textContent, 'Confirm attendance');
  assert.equal(h.events.length, 0);
  h.handle(path => path.endsWith('/checkins') ? response({ record: { ...h.record, status: 'late' } }) : response(h.dashboard('late')));
  await h.element('#checkin-confirm').listeners.click();
  assert.equal(h.element('#match-level').textContent, 'Late · saved'); assert.equal(h.element('#in-room').textContent, 1);
  assert.equal(h.element('#checkin-confirm').textContent, 'Attendance saved'); assert.equal(h.element('#checkin-confirm').disabled, true);
});

test('a closed session cannot be opened or checked in by confirm', async () => {
  const h = harness(); h.state.session.status = 'closed'; h.render(); h.element('#checkin-student').value = 'p1'; h.element('#checkin-student').listeners.change();
  assert.equal(h.element('#checkin-confirm').disabled, true);
  assert.equal(await h.confirmAttendance(), false);
  assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 0);
  assert.match(h.element('#recognition-sub').textContent, /closed.*new session/);
});

test('switching context during session creation prevents opening or checking in the former group', async () => {
  const h = harness(), gate = deferred(); h.state.session = null; h.render(); h.element('#checkin-student').value = 'p1';
  h.handle(path => path === '/api/groups/g1/sessions' ? gate.promise : response({ sessions: [], roster: [] }));
  const saving = h.confirmAttendance(); await settle(); await h.chooseGroup('other-group');
  gate.resolve(response({ session: { id: 'old-group-session', status: 'planned' } }));
  assert.equal(await saving, false); assert.equal(h.state.group, null); assert.equal(h.state.session, null);
  assert.equal(h.requests.filter(r => r.path.endsWith('/open') || r.path.endsWith('/checkins')).length, 0);
});

test('switching context while a planned session opens prevents check-in', async () => {
  const h = harness(), gate = deferred(); h.state.session.status = 'planned'; h.render(); h.element('#checkin-student').value = 'p1';
  h.handle(path => path.endsWith('/open') ? gate.promise : response(h.dashboard('pending')));
  const saving = h.confirmAttendance(); await settle(); h.showSignedOut();
  gate.resolve(response({ session: { id: 's1', status: 'open' } }));
  assert.equal(await saving, false); assert.equal(h.state.user, null);
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 0);
});

const sface = (overrides = {}) => ({ studentId: 'p1', confidence: .95, similarity: .56, recognitionMethod: 'sface', identityMatched: true, suggestion: true, ...overrides });

test('automatic attendance uses strict SFace similarity and rejects unknown, unmatched and non-SFace results', async () => {
  for (const match of [sface({ similarity: .55 }), sface({ similarity: .549 }), sface({ similarity: NaN }), sface({ similarity: Infinity }), sface({ studentId: 'unknown' }), sface({ identityMatched: false }), sface({ recognitionMethod: 'lbph' }), sface({ suggestion: false })]) {
    const h = harness(); h.cam.mode = 'live'; h.state.session = null;
    h.recognizeServer([match]); await settle();
    assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 0, JSON.stringify(match));
    assert.equal(h.state.students[0].status, 'pending'); assert.equal(h.state.session, null);
  }
  const h = harness(); h.cam.mode = 'live';
  h.handle(path => path.endsWith('/checkins') ? response({ record: h.record }) : response(h.dashboard()));
  h.recognizeServer([sface()]); await settle();
  assert.equal(h.state.students[0].status, 'present');
  assert.deepEqual(JSON.parse(h.requests.find(r => r.path.endsWith('/checkins')).options.body), { personId: 'p1', source: 'teacher' });
  assert.equal(h.element('#checkin-form').hidden, true);
  assert.equal(h.element('#match-level').textContent, 'Present · saved');
});

test('the first qualifying live face atomically creates an open session and saves once despite repeated frames', async () => {
  const h = harness(), atomic = deferred(); h.state.session = null; h.cam.mode = 'live'; h.state.group.code = 'PRESENCE-TEAM-REFERENCES'; h.render();
  assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 0);
  assert.equal(h.element('#checkin-form').hidden, true);
  h.handle(path => path === '/api/groups/g1/checkins' ? atomic.promise : response(h.dashboard('present', 'open')));
  h.recognizeServer([sface()]); h.recognizeServer([sface()]); await settle();
  const request = h.requests.find(r => r.path === '/api/groups/g1/checkins');
  assert.ok(request); assert.equal(h.requests.filter(r => r.path === request.path).length, 1);
  assert.deepEqual(JSON.parse(request.options.body), { personId: 'p1' });
  atomic.resolve(response({ session: { id: 'automatic-session', status: 'open', starts_at: '2026-10-10T12:00:00Z', ends_at: '2026-10-10T13:00:00Z' }, record: h.record, roster: [{ person_id: 'p1', person_code: '001', full_name: 'Test Student', record_id: 'r1', status: 'present', checked_in_at: h.record.checked_in_at, source: 'teacher' }] })); await settle();
  h.recognizeServer([sface()]); await settle();
  assert.equal(h.requests.filter(r => r.path === '/api/groups/g1/checkins').length, 1);
  assert.equal(h.requests.filter(r => /^\/api\/sessions\/.*\/checkins$/.test(r.path)).length, 0);
  assert.equal(h.requests.filter(r => r.path.endsWith('/open')).length, 0);
  assert.equal(h.events.filter(e => e.type === 'presence:checkin').length, 1);
  assert.equal(h.state.students[0].status, 'present'); assert.equal(h.cam.mode, 'live');
});

test('a qualifying face replaces an expired open session and saves into the current session', async () => {
  const h = harness(); h.cam.mode = 'live'; h.state.group.code = 'PRESENCE-TEAM-REFERENCES';
  h.state.session.ends_at = '2026-10-10T11:05:00Z';
  h.state.sessions = [h.state.session];
  const currentSession = { id: 'current-session', status: 'open', starts_at: '2026-10-10T12:01:00Z', ends_at: '2026-10-10T13:01:00Z' };
  h.handle(path => path === '/api/groups/g1/checkins'
    ? response({ session: currentSession, record: h.record, roster: [{ person_id: 'p1', person_code: '001', full_name: 'Test Student', record_id: 'r1', status: 'present', checked_in_at: h.record.checked_in_at, source: 'teacher' }] })
    : response(h.dashboard('present', 'open')));

  h.recognizeServer([sface()]); await settle();

  const requests = h.requests.filter(request => request.options.method === 'POST');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/groups/g1/checkins');
  assert.deepEqual(JSON.parse(requests[0].options.body), { personId: 'p1' });
  assert.equal(h.state.session.id, 'current-session');
  assert.equal(h.element('#session-select').value, 'current-session');
  assert.equal(h.state.students[0].status, 'present');
  assert.equal(h.events.filter(event => event.type === 'presence:checkin').length, 1);
  assert.equal(h.cam.mode, 'live');
});

test('two faces share session preparation and each gets its own saved check-in', async () => {
  const h = harness(), atomic = deferred(); h.state.session = null; h.cam.mode = 'live';
  h.state.students.push({ id: 'p2', name: 'Second Student', number: '002', status: 'pending' });
  const saved = new Set();
  h.handle((path, options) => {
    if (path === '/api/groups/g1/checkins') return atomic.promise;
    if (path.endsWith('/checkins')) { const id = JSON.parse(options.body).personId; saved.add(id); return response({ record: { ...h.record, id: `record-${id}` } }); }
    const dashboard = h.dashboard(saved.has('p1') ? 'present' : 'pending'); dashboard.session.status = 'open';
    dashboard.roster.push({ person_id: 'p2', person_code: '002', full_name: 'Second Student', status: saved.has('p2') ? 'present' : 'pending', record_id: 'record-p2' });
    dashboard.distribution = { present: saved.size, late: 0, absent: 0, pending: 2 - saved.size, total: 2 };
    return response(dashboard);
  });
  const faces = [sface(), sface({ studentId: 'p2' })];
  h.recognizeServer(faces); await settle();
  assert.equal(h.requests.filter(r => r.path === '/api/groups/g1/checkins').length, 1);
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
  saved.add('p1');
  atomic.resolve(response({ session: { id: 'both-faces', status: 'open', starts_at: '2026-10-10T12:00:00Z' }, record: { ...h.record, id: 'record-p1' }, roster: [
    { person_id: 'p1', person_code: '001', full_name: 'Test Student', record_id: 'record-p1', status: 'present', checked_in_at: h.record.checked_in_at },
    { person_id: 'p2', person_code: '002', full_name: 'Second Student', status: 'pending' },
  ] })); await settle(); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/open')).length, 0);
  assert.deepEqual([...saved].sort(), ['p1', 'p2']); assert.ok(h.state.students.every(student => student.status === 'present'));
  h.recognizeServer(faces); await settle(); assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 2);
});

test('context change discards an in-flight atomic first check-in response', async () => {
  const h = harness(), gate = deferred(); h.state.session = null; h.cam.mode = 'live';
  h.handle(path => path === '/api/groups/g1/checkins' ? gate.promise : response({ sessions: [], roster: [] }));
  h.recognizeServer([sface()]); await settle();
  assert.equal(h.requests.filter(r => r.path === '/api/groups/g1/checkins').length, 1);
  await h.chooseGroup('other-group');
  gate.resolve(response({ session: { id: 'old-session', status: 'open' }, record: h.record, roster: [{ person_id: 'p1', person_code: '001', full_name: 'Test Student', status: 'present' }] })); await settle();
  assert.equal(h.state.group, null); assert.equal(h.state.session, null); assert.equal(h.state.students.length, 0);
  assert.equal(h.events.filter(e => e.type === 'presence:checkin').length, 0);
  assert.equal(h.requests.some(r => r.path === '/api/sessions/old-session/dashboard'), false);
});

test('failed automatic writes keep attendance pending and retry after the cooldown', async () => {
  const h = harness(); h.cam.mode = 'live'; h.handle(() => response({ error: { message: 'Database unavailable' } }, 503));
  h.recognizeServer([sface()]); await settle();
  assert.equal(h.state.students[0].status, 'pending'); assert.equal(h.events.length, 0);
  assert.match(h.element('#recognition-sub').textContent, /save failed.*Retrying/);
  for (let i = 0; i < 10; i++) h.recognizeServer([sface()]); await settle();
  h.advance(4999); h.recognizeServer([sface()]); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
  h.advance(1); h.handle(path => path.endsWith('/checkins') ? response({ record: { ...h.record, status: 'late' } }) : response(h.dashboard('late')));
  h.recognizeServer([sface()]); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 2);
  assert.equal(h.state.students[0].status, 'late'); assert.equal(h.element('#match-level').textContent, 'Late · saved');
});

test('an acknowledged automatic write remains saved if dashboard refresh fails', async () => {
  const h = harness(); h.cam.mode = 'live';
  h.handle(path => path.endsWith('/checkins') ? response({ record: h.record }) : response({ error: { message: 'Dashboard unavailable' } }, 503));
  h.recognizeServer([sface()]); await settle();
  assert.equal(h.state.students[0].status, 'present'); assert.equal(h.events.length, 1);
  h.advance(10000); h.recognizeServer([sface()]); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 1);
});

test('automatic attendance cannot open closed, future or expired sessions and keeps LBPH manual controls', async () => {
  for (const session of [{ status: 'closed' }, { status: 'planned', starts_at: '2026-10-10T13:00:00Z', ends_at: '2026-10-10T14:00:00Z' }, { status: 'planned', starts_at: '2026-10-10T10:00:00Z', ends_at: '2026-10-10T11:00:00Z' }]) {
    const h = harness(); h.cam.mode = 'live'; Object.assign(h.state.session, session);
    h.recognizeServer([sface()]); await settle();
    assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 0);
  }
  const h = harness(); h.cam.mode = 'live'; h.recognizeServer([sface({ recognitionMethod: 'lbph' })]); await settle();
  assert.equal(h.element('#checkin-form').hidden, false); assert.equal(h.element('#checkin-confirm').disabled, false);
});

test('automatic session preparation discards responses after the course changes', async () => {
  const h = harness(), atomic = deferred(); h.cam.mode = 'live'; h.state.session = null;
  h.handle(path => path === '/api/groups/g1/checkins' ? atomic.promise : response({ sessions: [], roster: [] })); h.recognizeServer([sface()]); await settle();
  await h.chooseGroup('unknown-group');
  atomic.resolve(response({ session: { id: 'old-course-session', status: 'open', starts_at: '2026-10-10T12:00:00Z', ends_at: '2026-10-10T13:00:00Z' }, record: h.record, roster: [] })); await settle();
  assert.equal(h.state.group, null); assert.equal(h.state.session, null);
  assert.equal(h.events.filter(e => e.type === 'presence:checkin').length, 0);
  assert.equal(h.requests.some(r => r.path.endsWith('/open') || r.path === '/api/sessions/old-course-session/checkins'), false);
});

test('a second saved face updates the current roster after the first face refresh replaces it', async () => {
  const h = harness(), secondSave = deferred(); h.cam.mode = 'live';
  h.state.students.push({ id: 'p2', name: 'Second Student', number: '002', status: 'pending' });
  let dashboards = 0;
  h.handle((path, options) => {
    if (path.endsWith('/checkins')) return JSON.parse(options.body).personId === 'p2' ? secondSave.promise : response({ record: h.record });
    if (++dashboards > 1) return response({ error: { message: 'Refresh failed' } }, 503);
    const dashboard = h.dashboard(); dashboard.roster.push({ person_id: 'p2', person_code: '002', full_name: 'Second Student', status: 'pending', record_id: 'r2' });
    dashboard.distribution.pending = 1; dashboard.distribution.total = 2;
    return response(dashboard);
  });
  h.recognizeServer([sface(), sface({ studentId: 'p2' })]); await settle();
  assert.equal(h.state.students.find(student => student.id === 'p2').status, 'pending');
  secondSave.resolve(response({ record: { ...h.record, id: 'r2' } })); await settle();
  assert.ok(h.state.students.every(student => student.status === 'present'));
  h.recognizeServer([sface(), sface({ studentId: 'p2' })]); await settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/checkins')).length, 2);
});

const cameraDevice = (deviceId, label = '') => ({ kind: 'videoinput', deviceId, label });
function cameraStream(deviceId) {
  const track = { stopped: 0, listeners: {}, stop() { this.stopped++; }, getSettings: () => ({ deviceId }), addEventListener(name, callback) { this.listeners[name] = callback; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function mediaHarness(devices = [cameraDevice('front'), cameraDevice('back')]) {
  const media = { devices, calls: [], streams: [], listeners: {}, enumerateCalls: 0, async enumerateDevices() { this.enumerateCalls++; return this.devices; }, async getUserMedia(constraints) { this.calls.push(constraints); const stream = cameraStream(constraints.video.deviceId?.exact || 'front'); this.streams.push(stream); return stream; }, addEventListener(name, callback) { this.listeners[name] = callback; } };
  return { media, h: harness({ mediaDevices: media }) };
}

test('camera inventory loads without permission and selecting a camera does not write attendance', async () => {
  const { h, media } = mediaHarness([cameraDevice('front'), { kind: 'audioinput', deviceId: 'mic', label: 'Mic' }, cameraDevice('back')]); await settle();
  assert.equal(media.calls.length, 0); assert.equal(media.enumerateCalls, 1);
  assert.match(h.element('#camera-device').innerHTML, /Camera 1/); assert.match(h.element('#camera-device').innerHTML, /Camera 2/);
  assert.doesNotMatch(h.element('#camera-device').innerHTML, /Mic/);
  h.element('#camera-device').value = 'back'; await h.element('#camera-device').listeners.change();
  assert.equal(media.calls.length, 0); assert.equal(h.cameraDevices.selectedId, 'back');
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
  await h.startCamera();
  assert.deepEqual(JSON.parse(JSON.stringify(media.calls[0])), { video: { deviceId: { exact: 'back' } }, audio: false });
});

test('permission refreshes device labels and selects the actual default camera', async () => {
  const { h, media } = mediaHarness(); await settle();
  media.getUserMedia = async function(constraints) { this.calls.push(constraints); this.devices = [cameraDevice('front', 'MacBook camera'), cameraDevice('back', 'USB camera')]; return cameraStream('front'); };
  await h.startCamera(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(media.calls[0])), { video: { facingMode: 'user' }, audio: false });
  assert.match(h.element('#camera-device').innerHTML, /MacBook camera/); assert.match(h.element('#camera-device').innerHTML, /USB camera/);
  assert.equal(h.element('#camera-device').value, 'front'); assert.equal(h.cam.mode, 'live');
});

test('switching a live camera stops its stream and recognition while retaining saved attendance', async () => {
  const { h, media } = mediaHarness(); await settle(); await h.startCamera(); await settle();
  const originalSession = h.state.session; h.state.students[0].status = 'present'; h.cam.results = [{ studentId: 'p1', confidence: .95 }];
  h.element('#camera-device').value = 'back'; await h.element('#camera-device').listeners.change(); await settle();
  assert.equal(media.streams[0].track.stopped, 1); assert.equal(media.streams[1].track.stopped, 0);
  assert.equal(h.element('#camera-video').srcObject, media.streams[1]); assert.equal(h.cam.results.length, 0);
  assert.deepEqual(h.events.map(event => event.type), ['presence:camera-start', 'presence:camera-stop', 'presence:camera-start']);
  assert.equal(h.state.session, originalSession); assert.equal(h.state.students[0].status, 'present');
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('stop cancels a delayed camera request and a late stream cannot replace a restarted camera', async () => {
  const { h, media } = mediaHarness(), gate = deferred(); await settle();
  media.getUserMedia = () => gate.promise;
  const firstStart = h.startCamera(); assert.equal(h.element('#camera-device').disabled, true); assert.equal(h.element('#stop-camera').hidden, false);
  h.stopCamera(); assert.equal(h.element('#start-camera').disabled, false);
  const current = cameraStream('back'); media.getUserMedia = async () => current;
  await h.startCamera(); const late = cameraStream('front'); gate.resolve(late); await firstStart; await settle();
  assert.equal(late.track.stopped, 1); assert.equal(current.track.stopped, 0);
  assert.equal(h.element('#camera-video').srcObject, current); assert.equal(h.cam.mode, 'live');
  assert.equal(h.events.filter(event => event.type === 'presence:camera-start').length, 1);
});

test('changing course while permission is pending stops the late camera without restoring the preview', async () => {
  const { h, media } = mediaHarness(), gate = deferred(); await settle(); media.getUserMedia = () => gate.promise;
  const starting = h.startCamera(); await h.chooseGroup('unknown');
  const late = cameraStream('front'); gate.resolve(late); await starting;
  assert.equal(late.track.stopped, 1); assert.equal(h.cam.mode, 'off'); assert.equal(h.element('#camera-video').srcObject, null);
  assert.equal(h.events.filter(event => event.type === 'presence:camera-start').length, 0);
});

test('disconnecting the active camera stops it and requires an explicit replacement choice', async () => {
  const { h, media } = mediaHarness(); await settle(); await h.startCamera(); await settle();
  media.devices = [cameraDevice('back', 'USB camera')]; await media.listeners.devicechange();
  assert.equal(media.streams[0].track.stopped, 1); assert.equal(h.cam.mode, 'off'); assert.equal(h.element('#camera-video').srcObject, null);
  assert.equal(h.element('#camera-device').value, 'front'); assert.equal(h.element('#start-camera').disabled, true);
  assert.match(h.element('#camera-device-status').textContent, /disconnected.*Choose another camera/);
  assert.equal(media.calls.length, 1); assert.equal(h.state.students[0].status, 'pending');
  h.element('#camera-device').value = 'back'; await h.element('#camera-device').listeners.change();
  assert.equal(h.element('#start-camera').disabled, false); assert.equal(media.calls.length, 1);
  await h.startCamera(); assert.equal(media.calls[1].video.deviceId.exact, 'back');
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('inventory refreshes are serialized and outdated results never replace the latest list', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const h = harness({ mediaDevices: { getUserMedia: async () => cameraStream('fresh'), enumerateDevices: () => ++calls === 1 ? first.promise : second.promise } });
  const refreshing = h.refreshCameraDevices(); assert.equal(calls, 1);
  first.resolve([cameraDevice('old', 'Old camera')]); await settle();
  assert.equal(calls, 2); assert.doesNotMatch(h.element('#camera-device').innerHTML, /Old camera/);
  second.resolve([cameraDevice('fresh', 'Fresh camera')]); await refreshing;
  assert.match(h.element('#camera-device').innerHTML, /Fresh camera/); assert.doesNotMatch(h.element('#camera-device').innerHTML, /Old camera/);
});

test('unsupported camera APIs and denied permission leave teacher confirmation available', async () => {
  const unsupported = harness(); unsupported.element('#checkin-student').value = 'p1'; unsupported.element('#checkin-student').listeners.change();
  assert.match(unsupported.element('#camera-device-status').textContent, /unavailable.*Teacher check-in still works/);
  assert.equal(unsupported.element('#checkin-confirm').disabled, false);
  const { h, media } = mediaHarness(); await settle(); media.getUserMedia = async () => { throw new Error('Permission denied'); };
  await h.startCamera(); h.element('#checkin-student').value = 'p1'; h.element('#checkin-student').listeners.change();
  assert.equal(h.cam.mode, 'off'); assert.equal(h.element('#checkin-confirm').disabled, false);
  assert.match(h.element('#camera-device-status').textContent, /Permission denied.*teacher check-in/);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});
