"use strict";

/* ==========================================================================
   Customize with AI (prototype)
   Maps the student's request to a preset design instead of calling an AI
   service. Designs are stored as data-skin on <html>; one saved design per
   browser. Keep this single storage slot when moving to account storage.
   ========================================================================== */
(() => {
  const storageKey = "presence.student.savedDesign";
  const STORAGE_VERSION = 2;
  const designNames = { school: "School design", minecraft: "Minecraft", cyberpunk: "Cyberpunk", ocean: "Ocean", lavender: "Lavender" };

  const dialog = document.getElementById("customizer");
  const input = document.getElementById("theme-prompt");
  const messages = document.getElementById("theme-messages");
  const state = document.getElementById("theme-state");
  const save = document.getElementById("save-theme");
  const root = document.documentElement;

  let current = root.dataset.skin || "school";   // applied before first paint by the inline script
  let beforeOpen = current;
  let draft = null;
  let saved = null;
  let storageUnavailable = false;

  try {
    const s = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (s?.version === STORAGE_VERSION && Object.hasOwn(designNames, s.skin)) saved = s.skin;
  } catch { storageUnavailable = true; }

  function apply(design) {
    if (design === "school") delete root.dataset.skin;
    else root.dataset.skin = design;
    current = design;
  }

  function addMessage(text, role) {
    const p = document.createElement("p");
    p.className = `msg msg--${role}`;
    p.textContent = text;
    messages.append(p);
    while (messages.children.length > 24) messages.firstElementChild.remove();   // keep the chat short; nothing is stored
    messages.scrollTop = messages.scrollHeight;
  }

  function preview(design) {
    draft = design;
    apply(design);
    save.disabled = design === saved || (design === "school" && saved === null);
    state.textContent = save.disabled ? `${designNames[design]} · Already saved` : `Previewing ${designNames[design]} · Not saved yet`;
  }

  function request(prompt) {
    addMessage(prompt, "user");
    const r = prompt.toLowerCase();
    const design = /minecraft|block|pixel|grass/.test(r) ? "minecraft"
      : /cyber|neon|futur|synth/.test(r) ? "cyberpunk"
      : /ocean|sea|wave|beach|blue/.test(r) ? "ocean"
      : /lavender|purple|pastel|violet/.test(r) ? "lavender"
      : /default|original|school|ucf|full sail|reset/.test(r) ? "school"
      : null;
    if (design) {
      preview(design);
      addMessage(design === "school"
        ? "Here's your school's design again. Save it to make it your default."
        : `Here's ${designNames[design]}. Look at the page behind this panel, then save it or try something else.`, "assistant");
    } else {
      addMessage("This demo has four designs: Minecraft, Cyberpunk, Ocean, and Lavender. Mention one of those, or ask for the school design. Fully custom designs will need the AI service connected.", "assistant");
    }
  }

  document.getElementById("open-customizer").addEventListener("click", () => {
    beforeOpen = current;
    draft = null;
    save.disabled = true;
    state.textContent = storageUnavailable
      ? "Browser storage isn’t available · You can still preview designs"
      : saved ? `Saved: ${designNames[saved]} · Your next save replaces it`
      : "One saved design · Change it anytime";
    dialog.showModal();
    input.focus();
  });

  document.getElementById("close-customizer").addEventListener("click", () => dialog.close());

  // Closing without saving puts back whatever was showing before
  dialog.addEventListener("close", () => {
    apply(beforeOpen);
    draft = null;
  });

  document.getElementById("theme-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) { input.focus(); return; }
    request(prompt);
    input.value = "";
    input.focus();
  });

  document.querySelectorAll("[data-prompt]").forEach((b) => b.addEventListener("click", () => request(b.dataset.prompt)));

  document.getElementById("reset-theme").addEventListener("click", () => {
    preview("school");
    addMessage("Showing your school's design. Save to make it your default, or close to go back.", "assistant");
  });

  save.addEventListener("click", () => {
    if (draft === null) return;
    try {
      if (draft === "school") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify({ version: STORAGE_VERSION, skin: draft }));
      saved = draft === "school" ? null : draft;
      beforeOpen = draft;
      storageUnavailable = false;
      save.disabled = true;
      state.textContent = `${designNames[draft]} saved · This is your one saved design`;
      addMessage(`Saved ${designNames[draft]}. You can change it again anytime.`, "assistant");
    } catch {
      storageUnavailable = true;
      state.textContent = "Couldn’t save: browser storage isn’t available. Your preview is still showing.";
    }
  });
})();
