"use strict";
const password = document.getElementById("password");
const showPassword = document.getElementById("show-password");
showPassword.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  showPassword.textContent = show ? "Hide" : "Show";
  showPassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  showPassword.setAttribute("aria-pressed", String(show));
});
document.getElementById("login-form").addEventListener("submit", event => {
  event.preventDefault();
  document.getElementById("login-status").hidden = false;
  document.getElementById("login-status").textContent = "Sign-in is not connected yet. Use the workspace links below to explore the demo.";
});
