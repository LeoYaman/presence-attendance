"use strict";

// Static student/course data. Replace this source with authorized backend data later.
// A fixed date keeps the displayed history and sample schedule consistent.
const sampleDate = "2026-10-09";
const historySection = document.querySelector(".history");
const initialRows = [...historySection.querySelectorAll("tbody tr")].map((row) => ({
  date: row.querySelector("th time").dateTime,
  classTime: row.cells[1].textContent,
  status: row.querySelector(".status").textContent,
  checkIn: row.cells[4].querySelector("time")?.dateTime ?? null,
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
  const title = document.getElementById("course-title");
  const code = document.createElement("span");
  code.className = "course-code";
  code.textContent = course.code;
  title.replaceChildren(document.createTextNode(`${course.name} `), code);

  const weeks = Math.max(0, Math.ceil((asDate(course.endDate) - asDate(sampleDate)) / (7 * 24 * 60 * 60 * 1000)));
  const weeksText = historySection.querySelector(".weeks-left");
  const strong = document.createElement("strong");
  strong.textContent = `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  weeksText.replaceChildren(strong, document.createTextNode(" until course ends"));
  historySection.querySelector(".course-end").replaceChildren(document.createTextNode("Ends "), makeTime(course.endDate));
  historySection.querySelector(".record-count").textContent = `${course.records.length} sessions`;
  historySection.querySelector("caption").textContent = `Alex Morgan's attendance history for ${course.name}, ${course.code}`;

  const rows = course.records.map((record) => {
    const row = document.createElement("tr");
    const dateCell = document.createElement("th");
    dateCell.scope = "row";
    dateCell.append(makeTime(record.date));
    row.append(dateCell);
    for (const value of [record.classTime, course.code]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status ${record.status.toLowerCase()}`;
    badge.textContent = record.status;
    statusCell.append(badge);
    row.append(statusCell);
    const checkInCell = document.createElement("td");
    checkInCell.append(record.checkIn ? makeTime(record.checkIn, true) : document.createTextNode("—"));
    row.append(checkInCell);
    return row;
  });
  historySection.querySelector("tbody").replaceChildren(...rows);

  const used = course.records.filter((record) => record.status === "Absent").length;
  const remaining = Math.max(0, course.allowed - used);
  const allowance = document.querySelector(".allowance");
  allowance.querySelector(".allowance-total").textContent = `${used} used · ${remaining} remaining · ${course.allowed} allowed`;
  const bar = allowance.querySelector(".allowance-bar");
  bar.setAttribute("aria-label", `Absence allowance: ${used} used, ${remaining} remaining, ${course.allowed} allowed`);
  bar.replaceChildren(...Array.from({ length: course.allowed }, (_, index) => {
    const segment = document.createElement("span");
    segment.className = `segment ${index < used ? "used" : "remaining"}`;
    return segment;
  }));
  allowance.querySelector(".help-text").textContent = `Sample course policy for ${course.code}: ${course.allowed} absences allowed. This is not a universal rule. Late and Pending do not count as Absent in this example.`;
  if (announce) document.getElementById("course-feedback").textContent = `Showing ${course.name}, ${course.code}. ${course.records.length} sessions, ${remaining} absences remaining, ${weeks} weeks until course ends.`;
}

const courseSelect = document.getElementById("course-select");
courseSelect.addEventListener("change", () => renderCourse(courseSelect.value));
renderCourse(courseSelect.value, false);
document.querySelector(".course-picker").hidden = false;
