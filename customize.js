"use strict";
(() => {
  const root = document.documentElement;
  const dialog = document.getElementById("customizer");
  const state = document.getElementById("theme-state");
  const storageKey = "presence.student.savedDesign";
  const colors = ["school", "ocean", "lavender", "sage", "rose", "peach", "sunshine", "ruby", "tangerine", "gold", "emerald", "cobalt", "violet"];
  const shapes = ["rounded", "soft", "square"];
  let current = { skin: colors.includes(root.dataset.skin) ? root.dataset.skin : "school", bubbles: shapes.includes(root.dataset.bubbles) ? root.dataset.bubbles : "soft" };
  let beforeOpen = { ...current };
  function apply(design) {
    current = { ...design };
    if (current.skin === "school") delete root.dataset.skin;
    else root.dataset.skin = current.skin;
    root.dataset.bubbles = current.bubbles;
    document.querySelectorAll('[name="color-theme"]').forEach(input => input.checked = input.value === current.skin);
    document.querySelectorAll('[name="bubble-style"]').forEach(input => input.checked = input.value === current.bubbles);
  }
  apply(current);
  document.getElementById("open-customizer").addEventListener("click", () => {
    beforeOpen = { ...current };
    state.textContent = "Choose your colors and bubble style.";
    dialog.showModal();
  });
  document.getElementById("close-customizer").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => apply(beforeOpen));
  dialog.querySelectorAll('input[type="radio"]').forEach(input => input.addEventListener("change", () => {
    apply({ ...current, [input.name === "color-theme" ? "skin" : "bubbles"]: input.value });
    state.textContent = "Unsaved changes";
  }));
  document.getElementById("reset-theme").addEventListener("click", () => {
    apply({ skin: "school", bubbles: "soft" });
    state.textContent = "Unsaved changes";
  });
  document.getElementById("save-theme").addEventListener("click", () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 3, ...current }));
      beforeOpen = { ...current };
      state.textContent = "Changes saved";
      dialog.close();
    } catch {
      state.textContent = "Could not save in this browser.";
    }
  });
})();
