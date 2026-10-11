// Live attendance video is uploaded independently from the face-recognition loop.
const $ = selector => document.querySelector(selector);
const stateNode = $('#recording-state'), errorNode = $('#recording-error');
const listNode = $('#recording-list'), player = $('#recording-player'), jumpsNode = $('#recording-jumps');
const CHUNK_LIMIT = 8 * 1024 * 1024, BUFFER_LIMIT = 32 * 1024 * 1024, MAX_DURATION = 119 * 60 * 1000;
const api = () => window.Presence;
let generation = 0, active = null, checkins = [], currentGroup = null, currentTeacher = null, listGeneration = 0;
const supportedTypes = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
function mediaType() { return supportedTypes.find(type => MediaRecorder.isTypeSupported?.(type)) || ''; }
function urlId(id) { return encodeURIComponent(String(id)); }
function showError(error) { errorNode.hidden = false; errorNode.textContent = error?.message || String(error); }
function clearError() { errorNode.hidden = true; errorNode.textContent = ''; }
function recordingPath(groupId) { return `/groups/${urlId(groupId)}/recordings`; }
function setState(text) { stateNode.textContent = text; }
function sessionKey(context) { return `${context.sessionId ?? ''}|${context.sessionStartsAt ?? ''}|${context.sessionEndsAt ?? ''}`; }

async function refreshList(groupId = api().getContext().groupId) {
  const request = ++listGeneration;
  if (!groupId || !api()?.recordingRequest || !api().getContext().teacher) { listNode.replaceChildren(); return; }
  try {
    const result = await api().recordingRequest(recordingPath(groupId), { method: 'GET' });
    if (request !== listGeneration || String(api().getContext().groupId) !== String(groupId)) return;
    const records = Array.isArray(result.recordings) ? result.recordings : [];
    listNode.replaceChildren(...records.map(record => {
      const item = document.createElement('div'); item.className = 'recording-list__item';
      const label = document.createElement('span');
      const start = Date.parse(record.startedAt || record.started_at);
      const status = record.status || 'recording';
      const recovered = record.recovered || record.interrupted;
      label.textContent = `${recovered ? 'Recovered recording · ending may be missing' : Number.isFinite(start) ? `Class · ${new Date(start).toLocaleString()}` : 'Class recording'} · ${statusLabel(status, record)}`;
      item.append(label);
      if (status === 'finished' && record.seekable === true) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button button--secondary'; button.textContent = 'Play recording';
        button.addEventListener('click', () => play(record)); item.append(button);
      }
      if (status === 'processing_failed' && (record.endedAt || record.ended_at)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button button--secondary'; retry.textContent = 'Retry saving';
        retry.addEventListener('click', () => retryFinish(record, retry)); item.append(retry);
      }
      return item;
    }));
    if (!records.length) { const empty = document.createElement('p'); empty.className = 'integration-note'; empty.textContent = 'No saved recordings for this course yet.'; listNode.append(empty); }
  } catch (error) { if (request === listGeneration && String(api().getContext().groupId) === String(groupId)) showError(`Could not load saved recordings: ${error.message}`); }
}
async function retryFinish(record, button) {
  button.disabled = true; button.textContent = 'Retrying…';
  try {
    await api().recordingRequest(`/recordings/${urlId(record.id)}/finish`, { method: 'POST', body: { endedAt: record.endedAt || record.ended_at } });
    clearError(); await refreshList();
  } catch (error) {
    showError(`Could not retry saving this recording: ${error.message}`);
    button.disabled = false; button.textContent = 'Retry saving';
  }
}
function statusLabel(status, record) {
  if (status === 'finished') return record?.seekable === true ? 'saved' : 'playback unavailable';
  return ({ recording: 'uploading', processing_failed: 'processing failed' })[status] || String(status || 'unavailable');
}
function play(record, offset) {
  if (!record?.id || record.status !== 'finished' || record.seekable !== true) return;
  const path = `/api/recordings/${urlId(record.id)}/video`;
  // Authenticated same-origin video uses the browser's cookie and native range requests.
  player.src = path; player.hidden = false;
  if (Number.isFinite(offset)) {
    player.addEventListener('loadedmetadata', () => {
      const duration = player.duration;
      if (!Number.isFinite(duration) || duration <= 0) { showError('This recording does not report a finite duration, so the check-in time cannot be sought.'); return; }
      const target = Math.max(0, Math.min(duration, offset));
      try { player.currentTime = target; } catch { showError('The browser could not seek to that check-in time.'); }
    }, { once: true });
  }
  player.play().catch(() => {});
}
function buildJumps(record) {
  jumpsNode.replaceChildren();
  if (!record) return;
  const start = Date.parse(record.startedAt || record.started_at);
  const end = Date.parse(record.endedAt || record.ended_at || new Date().toISOString());
  if (record.status !== 'finished' || record.seekable !== true || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  const rosterMarks = api().getRoster().filter(student => ['present', 'late'].includes(student.status) && student.time).map(student => ({ studentId: student.id, studentName: student.name, time: student.time }));
  const marks = new Map();
  for (const mark of [...rosterMarks, ...checkins]) {
    const at = Date.parse(mark.time);
    if (!Number.isFinite(at) || at < start || at > end || mark.studentId == null) continue;
    marks.set(String(mark.studentId), mark);
  }
  for (const mark of marks.values()) {
    const at = Date.parse(mark.time), student = api().getRoster().find(item => String(item.id) === String(mark.studentId));
    const button = document.createElement('button'); button.type = 'button'; button.className = 'link recording-jump';
    button.textContent = `${student?.name || mark.studentName || 'Student'} · ${new Date(at).toLocaleTimeString()}`;
    button.addEventListener('click', () => play(record, Math.max(0, (at - start) / 1000 - 3))); jumpsNode.append(button);
  }
}
function renderSelected(record) { buildJumps(record); }

async function uploadChunk(session, blob, sequence) {
  const buffer = await blob.arrayBuffer();
  let error;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await session.created;
      if (!session.recordingId) throw new Error('The recording could not be created.');
      const path = `/recordings/${urlId(session.recordingId)}/chunks/${sequence}`;
      await api().recordingRequest(path, { method: 'PUT', rawBody: buffer, contentType: blob.type || session.mimeType });
      session.uploadedBytes += buffer.byteLength; return;
    } catch (cause) {
      error = cause;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, [250, 750, 1750][attempt]));
    }
  }
  throw new Error(`Video upload failed at chunk ${sequence}: ${error?.message || 'network error'}`);
}
function enqueue(session, blob) {
  if (!blob?.size || session.failed) return;
  if (blob.size > CHUNK_LIMIT) { fail(session, new Error('A video segment exceeded the 8 MiB upload limit. Recording stopped; attendance recognition continues.')); return; }
  session.bufferedBytes += blob.size;
  if (session.bufferedBytes > BUFFER_LIMIT) { fail(session, new Error('Video upload fell more than 32 MiB behind. Recording stopped to protect browser memory; attendance recognition continues.')); return; }
  const sequence = session.nextSequence++;
  session.queue = session.queue.then(async () => {
    if (session.failed) return;
    if (active === session) setState('Uploading recording…');
    try { await uploadChunk(session, blob, sequence); }
    catch (error) { fail(session, error); }
    finally { session.bufferedBytes = Math.max(0, session.bufferedBytes - blob.size); }
  });
}
function fail(session, error) {
  if (session.failed) return;
  session.failed = error; showError(error); if (active === session) setState('Recording failed');
  if (session.recorder?.state === 'recording') session.recorder.stop();
}
async function finish(session) {
  if (session.finishing) return session.finishing;
  session.finishing = (async () => {
    try {
      // A recorder can stop before it emits its first chunk. In that case the
      // queue is already resolved, so wait for the create request explicitly.
      await session.created;
      if (!session.recordingId) throw new Error('The recording could not be created.');
      await session.queue;
      if (session.failed) throw session.failed;
      const result = await api().recordingRequest(`/recordings/${urlId(session.recordingId)}/finish`, { method: 'POST', body: { endedAt: session.endedAt || new Date().toISOString() } });
      session.recording = result.recording;
      if (active === session) setState('Recording saved');
      await refreshList(session.groupId);
    } catch (error) { fail(session, error); await refreshList(session.groupId); }
    finally { if (active === session) active = null; }
  })();
  return session.finishing;
}
async function stop(session, reason = '') {
  if (!session || session.stopping) return session?.stopping;
  session.stopping = (async () => {
    clearTimeout(session.durationTimer);
    session.stopRequested = true;
    if (!session.recorder) {
      try { await session.created; } catch {}
    }
    if (session.recorder?.state === 'recording') {
      await new Promise(resolve => {
        session.recorder.addEventListener('stop', resolve, { once: true });
        try { session.recorder.stop(); } catch { resolve(); }
      });
    }
    if (reason && !session.failed && active === session) setState(`${reason} · saving recording…`);
    await finish(session);
  })();
  return session.stopping;
}
async function splitRecording(session) {
  if (!session || active !== session || session.splitting) return;
  session.splitting = true; clearTimeout(session.durationTimer);
  setState('Starting the next recording segment…');
  if (session.recorder?.state === 'recording') {
    await new Promise(resolve => {
      session.recorder.addEventListener('stop', resolve, { once: true });
      try { session.recorder.stop(); } catch { resolve(); }
    });
  }
  // The previous segment's ordered uploads and finish continue independently.
  if (active === session) active = null;
  const video = api().getVideo(), ctx = api().getContext();
  if (ctx.mode === 'live' && ctx.teacher && String(ctx.groupId) === String(session.groupId) && video.srcObject) begin({ detail: { video } });
}
async function begin(event) {
  const ctx = api().getContext();
  if (ctx.mode !== 'live' || !ctx.groupId || !ctx.teacher || !event?.detail?.video?.srcObject) {
    setState(ctx.groupId ? 'Waiting for live camera' : 'Choose a course to record'); return;
  }
  const groupId = ctx.groupId, stream = event.detail.video.srcObject, key = sessionKey(ctx);
  if (active) await stop(active, 'Camera restarted');
  const current = api().getContext(), video = api().getVideo();
  if (current.mode !== 'live' || !current.teacher || String(current.groupId) !== String(groupId) || sessionKey(current) !== key || video.srcObject !== stream) return;
  const token = ++generation;
  if (typeof MediaRecorder === 'undefined') { setState('Recording unavailable in this browser'); showError('This browser does not support video recording. Attendance recognition continues.'); return; }
  const type = mediaType();
  if (!type) { setState('Recording unavailable in this browser'); showError('No supported WebM or MP4 recording format is available. Attendance recognition continues.'); return; }
  // MediaRecorder reads the live stream without changing its constraints, so face matching keeps its camera quality.
  const mimeType = type;
  const startedAt = new Date().toISOString();
  const session = { generation: token, groupId, contextKey: key, mimeType, startedAt, nextSequence: 0, bufferedBytes: 0, uploadedBytes: 0, queue: Promise.resolve(), failed: null, recorder: null, stopRequested: false };
  active = session; clearError(); setState('Starting recording…');
  try {
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 }); session.recorder = recorder;
    recorder.addEventListener('dataavailable', event => enqueue(session, event.data));
    recorder.addEventListener('error', event => fail(session, event.error || new Error('The browser could not encode the recording.')));
    recorder.addEventListener('stop', () => { session.endedAt = new Date().toISOString(); if (active === session || session.stopping) finish(session); });
    session.startedAt = new Date().toISOString();
    recorder.start(5000); setState('Recording · 00:00');
    session.created = api().recordingRequest(recordingPath(groupId), { method: 'POST', body: { mimeType, startedAt: session.startedAt } }).then(created => {
      session.recordingId = created.recording?.id;
      if (session.recordingId == null) throw new Error('The server did not return a recording ID.');
      if (session.stopRequested && recorder.state === 'recording') recorder.stop();
      return created.recording;
    });
    await session.created;
    if (session.stopRequested) { await stop(session, 'Camera stopped'); return; }
    if (token !== generation || active !== session) { await stop(session, 'Context changed'); return; }
    session.durationTimer = setTimeout(() => splitRecording(session), MAX_DURATION);
    await refreshList(groupId);
  } catch (error) { fail(session, error); if (active === session) active = null; }
}
document.addEventListener('presence:camera-start', event => { begin(event).catch(error => showError(error)); });
document.addEventListener('presence:camera-stop', () => { if (active) stop(active, 'Camera stopped'); else setState('Waiting for live camera'); });
document.addEventListener('presence:checkin', event => {
  const detail = event.detail || {};
  if (detail.time && detail.studentId != null && (!active || String(detail.sessionId) === String(api().getContext().sessionId))) {
    checkins.push({ studentId: detail.studentId, studentName: detail.studentName, time: detail.time });
    if (checkins.length > 500) checkins.splice(0, checkins.length - 500);
    if (player.dataset.recording) renderSelected({ id: player.dataset.recording, startedAt: player.dataset.started, endedAt: player.dataset.ended });
  }
});
player.addEventListener('loadedmetadata', () => {
  const record = player._recording;
  if (record) renderSelected(record);
});
player.addEventListener('error', () => showError('This saved video could not be played. It may have expired or the browser may not support its format.'));
const originalPlay = play;
// Keep selected recording metadata available for attendance jump buttons.
play = function(record, offset) { player._recording = record; player.dataset.recording = String(record.id); player.dataset.started = record.startedAt || record.started_at || ''; player.dataset.ended = record.endedAt || record.ended_at || ''; originalPlay(record, offset); renderSelected(record); };
function pollContext() {
  const ctx = api().getContext();
  const groupChanged = currentGroup !== String(ctx.groupId || '');
  const teacherChanged = currentTeacher !== null && currentTeacher !== !!ctx.teacher;
  if (groupChanged || (teacherChanged && !ctx.teacher)) {
    if (groupChanged) checkins = [];
    if (teacherChanged && !ctx.teacher) listGeneration++;
    player.pause?.(); player.removeAttribute?.('src'); player.load?.(); player.hidden = true; player._recording = null; jumpsNode.replaceChildren();
    listNode.replaceChildren();
  }
  if (groupChanged || (teacherChanged && ctx.teacher)) {
    currentGroup = String(ctx.groupId || '');
    if (ctx.teacher) refreshList(ctx.groupId); else refreshList(null);
  }
  currentGroup = String(ctx.groupId || ''); currentTeacher = !!ctx.teacher;
  if (active && (ctx.mode !== 'live' || !ctx.teacher || String(ctx.groupId) !== String(active.groupId))) {
    const old = active;
    if (!old.transition) old.transition = stop(old, String(ctx.groupId) !== String(active.groupId) ? 'Course changed' : 'Camera context changed');
  }
  if (active && active.recorder?.state === 'recording') {
    const elapsed = Math.max(0, Date.now() - Date.parse(active.startedAt));
    setState(`Recording · ${new Date(elapsed).toISOString().slice(11, 19)}`);
  }
}
setInterval(pollContext, 1000);
window.addEventListener('beforeunload', () => { if (active) stop(active, 'Page closed'); });
pollContext();
