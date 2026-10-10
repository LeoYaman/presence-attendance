# Presence

Open these two pages from this folder (keep the folder structure as is):

- `index.html` — teacher view (camera + roster)
- `student.html` — student portal
- `overview.html` — admin (links to Students, Classes, Attendance, Integrations = `admin.html`, Settings, Audit history)

```
presence-site/
├── index.html      teacher page   → uses styles.css + app.js
├── styles.css
├── app.js
├── student.html    student page   → uses student.css + student.js + customize.js
├── student.css     (self-contained; doesn't need styles.css)
├── student.js
├── customize.js
├── overview.html, students.html, classes.html, attendance.html,
│   admin.html, settings.html, audit-history.html   admin pages → use admin.css + admin.js
├── admin.css       (self-contained; doesn't need styles.css)
├── admin.js
├── INTEGRATION.md  notes for the backend team
└── assets/         logos used by both pages
```

The camera only works when the page is served over http://localhost or https
(for example with VS Code Live Server), not when opened as a file.
