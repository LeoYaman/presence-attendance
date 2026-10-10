/* ==========================================================================
   Presence · Attendance
   - University theme (UCF / Full Sail) and light/dark appearance
   - Roster with per-student status menus and undo
   - Camera preview + recognition results pushed by the backend (window.Presence)
   - "Approve attendance" for when facial recognition fails
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const root = document.documentElement;

/* ---------- Config ---------- */
const UNIVERSITIES = {
  ucf:      { name: 'UCF',       campus: 'Orlando' },
  fullsail: { name: 'Full Sail', campus: 'Winter Park' },
};
const LATE_AFTER_MIN = 10;
const STATUS_LABEL = { present: 'Present', late: 'Late', absent: 'Absent', pending: 'Not seen' };

/* Illustrative thresholds — set real values with the backend team */
const THRESHOLDS = { high: 0.85, uncertain: 0.6 };
const levelOf = c => c >= THRESHOLDS.high ? 'high' : c >= THRESHOLDS.uncertain ? 'uncertain' : 'low';
const LEVEL_LABEL = { high: 'High', uncertain: 'Uncertain', low: 'Low' };

/* ---------- Sample roster (replaced by window.Presence.setRoster) ---------- */
const state = {
  approved: false,
  filter: 'all',
  query: '',
  sessionStart: new Date(),
  students: [
    ['Alex Morgan', 'present'], ['Jamie Lee', 'present'], ['Taylor Patel', 'late'],
    ['Jordan Williams', 'present'], ['Sam Chen', 'pending'], ['Avery Rivera', 'present'],
    ['Casey Brown', 'pending'], ['Riley Kim', 'late'], ['Morgan Nguyen', 'present'],
    ['Drew Harris', 'pending'], ['Quinn Smith', 'pending'], ['Robin Brooks', 'pending'],
  ].map(([name, status], i) => ({
    id: `s${String(i + 1).padStart(2, '0')}`,
    number: String(i + 1).padStart(3, '0'),
    name,
    status,
    time: status === 'present' || status === 'late' ? new Date(Date.now() - (12 - i) * 60000) : null,
    source: status === 'pending' ? null : 'camera',
  })),
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const fmtTime = d => d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ') : '';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const studentById = id => state.students.find(s => s.id === id);

/* ==========================================================================
   Theme
   ========================================================================== */
function setUniversity(key) {
  if (!UNIVERSITIES[key]) return;
  root.dataset.university = key;
  store.set('presence-university', key);
  $$('.uni-switch button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.uni === key)));
  $$('[data-uni-text]').forEach(el => { el.textContent = UNIVERSITIES[key][el.dataset.uniText]; });
  document.title = `Presence · ${UNIVERSITIES[key].name} Attendance`;
  $('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--nav-bg').trim() || '#000000';
  drawResults();
}

function setTheme(mode) {
  root.dataset.theme = mode;
  store.set('presence-theme', mode);
  $('#theme-btn').setAttribute('aria-pressed', String(mode === 'dark'));
  $('#theme-btn').setAttribute('aria-label', mode === 'dark' ? 'Light mode' : 'Dark mode');
  $('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--nav-bg').trim() || '#000000';
}

$$('.uni-switch button').forEach(b => b.addEventListener('click', () => setUniversity(b.dataset.uni)));
$('.uni-switch').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const btns = $$('.uni-switch button');
  const i = btns.findIndex(b => b.getAttribute('aria-checked') === 'true');
  const next = btns[(i + 1) % btns.length];
  setUniversity(next.dataset.uni);
  next.focus();
});
$('#theme-btn').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ==========================================================================
   Undo + notice
   ========================================================================== */
let undoSnapshot = null;
function snapshot() {
  undoSnapshot = {
    approved: state.approved,
    students: state.students.map(s => ({ ...s, time: s.time ? s.time.getTime() : null })),
  };
}
function undo() {
  if (!undoSnapshot) return;
  state.students = undoSnapshot.students.map(s => ({ ...s, time: s.time ? new Date(s.time) : null }));
  const wasApproved = undoSnapshot.approved;
  undoSnapshot = null;
  setApproved(wasApproved);
  showMatch(cam.match);
  notify('Undone.');
}

let noticeTimer;
function notify(msg, { undoable = false } = {}) {
  $('#toast-text').textContent = msg;
  $('#toast-undo').hidden = !undoable;
  $('#toast').classList.add('is-visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('#toast').classList.remove('is-visible'), undoable ? 6000 : 3000);
}
$('#toast-undo').addEventListener('click', () => { $('#toast').classList.remove('is-visible'); undo(); });

/* ==========================================================================
   Summary + roster
   ========================================================================== */
function counts() {
  const c = { present: 0, late: 0, absent: 0, pending: 0 };
  state.students.forEach(s => c[s.status]++);
  return c;
}

function renderSummary() {
  const c = counts();
  const total = state.students.length || 1;
  $('#in-room').textContent = c.present + c.late;
  $('#roster-total').textContent = state.students.length;
  $('#count-present').textContent = c.present;
  $('#count-late').textContent = c.late;
  $('#count-absent').textContent = c.absent;
  $('#count-pending').textContent = c.pending;
  $('#bar-present').style.width = `${(c.present / total) * 100}%`;
  $('#bar-late').style.width = `${(c.late / total) * 100}%`;
  $('#bar-absent').style.width = `${(c.absent / total) * 100}%`;
  $('#n-all').textContent = state.students.length;
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square" aria-hidden="true"><path class="tick__check" d="M5 12.5 10 17.5 19 7"/></svg>';
const CROSS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

const TRIANGLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 21 20H3Z"/></svg>';
const STATUS_CYCLE = ['present', 'late', 'absent', 'pending'];

function detail(s) {
  if (s.status === 'present' || s.status === 'late') {
    return `${s.number} · ${fmtTime(s.time)} · ${s.source === 'teacher' ? 'ticked by teacher' : 'camera'}`;
  }
  if (s.status === 'absent') return `${s.number} · marked absent`;
  return `${s.number} · not seen yet`;
}

function renderList(highlightId) {
  const q = state.query.trim().toLowerCase();
  const rows = state.students.filter(s =>
    (state.filter === 'all' || s.status === state.filter) &&
    (!q || s.name.toLowerCase().includes(q) || s.number.includes(q)));

  $('#student-list').innerHTML = rows.map(s => {
    const options = Object.entries(STATUS_LABEL)
      .map(([v, l]) => `<option value="${v}"${v === s.status ? ' selected' : ''}>${l}</option>`).join('');
    const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(s.status) + 1) % STATUS_CYCLE.length];
    return `
      <li class="student" data-id="${esc(s.id)}" data-status="${s.status}">
        <button type="button" class="tick" ${state.approved ? 'disabled' : ''}
          aria-label="${esc(s.name)}: ${STATUS_LABEL[s.status]}. Change to ${STATUS_LABEL[nextStatus]}">
          <span>${s.status === 'present' ? CHECK_SVG : s.status === 'late' ? TRIANGLE_SVG : s.status === 'absent' ? CROSS_SVG : ''}</span>
        </button>
        <span class="student__info">
          <span class="student__name">${esc(s.name)}</span>
          <span class="student__meta">${esc(detail(s))}</span>
        </span>
        <select class="status status--${s.status}" aria-label="Status for ${esc(s.name)}" ${state.approved ? 'disabled' : ''}>${options}</select>
      </li>`;
  }).join('');
  $('#empty-state').hidden = rows.length > 0;
}

function renderPicker() {
  const sel = $('#checkin-student');
  const keep = sel.value;
  const waiting = state.students.filter(s => s.status === 'pending' || s.status === 'absent');
  sel.innerHTML = `<option value="">${waiting.length ? 'Select a student' : 'Everyone is checked in'}</option>` +
    waiting.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.number)})</option>`).join('');
  if (waiting.some(s => s.id === keep)) sel.value = keep;
  updateRecognitionControls();
}

function render(highlightId) {
  renderSummary();
  renderList(highlightId);
  renderPicker();
}

/* Change a status from the roster */
$('#student-list').addEventListener('change', e => {
  const sel = e.target.closest('select.status');
  if (!sel || state.approved) return;
  const s = studentById(sel.closest('.student').dataset.id);
  snapshot();
  s.status = sel.value;
  s.source = 'teacher';
  s.time = (s.status === 'present' || s.status === 'late') ? new Date() : null;
  render(s.id);
  $(`.student[data-id="${CSS.escape(s.id)}"] select`)?.focus();
  notify(`${s.name} marked ${STATUS_LABEL[s.status].toLowerCase()}.`, { undoable: true });
});

/* Cycle through all four attendance statuses. */
$('#student-list').addEventListener('click', e => {
  const btn = e.target.closest('.tick');
  if (!btn || state.approved) return;
  const s = studentById(btn.closest('.student').dataset.id);
  snapshot();
  s.status = STATUS_CYCLE[(STATUS_CYCLE.indexOf(s.status) + 1) % STATUS_CYCLE.length];
  s.source = s.status === 'pending' ? null : 'teacher';
  s.time = (s.status === 'present' || s.status === 'late') ? new Date() : null;
  render(s.id);
  notify(`${s.name} marked ${STATUS_LABEL[s.status].toLowerCase()}.`, { undoable: true });
  $(`.student[data-id="${CSS.escape(s.id)}"] .tick`)?.focus();
});

/* Filters + search */
$$('.tabs button').forEach(btn => btn.addEventListener('click', () => {
  state.filter = btn.dataset.filter;
  $$('.tabs button').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
  renderList();
}));
$('#roster-search').addEventListener('input', e => { state.query = e.target.value; renderList(); });

/* ==========================================================================
   Camera + recognition results
   The page does not recognize faces. The backend pushes results into
   window.Presence.recognize(...) — see INTEGRATION.md.
   ========================================================================== */
const video = $('#camera-video');
const canvas = $('#camera-overlay');
const ctx = canvas.getContext('2d');
const cam = { mode: 'off', stream: null, results: [], match: null, demoTimer: 0 };

function setCameraState(mode, text) {
  const el = $('#camera-state');
  el.classList.toggle('is-live', mode === 'live');
  el.classList.toggle('is-demo', mode === 'demo');
  $('#camera-state-text').textContent = text;
  $('#camera-empty').hidden = mode !== 'off';
  $('#stop-camera').hidden = mode === 'off';
  $('#face-count-wrap').hidden = mode === 'off';
}

function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawResults();
}
new ResizeObserver(sizeCanvas).observe(canvas);

/* Normalized box (0–1 of the un-mirrored camera frame) → on-screen pixels */
function toScreen(box) {
  const { width: cw, height: ch } = canvas.getBoundingClientRect();
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;   // demo assumes 16:9
  const scale = Math.max(cw / vw, ch / vh);
  const fw = vw * scale, fh = vh * scale;
  const ox = (cw - fw) / 2, oy = (ch - fh) / 2;
  const w = box.width * fw, h = box.height * fh;
  const x = box.x * fw + ox;
  return { x: cw - x - w, y: box.y * fh + oy, w, h };
}

function drawResults() {
  if (!canvas.width) return;
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const colors = { high: '#30d158', uncertain: '#ff9f0a', low: '#ff453a' };
  const font = root.dataset.university === 'ucf' ? 'Montserrat, Arial, sans-serif' : 'Roboto, Arial, sans-serif';
  cam.results.forEach(r => {
    if (!r.box) return;
    const f = toScreen(r.box);
    const lvl = levelOf(r.confidence);
    const s = studentById(r.studentId);
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors[lvl];
    ctx.beginPath();
    const corner = root.dataset.university === 'ucf' ? 0 : 14;     // UCF: square corners
    if (ctx.roundRect) ctx.roundRect(f.x, f.y, f.w, f.h, corner); else ctx.rect(f.x, f.y, f.w, f.h);
    ctx.stroke();

    const name = s && lvl !== 'low' ? s.name : 'Unknown';
    const ly = f.y + f.h + 44 > height ? f.y - 12 : f.y + f.h + 28;
    ctx.font = `600 17px ${font}`;
    ctx.fillStyle = '#f5f5f7';
    ctx.fillText(name, f.x, ly);
    const nw = ctx.measureText(name).width;
    ctx.font = `400 17px ${font}`;
    ctx.fillStyle = colors[lvl];
    ctx.fillText(`  ${Math.round(r.confidence * 100)}%`, f.x + nw, ly);
  });
}

/* ---------- Recognition tile ---------- */
function showMatch(r) {
  cam.match = r;
  const lvlEl = $('#match-level');
  const sel = $('#checkin-student');

  if (!r) {
    $('#match-name').textContent = 'No one yet';
    $('#confidence-value').textContent = '';
    lvlEl.textContent = '';
    lvlEl.className = 'match__level';
    sel.value = '';
    updateRecognitionControls();
    return;
  }

  const lvl = levelOf(r.confidence);
  const s = studentById(r.studentId);
  $('#match-name').textContent = s && lvl !== 'low' ? s.name : 'Unknown student';
  $('#confidence-value').textContent = `${Math.round(r.confidence * 100)}%`;
  lvlEl.textContent = `${LEVEL_LABEL[lvl]} confidence`;
  lvlEl.className = `match__level is-${lvl}`;

  // Pre-select the suggestion when the teacher only needs to confirm
  sel.value = (lvl === 'uncertain' && s && [...sel.options].some(o => o.value === s.id)) ? s.id : '';
  updateRecognitionControls();
}

function updateRecognitionControls() {
  const sel = $('#checkin-student');
  const r = cam.match;
  const lvl = r ? levelOf(r.confidence) : null;
  const s = r && studentById(r.studentId);
  const already = s && (s.status === 'present' || s.status === 'late');

  let note;
  if (state.approved) note = 'Attendance is approved and locked.';
  else if (cam.mode === 'off') note = 'The camera is off. You can still set statuses in the roster.';
  else if (!r) note = cam.results.length ? 'Someone is in frame. Waiting for a match.' : 'Waiting for a student to step in front of the camera.';
  else if (lvl !== 'low' && already) note = `Checked in at ${fmtTime(s.time)}.`;
  else if (lvl === 'uncertain') note = 'Confirm this is the right student, or choose someone else.';
  else if (lvl === 'low') note = 'Choose who this is to check them in.';
  else note = 'Checked in automatically.';
  $('#recognition-sub').textContent = note;

  const needsTeacher = r && lvl !== 'high' && !(lvl === 'uncertain' && already) && !state.approved && cam.mode !== 'off';
  sel.disabled = !needsTeacher || sel.options.length < 2;
  $('#checkin-confirm').disabled = sel.disabled || !sel.value;
}

/* ---------- Check-in ---------- */
function checkIn(studentId, source) {
  const s = studentById(studentId);
  if (!s || state.approved || s.status === 'present' || s.status === 'late') return false;
  snapshot();
  const minutes = (Date.now() - state.sessionStart) / 60000;
  s.status = minutes > LATE_AFTER_MIN ? 'late' : 'present';
  s.time = new Date();
  s.source = source;
  render(s.id);
  document.dispatchEvent(new CustomEvent('presence:checkin', {
    detail: { studentId: s.id, status: s.status, source, time: s.time.toISOString() },
  }));
  notify(`${s.name} checked in, ${STATUS_LABEL[s.status].toLowerCase()}.`, { undoable: true });
  return true;
}

$('#checkin-student').addEventListener('change', updateRecognitionControls);
$('#checkin-confirm').addEventListener('click', () => {
  const id = $('#checkin-student').value;
  if (checkIn(id, 'teacher')) showMatch({ ...cam.match, studentId: id, confidence: 1 });
});

/**
 * Entry point for the backend — one entry per face in the current frame.
 * @param {Array<{studentId?: string|null, confidence: number, box?: {x:number,y:number,width:number,height:number}}>} results
 */
function recognize(results) {
  if (cam.mode === 'off') return;
  cam.results = Array.isArray(results) ? results : [results];
  $('#face-count').textContent = cam.results.length;
  drawResults();

  cam.results.forEach(r => { if (levelOf(r.confidence) === 'high' && r.studentId) checkIn(r.studentId, 'camera'); });

  // Don't replace the tile while the teacher is deciding
  const sel = $('#checkin-student');
  const deciding = document.activeElement === sel || (sel.value && cam.match && levelOf(cam.match.confidence) !== 'high');
  if (!deciding || !cam.match) showMatch([...cam.results].sort((a, b) => b.confidence - a.confidence)[0] || null);
}

/* ---------- Camera ---------- */
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    notify('This browser can’t open the camera, so the demo is running instead.');
    return startDemo();
  }
  const btn = $('#start-camera');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = cam.stream;
    await video.play();
    cam.mode = 'live';
    setCameraState('live', 'Live');
    sizeCanvas();
    showMatch(null);
    document.dispatchEvent(new CustomEvent('presence:camera-start', { detail: { video } }));
  } catch (err) {
    console.warn(err);
    stopCamera();
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    notify(denied ? 'Camera access is off. You can still set statuses in the roster.' : 'The camera couldn’t start. Try the demo, or set statuses in the roster.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start camera';
  }
}

function stopCamera() {
  clearTimeout(cam.demoTimer);
  cam.stream?.getTracks().forEach(t => t.stop());
  const wasOn = cam.mode !== 'off';
  cam.stream = null;
  video.srcObject = null;
  cam.mode = 'off';
  cam.results = [];
  drawResults();
  $('#face-count').textContent = 0;
  setCameraState('off', 'Camera off');
  showMatch(null);
  if (wasOn) document.dispatchEvent(new CustomEvent('presence:camera-stop'));
}

/* Demo: mock results through the same recognize() path the backend uses */
function startDemo() {
  stopCamera();
  cam.mode = 'demo';
  setCameraState('demo', 'Demo');
  sizeCanvas();
  showMatch(null);
  const script = [0.95, 0.72, 0.4, 0.91, 0.68];
  let step = 0;
  const next = () => {
    if (cam.mode !== 'demo') return;
    const waiting = state.students.filter(s => s.status === 'pending' || s.status === 'absent');
    if (!waiting.length || state.approved) { recognize([]); return; }
    const conf = script[step++ % script.length];
    const s = waiting[Math.floor(Math.random() * waiting.length)];
    recognize([{ studentId: s.id, confidence: conf, box: { x: 0.39, y: 0.18, width: 0.22, height: 0.44 } }]);
    cam.demoTimer = setTimeout(next, levelOf(conf) === 'high' ? 3500 : 7000);
  };
  cam.demoTimer = setTimeout(next, 800);
}

$('#start-camera').addEventListener('click', startCamera);
$('#start-demo').addEventListener('click', startDemo);
$('#stop-camera').addEventListener('click', stopCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden && cam.mode === 'live') stopCamera(); });

/* ==========================================================================
   Approve attendance
   ========================================================================== */
const dialog = $('#approve-dialog');

function setApproved(on) {
  state.approved = on;
  const btn = $('#approve-btn');
  btn.classList.toggle('button--done', on);
  btn.textContent = on ? 'Reopen attendance' : 'Approve attendance';
  $('#approve-note').textContent = on
    ? `Approved at ${fmtTime(new Date())}. Reopen it to make changes.`
    : 'If facial recognition fails, review the list above and approve it as shown.';
  $('#session-status').classList.toggle('is-approved', on);
  $('#session-status-text').textContent = on ? 'Approved' : 'Session open';
  render();
}

$('#approve-btn').addEventListener('click', () => {
  if (state.approved) { setApproved(false); notify('Attendance reopened.'); return; }
  const c = counts();
  $('#dialog-text').textContent =
    `${c.present} present, ${c.late} late, ${c.absent} absent` +
    (c.pending ? `, and ${c.pending} not seen yet.` : '.') +
    ' This locks the record for CS 101, Section A.';
  $('#pending-row').hidden = c.pending === 0;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else if (confirm('Approve attendance?')) finalizeApproval();
});
dialog.addEventListener('close', () => { if (dialog.returnValue === 'approve') finalizeApproval(); });

function finalizeApproval() {
  snapshot();
  if ($('#mark-pending-absent').checked) {
    state.students.forEach(s => { if (s.status === 'pending') { s.status = 'absent'; s.source = 'teacher'; } });
  }
  setApproved(true);
  showMatch(cam.match);
  const c = counts();
  document.dispatchEvent(new CustomEvent('presence:approved', {
    detail: {
      approvedAt: new Date().toISOString(),
      sessionStart: state.sessionStart.toISOString(),
      students: state.students.map(s => ({ id: s.id, name: s.name, status: s.status, source: s.source, time: s.time?.toISOString() ?? null })),
    },
  }));
  notify(`Approved. ${c.present + c.late} of ${state.students.length} attended.`, { undoable: true });
}

/* ==========================================================================
   Init + public API
   ========================================================================== */
/* Logos: show the official file if it's in /assets, otherwise the name as text */
$$('img[data-logo]').forEach(img => {
  const ok = () => { if (img.naturalWidth) img.closest('.logo__slot').classList.add('has-img'); };
  if (img.complete) ok(); else img.addEventListener('load', ok);
});

setUniversity(root.dataset.university || 'ucf');
setTheme(root.dataset.theme || 'light');
$('#session-start').textContent = fmtTime(state.sessionStart);
setCameraState('off', 'Camera off');
render();
showMatch(null);

window.Presence = Object.freeze({
  recognize,                                   // push recognition results for the current frame
  getVideo: () => video,                       // <video> with the live camera stream
  getRoster: () => state.students.map(s => ({ ...s, time: s.time?.toISOString() ?? null })),
  setRoster(list) {                            // [{ id, number, name }] — replaces the sample roster
    state.students = list.map(s => ({ status: 'pending', time: null, source: null, ...s }));
    render();
  },
  thresholds: THRESHOLDS,
});
