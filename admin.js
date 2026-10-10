"use strict";

/* ==========================================================================
   Presence · Admin pages
   - University (UCF / Full Sail) and light/dark, shared with the other views
   - Demo actions (data-action) show what would happen; nothing is saved or sent
   ========================================================================== */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const root = document.documentElement;
  const NAMES = { ucf: "UCF", fullsail: "Full Sail" };
  const store = {
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  function syncThemeColor() {
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue("--nav-bg").trim() || "#000000";
  }
  function setUniversity(key) {
    if (!NAMES[key]) return;
    root.dataset.university = key;
    store.set("presence-university", key);
    $$(".uni-switch button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.uni === key)));
    syncThemeColor();
  }
  function setAppearance(mode) {
    root.dataset.theme = mode;
    store.set("presence-theme", mode);
    const btn = $("#theme-btn");
    btn.setAttribute("aria-pressed", String(mode === "dark"));
    btn.setAttribute("aria-label", mode === "dark" ? "Light mode" : "Dark mode");
    syncThemeColor();
  }

  $$(".uni-switch button").forEach((b) => b.addEventListener("click", () => setUniversity(b.dataset.uni)));
  $(".uni-switch").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const btns = $$(".uni-switch button");
    const i = btns.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const next = btns[(i + 1) % btns.length];
    setUniversity(next.dataset.uni);
    next.focus();
  });
  $("#theme-btn").addEventListener("click", () => setAppearance(root.dataset.theme === "dark" ? "light" : "dark"));

  // Logos: show the file if it's in /assets, otherwise the name as text
  $$("img[data-logo]").forEach((img) => {
    const ok = () => { if (img.naturalWidth) img.closest(".logo__slot").classList.add("has-img"); };
    if (img.complete) ok(); else img.addEventListener("load", ok);
  });

  setUniversity(root.dataset.university || "ucf");
  setAppearance(root.dataset.theme || "light");

  // Keep the current section link visible on narrow screens
  $('.section-nav a[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });

  /* ---------- Demo actions ---------- */
  const notice = $("#toast");
  let timer;
  function notify(text) {
    if (!notice) return;
    $("#toast-text").textContent = text;
    notice.classList.add("is-visible");
    clearTimeout(timer);
    timer = setTimeout(() => notice.classList.remove("is-visible"), 3500);
  }

  const MESSAGES = {
    "test-connection": "Demo only: no test was sent. With the backend connected, this sends a labeled test payload.",
    "save-configuration": "Demo only: the configuration wasn’t saved.",
    "replace-key": "Demo only: enter a replacement key above. Keys will be stored on the server, never in the browser.",
    "remove-key": "Demo only: the saved key wasn’t removed.",
    "save-settings": "Demo only: preferences weren’t saved.",
  };

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "retry-delivery") {
      const cell = btn.closest("tr")?.querySelector(".st");
      if (cell) { cell.className = "st st--neutral"; cell.textContent = "Retry queued (demo)"; }
      btn.disabled = true;
      notify("Demo only: no request was sent.");
      return;
    }
    if (MESSAGES[action]) notify(MESSAGES[action]);
  });

  const enable = $("#integration-enabled");
  enable?.addEventListener("change", () =>
    notify(enable.checked ? "Integration on (demo). Nothing will be sent until the backend is connected." : "Integration off (demo)."));
})();
