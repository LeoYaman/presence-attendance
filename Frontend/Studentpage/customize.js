"use strict";

// Prototype adapter: maps requests to curated themes instead of calling an AI API.
// Keep this single slot when integrating account-based storage later.
(() => {
  const storageKey = "presence.student.savedDesign";
  const themeNames = { default: "Presence", minecraft: "Minecraft", cyberpunk: "Cyberpunk", ocean: "Ocean", lavender: "Lavender" };
  const dialog = document.getElementById("customizer");
  const input = document.getElementById("theme-prompt");
  const messages = document.getElementById("theme-messages");
  const state = document.getElementById("theme-state");
  const save = document.getElementById("save-theme");
  let currentTheme = "default";
  let previousTheme = currentTheme;
  let draftTheme = null;
  let savedTheme = null;
  let storageUnavailable = false;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    currentTheme = theme;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.version === 1 && Object.hasOwn(themeNames, saved.theme)) {
      savedTheme = saved.theme;
      applyTheme(savedTheme);
    }
  } catch { storageUnavailable = true; }

  function addMessage(text, role) {
    const message = document.createElement("p");
    message.className = `message ${role}`;
    message.textContent = text;
    messages.append(message);
    // Keep the temporary conversation bounded; no chat history is persisted.
    while (messages.children.length > 24) messages.firstElementChild.remove();
    messages.scrollTop = messages.scrollHeight;
  }
  function preview(theme) {
    draftTheme = theme;
    applyTheme(theme);
    save.disabled = false;
    state.textContent = `Previewing ${themeNames[theme]} · Not saved yet`;
  }
  function requestTheme(prompt) {
    addMessage(prompt, "user");
    const request = prompt.toLowerCase();
    const theme = /minecraft|block|pixel/.test(request) ? "minecraft"
      : /cyberpunk|neon|futur/.test(request) ? "cyberpunk"
      : /ocean|sea|blue/.test(request) ? "ocean"
      : /lavender|purple|pastel/.test(request) ? "lavender"
      : /default|original|presence|reset/.test(request) ? "default" : null;
    if (theme) {
      preview(theme);
      addMessage(`Here's a ${themeNames[theme]} preview. Check the page behind this panel. Try another idea or save it to replace your saved design.`, "assistant");
    } else {
      addMessage("This demo can preview Minecraft, cyberpunk, ocean, lavender, or the default theme. Pick one or include its name in your request. Custom AI-generated designs will need an AI service connection.", "assistant");
    }
  }
  document.getElementById("open-customizer").addEventListener("click", () => {
    previousTheme = currentTheme;
    draftTheme = null;
    save.disabled = true;
    state.textContent = storageUnavailable ? "Browser storage unavailable · You can still preview designs" : savedTheme ? `Saved design: ${themeNames[savedTheme]} · Your next save replaces it` : "One saved design · Unlimited changes";
    dialog.showModal();
    input.focus();
  });
  document.getElementById("close-customizer").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    applyTheme(previousTheme);
    draftTheme = null;
  });
  document.getElementById("theme-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) { input.focus(); return; }
    requestTheme(prompt);
    input.value = "";
    input.focus();
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => requestTheme(button.dataset.prompt)));
  document.getElementById("reset-theme").addEventListener("click", () => {
    preview("default");
    addMessage("Previewing the original Presence design. Save to replace your saved design, or close to discard this preview.", "assistant");
  });
  save.addEventListener("click", () => {
    if (draftTheme === null) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, theme: draftTheme }));
      savedTheme = draftTheme;
      previousTheme = draftTheme;
      storageUnavailable = false;
      state.textContent = `${themeNames[draftTheme]} saved · One design stored`;
      addMessage(`Saved ${themeNames[draftTheme]}. This is your only saved design. You can change it again anytime.`, "assistant");
      save.disabled = true;
    } catch {
      storageUnavailable = true;
      state.textContent = "Could not save: browser storage is unavailable. Your preview is still open.";
    }
  });
})();
