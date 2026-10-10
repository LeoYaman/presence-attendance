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

const loginDialog = document.getElementById('login-dialog');
let selectedLoginRole = 'Professor';
document.querySelectorAll('[data-login-role]').forEach(button => {
  button.addEventListener('click', async () => {
    selectedLoginRole = button.dataset.loginRole;
    if (window.location.hostname.endsWith('.proxy.runpod.net')) {
      const destinations = { Professor: '/index.html', Student: '/student.html?demo=1', Faculty: '/parent-child.html', Security: '/criminal-detection.html' };
      const destination = destinations[selectedLoginRole];
      if (!destination) return;
      button.disabled = true;
      try {
        const response = await fetch('/api/presentation-login', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const result = await response.json();
        if (!response.ok || result?.user?.role !== 'teacher') throw new Error(result?.error?.message || 'Demo workspace unavailable.');
        window.location.assign(destination);
      } catch (error) {
        window.alert(error.message || 'Demo workspace unavailable. Please try again.');
        button.disabled = false;
      }
      return;
    }
    document.getElementById('login-title').textContent = `${selectedLoginRole} Sign In`;
    document.getElementById('login-form').reset();
    document.querySelector('#login-form button[type="submit"]').disabled = false;
    document.getElementById('password').type = 'password';
    document.getElementById('show-password').textContent = 'Show';
    document.getElementById('show-password').setAttribute('aria-pressed', 'false');
    document.getElementById('show-password').setAttribute('aria-label', 'Show password');
    document.getElementById('login-status').hidden = true;
    loginDialog.showModal();
    document.getElementById('email').focus();
  });
});
document.querySelector('.login-close').addEventListener('click', () => loginDialog.close());

const form = document.getElementById("login-form");
const email = document.getElementById("email");
const password = document.getElementById("password");
const showPassword = document.getElementById("show-password");
const status = document.getElementById("login-status");
const submitButton = form.querySelector('button[type="submit"]');

showPassword.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  showPassword.textContent = show ? "Hide" : "Show";
  showPassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  showPassword.setAttribute("aria-pressed", String(show));
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  status.hidden = false;
  status.textContent = "Signing in…";
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.value.trim(), password: password.value })
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result?.error?.message || "Sign-in failed. Check your email and password.");
    }

    const workspaces = {
      Professor: { roles: ['teacher'], path: '/index.html' },
      Student: { roles: ['student'], path: '/student.html' },
      Faculty: { roles: ['teacher', 'admin'], path: '/parent-child.html' },
      Security: { roles: ['teacher', 'admin'], path: '/criminal-detection.html' }
    };
    const workspace = workspaces[selectedLoginRole];
    const serverRole = result?.user?.role;
    if (!workspace || !workspace.roles.includes(serverRole)) {
      const roleName = typeof serverRole === 'string' ? serverRole : 'unknown';
      status.textContent = `You are signed in as ${roleName}, but that account cannot access the ${selectedLoginRole} workspace. Your session is active.`;
      submitButton.disabled = false;
      return;
    }
    window.location.assign(workspace.path);
  } catch (error) {
    status.textContent = error instanceof TypeError
      ? "Unable to reach the sign-in service. Please try again."
      : error.message || "Sign-in failed. Please try again.";
    submitButton.disabled = false;
  }
});
