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
let stream;
function stopCamera() {
 stream?.getTracks().forEach(track => track.stop()); stream = null;
 video.srcObject = null; delete video.dataset.active;
 start.disabled = false; stop.disabled = true;
 document.getElementById('camera-state-text').textContent = 'Camera off';
}
start.addEventListener('click', async () => {
 start.disabled = true;
 try {
  stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false});
  video.srcObject = stream; video.dataset.active = 'true'; stop.disabled = false;
  document.getElementById('camera-state-text').textContent = 'Camera on · Preview only';
 } catch {
  start.disabled = false;
  document.getElementById('camera-state-text').textContent = 'Camera unavailable. Check browser camera permissions.';
 }
});
stop.addEventListener('click', stopCamera);
window.addEventListener('pagehide', stopCamera);
document.getElementById('workspace-search').addEventListener('input', event => {
 const query = event.target.value.trim().toLowerCase();
 document.querySelectorAll('#workspace-records .student').forEach(row => row.hidden = !row.textContent.toLowerCase().includes(query));
});
document.querySelectorAll('.pickup-confirm').forEach(button => button.addEventListener('click', () => {
 button.textContent = 'Confirmed'; button.disabled = true;
 document.getElementById('workspace-status').textContent = button.closest('.student').querySelector('.student__name').textContent + ': sample pickup confirmed.';
}));
