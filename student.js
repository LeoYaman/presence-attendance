"use strict";

/* ==========================================================================
   Presence · Student portal
   - University (UCF / Full Sail) and light/dark, shared with the teacher view
   - Course picker, attendance history, absence allowance
   Data is static sample data. Replace `courses` with the student's records
   from the backend (only this student's own records).
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const root = document.documentElement;

/* ---------- University + appearance (same storage keys as the teacher view) ---------- */
const UNIVERSITIES = {
  ucf:      { name: "UCF" },
  fullsail: { name: "Full Sail" },
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function syncThemeColor() {
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--nav-bg").trim() || "#000000";
}
function setUniversity(key) {
  if (!UNIVERSITIES[key]) return;
  root.dataset.university = key;
  store.set("presence-university", key);
  $$(".uni-switch button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.uni === key)));
  document.title = `My Attendance · ${UNIVERSITIES[key].name} · Presence`;
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

/* Logos: show the file if it's in /assets, otherwise the name as text */
$$("img[data-logo]").forEach((img) => {
  const ok = () => { if (img.naturalWidth) img.closest(".logo__slot").classList.add("has-img"); };
  if (img.complete) ok(); else img.addEventListener("load", ok);
});

setUniversity(root.dataset.university || "ucf");
setAppearance(root.dataset.theme || "light");

/* ==========================================================================
   Course data
   ========================================================================== */
// A fixed date keeps the sample history and "weeks left" consistent.
const sampleDate = "2026-10-09";
const studentName = "Alex Morgan";

// CS 101 is read from the table already in the page, so it also works without JavaScript.
const historySection = $(".history");
const initialRows = $$("tbody tr", historySection).map((row) => ({
  date: $("th time", row).dateTime,
  classTime: row.cells[1].textContent,
  status: $(".st", row).textContent,
  checkIn: row.cells[3].querySelector("time")?.dateTime ?? null,
}));

const courses = {
  cs101: { name: "Introduction to Computer Science", code: "CS 101", endDate: "2026-12-11", allowed: 10, records: initialRows },
  math201: {
    name: "Calculus II", code: "MATH 201", endDate: "2026-12-04", allowed: 10,
    records: [
      { date: "2026-10-08", classTime: "11:00 AM–12:30 PM", status: "Pending", checkIn: null },
      { date: "2026-10-06", classTime: "11:00 AM–12:30 PM", status: "Present", checkIn: "2026-10-06T10:56" },
      { date: "2026-10-01", classTime: "11:00 AM–12:30 PM", status: "Late", checkIn: "2026-10-01T11:08" },
      { date: "2026-09-29", classTime: "11:00 AM–12:30 PM", status: "Absent", checkIn: null },
      { date: "2026-09-24", classTime: "11:00 AM–12:30 PM", status: "Present", checkIn: "2026-09-24T10:58" },
    ],
  },
  eng102: {
    name: "Academic Writing", code: "ENG 102", endDate: "2026-11-20", allowed: 10,
    records: [
      { date: "2026-10-09", classTime: "2:00–3:30 PM", status: "Pending", checkIn: null },
      { date: "2026-10-07", classTime: "2:00–3:30 PM", status: "Present", checkIn: "2026-10-07T13:57" },
      { date: "2026-10-02", classTime: "2:00–3:30 PM", status: "Absent", checkIn: null },
      { date: "2026-09-30", classTime: "2:00–3:30 PM", status: "Present", checkIn: "2026-09-30T13:59" },
      { date: "2026-09-25", classTime: "2:00–3:30 PM", status: "Absent", checkIn: null },
    ],
  },
};

const LOW_ALLOWANCE = 2;   // warn when this many absences (or fewer) are left
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const asDate = (value) => new Date(`${value}T00:00:00Z`);

function makeTime(value, isCheckIn = false) {
  const time = document.createElement("time");
  time.dateTime = value;
  time.textContent = isCheckIn ? timeFormat.format(new Date(`${value}Z`)) : dateFormat.format(asDate(value));
  return time;
}

function renderCourse(courseKey, announce = true) {
  const course = courses[courseKey];
  if (!course) return;

  const counts = { Present: 0, Late: 0, Absent: 0, Pending: 0 };
  course.records.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const used = counts.Absent;
  const remaining = Math.max(0, course.allowed - used);
  const weeks = Math.max(0, Math.ceil((asDate(course.endDate) - asDate(sampleDate)) / (7 * 24 * 60 * 60 * 1000)));
  const low = remaining <= LOW_ALLOWANCE;
  const endText = dateFormat.format(asDate(course.endDate));

  // Statement band
  $("#remaining-count").textContent = remaining;
  $("#remaining-word").textContent = remaining === 1 ? "absence" : "absences";
  $("#headline-course").textContent = course.name;
  $("#headline").classList.toggle("is-low", low);
  $("#headline-sub").textContent =
    `${used} of ${course.allowed} allowed absences used · ${weeks} ${weeks === 1 ? "week" : "weeks"} until the course ends on ${endText}.`;
  $("#n-present").textContent = counts.Present;
  $("#n-late").textContent = counts.Late;
  $("#n-absent").textContent = counts.Absent;
  $("#n-pending").textContent = counts.Pending;

  // History table
  $("#session-count").textContent = `${course.records.length} sessions`;
  $("#history-caption").textContent = `${studentName}'s attendance history for ${course.name}, ${course.code}`;
  const rows = course.records.map((record) => {
    const row = document.createElement("tr");
    const dateCell = document.createElement("th");
    dateCell.scope = "row";
    dateCell.append(makeTime(record.date));
    const timeCell = document.createElement("td");
    timeCell.textContent = record.classTime;
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `st st--${record.status.toLowerCase()}`;
    status.textContent = record.status;
    statusCell.append(status);
    const checkInCell = document.createElement("td");
    checkInCell.append(record.checkIn ? makeTime(record.checkIn, true) : document.createTextNode("—"));
    row.append(dateCell, timeCell, statusCell, checkInCell);
    return row;
  });
  $("tbody", historySection).replaceChildren(...rows);

  // Absence allowance
  const lead = $("#allowance-lead");
  const strong = document.createElement("strong");
  strong.textContent = `${remaining} left`;
  lead.replaceChildren(strong, document.createTextNode(` of ${course.allowed} allowed.${low ? " Talk to your instructor if you expect to miss more." : ""}`));
  lead.classList.toggle("is-low", low);
  const bar = $("#allowance-bar");
  bar.style.setProperty("--n", course.allowed);
  bar.classList.toggle("is-low", low);
  bar.setAttribute("aria-label", `Absence allowance: ${used} used, ${remaining} remaining, ${course.allowed} allowed`);
  bar.replaceChildren(...Array.from({ length: course.allowed }, (_, i) => {
    const seg = document.createElement("span");
    seg.className = `seg ${i < used ? "seg--used" : "seg--left"}`;
    return seg;
  }));
  $("#allowance-help").textContent =
    `Sample policy for ${course.code}: ${course.allowed} absences allowed. Late and Pending don’t count as absences in this example.`;

  // Course facts
  $("#fact-code").textContent = course.code;
  $("#fact-end").replaceChildren(makeTime(course.endDate));
  $("#fact-weeks").textContent = weeks;
  $("#fact-sessions").textContent = course.records.length;

  if (announce) {
    $("#course-feedback").textContent =
      `Showing ${course.name}, ${course.code}. ${course.records.length} sessions, ${remaining} absences left, ${weeks} weeks until the course ends.`;
  }
}

const courseSelect = $("#course-select");
courseSelect.addEventListener("change", () => renderCourse(courseSelect.value));
renderCourse(courseSelect.value, false);
$(".course-picker").hidden = false;
