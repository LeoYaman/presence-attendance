'use strict';
(() => {
 const results = document.getElementById('passenger-results') || (document.body.classList.contains('criminal-page') ? document.getElementById('workspace-records') : null);
 if (!results) return;
 const status = document.getElementById('passenger-status') || document.getElementById('workspace-status');
 const references = document.getElementById('passenger-reference-status');
 const canvas = document.createElement('canvas');
 const context = canvas.getContext('2d');
 const videoElement = document.getElementById('workspace-video');
 const overlay = document.createElement('canvas');
 overlay.id = 'passenger-overlay';
 overlay.setAttribute('aria-hidden', 'true');
 videoElement.parentElement.append(overlay);
 const overlayContext = overlay.getContext('2d');
 let faceBoxes = [];
 function drawBoxes() {
  const bounds = overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(bounds.width * dpr);
  overlay.height = Math.round(bounds.height * dpr);
  if (!overlayContext || !videoElement.videoWidth || !videoElement.videoHeight) return;
  overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scale = Math.max(bounds.width / videoElement.videoWidth, bounds.height / videoElement.videoHeight);
  const frameWidth = videoElement.videoWidth * scale, frameHeight = videoElement.videoHeight * scale;
  for (const match of faceBoxes) {
   const box = match?.box;
   if (!box || !['x','y','width','height'].every(key => Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1) || !box.width || !box.height) continue;
   const width = box.width * frameWidth, height = box.height * frameHeight;
   // The preview uses mirrored object-fit:cover; the backend coordinates do not.
   const x = bounds.width - (box.x * frameWidth + (bounds.width - frameWidth) / 2) - width;
   const y = box.y * frameHeight + (bounds.height - frameHeight) / 2;
   const passenger = match.identityMatched === true ? roster.get(String(match.passengerId)) : null;
   overlayContext.strokeStyle = passenger ? '#30d158' : '#ff9f0a';
   overlayContext.lineWidth = 2;
   overlayContext.strokeRect(x, y, width, height);
   const label = passenger ? `${passenger.name} · Passenger` : 'Unknown face';
   overlayContext.font = '600 16px Arial, sans-serif';
   const labelWidth = Math.min(bounds.width, overlayContext.measureText(label).width + 12);
   const labelX = Math.max(0, Math.min(x, bounds.width - labelWidth));
   const labelY = Math.max(0, Math.min(y + height + 4, bounds.height - 26));
   overlayContext.fillStyle = '#152019e6';
   overlayContext.fillRect(labelX, labelY, labelWidth, 24);
   overlayContext.fillStyle = '#fff';
   overlayContext.fillText(label, labelX + 6, labelY + 17, Math.max(1, labelWidth - 12));
  }
 }
 function clearBoxes() { faceBoxes = []; drawBoxes(); }
 new ResizeObserver(drawBoxes).observe(videoElement.parentElement);
 let generation = 0;
 let timer;
 let controller;
 let activeVideo;
 let csrf = '';
 let roster = new Map();
 let lastRender = '';

 function empty(message) {
  if (lastRender === message) return;
  const item = document.createElement('li');
  item.className = 'usecase-empty'; item.textContent = message;
  results.replaceChildren(item); lastRender = message;
 }
 function invalidate() {
  generation++;
  clearBoxes();
  clearTimeout(timer);
  controller?.abort(); controller = null;
 }
 async function request(path, body, token) {
  const localController = new AbortController();
  controller = localController;
  const timeout = setTimeout(() => localController.abort(), 15000);
  try {
   const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', signal: localController.signal,
    ...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json', 'X-CSRF-Token':csrf}, body:JSON.stringify(body)})
   });
   if (token !== generation) throw new Error('Stale request');
   const payload = await response.json();
   if (token !== generation) throw new Error('Stale request');
   if (!response.ok) throw Object.assign(new Error(payload.error?.message || `Request failed (${response.status}).`), {status:response.status});
   return payload;
  } finally {
   clearTimeout(timeout);
   if (controller === localController) controller = null;
  }
 }
 async function initialize(token) {
  const session = await request('/api/me', undefined, token);
  if (token !== generation) return;
  if (!session.user || typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Sign in to recognize passengers.');
  csrf = session.csrfToken;
  const payload = await request('/api/passengers', undefined, token);
  if (token !== generation) return;
  if (!Array.isArray(payload.passengers)) throw new Error('Passenger roster is unavailable.');
  const nextRoster = new Map();
  for (const passenger of payload.passengers) {
   if (!passenger || !['string','number'].includes(typeof passenger.id) || !String(passenger.id) || typeof passenger.name !== 'string' || !passenger.name.trim() || passenger.role !== 'passenger' || nextRoster.has(String(passenger.id))) throw new Error('Passenger roster is invalid.');
   nextRoster.set(String(passenger.id), passenger);
  }
  roster = nextRoster;
  references.textContent = roster.size ? `Enrolled passengers: ${[...roster.values()].map(passenger => passenger.name).join(', ')}. Reference readiness is checked during detection.` : 'No passengers are enrolled.';
 }
 function render(payload) {
  if (!Array.isArray(payload.matches)) throw new Error('Recognition returned an invalid response.');
  faceBoxes = payload.matches; drawBoxes();
  const matches = payload.matches.filter(match => match && match.identityMatched === true && match.passengerId != null && match.role === 'passenger' && roster.has(String(match.passengerId)) && Number.isFinite(match.similarity));
  const unique = new Map();
  for (const match of matches) {
   const key = String(match.passengerId);
   if (!unique.has(key) || match.similarity > unique.get(key).similarity) unique.set(key, match);
  }
  if (!unique.size) {
   const unknownFace = payload.matches.some(match => match && match.box);
   empty(unknownFace ? 'Unknown face' : 'No face detected.');
   status.textContent = unknownFace ? 'Recognition active · Unknown face.' : 'Recognition active · No face detected.';
  } else {
   const key = JSON.stringify([...unique.values()].map(match => [match.passengerId, match.similarity.toFixed(2)]));
   if (key !== lastRender) {
    const rows = [...unique.values()].map(match => {
     const row = document.createElement('li'); row.className = 'student';
     const text = document.createElement('span'); text.className = 'student__info';
     const name = document.createElement('span'); name.className = 'student__name'; name.textContent = roster.get(String(match.passengerId)).name;
     const role = document.createElement('span'); role.className = 'student__meta'; role.textContent = 'Passenger';
     const score = document.createElement('span'); score.className = 'student__meta'; score.textContent = `Face similarity: ${match.similarity.toFixed(2)}`;
     text.append(name, role, score); row.append(text); return row;
    });
    const search = document.getElementById('workspace-search')?.value.trim().toLowerCase() || '';
    rows.forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(search); });
    results.replaceChildren(...rows); lastRender = key;
   }
   status.textContent = `Recognition active · ${unique.size} passenger${unique.size === 1 ? '' : 's'} matched.`;
  }
  if (Number.isInteger(payload.registeredReferences)) references.textContent = `${payload.registeredReferences} registered face reference${payload.registeredReferences === 1 ? '' : 's'} · ${[...roster.values()].map(passenger => passenger.name).join(', ')}.`;
 }
 async function capture(token) {
  if (token !== generation || !activeVideo) return;
  const video = activeVideo;
  try {
   if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    status.textContent = 'Waiting for camera frames…';
   } else {
    const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    if (!context) throw new Error('Browser image capture is unavailable.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    if (!image || image.length > 350000) throw new Error('Camera frame exceeds the upload limit.');
    const payload = await request('/api/passengers/detect', {image}, token);
    if (token !== generation) return;
    render(payload);
   }
  } catch (error) {
   if (token !== generation) return;
   clearBoxes();
   empty('Passenger recognition unavailable. No current matches.');
   status.textContent = error.status === 401 || error.status === 403 ? 'Session unavailable. Sign in, then restart the camera.' : `Recognition unavailable: ${error.name === 'AbortError' ? 'Request timed out.' : error.message}`;
   if (error.status === 401 || error.status === 403) return;
  }
  if (token === generation && activeVideo) timer = setTimeout(() => capture(token), 300);
 }
 window.addEventListener('workspace:camera-start', async event => {
  invalidate(); activeVideo = event.detail.video;
  const token = generation;
  empty('Preparing passenger recognition…'); status.textContent = 'Connecting passenger recognition…';
  try {
   await initialize(token);
   if (token === generation) capture(token);
  } catch (error) {
   if (token !== generation) return;
   clearBoxes();
   empty('Passenger recognition unavailable. No current matches.');
   status.textContent = error.status === 401 ? 'Sign in, then restart the camera.' : `Recognition unavailable: ${error.name === 'AbortError' ? 'Request timed out.' : error.message}`;
  }
 });
 function stopRecognition() {
  invalidate(); activeVideo = null;
  empty('Camera stopped. No current passenger matches.'); status.textContent = 'Camera off · Recognition stopped.';
 }
 window.addEventListener('workspace:camera-stop', stopRecognition);
 window.addEventListener('pagehide', stopRecognition);
 const startup = generation;
 initialize(startup).then(() => {
  if (startup === generation) status.textContent = 'Ready · Start the camera to recognize passengers.';
 }).catch(error => {
  if (startup !== generation) return;
  status.textContent = error.status === 401 ? 'Sign in to recognize passengers.' : `Recognition setup unavailable: ${error.name === 'AbortError' ? 'Request timed out.' : error.message}`;
  references.textContent = 'Passenger roster unavailable.';
 });
})();
