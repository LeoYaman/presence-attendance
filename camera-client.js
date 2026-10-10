// Browser camera frames are processed by the repository's Python worker.
// Server SFace matches above 0.55 can save attendance automatically.
const $ = selector => document.querySelector(selector);
const capture = document.createElement('canvas');
const picker = $('#enroll-student'), enroll = $('#enroll-face'), clear = $('#clear-faces');
const consent = $('#face-consent'), status = $('#face-service-status');
let generation = 0, timer, busy = false, enrolling = false, activeGroup;
const api = () => window.Presence;
const context = () => api().getContext();
const current = (token, initial) => token === generation && context().mode === 'live' && context().groupId === initial.groupId && context().version === initial.version;
function frame() {
  const video = api().getVideo();
  if (video.readyState < 2 || !video.videoWidth) throw new Error('Wait for the camera image.');
  const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
  capture.width = Math.round(video.videoWidth * scale); capture.height = Math.round(video.videoHeight * scale);
  capture.getContext('2d').drawImage(video, 0, 0, capture.width, capture.height);
  return capture.toDataURL('image/jpeg', .8).split(',')[1];
}
function controls() {
  const c = context(), roster = api().getRoster(), previous = picker.value;
  const key = JSON.stringify([c.groupId, roster.map(s => [s.id,s.name])]);
  if (picker.dataset.roster !== key) {
    picker.replaceChildren(new Option('Select a student', ''), ...roster.map(s => new Option(s.name, s.id)));
    if (roster.some(s => String(s.id) === previous) && activeGroup === c.groupId) picker.value = previous;
    picker.dataset.roster = key;
  }
  if (activeGroup !== c.groupId) { activeGroup = c.groupId; consent.checked = false; }
  enroll.disabled = busy || enrolling || c.mode !== 'live' || !c.teacher || !c.groupId || !picker.value || !consent.checked;
  clear.disabled = busy || enrolling || !c.teacher || !c.groupId;
  picker.disabled = enrolling || !c.teacher || !c.groupId;
}
async function detect(token) {
  const initial = context();
  if (token !== generation || initial.mode !== 'live') return;
  if (!initial.teacher || !initial.groupId) { status.textContent = 'Connect a teacher session and choose a course to enable face matching.'; schedule(token); return; }
  if (busy || enrolling) { schedule(token); return; }
  busy = true; controls();
  let failed = false, retryDelay = 650;
  try {
    const result = await api().faceRequest(initial.groupId, 'detect', { image: frame() });
    if (!current(token, initial)) return;
    api().recognize(result.matches.map(match => ({ ...match, suggestion: true })), { trustedServer: true, groupId: initial.groupId, version: initial.version });
    const temporaryRegistrations = Object.values(result.sampleCounts).filter(count => count > 0 && count < 5).length;
    const registeredReferences = Number.isFinite(result.registeredReferences) ? result.registeredReferences : Object.values(result.sampleCounts).filter(count => count >= 5).length;
    status.textContent = `${registeredReferences} saved reference faces · ${temporaryRegistrations} temporary registrations · saved SFace matches above 0.55 save attendance automatically; temporary samples require manual check-in.`;
  } catch (error) {
    failed = error.code === 'face_service_unavailable';
    retryDelay = 2500;
    if (current(token, initial)) { api().recognize([]); status.textContent = error.message + (failed ? ' Stop and start the camera after fixing setup.' : ' Retrying shortly…'); }
  } finally { busy = false; controls(); if ((!failed || !current(token, initial)) && token === generation) schedule(token, retryDelay); }
}
function schedule(token, delay = 650) { clearTimeout(timer); timer = setTimeout(() => detect(token), delay); }
document.addEventListener('presence:camera-start', () => { const token = ++generation; status.textContent = 'Connecting to local face service…'; controls(); detect(token); });
document.addEventListener('presence:camera-stop', () => { generation++; clearTimeout(timer); controls(); });
enroll.addEventListener('click', async () => {
  controls(); if (enroll.disabled) return;
  const initial = context(), token = generation, personId = picker.value;
  enrolling = true; controls();
  try {
    for (let sample = 0; sample < 5; sample++) {
      if (!current(token, initial)) return;
      status.textContent = `Capturing sample ${sample + 1}/5 · keep one face visible and move slightly.`;
      const result = await api().faceRequest(initial.groupId, 'enroll', { personId, image: frame() });
      if (!current(token, initial)) return;
      status.textContent = result.ready ? 'Face registered. Review the suggested match, then confirm attendance.' : `${result.sampleCount}/5 samples saved. Keep moving slightly.`;
      if (sample < 4) await new Promise(resolve => setTimeout(resolve, 800));
    }
    consent.checked = false;
  } catch (error) { if (current(token, initial)) status.textContent = error.message; }
  finally { enrolling = false; controls(); if (token === generation) schedule(token); }
});
clear.addEventListener('click', async () => {
  controls(); if (clear.disabled) return;
  const initial = context(); busy = true; controls();
  try {
    await api().faceRequest(initial.groupId, 'clear', {});
    if (context().groupId === initial.groupId) { api().recognize([]); status.textContent = 'Course face samples cleared.'; }
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; controls(); }
});
consent.addEventListener('change', controls); picker.addEventListener('change', controls);
setInterval(controls, 1000); controls();
