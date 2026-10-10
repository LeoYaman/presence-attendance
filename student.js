"use strict";

/* Presence: server identity, saved attendance and class policies are authoritative. */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const root = document.documentElement;
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
const UNIVERSITIES = { ucf: { name: "UCF" }, fullsail: { name: "Full Sail" } };
function syncThemeColor() {
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--nav-bg").trim() || "#000000";
}
function setUniversity(key) {
  if (!UNIVERSITIES[key]) return;
  root.dataset.university = key;
  store.set("presence-university", key);
  $$(".uni-switch button").forEach(button => button.setAttribute("aria-checked", String(button.dataset.uni === key)));
  document.title = `My Attendance · ${UNIVERSITIES[key].name} · Presence`;
  syncThemeColor();
}
function setAppearance(mode) {
  root.dataset.theme = mode;
  store.set("presence-theme", mode);
  $("#theme-btn").setAttribute("aria-pressed", String(mode === "dark"));
  $("#theme-btn").setAttribute("aria-label", mode === "dark" ? "Light mode" : "Dark mode");
  syncThemeColor();
}
try {
  const design = JSON.parse(store.get("presence.student.savedDesign") || "null");
  const colors = ["ocean", "lavender", "sage", "rose", "peach", "sunshine", "ruby", "tangerine", "gold", "emerald", "cobalt", "violet"];
  if (design && [2, 3].includes(design.version) && colors.includes(design.skin)) root.dataset.skin = design.skin;
  if (design?.version === 3 && ["rounded", "soft", "square"].includes(design.bubbles)) root.dataset.bubbles = design.bubbles;
} catch {}
setUniversity(store.get("presence-university") || root.dataset.university || "ucf");
setAppearance(store.get("presence-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$$(".uni-switch button").forEach(button => button.addEventListener("click", () => setUniversity(button.dataset.uni)));
$(".uni-switch").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const buttons = $$(".uni-switch button"), next = buttons[(buttons.findIndex(button => button.getAttribute("aria-checked") === "true") + 1) % buttons.length];
  setUniversity(next.dataset.uni); next.focus();
});
$("#theme-btn").addEventListener("click", () => setAppearance(root.dataset.theme === "dark" ? "light" : "dark"));
$$("img[data-logo]").forEach(img => {
  const loaded = () => { if (img.naturalWidth) img.closest(".logo__slot").classList.add("has-img"); };
  if (img.complete) loaded(); else img.addEventListener("load", loaded);
});

const state = { user: null, csrf: "", preview: false, profile: null, groups: [], history: [], summary: [], students: [], personId: "", groupId: "", version: 0, busy: false, saving: false };
const labels = { present: "Present", late: "Late", absent: "Absent", pending: "Pending" };
const courseSelect = $("#course-select"), previewSelect = $("#preview-select"), preference = $("#email-notifications"), historyBody = $("tbody", $(".history"));
function message(text) { $("#attendance-state").textContent = text; }
async function api(path, body) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf }, body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error("The attendance server returned an unreadable response."); }
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `Attendance request failed (${response.status}).`), { status: response.status });
  return data;
}
function emptyRow(text) {
  const row = document.createElement("tr"), cell = document.createElement("td");
  cell.colSpan = 4; cell.textContent = text; row.append(cell); historyBody.replaceChildren(row);
}
function resetRecords(text) {
  state.profile = null; state.groups = []; state.history = []; state.summary = []; state.groupId = "";
  $("#attendance-placeholder").textContent = text; $("#attendance-placeholder").hidden = false; $("#attendance-summary").hidden = true;
  $("#headline").classList.remove("is-low"); $("#session-count").textContent = "— sessions"; $("#history-caption").textContent = "Student attendance history";
  courseSelect.replaceChildren(); courseSelect.disabled = true; $(".course-picker:not(#preview-picker)").hidden = true;
  for (const id of ["fact-code", "fact-end", "fact-weeks", "fact-sessions"]) $(`#${id}`).textContent = "—";
  $("#allowance-lead").textContent = "Allowance unavailable"; $("#allowance-lead").classList.remove("is-low");
  $("#allowance-bar").replaceChildren(); $("#allowance-bar").setAttribute("aria-label", "Absence allowance unavailable");
  $("#allowance-help").textContent = "Select a saved class to see its absence policy.";
  $("#course-help").textContent = "Schedule and history come from saved class records.";
  preference.checked = false; preference.disabled = true;
  $("#profile-name").textContent = state.preview ? "Student preview" : "Student attendance";
  $("#profile-id").textContent = "No student selected"; $("#profile-avatar").textContent = "—";
  $("#student-kicker").textContent = text; emptyRow(text);
}
function options(select, items, selected, label) {
  select.replaceChildren(...items.map(item => {
    const option = document.createElement("option"); option.value = item.id; option.textContent = label(item); return option;
  }));
  select.value = selected; select.disabled = items.length === 0;
}
function formatTimestamp(value, zone, timeOnly = false) {
  return new Intl.DateTimeFormat("en-US", { ...(timeOnly ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", year: "numeric" }), timeZone: zone }).format(new Date(value));
}
function timeElement(value, text) {
  const element = document.createElement("time"); element.dateTime = value; element.textContent = text; return element;
}
function renderCourse(announce = false) {
  const group = state.groups.find(group => group.id === state.groupId);
  if (!group) return;
  const summary = state.summary.find(row => row.group_id === group.id), records = state.history.filter(row => row.group_id === group.id), zone = group.time_zone || "UTC";
  const allowed = Number(summary?.allowed_absences ?? group.allowed_absences), used = summary ? Number(summary.used_absences) : null, remaining = summary ? Number(summary.remaining_absences) : null;
  const hasAllowance = summary && [allowed, used, remaining].every(Number.isFinite), low = Boolean(hasAllowance && remaining <= 2);
  $("#attendance-placeholder").hidden = Boolean(hasAllowance); $("#attendance-summary").hidden = !hasAllowance;
  $("#attendance-placeholder").textContent = "Absence allowance unavailable for this class.";
  $("#remaining-count").textContent = remaining; $("#remaining-word").textContent = remaining === 1 ? "absence" : "absences";
  $("#headline-course").textContent = group.name; $("#headline").classList.toggle("is-low", low);
  $("#session-count").textContent = `${records.length} ${records.length === 1 ? "session" : "sessions"}`;
  $("#history-caption").textContent = `${state.profile.full_name}'s attendance history for ${group.name}, ${group.course_code}`;
  if (!records.length) emptyRow("No attendance records have been saved for this class.");
  else historyBody.replaceChildren(...records.map(record => {
    const row = document.createElement("tr"), date = document.createElement("th"), times = document.createElement("td"), status = document.createElement("td"), badge = document.createElement("span"), checked = document.createElement("td");
    date.scope = "row"; date.append(timeElement(record.starts_at, formatTimestamp(record.starts_at, zone)));
    times.textContent = `${formatTimestamp(record.starts_at, zone, true)}–${formatTimestamp(record.ends_at, zone, true)}`;
    const key = Object.hasOwn(labels, record.status) ? record.status : "pending";
    badge.className = `st st--${key}`; badge.textContent = labels[key]; status.append(badge);
    checked.append(record.checked_in_at ? timeElement(record.checked_in_at, formatTimestamp(record.checked_in_at, zone, true)) : document.createTextNode("—"));
    row.append(date, times, status, checked); return row;
  }));
  const bar = $("#allowance-bar"); bar.classList.toggle("is-low", low); $("#allowance-lead").classList.toggle("is-low", low);
  if (hasAllowance) {
    const lead = document.createElement("strong"); lead.textContent = `${remaining} left`;
    $("#allowance-lead").replaceChildren(lead, document.createTextNode(` of ${allowed} allowed.${low ? " Talk to your instructor if you expect to miss more." : ""}`));
    bar.setAttribute("aria-label", `Absence allowance: ${used} used, ${remaining} remaining, ${allowed} allowed`);
    // The displayed figures are exact; cap segments for unusually large policies.
    const segments = Math.min(allowed, 100); bar.style.setProperty("--n", Math.max(segments, 1));
    bar.replaceChildren(...Array.from({ length: segments }, (_, index) => {
      const segment = document.createElement("span"); segment.className = `seg ${index < Math.round(remaining / Math.max(allowed, 1) * segments) ? "seg--left" : "seg--used"}`; segment.style.gridColumn = String(index + 1); return segment;
    }));
    $("#allowance-help").textContent = `${group.course_code}: ${allowed} absences allowed. Only absent records in finalized sessions that have started count toward this allowance. Late and Pending do not count.`;
  } else {
    $("#allowance-lead").textContent = "Allowance unavailable"; bar.replaceChildren(); bar.setAttribute("aria-label", "Absence allowance unavailable");
    $("#allowance-help").textContent = "The server has no absence summary for this class.";
  }
  $("#fact-code").textContent = group.course_code;
  const end = String(summary?.term_ends_on || group.term_ends_on || "").slice(0, 10);
  const validEnd = /^\d{4}-\d{2}-\d{2}$/.test(end) && Number.isFinite(Date.parse(`${end}T00:00:00Z`));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()), part = type => today.find(item => item.type === type).value;
  const todayDate = `${part("year")}-${part("month")}-${part("day")}`;
  if (validEnd) {
    $("#fact-end").replaceChildren(timeElement(end, formatTimestamp(`${end}T00:00:00Z`, "UTC")));
    $("#fact-weeks").textContent = Math.max(0, Math.ceil((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${todayDate}T00:00:00Z`)) / 604800000));
  } else { $("#fact-end").textContent = "—"; $("#fact-weeks").textContent = "—"; }
  $("#fact-sessions").textContent = records.length;
  $("#course-help").textContent = `Class times use ${zone}. Weeks left are counted from today's date in this class's time zone.`;
  if (announce) $("#course-feedback").textContent = `Showing ${group.course_code} · ${group.name}. ${records.length} saved sessions${hasAllowance ? `, ${remaining} absences left` : ""}.`;
}
function renderProfile(payload) {
  if (!payload.groups.length) resetRecords("No classes assigned yet.");
  state.profile = payload.profile; state.groups = payload.groups; state.history = payload.history; state.summary = payload.summary;
  if (!state.groups.some(group => group.id === state.groupId)) state.groupId = state.groups[0]?.id || "";
  const name = state.profile.full_name;
  $("#profile-name").textContent = name; $("#profile-id").textContent = `${state.preview ? "Read-only preview" : "Student"} · ID ${state.profile.person_code}`;
  $("#student-profile").setAttribute("aria-label", `${state.preview ? "Read-only preview of" : "Student profile for"} ${name}`);
  $("#profile-avatar").textContent = name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
  $("#student-kicker").textContent = `${name} · Student ID ${state.profile.person_code}${state.preview ? " · Read-only preview" : ""}`;
  preference.checked = Boolean(state.profile.notify_absence); preference.disabled = state.preview || state.saving;
  $("#email-help").textContent = state.preview ? "Notification preferences are read-only in student preview." : "Save your attendance email preference. Email delivery is not configured yet.";
  options(courseSelect, state.groups, state.groupId, group => `${group.course_code} · ${group.name}`);
  $(".course-picker:not(#preview-picker)").hidden = state.groups.length === 0;
  if (state.groupId) renderCourse();
  else {
    $("#attendance-placeholder").textContent = "No classes assigned yet."; $("#attendance-placeholder").hidden = false; $("#attendance-summary").hidden = true;
    emptyRow("No classes or attendance records are assigned to this student.");
  }
}
async function refreshAttendance() {
  if (state.saving) return;
  const version = ++state.version; state.busy = true; $("#refresh-attendance").disabled = true;
  message(state.profile ? "Refreshing saved attendance…" : "Loading saved attendance…");
  try {
    const identity = await api("/api/me"); if (version !== state.version) return;
    const changed = state.user?.id !== identity.user.id || state.user?.role !== identity.user.role;
    state.user = identity.user; state.csrf = identity.csrfToken; state.preview = ["teacher", "admin"].includes(state.user.role);
    $("#student-signin").hidden = true; $("#preview-picker").hidden = !state.preview;
    if (changed) { state.personId = ""; resetRecords("Loading saved attendance…"); }
    let payload;
    if (state.preview) {
      const data = await api("/api/student-preview"); if (version !== state.version) return;
      state.students = data.students;
      if (!state.students.some(student => student.id === state.personId)) state.personId = state.students[0]?.id || "";
      options(previewSelect, state.students, state.personId, student => `${student.full_name} · ${student.person_code}`);
      if (!state.personId) { resetRecords("No students available in your managed classes."); message("No students are assigned to your managed classes."); return; }
      payload = await api(`/api/student-preview/${encodeURIComponent(state.personId)}`);
    } else if (state.user.role === "student") payload = await api("/api/student-profile");
    else throw new Error("This account cannot view student attendance.");
    if (version !== state.version) return;
    renderProfile(payload);
    message(`${state.preview ? "Read-only preview · " : ""}Saved attendance refreshed ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date())}. Updates every 15 seconds.`);
  } catch (error) {
    if (version !== state.version) return;
    if (error.status === 401) {
      state.user = null; state.preview = false; state.personId = ""; state.students = [];
      $("#preview-picker").hidden = true; previewSelect.replaceChildren(); resetRecords("Sign in to view your attendance."); $("#student-signin").hidden = false;
      message("Your sign-in session is unavailable. Sign in to load your saved attendance.");
    } else if (error.status === 403 || error.status === 404 || !state.profile) { resetRecords("Attendance unavailable."); message(error.message); }
    else message(`Refresh failed: ${error.message} Displayed records may be out of date.`);
  } finally {
    if (version === state.version) { state.busy = false; $("#refresh-attendance").disabled = false; }
  }
}
courseSelect.addEventListener("change", () => { state.groupId = courseSelect.value; renderCourse(true); });
previewSelect.addEventListener("change", () => { state.personId = previewSelect.value; resetRecords("Loading selected student's attendance…"); refreshAttendance(); });
$("#refresh-attendance").addEventListener("click", refreshAttendance);
preference.disabled = true;
preference.addEventListener("change", async () => {
  if (!state.profile || state.preview || state.saving) return;
  const version = state.version, profile = state.profile, previous = Boolean(profile.notify_absence), value = preference.checked;
  state.saving = true; preference.disabled = true; $("#refresh-attendance").disabled = true;
  try {
    const saved = await api("/api/preferences", { notify_absence: value }); if (version !== state.version) return;
    profile.notify_absence = saved.notify_absence; preference.checked = Boolean(saved.notify_absence);
    $("#email-help").textContent = "Preference saved. Email delivery is not configured yet.";
  } catch (error) {
    if (version !== state.version) return;
    preference.checked = previous; $("#email-help").textContent = `Could not save preference: ${error.message}`;
  } finally { state.saving = false; preference.disabled = !state.profile || state.preview; $("#refresh-attendance").disabled = state.busy; }
});
const notificationBell = $("#notification-bell"), notificationDropdown = $("#notification-dropdown");
function closeNotifications() { notificationDropdown.hidden = true; notificationBell.setAttribute("aria-expanded", "false"); }
notificationBell.addEventListener("click", () => {
  const open = notificationDropdown.hidden; notificationDropdown.hidden = !open; notificationBell.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", event => { if (!event.target.closest(".notification-control")) closeNotifications(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && !notificationDropdown.hidden) { closeNotifications(); notificationBell.focus(); } });
setInterval(() => { if (!document.hidden && !state.busy && !state.saving) refreshAttendance(); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.busy && !state.saving) refreshAttendance(); });
refreshAttendance();
