/* Presence: server identity, permissions and saved attendance are authoritative. */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const root = document.documentElement;
const UNIVERSITIES = { ucf: { name: 'UCF', campus: 'Orlando' }, fullsail: { name: 'Full Sail', campus: 'Winter Park' } };
const STATUS_LABEL = { present: 'Present', late: 'Late', absent: 'Absent', pending: 'Not seen' };
const THRESHOLDS = Object.freeze({ high: .85, uncertain: .6 });
const levelOf = c => c >= THRESHOLDS.high ? 'high' : c >= THRESHOLDS.uncertain ? 'uncertain' : 'low';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { user: null, csrf: '', groups: [], group: null, sessions: [], session: null, students: [], approved: false, filter: 'all', query: '', dashboard: null, syncing: false };
const inflight = new Map();
const automaticRetries = new Map(), automaticSaved = new Set();
const AUTOMATIC_SIMILARITY = .55, AUTOMATIC_RETRY_MS = 5000;
let contextVersion = 0, dashboardVersion = 0;
const cam = { mode: 'off', stream: null, results: [], match: null, demoTimer: 0, demoPersist: false, attempted: new Set(), manualSelection: false, automaticError: '' };
const cameraDevices = { devices: [], selectedId: '', activeId: '', opening: false, lifecycle: 0, inventoryVersion: 0, inventoryPromise: null, unavailable: false };
const video = $('#camera-video'), canvas = $('#camera-overlay'), ctx = canvas.getContext('2d');
const teacher = () => ['teacher', 'admin'].includes(state.user?.role);
const canCheckIn = () => teacher() && state.session?.status === 'open' && !inflight.has(`approve-next:${state.session.id}`);
const studentById = id => state.students.find(s => String(s.id) === String(id));
const automaticCamera = () => cam.mode === 'live' && (state.group?.code === 'PRESENCE-TEAM-REFERENCES' || cam.results.some(result => result.recognitionMethod === 'sface'));
const zone = () => state.group?.time_zone || 'UTC';
function fmtTime(value) { return value ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone() }).format(new Date(value)) : '—'; }
function fmtDate(value, timeZone = zone()) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value)) : '—'; }
function notify(message) { $('#toast-text').textContent = message; $('#toast-undo').hidden = true; $('#toast').classList.add('is-visible'); clearTimeout(notify.timer); notify.timer = setTimeout(() => $('#toast').classList.remove('is-visible'), 7000); }
function report(error) { notify(error.message || 'The request failed. Retry when the connection is available.'); }
async function api(path, body) {
  const requestContext = contextVersion;
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) }) });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('The attendance server returned an unreadable response.'); }
  if (!response.ok) { if (response.status === 401 && path !== '/login' && requestContext === contextVersion) showSignedOut(); throw Object.assign(new Error(payload.error?.message || `Request failed (${response.status}).`), { code: payload.error?.code, status: response.status }); }
  return payload;
}
async function recordingRequest(path, {method = 'GET', body, rawBody, contentType} = {}) {
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',cache:'no-store',
    headers:method==='GET'?{}:{'X-CSRF-Token':state.csrf,'Content-Type':contentType||'application/json'},
    ...(method==='GET'?{}:{body:rawBody===undefined?JSON.stringify(body??{}):rawBody})});
  let payload;
  try{payload=await response.json();}catch{throw new Error('The video server returned an unreadable response.');}
  if(!response.ok)throw Object.assign(new Error(payload.error?.message||`Video request failed (${response.status}).`),{status:response.status,code:payload.error?.code});
  return payload;
}
function singleFlight(key, operation) { if (inflight.has(key)) return inflight.get(key); const promise = Promise.resolve().then(operation).finally(() => inflight.delete(key)); inflight.set(key, promise); return promise; }
function setUniversity(key) { if (!UNIVERSITIES[key]) return; root.dataset.university = key; try { localStorage.setItem('presence-university', key); } catch {} $$('.uni-switch button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.uni === key))); $$('[data-uni-text]').forEach(el => { el.textContent = UNIVERSITIES[key][el.dataset.uniText]; }); document.title = `Presence · ${UNIVERSITIES[key].name} Attendance`; drawResults(); }
function setTheme(mode) { root.dataset.theme = mode; try { localStorage.setItem('presence-theme', mode); } catch {} $('#theme-btn').setAttribute('aria-pressed', String(mode === 'dark')); $('#theme-btn').setAttribute('aria-label', mode === 'dark' ? 'Light mode' : 'Dark mode'); }
$$('.uni-switch button').forEach(b => b.addEventListener('click', () => setUniversity(b.dataset.uni)));
$('.uni-switch').addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); const buttons = $$('.uni-switch button'), next = buttons[(buttons.findIndex(b => b.getAttribute('aria-checked') === 'true') + 1) % buttons.length]; setUniversity(next.dataset.uni); next.focus(); });
$('#theme-btn').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
function showSignedOut() { contextVersion++; stopCamera(); Object.assign(state, { user: null, csrf: '', group: null, session: null, students: [], groups: [], sessions: [], dashboard: null, approved: false, syncing: false }); $('#connection-panel').hidden = false; $('#connection-message').textContent = 'No authorized backend session is connected. Attendance recording is unavailable.'; $('#account-panel').hidden = true; $('#teacher-content').hidden = false; $('#history-panel').hidden = true; $('#local-course').textContent = 'Attendance'; $('#group-select').innerHTML = '<option value="">Choose a course section</option>'; $('#session-select').innerHTML = '<option value="">Choose a session</option>'; render(); }
async function signedIn(payload) {
  const version = ++contextVersion;
  state.user = payload.user; state.csrf = payload.csrfToken; state.capabilities = payload.capabilities || {};
  $('#connection-panel').hidden = true; $('#account-panel').hidden = false; $('#account-name').textContent = `${state.user.full_name || state.user.email} · ${state.user.role}`;
  $('#teacher-content').hidden = !teacher(); $('#history-panel').hidden = teacher();
  if (!teacher()) { $('#session-status-text').textContent = 'Student history'; return loadHistory(); }
  const data = await api('/groups'); if (version !== contextVersion) return; state.groups = data.groups;
  $('#group-select').innerHTML = '<option value="">Choose a course section</option>' + data.groups.map(g => `<option value="${esc(g.id)}">${esc(g.course_code)} · ${esc(g.name)} (${esc(g.code)})</option>`).join('');
  if (data.groups.length) { const preferred = data.groups.find(g => g.code === 'CLS-101') || data.groups.find(g => g.code === 'PRESENCE-TEAM-REFERENCES') || data.groups[0]; $('#group-select').value = preferred.id; await chooseGroup(preferred.id); } else $('#sync-status').textContent = 'No course sections are assigned to this account.';
}
async function reconnect() { const version = contextVersion; $('#reconnect-btn').disabled = true; $('#connection-message').textContent = 'Connecting to the attendance backend…'; try { const payload = await api('/me'); if (version === contextVersion) await signedIn(payload); } catch (error) { $('#connection-panel').hidden = false; $('#connection-message').textContent = error.status === 401 ? 'No authorized backend session is connected. Attendance recording is unavailable.' : `Attendance server unavailable: ${error.message}`; } finally { $('#reconnect-btn').disabled = false; } }
$('#reconnect-btn').addEventListener('click', reconnect);
$('#logout-btn').addEventListener('click', async () => { try { await api('/logout', {}); showSignedOut(); } catch (error) { report(error); } });
async function chooseGroup(id) {
  const version = ++contextVersion; stopCamera(); state.session = null; state.students = []; state.dashboard = null; state.approved = false; state.syncing = false;
  state.group = state.groups.find(g => String(g.id) === String(id)) || null; render(); if (!state.group) return;
  $('#course-label').textContent = `${state.group.course_code} · ${state.group.name}`; $('#local-course').textContent = `${state.group.course_code} Attendance`; $('#course-zone').textContent = state.group.time_zone;
  const [sessions, roster] = await Promise.all([api(`/groups/${id}/sessions`), api(`/groups/${id}/roster`)]); if (version !== contextVersion) return;
  state.sessions = sessions.sessions;
  $('#session-select').innerHTML = '<option value="">Choose a session</option>' + state.sessions.map(s => `<option value="${esc(s.id)}">${esc(fmtDate(s.starts_at))} · ${esc(s.status)}</option>`).join('');
  state.students = mapRoster(roster.roster);
  const preferred = state.sessions.find(s => s.status === 'open') || state.sessions[0];
  if (preferred) { $('#session-select').value = preferred.id; await chooseSession(preferred.id); } else { $('#sync-status').textContent = 'Create a session for this section.'; render(); }
}
async function chooseSession(id) { contextVersion++; stopCamera(); state.session = state.sessions.find(s => String(s.id) === String(id)) || null; state.dashboard = null; state.students = []; state.approved = false; state.syncing = false; render(); if (state.session) await refresh(); }
$('#group-select').addEventListener('change', e => chooseGroup(e.target.value).catch(report));
$('#session-select').addEventListener('change', e => chooseSession(e.target.value).catch(report));
function mapRoster(roster) { return roster.map(r => ({ id: r.person_id, number: r.person_code, name: r.full_name, status: r.status || 'pending', time: r.checked_in_at || null, source: r.source || r.method, recordId: r.record_id })); }
async function refresh() {
  if (!state.session || !teacher()) return;
  const id = state.session.id, version = contextVersion, generation = dashboardVersion;
  return singleFlight(`refresh:${version}:${generation}:${id}`, async () => {
    state.syncing = true; updateControls();
    try { const data = await api(`/sessions/${id}/dashboard`); if (version !== contextVersion || generation !== dashboardVersion || !state.user) return; state.session = data.session; state.students = mapRoster(data.roster); state.dashboard = data; state.approved = data.session.status === 'closed'; state.sessions = state.sessions.map(session => String(session.id) === String(id) ? data.session : session); const option = Array.from($('#session-select').options || []).find(item => String(item.value) === String(id)); if (option) option.textContent = `${fmtDate(data.session.starts_at)} · ${data.session.status}`; $('#sync-status').textContent = `Saved data · refreshed ${fmtTime(new Date())} · updates every 5 seconds`; render(); }
    catch (error) { if (version === contextVersion) $('#sync-status').textContent = `Refresh failed: ${error.message} Displayed data may be out of date.`; throw error; }
    finally { if (version === contextVersion && generation === dashboardVersion) { state.syncing = false; updateControls(); } }
  });
}
$('#refresh-btn').addEventListener('click', () => refresh().catch(report));
// Five-second polling supports the prototype without requiring a streaming server.
setInterval(() => { if (!document.hidden && teacher() && state.session) refresh().catch(() => {}); }, 5000);
$('#create-session-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!state.group) return notify('Choose a section first.');
  const groupId = state.group.id, version = contextVersion; $('#create-session-btn').disabled = true;
  try { const data = await singleFlight(`create:${groupId}`, () => api(`/groups/${groupId}/sessions`, { startsAt: new Date($('#new-start').value).toISOString(), endsAt: new Date($('#new-end').value).toISOString(), lateAfterMinutes: Number($('#new-late').value) })); if (version !== contextVersion) return; await chooseGroup(groupId); $('#session-select').value = data.session.id; await chooseSession(data.session.id); notify('Session saved. Open it to begin check-ins.'); } catch (error) { report(error); } finally { updateControls(); }
});
$('#open-session-btn').addEventListener('click', () => changeSession('open').catch(report));
async function changeSession(action) {
  if (!state.session) return; const id = state.session.id, version = contextVersion, generation = dashboardVersion;
  return singleFlight(`lifecycle:${id}`, async () => { updateControls(); const data = await api(`/sessions/${id}/${action}`, {}); if (version !== contextVersion) return; dashboardVersion++; await refresh(); if (version !== contextVersion) return; notify(action === 'open' ? 'Session opened and saved.' : 'Attendance approved and saved. Students not seen are absent.'); if (action === 'close') document.dispatchEvent(new CustomEvent('presence:approved', { detail: { sessionId: id, approvedAt: data.session.closed_at, sessionStart: data.session.starts_at, students: window.Presence.getRoster() } })); }).finally(updateControls);
}
async function approveAndNext() {
  const pending = inflight.get(`approve-next:${state.session?.id}`); if (pending) return pending;
  if (!canCheckIn() || !state.group) return;
  const id = state.session.id, groupId = state.group.id, version = contextVersion;
  return singleFlight(`approve-next:${id}`, async () => {
    updateControls();
    const data = await api(`/sessions/${id}/approve-next`, {});
    if (version !== contextVersion || !teacher() || String(state.group?.id) !== String(groupId) || String(state.session?.id) !== String(id)) return;
    const approvedStudents = mapRoster(data.approvedRoster), nextStudents = mapRoster(data.roster);
    const approval = { sessionId: data.approvedSession.id, approvedAt: data.approvedSession.closed_at, sessionStart: data.approvedSession.starts_at, students: approvedStudents.map(student => ({ ...student })) };
    // Invalidate old dashboard, check-in and face responses without stopping the live stream.
    contextVersion++; dashboardVersion++;
    state.sessions = [data.session, ...state.sessions.filter(session => String(session.id) !== String(data.session.id)).map(session => String(session.id) === String(id) ? data.approvedSession : session)];
    state.session = data.session; state.students = nextStudents; state.dashboard = null; state.approved = false; state.syncing = false;
    state.filter = 'all'; state.query = ''; $('#roster-search').value = '';
    $$('.tabs button').forEach(button => button.setAttribute('aria-checked', String(button.dataset.filter === 'all')));
    $('#session-select').innerHTML = '<option value="">Choose a session</option>' + state.sessions.map(session => `<option value="${esc(session.id)}">${esc(fmtDate(session.starts_at))} · ${esc(session.status)}</option>`).join('');
    $('#session-select').value = data.session.id;
    cam.results = []; cam.match = null; cam.attempted.clear(); cam.manualSelection = false; cam.automaticError = '';
    automaticSaved.clear(); automaticRetries.clear(); $('#checkin-student').value = ''; $('#face-count').textContent = '0';
    drawResults(); showMatch(null); render();
    $('#sync-status').textContent = 'Attendance saved · a new one-hour session is open.';
    document.dispatchEvent(new CustomEvent('presence:approved', { detail: approval }));
    notify('Attendance approved and saved. A fresh one-hour session is open; camera check-ins can continue.');
    // The acknowledged new roster remains usable if this optional dashboard refresh fails.
    await refresh().catch(() => {});
  }).finally(updateControls);
}
function counts() { const c = { present: 0, late: 0, absent: 0, pending: 0 }; state.students.forEach(s => { if (s.status in c) c[s.status]++; }); return c; }
function render() {
  const c = state.dashboard?.distribution || counts(), total = state.students.length;
  $('#in-room').textContent = c.present + c.late; $('#roster-total').textContent = total;
  ['present', 'late', 'absent', 'pending'].forEach(status => { $(`#count-${status}`).textContent = c[status]; if (status !== 'pending') $(`#bar-${status}`).style.width = `${total ? c[status] / total * 100 : 0}%`; });
  $('#n-all').textContent = total; $('#session-start').textContent = fmtTime(state.session?.starts_at); $('#late-minutes').textContent = state.session?.late_after_minutes ?? '—';
  $('#session-status-text').textContent = state.session ? `Session ${state.session.status}` : state.user ? 'Choose a session' : 'Dashboard'; $('#session-status').classList.toggle('is-approved', state.approved);
  $('#approve-btn').textContent = state.approved ? 'Attendance approved' : 'Approve attendance';
  $('#approve-note').textContent = state.approved ? 'The session is closed. Authorized corrections require a reason and are saved in the audit log.' : 'Approval saves and closes this session, marks students not seen as absent, and opens a fresh one-hour session. The camera keeps running.';
  renderList(); renderPicker(); renderCharts(); updateControls();
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>';
function renderList() {
  const q = state.query.trim().toLowerCase(); const rows = state.students.filter(s => (state.filter === 'all' || s.status === state.filter) && (!q || s.name.toLowerCase().includes(q) || String(s.number).toLowerCase().includes(q)));
  $('#student-list').innerHTML = rows.map(s => { const checked = ['present', 'late'].includes(s.status), options = Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${v === s.status ? 'selected' : ''} ${v === 'pending' ? 'disabled' : ''}>${l}</option>`).join(''); return `<li class="student" data-id="${esc(s.id)}" data-status="${s.status}"><button type="button" class="tick" role="checkbox" aria-checked="${checked}" ${!canCheckIn() || s.status !== 'pending' ? 'disabled' : ''} aria-label="Check in ${esc(s.name)}"><span>${CHECK_SVG}</span></button><span class="student__info"><span class="student__name">${esc(s.name)}</span><span class="student__meta">${esc(s.number)} · ${checked ? `${esc(fmtTime(s.time))} · ${esc(s.source)}` : esc(STATUS_LABEL[s.status])}</span></span><select class="status status--${s.status}" aria-label="Correct status for ${esc(s.name)}" ${!teacher() || !s.recordId ? 'disabled' : ''}>${options}</select></li>`; }).join('');
  $('#empty-state').hidden = rows.length > 0; $('#empty-state').textContent = state.session ? 'No students match.' : 'Choose or create a session to record attendance.';
}
function renderPicker() { const select = $('#checkin-student'), previous = select.value; const available = state.students.filter(s => ['pending', 'present', 'late'].includes(s.status)); select.innerHTML = '<option value="">Select a student</option>' + available.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.number)})${s.status === 'pending' ? '' : ` · ${STATUS_LABEL[s.status]} · saved`}</option>`).join(''); if (available.some(s => String(s.id) === previous)) select.value = previous; else { select.value = ''; cam.manualSelection = false; } updateRecognitionControls(); }
function updateControls() { $('#open-session-btn').disabled = !teacher() || !state.session || state.session.status !== 'planned' || inflight.has(`lifecycle:${state.session?.id}`); $('#approve-btn').disabled = !canCheckIn() || inflight.has(`lifecycle:${state.session?.id}`) || inflight.has(`approve-next:${state.session?.id}`); $('#refresh-btn').disabled = !state.session || state.syncing; $('#create-session-btn').disabled = !state.group || inflight.has(`create:${state.group?.id}`); updateRecognitionControls(); }
function renderCharts() {
  const arrivals = state.dashboard?.arrivals || [], max = Math.max(1, ...arrivals.map(item => item.count));
  $('#arrivals-chart').innerHTML = arrivals.length ? arrivals.map(item => `<div class="chart-row"><span class="mono">${esc(fmtTime(item.bucket))}</span><span class="chart-track"><span style="width:${item.count / max * 100}%"></span></span><strong>${item.count}</strong></div>`).join('') : '<p>No saved arrivals yet.</p>';
  $('#daily-trends').innerHTML = (state.dashboard?.daily || []).map(item => `<tr><td>${esc(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: zone() }).format(new Date(item.bucket)))}</td><td>${item.present}</td><td>${item.late}</td><td>${item.absent}</td><td>${item.pending}</td><td>${item.total}</td></tr>`).join('') || '<tr><td colspan="6">No session history yet.</td></tr>'; $('#dashboard-zone').textContent = zone();
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; $$('.tabs button').forEach(item => item.setAttribute('aria-checked', String(item === b))); renderList(); }));
$('#roster-search').addEventListener('input', e => { state.query = e.target.value; renderList(); });
$('#student-list').addEventListener('click', e => { const button = e.target.closest('.tick'); if (button && !button.disabled) checkIn(button.closest('.student').dataset.id, 'teacher').catch(report); });
$('#student-list').addEventListener('change', async e => {
  const select = e.target.closest('select.status'); if (!select) return; const student = studentById(select.closest('.student').dataset.id), status = select.value; renderList(); if (status === student.status) return;
  const reason = prompt(`Reason for correcting ${student.name} from ${STATUS_LABEL[student.status]} to ${STATUS_LABEL[status]} (required):`); if (!reason?.trim()) return;
  let checkedInAt = null;
  if (status !== 'absent') {
    const proposed = prompt(`Corrected check-in time as ISO timestamp with UTC offset (for example 2026-10-10T09:15:00-04:00). It must be within the session's open period. Course time zone: ${zone()}.`, student.time || state.session.opened_at || state.session.starts_at);
    if (!proposed) return;
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(proposed) || !Number.isFinite(Date.parse(proposed))) return notify('Enter a valid ISO timestamp with a time zone. The record has not changed.');
    checkedInAt = new Date(proposed).toISOString();
  }
  const recordId = student.recordId, version = contextVersion;
  try { await singleFlight(`correction:${recordId}`, () => api(`/records/${recordId}/correction`, { status, reason: reason.trim(), checkedInAt })); if (version !== contextVersion) return; dashboardVersion++; await refresh(); if (version !== contextVersion) return; notify(`${student.name}'s correction is saved.`); } catch (error) { report(error); }
});
async function checkIn(studentId, source = 'teacher', confidence) {
  const student = studentById(studentId); if (!student || !canCheckIn() || student.status !== 'pending') return false;
  if (cam.mode === 'demo' && !cam.demoPersist) { notify('Synthetic demo results do not save attendance. Stop the demo to check in a student.'); return false; }
  const sessionId = state.session.id, version = contextVersion;
  return singleFlight(`checkin:${sessionId}:${studentId}`, async () => {
    const data = await api(`/sessions/${sessionId}/checkins`, { personId: student.id, source, ...(confidence === undefined ? {} : { confidence }) });
    if (version !== contextVersion) return true;
    dashboardVersion++;
    if (!['present', 'late'].includes(data.record.status)) { await refresh(); notify('An existing absence requires a correction with a reason. No check-in was recorded.'); return false; }
    return applySavedCheckin(student.id, sessionId, data.record, source);
  });
}
function applySavedCheckin(studentId, sessionId, record, source) {
  const student = studentById(studentId);
  if (!student || !['present', 'late'].includes(record?.status)) return false;
  Object.assign(student, { status: record.status, recordId: record.id, time: record.checked_in_at, source });
  state.dashboard = null; render();
  document.dispatchEvent(new CustomEvent('presence:checkin', { detail: { studentId: student.id, sessionId, recordId: record.id, status: record.status, source, time: record.checked_in_at } }));
  notify(`${student.name} checked in and saved, ${STATUS_LABEL[record.status].toLowerCase()}.`);
  // The check-in response is authoritative. Refresh the dashboard in the
  // background so network latency there does not delay the saved state.
  refresh().catch(() => {});
  return true;
}
async function confirmAttendance(studentId = $('#checkin-student').value, automatic = false) {
  const student = studentById(studentId);
  if (!teacher() || !state.group || !student || student.status !== 'pending' || cam.mode === 'demo' || inflight.has(`approve-next:${state.session?.id}`)) return false;
  if (state.session?.status === 'closed') { notify('This session is closed. Choose or create a new session to record attendance.'); return false; }
  const groupId = state.group.id, version = contextVersion;
  const current = () => version === contextVersion && teacher() && String(state.group?.id) === String(groupId) && (!automatic || cam.mode === 'live');
  const saving = singleFlight(`confirm:${version}:${groupId}:${studentId}`, async () => {
    if (!current()) return false;
    const prepared = await singleFlight(`prepare:${version}:${groupId}`, async () => {
    if (!current()) return;
    if (!state.session) {
      if (automatic) {
        const data = await api(`/groups/${groupId}/checkins`, { personId: student.id });
        if (!current()) return;
        if (!data.session || !data.record || !Array.isArray(data.roster)) return;
        state.session = data.session; state.sessions.unshift(data.session); state.students = mapRoster(data.roster);
        $('#session-select').innerHTML = '<option value="">Choose a session</option>' + state.sessions.map(s => `<option value="${esc(s.id)}">${esc(fmtDate(s.starts_at))} · ${esc(s.status)}</option>`).join('');
        $('#session-select').value = data.session.id;
        if (!['present', 'late'].includes(data.record.status)) { dashboardVersion++; refresh().catch(() => {}); return; }
        dashboardVersion++;
        applySavedCheckin(student.id, data.session.id, data.record, 'teacher');
        return { savedStudentId: String(student.id) };
      }
      const startsAt = new Date(), endsAt = new Date(startsAt.getTime() + 60 * 60000);
      const data = await singleFlight(`create:${groupId}`, () => api(`/groups/${groupId}/sessions`, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), lateAfterMinutes: 15 }));
      if (!current()) return false;
      state.session = data.session; state.sessions.unshift(data.session);
      $('#session-select').innerHTML = '<option value="">Choose a session</option>' + state.sessions.map(s => `<option value="${esc(s.id)}">${esc(fmtDate(s.starts_at))} · ${esc(s.status)}</option>`).join('');
      $('#session-select').value = data.session.id;
    }
    if (state.session.status === 'planned') {
      if (automatic && !(Date.parse(state.session.starts_at) <= Date.now() && Date.parse(state.session.ends_at) > Date.now())) return;
      await changeSession('open');
      if (!current()) return;
    }
    });
    if (!current() || state.session?.status !== 'open') return false;
    if (String(prepared?.savedStudentId) === String(studentId)) return true;
    return checkIn(studentId, 'teacher');
  });
  updateControls();
  try { return await saving; } finally { if (version === contextVersion) updateControls(); }
}
function automaticMatch(result) {
  return result.suggestion === true && result.recognitionMethod === 'sface' && result.identityMatched === true && Number.isFinite(result.similarity) && result.similarity > AUTOMATIC_SIMILARITY && studentById(result.studentId)?.status === 'pending';
}
function automaticAttendance(result, serverContext) {
  if (inflight.has(`approve-next:${state.session?.id}`)) return;
  if (cam.mode !== 'live' || !teacher() || !state.group || state.session?.status === 'closed' || !automaticMatch(result) || serverContext?.trustedServer !== true || serverContext.version !== contextVersion || String(serverContext.groupId) !== String(state.group.id)) return;
  const version = contextVersion, groupId = state.group.id, studentId = result.studentId;
  const key = `${version}:${groupId}:${studentId}`, savedKey = () => `${version}:${groupId}:${state.session?.id}:${studentId}`;
  if (automaticSaved.has(savedKey()) || inflight.has(`automatic:${key}`) || (automaticRetries.get(key) || 0) > Date.now()) return;
  cam.automaticError = '';
  singleFlight(`automatic:${key}`, async () => {
    try {
      const saved = await confirmAttendance(studentId, true);
      if (version !== contextVersion || cam.mode !== 'live') return;
      if (saved) { automaticSaved.add(savedKey()); automaticRetries.delete(key); cam.automaticError = ''; }
      else automaticRetries.set(key, Date.now() + AUTOMATIC_RETRY_MS);
    } catch (error) {
      if (version !== contextVersion || cam.mode !== 'live') return;
      automaticRetries.set(key, Date.now() + AUTOMATIC_RETRY_MS);
      cam.automaticError = `Attendance save failed: ${error.message} Retrying when this face is seen again.`;
    }
  }).finally(() => { if (version === contextVersion) updateRecognitionControls(); });
  updateRecognitionControls();
}
async function loadHistory() { const version = contextVersion, data = await api('/history'); if (version !== contextVersion || !state.user) return; $('#history-summary').innerHTML = data.summary.map(item => `<article class="history-card"><h3>${esc(item.course_code)} · ${esc(item.group_code)}</h3><p><strong>${item.remaining_absences}</strong> absences remaining of ${item.allowed_absences}</p><p>${item.used_absences} used · term ends ${esc(String(item.term_ends_on).slice(0, 10))}</p></article>`).join('') || '<p>No attendance allowance is assigned yet.</p>'; $('#history-rows').innerHTML = data.history.map(item => `<tr><td>${esc(item.course_code)} · ${esc(item.group_name)}</td><td>${esc(fmtDate(item.starts_at, item.time_zone))}<small>${esc(item.time_zone)}</small></td><td><span class="status status--${esc(item.status)}">${esc(STATUS_LABEL[item.status] || item.status)}</span></td><td>${esc(fmtDate(item.checked_in_at, item.time_zone))}</td></tr>`).join('') || '<tr><td colspan="4">No attendance records yet.</td></tr>'; }
$('#history-refresh').addEventListener('click', () => loadHistory().catch(report));
function setCameraState(mode, text) { if (mode === 'off') cam.automaticError = ''; $('#camera-state').classList.toggle('is-live', mode === 'live'); $('#camera-state').classList.toggle('is-demo', mode === 'demo'); $('#camera-state-text').textContent = text; $('#camera-empty').hidden = mode !== 'off'; $('#stop-camera').hidden = mode === 'off'; $('#face-count-wrap').hidden = mode === 'off'; $('#camera-warning').textContent = mode === 'demo' ? cam.demoPersist ? 'SYNTHETIC DATABASE DEMO · generated face results save only to the DEMO section when the server explicitly allows synthetic camera. This is not facial recognition.' : 'SYNTHETIC VISUAL DEMO · generated boxes and confidence scores. This never saves attendance.' : automaticCamera() ? 'Automatic attendance · saved SFace matches above 0.55 similarity check in once per session.' : 'Temporary face matching · review the suggested student and confirm attendance.'; updateRecognitionControls(); }
function sizeCanvas() { const bounds = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = bounds.width * dpr; canvas.height = bounds.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawResults(); }
function drawResults() { if (!canvas.width) return; const { width, height } = canvas.getBoundingClientRect(); ctx.clearRect(0, 0, width, height); cam.results.forEach(r => { if (!r.box) return; const vw = video.videoWidth || 1280, vh = video.videoHeight || 720, scale = Math.max(width / vw, height / vh), fw = vw * scale, fh = vh * scale, box = r.box, w = box.width * fw, h = box.height * fh, x = width - (box.x * fw + (width - fw) / 2) - w, y = box.y * fh + (height - fh) / 2; ctx.strokeStyle = { high: '#30d158', uncertain: '#ff9f0a', low: '#ff453a' }[levelOf(r.confidence)]; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.font = '600 17px Arial, sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(`${cam.mode === 'demo' ? 'Synthetic face' : studentById(r.studentId)?.name || 'Unknown'} · ${['present', 'late'].includes(studentById(r.studentId)?.status) && cam.mode !== 'demo' ? `${STATUS_LABEL[studentById(r.studentId).status]} · saved` : r.suggestion ? (r.identityMatched ? r.recognitionMethod === 'sface' ? 'recognized' : 'manual match' : 'unregistered') : `${Math.round(r.confidence * 100)}%`}`, x, y + h + 24 > height ? y - 12 : y + h + 24); }); }
new ResizeObserver(sizeCanvas).observe(canvas);
function showMatch(r) {
  const previousMatch = cam.match;
  if (!cam.manualSelection && previousMatch?.suggestion && !r?.studentId && $('#checkin-student').value === previousMatch.studentId && studentById(previousMatch.studentId)?.status === 'pending') $('#checkin-student').value = '';
  cam.match = r;
  $('#match-name').textContent = r ? cam.mode === 'demo' ? 'Synthetic face' : studentById(r.studentId)?.name || 'Unknown student' : 'No one yet';
  $('#confidence-value').textContent = r ? r.suggestion ? (r.recognitionMethod === 'sface' && Number.isFinite(r.similarity) ? `Similarity ${r.similarity.toFixed(2)}` : Number.isFinite(r.distance) ? `Distance ${r.distance.toFixed(1)}` : '—') : `${Math.round(r.confidence * 100)}%` : '—';
  $('#match-level').textContent = r ? r.suggestion ? (r.identityMatched ? r.recognitionMethod !== 'sface' ? 'Possible match · confirm' : automaticMatch(r) ? 'Recognized · saving automatically' : 'Possible match · below automatic threshold' : 'Unknown face') : `${levelOf(r.confidence)} confidence${cam.mode === 'demo' ? ' · synthetic' : ''}` : '';
  $('#match-level').className = `match__level${r ? ` is-${levelOf(r.confidence)}` : ''}`;
  const student = studentById(r?.studentId);
  if (!cam.manualSelection && r && (r.suggestion || levelOf(r.confidence) !== 'high') && student && ['pending', 'present', 'late'].includes(student.status)) $('#checkin-student').value = String(student.id);
  updateRecognitionControls();
}
function updateRecognitionControls() {
  const selected = studentById(automaticCamera() ? cam.match?.studentId : $('#checkin-student').value), saved = selected && ['present', 'late'].includes(selected.status), saving = [...inflight.keys()].some(key => key.startsWith(`confirm:${contextVersion}:${state.group?.id}:`) || key.startsWith(`automatic:${contextVersion}:${state.group?.id}:`));
  const allowed = teacher() && state.group && state.session?.status !== 'closed' && cam.mode !== 'demo' && !inflight.has(`approve-next:${state.session?.id}`);
  $('#recognition-sub').textContent = cam.mode === 'demo' ? cam.demoPersist ? 'Synthetic results are submitted to the server; the roster changes only after saved acknowledgment.' : 'Synthetic display only; no attendance is written.' : saved ? 'Attendance is saved for this session.' : state.session?.status === 'closed' ? 'This session is closed. Choose or create a new session.' : automaticCamera() ? saving ? 'Recognized student · saving attendance automatically…' : !state.session ? 'Waiting for a saved face above 0.55 similarity to create a session and save attendance.' : state.session.status === 'planned' ? 'A qualifying face opens this session during its scheduled time.' : 'Saved faces above 0.55 similarity check in automatically. Unknown faces remain unsaved.' : !state.session ? 'Confirm attendance to create and open a session, then save this student.' : state.session.status === 'planned' ? 'Confirm attendance to open this session and save this student.' : 'Choose a student, then confirm attendance.';
  $('#checkin-form').hidden = automaticCamera();
  if (cam.mode === 'live' && cam.automaticError && !saving && !saved) $('#recognition-sub').textContent = cam.automaticError;
  $('#checkin-student').disabled = !allowed || saving;
  $('#checkin-confirm').disabled = !allowed || saving || !selected || selected.status !== 'pending';
  $('#checkin-confirm').textContent = saving ? 'Saving attendance…' : saved ? 'Attendance saved' : 'Confirm attendance';
  if (saved && cam.mode !== 'demo') { $('#match-name').textContent = selected.name; $('#match-level').textContent = `${STATUS_LABEL[selected.status]} · saved`; $('#match-level').className = 'match__level is-high'; }
  else if (cam.manualSelection && selected) { $('#match-name').textContent = selected.name; $('#match-level').textContent = 'Selected · confirm attendance'; }
}
function recognize(results, serverContext) { if (cam.mode === 'off' || (serverContext && (serverContext.version !== contextVersion || String(serverContext.groupId) !== String(state.group?.id)))) return; cam.results = (Array.isArray(results) ? results : [results]).filter(r => r && Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1 && (!r.box || ['x', 'y', 'width', 'height'].every(key => Number.isFinite(r.box[key]) && r.box[key] >= 0 && r.box[key] <= 1))); $('#face-count').textContent = cam.results.length; drawResults(); cam.results.forEach(r => { if (cam.mode === 'live') automaticAttendance(r, serverContext); const key = `${state.session?.id}:${r.studentId}`; if (cam.mode === 'demo' && cam.demoPersist && !r.suggestion && levelOf(r.confidence) === 'high' && r.studentId && !cam.attempted.has(key)) { cam.attempted.add(key); checkIn(r.studentId, 'camera', r.confidence).catch(report); } }); if (document.activeElement !== $('#checkin-student') || cam.mode === 'live') showMatch([...cam.results].sort((a, b) => Number(!!b.studentId) - Number(!!a.studentId) || b.confidence - a.confidence)[0] || null); }
function updateCameraControls() {
  const supported = !!navigator.mediaDevices?.getUserMedia;
  $('#start-camera').disabled = cameraDevices.opening || cameraDevices.unavailable || !supported;
  $('#camera-device').disabled = cameraDevices.opening || !supported || !navigator.mediaDevices?.enumerateDevices;
  $('#camera-devices-refresh').disabled = cameraDevices.opening || !!cameraDevices.inventoryPromise || !navigator.mediaDevices?.enumerateDevices;
  $('#start-demo').disabled = cameraDevices.opening;
  $('#start-persisted-demo').disabled = cameraDevices.opening;
  $('#stop-camera').hidden = cam.mode === 'off' && !cameraDevices.opening;
}
function renderCameraDevices() {
  const select = $('#camera-device');
  select.innerHTML = '<option value="">Default camera</option>' + cameraDevices.devices.map((device, index) => `<option value="${esc(device.deviceId)}">${esc(device.label || `Camera ${index + 1}`)}</option>`).join('');
  if (cameraDevices.selectedId && !cameraDevices.devices.some(device => device.deviceId === cameraDevices.selectedId)) select.innerHTML += `<option value="${esc(cameraDevices.selectedId)}">Selected camera (unavailable)</option>`;
  select.value = cameraDevices.selectedId;
}
function cameraDisconnected() {
  stopCamera(); cameraDevices.unavailable = true; renderCameraDevices(); updateCameraControls();
  const message = 'The selected camera disconnected. Choose another camera, then start it. Teacher check-in still works.';
  $('#camera-device-status').textContent = message; notify(message);
}
function refreshCameraDevices() {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) {
    $('#camera-device-status').textContent = media?.getUserMedia ? 'Camera selection is unavailable in this browser. Default camera preview and teacher check-in still work.' : 'Camera preview is unavailable in this browser. Teacher check-in still works.';
    updateCameraControls(); return Promise.resolve();
  }
  cameraDevices.inventoryVersion++;
  if (cameraDevices.inventoryPromise) return cameraDevices.inventoryPromise;
  cameraDevices.inventoryPromise = (async () => {
    let version;
    do {
      version = cameraDevices.inventoryVersion;
      try {
        const inventory = await media.enumerateDevices();
        if (version !== cameraDevices.inventoryVersion) continue;
        const seen = new Set();
        cameraDevices.devices = inventory.filter(device => device.kind === 'videoinput' && device.deviceId && !seen.has(device.deviceId) && seen.add(device.deviceId));
        if (cameraDevices.activeId && cam.stream && !cameraDevices.devices.some(device => device.deviceId === cameraDevices.activeId)) { cameraDisconnected(); continue; }
        cameraDevices.unavailable = !!cameraDevices.selectedId && !cameraDevices.devices.some(device => device.deviceId === cameraDevices.selectedId);
        renderCameraDevices();
        $('#camera-device-status').textContent = cameraDevices.unavailable ? 'The selected camera is unavailable. Choose another camera to start preview.' : !cameraDevices.devices.length ? 'No cameras were listed. Connect a camera or allow camera access when starting preview. Teacher check-in still works.' : cameraDevices.devices.some(device => !device.label) ? 'Choose a camera. Camera names appear after you allow camera access.' : `${cameraDevices.devices.length} camera${cameraDevices.devices.length === 1 ? '' : 's'} available.`;
      } catch (error) {
        if (version === cameraDevices.inventoryVersion) $('#camera-device-status').textContent = `Camera list could not refresh: ${error.message || 'Access unavailable'}. Teacher check-in still works.`;
      }
    } while (version !== cameraDevices.inventoryVersion);
  })().finally(() => { cameraDevices.inventoryPromise = null; updateCameraControls(); });
  updateCameraControls(); return cameraDevices.inventoryPromise;
}
async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) return notify('Camera preview is unavailable in this browser. Teacher check-in still works.');
  if (cameraDevices.unavailable) return notify('Choose an available camera before starting preview.');
  const lifecycle = cameraDevices.lifecycle, selectedId = cameraDevices.selectedId;
  cameraDevices.opening = true; setCameraState('off', 'Camera starting…'); updateCameraControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: selectedId ? { deviceId: { exact: selectedId } } : { facingMode: 'user' }, audio: false });
    if (lifecycle !== cameraDevices.lifecycle) { stream.getTracks().forEach(track => track.stop()); return; }
    cam.stream = stream; video.srcObject = stream;
    const track = stream.getVideoTracks?.()[0];
    cameraDevices.activeId = track?.getSettings?.().deviceId || selectedId;
    if (cameraDevices.activeId) cameraDevices.selectedId = cameraDevices.activeId;
    track?.addEventListener?.('ended', () => { if (lifecycle === cameraDevices.lifecycle && cam.stream === stream) cameraDisconnected(); });
    refreshCameraDevices();
    await video.play();
    if (lifecycle !== cameraDevices.lifecycle) return;
    cameraDevices.opening = false; cam.mode = 'live'; setCameraState('live', 'Camera · face matching'); sizeCanvas();
    document.dispatchEvent(new CustomEvent('presence:camera-start', { detail: { video } }));
  } catch (error) {
    if (lifecycle !== cameraDevices.lifecycle) return;
    stopCamera();
    const message = `Camera could not start: ${error.message || 'Access unavailable'}. Use teacher check-in.`;
    $('#camera-device-status').textContent = message; notify(message);
  } finally { if (lifecycle === cameraDevices.lifecycle) { cameraDevices.opening = false; updateCameraControls(); } }
}
function stopCamera() { cameraDevices.lifecycle++; cameraDevices.opening = false; cameraDevices.activeId = ''; clearTimeout(cam.demoTimer); cam.stream?.getTracks().forEach(t => t.stop()); const wasOn = cam.mode !== 'off'; cam.stream = null; video.srcObject = null; cam.mode = 'off'; cam.demoPersist = false; cam.results = []; cam.attempted.clear(); cam.manualSelection = false; $('#face-count').textContent = '0'; drawResults(); setCameraState('off', 'Camera off'); showMatch(null); updateCameraControls(); if (wasOn) document.dispatchEvent(new CustomEvent('presence:camera-stop')); }
function startDemo(persist = false) { if (persist && (!canCheckIn() || state.group?.code !== 'PRESENCE-DEMO-SYNTHETIC' || !state.capabilities?.syntheticCamera)) return notify('Open a session in PRESENCE-DEMO-SYNTHETIC with ALLOW_SYNTHETIC_CAMERA enabled on the server.'); stopCamera(); cam.demoPersist = persist; cam.mode = 'demo'; setCameraState('demo', persist ? 'Synthetic database demo' : 'Synthetic visual demo'); sizeCanvas(); let step = 0; const next = () => { if (cam.mode !== 'demo') return; recognize([{ studentId: persist ? state.students.find(s => s.status === 'pending')?.id || null : null, confidence: persist ? .95 : [.95, .72, .4][step++ % 3], box: { x: .39, y: .18, width: .22, height: .44 } }]); cam.demoTimer = setTimeout(next, 3500); }; next(); }
$('#start-camera').addEventListener('click', startCamera); $('#start-demo').addEventListener('click', () => startDemo(false)); $('#start-persisted-demo').addEventListener('click', () => startDemo(true)); $('#stop-camera').addEventListener('click', stopCamera);
$('#camera-device').addEventListener('change', () => { cameraDevices.selectedId = $('#camera-device').value; cameraDevices.unavailable = false; updateCameraControls(); if (cam.mode === 'live' || cameraDevices.opening) return startCamera(); });
$('#camera-devices-refresh').addEventListener('click', refreshCameraDevices);
navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameraDevices);
$('#checkin-student').addEventListener('change', () => { cam.manualSelection = !!$('#checkin-student').value; updateRecognitionControls(); }); $('#checkin-confirm').addEventListener('click', () => confirmAttendance().catch(report));
document.addEventListener('visibilitychange', () => { if (document.hidden && (cam.mode === 'live' || cameraDevices.opening)) stopCamera(); });
const dialog = $('#approve-dialog');
let approvalDialogContext;
function submitApproval() { if (approvalDialogContext?.version !== contextVersion || String(approvalDialogContext?.sessionId) !== String(state.session?.id)) return; const version = contextVersion; return approveAndNext().catch(error => { if (version === contextVersion) notify(`Could not approve attendance: ${error.message} Retry Approve attendance.`); }); }
$('#approve-btn').addEventListener('click', () => { if (!canCheckIn()) return; approvalDialogContext = { sessionId: state.session.id, version: contextVersion }; const c = counts(); $('#dialog-text').textContent = `${c.present} present, ${c.late} late, ${c.absent} absent, ${c.pending} not seen. Approval saves and closes this session in ${state.group.code}, then opens a fresh one-hour session with everyone not seen yet. The camera keeps running.`; if (typeof dialog.showModal === 'function') dialog.showModal(); else if (confirm($('#dialog-text').textContent)) return submitApproval(); });
dialog.addEventListener('close', () => { if (dialog.returnValue === 'approve') return submitApproval(); });
window.Presence = Object.freeze({ recognize, getVideo: () => video, getRoster: () => state.students.map(s => ({ ...s })), setRoster: () => refresh(), refresh, checkIn, getContext: () => ({ userId: state.user?.id, groupId: state.group?.id, groupCode: state.group?.code, sessionId: state.session?.id, sessionStartsAt: state.session?.starts_at, sessionEndsAt: state.session?.ends_at, version: contextVersion, mode: cam.mode, teacher: teacher() }), recordingRequest, faceRequest: (groupId, action, body) => api(`/groups/${groupId}/faces/${action}`, body), thresholds: THRESHOLDS });
$$('img[data-logo]').forEach(img => { const loaded = () => { if (img.naturalWidth) img.closest('.logo__slot').classList.add('has-img'); }; if (img.complete) loaded(); else img.addEventListener('load', loaded); });
let savedUniversity = root.dataset.university || 'ucf', savedTheme = root.dataset.theme || 'light';
try { savedUniversity = localStorage.getItem('presence-university') || savedUniversity; savedTheme = localStorage.getItem('presence-theme') || (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch {}
setUniversity(savedUniversity); setTheme(savedTheme); showSignedOut();
refreshCameraDevices();
const localInput = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$('#new-start').value = localInput(new Date()); $('#new-end').value = localInput(new Date(Date.now() + 60 * 60000)); $('#create-zone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
reconnect();
