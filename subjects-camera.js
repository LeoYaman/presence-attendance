(() => {
// Shared, API-backed subject roster and live recognition for the three workspaces.
// The camera stream is owned by each page's existing camera controller.
const app = document.body.dataset.subjectsApp || (document.body.classList.contains('criminal-page') ? 'subject-finder' : document.body.classList.contains('parent-child-page') ? 'parent-child' : 'attendance');
const video = document.getElementById('workspace-video') || document.getElementById('camera-video');
const host = document.querySelector('.camera-col');
if (host && video) {
  const panel = document.createElement('section');
  panel.className = 'match subjects-panel';
  panel.setAttribute('aria-labelledby', 'subjects-title');
  panel.innerHTML = '<section aria-labelledby="subjects-title"><h2 class="match__name" id="subjects-title">Registered subjects</h2><p class="match__note" id="subjects-status" role="status">Loading registered subjects…</p><ul id="subjects-list" class="students" aria-label="Registered subjects"></ul></section><section aria-labelledby="subject-result-title"><h2 class="match__name" id="subject-result-title">Recognition result</h2><p class="match__name" id="subjects-match" aria-live="polite">No identity match</p><p class="match__note" id="subjects-match-note">A camera match will appear here after server verification.</p></section>';
  if (app !== 'parent-child') host.append(panel);
  const status = panel.querySelector('#subjects-status');
  const list = panel.querySelector('#subjects-list');
  const match = panel.querySelector('#subjects-match');
  const matchNote = panel.querySelector('#subjects-match-note');
  const alert = document.createElement('aside');
  alert.id = 'subjects-detection-alert';
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');
  alert.setAttribute('aria-atomic', 'true');
  alert.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100000;width:min(620px,calc(100vw - 32px));box-sizing:border-box;display:none;flex-direction:column;gap:6px;padding:20px 24px;border:3px solid #a44700;border-radius:14px;background:#fff1bd;color:#19130b;box-shadow:0 12px 38px rgba(0,0,0,.32);font-family:Arial,sans-serif;text-align:center;';
  const alertLabel = document.createElement('span');
  alertLabel.textContent = 'REGISTERED SUBJECT DETECTED';
  alertLabel.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:.12em;';
  const alertMessage = document.createElement('strong');
  alertMessage.id = 'subjects-detection-alert-message';
  alertMessage.style.cssText = 'font-size:clamp(24px,4vw,34px);line-height:1.2;';
  alert.append(alertLabel, alertMessage);
  alert.hidden = true;
  document.body.append(alert);
  let visibleMatch, visibleNote;
  if (app === 'parent-child') {
    const banner = document.createElement('section');
    banner.className = 'match subjects-panel subjects-live-banner';
    banner.setAttribute('aria-label', 'Live subject recognition');
    visibleMatch = document.createElement('p');
    visibleMatch.id = 'subjects-live-match'; visibleMatch.className = 'match__name';
    visibleMatch.setAttribute('role', 'status'); visibleMatch.setAttribute('aria-live', 'polite');
    visibleNote = document.createElement('p');
    visibleNote.id = 'subjects-live-note'; visibleNote.className = 'match__note';
    banner.append(visibleMatch, visibleNote);
    host.prepend(banner);
  }
  function updateMatch(message, note) {
    match.textContent = message; matchNote.textContent = note;
    const detected = message.startsWith('Got you, ');
    alert.hidden = !detected;
    alert.style.display = detected ? 'flex' : 'none';
    if (alertMessage.textContent !== (detected ? message : '')) alertMessage.textContent = detected ? message : '';
    if (visibleMatch) { visibleMatch.textContent = message; visibleNote.textContent = note; }
  }
  updateMatch('No identity match', 'Start the camera for server-verified subject recognition.');
  let csrf = '', generation = 0, timer, busy = false, refreshing = false, rosterVersion = -1;
  let pickupApprovalPending = false;
  window.addEventListener('pickup:approval-start', () => { pickupApprovalPending = true; });
  window.addEventListener('pickup:approval-end', () => { pickupApprovalPending = false; });
  let initialized = false, pickupEnabled = false;
  let knownSubjects = new Map(), detectionController = null, lastMatchedSubjects = [];
  const cameraFigure = app === 'parent-child' ? document.querySelector('figure.camera') : null;
  const overlay = cameraFigure ? document.createElement('canvas') : null;
  let overlayMatches = [];
  if (overlay) {
    overlay.className = 'subjects-face-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.pointerEvents = 'none';
    cameraFigure.append(overlay);
  }
  function validBox(box) {
    return box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
      && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
      && box.x + box.width <= 1 && box.y + box.height <= 1;
  }
  function drawOverlay() {
    if (!overlay) return;
    const width = cameraFigure.clientWidth, height = cameraFigure.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    overlay.width = Math.round(width * ratio); overlay.height = Math.round(height * ratio);
    const context = overlay.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!width || !height || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const contentWidth = video.videoWidth * scale, contentHeight = video.videoHeight * scale;
    const left = (width - contentWidth) / 2, top = (height - contentHeight) / 2;
    const transform = window.getComputedStyle(video).transform;
    const mirrored = transform === 'scaleX(-1)' || /^matrix(?:3d)?\(\s*-/.test(transform);
    context.strokeStyle = '#22c55e'; context.lineWidth = 3;
    for (const item of overlayMatches) {
      if (!knownSubjects.has(String(item.subjectId)) || knownSubjects.get(String(item.subjectId)) !== item.name) continue;
      const box = item.box;
      const x = mirrored ? 1 - box.x - box.width : box.x;
      context.strokeRect(left + x * contentWidth, top + box.y * contentHeight, box.width * contentWidth, box.height * contentHeight);
    }
  }
  function clearOverlay() { overlayMatches = []; drawOverlay(); }
  if (overlay) {
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(drawOverlay) : null;
    observer?.observe(cameraFigure);
    window.addEventListener('resize', drawOverlay);
    video.addEventListener('loadedmetadata', drawOverlay);
    window.addEventListener('pagehide', () => {
      generation++; clearTimeout(timer); detectionController?.abort();
      observer?.disconnect(); clearOverlay();
    });
  }
  const presence = () => window.Presence;
  const pageContext = () => app === 'attendance' ? presence()?.getContext?.() : null;
  async function request(path, body, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let response;
    try { response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) })
    }); } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status}).`);
    return payload;
  }
  function renderSubjects(subjects) {
    list.replaceChildren();
    knownSubjects = new Map(subjects.filter(subject => subject && subject.id !== undefined && subject.id !== null && typeof subject.name === 'string').map(subject => [String(subject.id), subject.name]));
    if (lastMatchedSubjects.some(subject => knownSubjects.get(subject.id) !== subject.name)) {
      lastMatchedSubjects = []; clearOverlay(); updateMatch('No identity match', 'The matched subject is no longer in the registered list.');
    }
    if (!subjects.length) {
      const empty = document.createElement('li'); empty.className = 'usecase-empty'; empty.textContent = 'No registered subjects are available.'; list.append(empty); return;
    }
    for (const subject of subjects) {
      const item = document.createElement('li'); item.className = 'student';
      const info = document.createElement('span'); info.className = 'student__info';
      const name = document.createElement('span'); name.className = 'student__name'; name.textContent = subject.name;
      const meta = document.createElement('span'); meta.className = 'student__meta';
      meta.textContent = `${Number(subject.referenceCount) || 0} enrolled reference${Number(subject.referenceCount) === 1 ? '' : 's'}`;
      info.append(name, meta); item.append(info); list.append(item);
    }
  }
  async function refreshSubjects() {
    if (refreshing) return;
    refreshing = true;
    try {
      const data = await request(`/api/subjects?app=${encodeURIComponent(app)}`);
      if (Number.isInteger(data.version) && data.version !== rosterVersion) {
        rosterVersion = data.version; renderSubjects(Array.isArray(data.subjects) ? data.subjects : []);
      }
      status.textContent = `Registered subjects · version ${data.version}`;
    } catch (error) { status.textContent = error.message; }
    finally { refreshing = false; }
  }
  function imageFrame() {
    if (video.readyState < 2 || !video.videoWidth) throw new Error('Wait for a camera image.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    const draw = () => canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const encode = () => canvas.toDataURL('image/jpeg', .78).split(',')[1];
    draw();
    let image = encode();
    for (const quality of [.65, .5]) {
      if (image.length <= 350000) break;
      image = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    }
    while (image.length > 350000 && canvas.width > 320 && canvas.height > 240) {
      canvas.width = Math.max(320, Math.round(canvas.width * .8));
      canvas.height = Math.max(240, Math.round(canvas.height * .8));
      draw();
      image = canvas.toDataURL('image/jpeg', .5).split(',')[1];
    }
    if (image.length > 350000) throw new Error('Camera image is too large to send. Try a lower camera resolution.');
    return { image, width: canvas.width, height: canvas.height };
  }
  function showMatch(result, frame) {
    const valid = Array.isArray(result.matches) ? result.matches : [];
    const verified = [...new Map(valid.filter(item => item && item.identityMatched === true && item.subjectId !== undefined && item.subjectId !== null && knownSubjects.has(String(item.subjectId)) && knownSubjects.get(String(item.subjectId)) === item.name).map(item => [String(item.subjectId), item])).values()];
    overlayMatches = verified.filter(item => validBox(item.box)).map(item => ({ subjectId: item.subjectId, name: item.name, box: { ...item.box } }));
    drawOverlay();
    if (verified.length) {
      lastMatchedSubjects = verified.map(item => ({id: String(item.subjectId), name: item.name}));
      updateMatch(`Got you, ${verified.map(item => item.name).join(', ')}`, 'Identity matched to a registered subject by the server. This does not verify any relationship or authorization.');
    } else {
      lastMatchedSubjects = [];
      const tooSmall = valid.some(item => item?.box && frame && (item.box.width * frame.width < 80 || item.box.height * frame.height < 80));
      const note = Number(result.registeredReferences) === 0 ? 'No face references are enrolled for this app yet.'
        : tooSmall ? 'Move closer to the camera so your face is at least 80 pixels wide and high.'
        : valid.length ? 'A face was detected, but it did not match a known subject.' : 'No registered subject was identified.';
      updateMatch('No identity match', note);
    }
  }
  async function detect(token) {
    if (token !== generation) return;
    if (!initialized) { schedule(token, 250); return; }
    if (busy || pickupApprovalPending) { schedule(token, 250); return; }
    if (video.readyState < 2) { schedule(token, 250); return; }
    const context = pageContext();
    const groupId = app === 'attendance' ? context?.groupId : undefined;
    const contextVersion = app === 'attendance' ? context?.version : undefined;
    if (app === 'attendance' && (!context?.teacher || !groupId)) { status.textContent = 'Choose a course to enable subject recognition.'; schedule(token, 1200); return; }
    busy = true;
    const controller = new AbortController(); detectionController = controller;
    try {
      const frame = imageFrame();
      const pickup = app === 'parent-child' && pickupEnabled;
      const data = await request('/api/subjects/detect',
        { image: frame.image, app, ...(groupId ? { groupId } : {}) }, controller.signal);
      if (!data || !Array.isArray(data.matches)) throw new Error('Recognition service returned an invalid response.');
      if (token !== generation) return;
      const latest = pageContext();
      if (app === 'attendance' && (latest?.groupId !== groupId || latest?.version !== contextVersion)) { schedule(token, 0); return; }
      showMatch(data, frame);
      let pickupDecision = null;
      if (pickup) {
        try { pickupDecision = await request('/api/pickup-demo/decide', {image:frame.image}, controller.signal); }
        catch (error) {
          if (token === generation) window.dispatchEvent(new CustomEvent('subjects:pickup-error', {detail:{message:error.message}}));
        }
        if (token !== generation) return;
      }
      if (app === 'parent-child' && (!pickup || pickupDecision)) window.dispatchEvent(new CustomEvent('subjects:recognition', {detail:{app,result:pickupDecision?.recognition??data,...(pickupDecision ? {pickupDecision} : {})}}));
      if (Number.isInteger(data.version) && data.version !== rosterVersion) await refreshSubjects();
      schedule(token, app === 'parent-child' ? 200 : 1500);
    } catch (error) {
      if (token === generation) { lastMatchedSubjects = []; clearOverlay(); updateMatch('Recognition unavailable', error.message); if(app==='parent-child')window.dispatchEvent(new CustomEvent('subjects:recognition-error')); schedule(token, 3000); }
    } finally { if (detectionController === controller) detectionController = null; busy = false; }
  }
  function schedule(token, delay) { clearTimeout(timer); timer = setTimeout(() => detect(token), delay); }
  async function initialize() {
    try {
      const session = await request('/api/me');
      if (!session.user || !['teacher', 'admin'].includes(session.user.role) || typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Sign in with an authorized teacher or admin account to view subjects.');
      csrf = session.csrfToken;
      if (app === 'parent-child') pickupEnabled = (await request('/api/pickup-demo')).enabled === true;
      await refreshSubjects();
      initialized = true;
      setInterval(refreshSubjects, 5000);
    } catch (error) { status.textContent = error.message; updateMatch('Recognition unavailable', error.message); }
  }
  const cameraEvents = app === 'attendance' ? document : window;
  cameraEvents.addEventListener(app === 'attendance' ? 'presence:camera-start' : 'workspace:camera-start', () => {
    generation++; const token = generation; lastMatchedSubjects = []; clearOverlay(); updateMatch('Checking identity…', 'Waiting for a server-verified match.'); detect(token);
  });
  cameraEvents.addEventListener(app === 'attendance' ? 'presence:camera-stop' : 'workspace:camera-stop', () => {
    generation++; clearTimeout(timer); detectionController?.abort(); lastMatchedSubjects = []; clearOverlay(); updateMatch('No identity match', 'Camera is off.');
  });
  if (app === 'parent-child') window.addEventListener('workspace:camera-error', event => {
    generation++; clearTimeout(timer); detectionController?.abort(); lastMatchedSubjects = []; clearOverlay();
    updateMatch('Camera unavailable', typeof event.detail?.message === 'string' ? event.detail.message : 'Check camera access and retry.');
  });
  void initialize();
}
})();
