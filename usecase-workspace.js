"use strict";

const root = document.documentElement;
const readAppearance = key => { try { return localStorage.getItem(key); } catch { return null; } };
const saveAppearance = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
function applyAppearance() {
  const university = readAppearance('presence-university');
  const theme = readAppearance('presence-theme');
  root.dataset.university = ['ucf', 'fullsail'].includes(university) ? university : 'ucf';
  root.dataset.theme = ['light', 'dark'].includes(theme) ? theme : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.querySelectorAll('.uni-switch button[data-uni]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.uni === root.dataset.university)));
  const themeButton = document.getElementById('theme-btn');
  if (themeButton) { themeButton.setAttribute('aria-pressed', String(root.dataset.theme === 'dark')); themeButton.setAttribute('aria-label', root.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode'); }
}
document.querySelectorAll('.uni-switch button[data-uni]').forEach(button => button.addEventListener('click', () => { saveAppearance('presence-university', button.dataset.uni); applyAppearance(); }));
document.getElementById('theme-btn')?.addEventListener('click', () => { saveAppearance('presence-theme', root.dataset.theme === 'dark' ? 'light' : 'dark'); applyAppearance(); });
window.addEventListener('storage', applyAppearance);
applyAppearance();


const video = document.getElementById('workspace-video');
const start = document.getElementById('start-camera');
const stop = document.getElementById('stop-camera');
const cameraSelect = document.getElementById('camera-select');
const cameraSelectStatus = document.getElementById('camera-select-status');
async function listCameras() {
 if (!cameraSelect || !navigator.mediaDevices?.enumerateDevices) return;
 try {
  const selected = cameraSelect.value;
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
  const options = cameras.map((device, index) => {
   const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Camera ${index + 1}`; return option;
  });
  const fallback = document.createElement('option'); fallback.value = ''; fallback.textContent = 'Default camera';
  cameraSelect.replaceChildren(fallback, ...options);
  cameraSelect.value = cameras.some(device => device.deviceId === selected) ? selected : '';
  cameraSelectStatus.textContent = cameras.length ? 'Choose a camera. Switching restarts the live preview.' : 'No cameras found. Check camera permissions.';
 } catch { cameraSelectStatus.textContent = 'Camera list unavailable. Check browser permissions.'; }
}
navigator.mediaDevices?.addEventListener?.('devicechange', listCameras);
cameraSelect?.addEventListener('change', () => { if (stream) { stopCamera(); start.click(); } });
listCameras();
let stream;
let cameraGeneration = 0;
function stopCamera() {
 cameraGeneration++;
 stream?.getTracks().forEach(track => track.stop()); stream = null;
 video.srcObject = null; delete video.dataset.active;
 start.disabled = false; stop.disabled = true;
 document.getElementById('camera-state-text').textContent = 'Camera off';
 window.dispatchEvent(new CustomEvent('workspace:camera-stop'));
}
start.addEventListener('click', async () => {
 const generation = ++cameraGeneration;
 start.disabled = true;
 stop.disabled = false;
 try {
  const requestedStream = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},...(cameraSelect?.value ? {deviceId:{exact:cameraSelect.value}} : {})},audio:false});
  if (generation !== cameraGeneration) { requestedStream.getTracks().forEach(track => track.stop()); return; }
  stream = requestedStream;
  await listCameras();
  if (generation !== cameraGeneration) return;
  stream.getTracks().forEach(track => track.addEventListener('ended', stopCamera, {once:true}));
  video.srcObject = stream; video.dataset.active = 'true'; stop.disabled = false;
  document.getElementById('camera-state-text').textContent = document.body.classList.contains('criminal-page') ? 'Camera on · Subject Finder' : document.body.dataset.subjectsApp === 'parent-child' ? 'Camera on · Subject recognition' : 'Camera on · Preview only';
  window.dispatchEvent(new CustomEvent('workspace:camera-start', {detail:{video}}));
 } catch (error) {
  if (generation !== cameraGeneration) return;
  start.disabled = false; stop.disabled = true;
  document.getElementById('camera-state-text').textContent = error?.name === 'NotFoundError' ? 'No camera detected. Try Chrome or Edge and check your webcam connection.' : error?.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access for this site in Chrome or Edge.' : error?.name === 'NotReadableError' ? 'Camera is busy. Close other camera apps and retry.' : 'Camera unavailable. Try Chrome or Edge with camera permission enabled.';
  window.dispatchEvent(new CustomEvent('workspace:camera-error', {detail:{message:document.getElementById('camera-state-text').textContent}}));
 }
});
stop.addEventListener('click', stopCamera);
window.addEventListener('pagehide', stopCamera);
document.getElementById('workspace-search')?.addEventListener('input', event => {
 const query = event.target.value.trim().toLowerCase();
 document.querySelectorAll('#workspace-records .student').forEach(row => row.hidden = !row.textContent.toLowerCase().includes(query));
});
document.querySelectorAll('.pickup-confirm').forEach(button => button.addEventListener('click', () => {
 button.textContent = 'Confirmed'; button.disabled = true;
 document.getElementById('workspace-status').textContent = button.closest('.student').querySelector('.student__name').textContent + ': sample pickup confirmed.';
}));
