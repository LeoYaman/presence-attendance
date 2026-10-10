# Presence frontend and recognition integration

Serve the root UI from the attendance backend (`/`). The dashboard opens directly without a login form. The frontend restores an existing HTTP-only session cookie through `/api/me`; an external authentication integration can establish that cookie through `/api/login`. When the session or backend is unavailable, the dashboard shows connection status and recording controls remain disabled. There is no client-side role selector. Login and `/me` return the server's user identity and CSRF token. Mutations send that token in `X-CSRF-Token`; they never send a claimed actor or role.

## Saved attendance workflow

Teachers choose an assigned course section, create a session, and open it. The roster is loaded from the API. A teacher check-in posts `{personId, source:'teacher'}` to `/api/sessions/:id/checkins`. Status, check-in time, counts and trends are taken from the saved dashboard. Attendance does not change locally before database acknowledgment. Duplicate in-flight check-ins share one request; the database supplies retry idempotency.

Approve attendance posts to `/api/sessions/:id/close`. The server marks students not seen as absent and closes the session. Corrections use `/api/records/:id/correction` with `{status, reason, checkedInAt}`. A reason is required. Present and late corrections ask the teacher to supply the actual original check-in time as an ISO timestamp with an offset; closed sessions require a time during their open period. Absent corrections have `checkedInAt:null`. Cancellation and failures retain the saved record; there is no local-only undo.

Dashboard refreshes every five seconds while a teacher has a visible selected session. This bounded prototype polling avoids a separate streaming service. Context and dashboard generations discard old responses after section/session switches, sign-out or acknowledged mutations. Failed refreshes show a stale-data message. Counts, five-minute arrival buckets and finalized daily trends come from server queries. Session and bucket times display in the course's IANA time zone. Session creation inputs explicitly use the browser's time zone and are sent as UTC ISO timestamps.

Students can read `/api/history` for their own saved session history and term absence allowances. API authorization determines what each account can access.

The root `student.html` loads `/api/student-profile` for authenticated students: identity, course sections, saved history and server-calculated absence allowance. `/api/preferences` saves that student's notification preference; email delivery is not configured. Teachers and admins use the clearly labeled, read-only `/api/student-preview` picker. Teacher previews include only their assigned course sections, even when the selected student belongs to other courses. Preview cannot change a student's notification preferences. No sample attendance is embedded in the connected student page.

## Recognition adapter boundary

The browser sends camera JPEG frames to authenticated `/api/groups/:groupId/faces/detect`, `/enroll` and `/clear` endpoints. They run this repository's MediaPipe/OpenCV worker. `camera-client.js` marks every match as `suggestion:true`, which never automatically writes attendance. Teachers review and confirm using the existing teacher check-in workflow. A trusted automatic recognition adapter is still absent; arbitrary browser camera claims remain rejected. See the root README for Python setup and registration.

The existing `window.Presence` boundary remains available:

```js
window.Presence.recognize([
  { studentId: 'server-person-uuid', confidence: 0.91,
    box: { x: 0.38, y: 0.20, width: 0.24, height: 0.42 } }
]);
// Confidence and boxes are display suggestions; the server must authorize writes.
const video = window.Presence.getVideo();
const savedRoster = window.Presence.getRoster();
await window.Presence.refresh();
await window.Presence.checkIn('server-person-uuid', 'teacher');
```

Boxes use normalized 0–1 coordinates of the unmirrored frame; the UI handles mirroring. Invalid confidence/box values are ignored. High suggestions may submit a camera request once per preview session; the backend rejects untrusted claims. Medium/low suggestions can be confirmed as a teacher check-in after the teacher identifies the student. `setRoster()` now reloads the authoritative API roster; supplied local rows cannot overwrite attendance.

The existing events remain acknowledgment notifications:

```js
document.addEventListener('presence:camera-start', e => {
  // e.detail.video is the preview element. Attach a trusted adapter here.
});
document.addEventListener('presence:camera-stop', () => {});
document.addEventListener('presence:checkin', e => {
  // After successful saved acknowledgment and refresh:
  // {studentId, sessionId, recordId, status, source:'teacher'|'camera', time}
});
document.addEventListener('presence:approved', e => {
  // After successful persisted close and refresh:
  // {sessionId, approvedAt, sessionStart, students}
});
```

## Explicit synthetic demonstrations

`Show synthetic demo` draws generated boxes and scores. It never writes attendance.

`Run synthetic database demo` is separate and visibly labeled synthetic. It requires an open session in the seeded `PRESENCE-DEMO-SYNTHETIC` section and `/me` capability `syntheticCamera:true`, enabled by `ALLOW_SYNTHETIC_CAMERA=true` on the backend. Generated matches go through the real camera check-in API and database before the roster/dashboard change. The server verifies the seeded demo enrollment and records its synthetic recognition provider. This is an end-to-end persistence demonstration, not real facial recognition. Disable the server flag outside explicit local demonstrations.

## Frontend verification

Run `node --check app.js` and `node --test tests/frontend.test.mjs`. The VM tests exercise rejected persistence, in-flight check-in deduplication, close acknowledgment, stale response isolation, correction timestamps and cancellation, visual versus persisted synthetic demos, and untrusted camera rejection. The parent task additionally exercises the browser against the database-backed server.
