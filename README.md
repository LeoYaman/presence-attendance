# Presence Attendance — Tiger Data

Teacher check-ins and attendance corrections are committed to PostgreSQL before the UI shows success. The existing relational roster and attendance workflows remain in use; an append-only TimescaleDB `attendance_events` hypertable records their state changes in the same transaction. Live camera images and embeddings are not persisted. The anonymous ORL reference archive is stored separately as test data (see below).

## Local setup

Requires Node.js 22+ and a PostgreSQL service with TimescaleDB (Tiger Data). From the repository root:

```powershell
cd Backend
pnpm install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edit Backend/.env locally; never put credentials in browser code.
pnpm test
pnpm db:check
pnpm db:migrate
pnpm db:verify
pnpm start
```

Open `PUBLIC_ORIGIN` (default `http://localhost:3000`). The API serves the root attendance UI on the same origin. See [Backend setup and security](Backend/README.md) for environment variables, authentication, account provisioning, scoped database permissions, synthetic seed commands and optional Timescale integration tests. Existing accounts need compatible password hashes; caller-supplied IDs and roles cannot authenticate a request.

The dashboard opens directly without a login page. It restores an existing backend session automatically; authentication through `/api/login` remains available for an external integration. Without an authorized session, the dashboard displays connection status and disables attendance recording.

From the repository root, run `node --test tests/frontend.test.mjs` for persistence failure, retry, approval and stale polling behavior. Backend tests use actual HTTP requests to a local test server; if an execution sandbox blocks loopback networking, run those tests in a local terminal with loopback access.

The original sibling `../Backend` was copied into this repository because it was absent from the clone. Migrations `001` and `002` are preserved byte-for-byte. Apply only the new numbered migrations to an existing database; the checksum runner rejects edits to already-applied files. Migration application is transactional. Never use a reset/drop command to upgrade an existing service.

## Demo walkthrough

Use only the explicitly labeled synthetic seed described in the Backend README. Seeding is opt-in, adds its own demo records and does not erase existing data. Set the demo password locally and enable synthetic recognition only when demonstrating the synthetic course.

1. Establish a backend session as the seeded demo teacher through the authentication integration (`/api/login`), open the dashboard and select the **SYNTHETIC DEMO** course.
2. Create a session with an end time in the future, then open it. The database snapshots its roster as pending.
3. Check a student in manually, or run the labeled synthetic camera demo. Wait for the API acknowledgement. The record and its event commit together.
4. Observe the live count, present/late/pending distribution, five-minute arrival chart and daily finalized participation trend. Retry a check-in: the first result stays unchanged and no second event is created.
5. Correct a record with a reason if needed. Approve attendance to close the current session and open a fresh one-hour session. Remaining pending students become absent in the closed session; the next roster starts pending and the camera stays active.
6. Establish a backend session as the synthetic student to inspect that student's own history. Teachers can inspect the selected session's report.

The standalone `face_data/webcam_faces.py` performs face detection. The new `recognition_worker.py` adds temporary face enrollment and OpenCV matching for manual suggestions, plus saved SFace references for automatic attendance (see setup below). The real recognition boundary is a backend adapter; browser-provided IDs or confidence scores are not trusted real recognition results. The demo must never be presented as actual identity recognition. Other AdminPage/Frontend prototype pages remain design references; the working authenticated integration is the root page.

## Tiger Data demonstration

| File | Sponsor feature / evidence |
|---|---|
| `Backend/db/migrations/003_attendance_events.sql` | Time-partitioned hypertable; time-inclusive primary key; foreign keys to ordinary relational tables; transactional event trigger |
| `Backend/src` | Dashboard SQL uses `time_bucket` for five-minute arrivals and course-time-zone daily trends |
| `Backend/scripts/migrations.mjs` | Checksum migration tracking and actual hypertable verification |
| `Backend/tests` | Duplicate prevention, rollback, authorization, correction and analytics checks; separate real Timescale verification |
| `app.js`, `index.html` | API-backed roster, DB acknowledgements, five-second polling and labeled synthetic demo |

Polling fits a classroom dashboard with modest update frequency and avoids persistent stream connections. Dashboard queries read current relational outcomes and raw hypertable events: corrections and recent commits are visible on the next poll without a background refresh lag. A continuous aggregate is deliberately deferred until measured data volume warrants it; immutable arrival counts and corrected participation outcomes need different aggregation semantics.

Verified against official Tiger Data documentation: [unique indexes must include partition columns](https://www.tigerdata.com/docs/build/performance-optimization/hypertables-and-unique-indexes), [hypertable constraints](https://github.com/timescale/docs/blob/latest/use-timescale/schema-management/about-constraints.md), [time buckets](https://www.tigerdata.com/docs/learn/data-lifecycle/time-buckets/about-time-buckets), and [continuous aggregates and their real-time defaults](https://www.tigerdata.com/docs/learn/continuous-aggregates). The ordinary attendance table still enforces unique `(session_id, person_id)`; converting it to a hypertable would weaken that useful global constraint.

Without `DATABASE_URL`, local tests still run, but service connectivity, migration execution and real Timescale behavior cannot be claimed verified. PGlite tests exercise PostgreSQL workflow logic with an explicitly identified Timescale test shim; they do not validate Timescale chunk routing or TLS networking. No cloud service, deployment or GitHub push is performed automatically.

## Logos

| File | Size | Shown at | Used on |
|---|---|---|---|
| `ucf-logo.png` | 450 × 342 | 40px tall | UCF theme, black nav (both modes) |
| `fullsail-logo.png` | 540 × 376 | 48px tall | Full Sail theme, light mode (white nav) |
| `fullsail-logo-white.png` | 540 × 376 | 48px tall | Full Sail theme, dark mode (charcoal nav) |

All three are trimmed to the artwork and have transparent backgrounds.
`fullsail-logo-white.png` is the same logo with the charcoal lettering turned
white so it reads on dark backgrounds; the orange circle and plane are unchanged.

If a file is missing, the site shows the university name as text instead.

Note: the UCF file supplied is the interlocking athletics-style "UCF". UCF's
brand guide (ucf.edu/brand/logo-and-identity) reserves that mark for
Athletics and asks academic uses to use the stacked UCF mark instead, which is
available on request from UCF Brand and Marketing. To switch, replace
`ucf-logo.png` with the stacked mark and adjust its `width`/`height` in
`index.html` to the new file's proportions.
# Quick offline local demo

From `Backend`, run `npm run start:local`, then visit `http://localhost:3000`. This persistent PGlite demo needs no cloud credentials and opens the fixed synthetic teacher session without a login page. Data is saved in `Backend/.local-db/pgdata/database.tar` after commits. Restarting keeps attendance and corrections. Only use it on this computer; it binds to `127.0.0.1`.

This local mode does not provide TimescaleDB hypertables. See [Backend local demo instructions](Backend/README.md) for the distinction from the Tiger Data setup. The cloud `.env` and production migration commands are preserved.

## Frontend camera matching (repository code)

The root dashboard now sends JPEG frames to the existing Node server. The server
runs `face_data/recognition_worker.py`, which reuses the MediaPipe detector/model
from `webcam_faces.py` and adds OpenCV LBPH matching using the existing
`opencv-contrib-python` dependency. No separate GitHub face library is used.

Use a **64-bit Python 3.12+** environment (32-bit Python cannot install the Windows
MediaPipe wheel):

```powershell
py -3.12 -m venv face_data/.venv
./face_data/.venv/Scripts/python.exe -m pip install -r face_data/requirements.txt
./face_data/.venv/Scripts/python.exe face_data/webcam_faces.py --download-model
cd Backend
node scripts/local-demo.mjs
```

For a different interpreter, set `FACE_PYTHON` to its executable before starting
Node. The default is the repository's `face_data/.venv` interpreter. Restart Node
after adding this integration if the dashboard server is already running.

1. Connect an authorized teacher session, select a course and open an attendance session.
2. Start the browser camera, select the consenting student under **Register face**
   and check the consent box.
3. Click **Capture 5 face samples**. Keep exactly one face in frame, reasonably
   close to the camera, and move slightly between captures.
4. The camera suggests registered students. Review the selected student and click
   **Check in** to persist attendance through the existing teacher workflow.
5. **Clear course face samples** deletes that course's enrollment from memory.

Only registered active course members are considered. At least five unique JPEG
samples are required per identity. Matching rejects raw LBPH distances above 50
and competing identities separated by less than 10 distance units. These are
conservative prototype thresholds, not calibrated identity probabilities. Poor
lighting, head rotation and similar-looking people can still cause incorrect
suggestions; there is no liveness/spoof protection. Teacher confirmation is
required, and saved records have `source: teacher` rather than claiming verified
camera attendance.

Samples and matching models are held in the Python worker's RAM; images are not
written to disk. Restarting Node/worker loses registration. Stopping the camera
stops frame requests, but samples remain until cleared/restarted. Limits are 30
samples/person and 2,000 samples total (about 45 MB of raw grayscale pixels, plus
models/runtime overhead). The browser sends at most 640x480 JPEG frames; face
endpoints require session authentication, CSRF, origin and group-manager access.

Tests: `node --test tests/frontend.test.mjs`, `node --test Backend/tests/*.test.mjs`
and `./face_data/.venv/Scripts/python.exe -m unittest face_data.test_recognition_worker`.

## MacBook camera over Tailscale

Open the dashboard on the MacBook itself in Safari or Chrome: `getUserMedia`
uses the camera attached to the browser's device. JPEG frames travel through
Tailscale HTTPS to this Windows server for MediaPipe/OpenCV processing.
Both devices must be connected to the same tailnet. Grant camera permission to
the HTTPS site in the MacBook browser (and macOS camera settings if needed).

The local demo has an optional, strict remote mode. Set
`LOCAL_DEMO_PUBLIC_ORIGIN` to this device's exact `https://…ts.net` root origin and
`LOCAL_DEMO_TAILSCALE_LOGIN` to the authorized Tailscale login before starting
`node scripts/local-demo.mjs`. It checks the exact Host and the Serve-injected
`Tailscale-User-Login` header on every request, keeps Node bound to 127.0.0.1 and
uses Secure cookies. Plain localhost access is disabled in this mode.
Use `tailscale serve --bg --https=443 http://127.0.0.1:3000` to proxy the service
within the tailnet. Existing Serve routes on other ports are preserved.
Do not enable Funnel for this demo. The fixed teacher session is limited to the
configured Tailscale account and synthetic demo course.

To return to ordinary local mode, remove `LOCAL_DEMO_PUBLIC_ORIGIN` and
`LOCAL_DEMO_TAILSCALE_LOGIN` from the server process environment and restart it;
disable only this Serve mapping with `tailscale serve --https=443 off`.

## Imported ORL reference face dataset

The Git-tracked `att_faces.zip` contains the **ORL face database**: 40 anonymous
subjects (`s1`–`s40`), each with 10 original 92×112 grayscale PGM images. Credit:
**Olivetti Research Laboratory**; the archive README and source GitHub URL are
stored with the dataset. This is a separate test dataset and has no student,
face-enrollment, course, or attendance associations.

Migration `006_face_datasets.sql` adds `attendance.face_datasets`,
`attendance.face_dataset_subjects`, and `attendance.face_dataset_images`. The
last table stores original image bytes as `bytea`, file identifiers and SHA-256
hashes; datasets are constrained to `test_only=true`. These tables are not
exposed by the frontend or granted to the ordinary runtime role.

To repeat an import into the local demo, **stop its Node server first**, then run
from `Backend`:

```powershell
node scripts/import-face-dataset.mjs --local --offline-confirmed
```

Restart the server using the same local/Tailscale environment afterwards. The
import is transactional, validates all 400 files, and checks stored bytes on
reimport. An unchanged archive inserts no duplicates; changed provenance or
corrupt stored bytes produce an error without overwriting data. The local
snapshot persists the dataset across restarts. For a configured cloud database,
apply migrations with its migration-owner account, then explicitly use
`node scripts/import-face-dataset.mjs --database`; importing locally does not
also modify cloud data.

The dataset archive SHA-256 is
`509d763bd2276aa054d260d7f1000e8be212738134f2f83d8ff13bc2adf1c8ec`.
Validation: `node --test Backend/tests/face-dataset.test.mjs` and
`./face_data/.venv/Scripts/python.exe -m unittest face_data.test_export_dataset`.

## Saved team reference photographs

The four user-confirmed WIN photograph/name mappings in `face_data/students.json`
are imported separately from the anonymous ORL dataset. Migration 007 stores
original JPEG bytes, SHA-256, source Git commit and person/group mappings.
Stop the local server, then run from Backend:
`node scripts/import-team-references.mjs --local --offline-confirmed`.
The additive import creates the `PRESENCE-TEAM-REFERENCES` demo group and four
people, without login accounts, sessions or attendance records. Repeated imports
verify existing data and refuse conflicting mappings.

That group uses the repository's YuNet detection and aligned SFace matching.
Only server-authorized active roster mappings participate; the cosine similarity
threshold is 0.45 with a 0.06 runner-up margin. Models live under
`face_data/models`; `download_models()` in `recognition.py` downloads the official
OpenCV models. Saved mappings persist across restarts. Other groups retain the
temporary LBPH enrollment flow. Clearing temporary samples does not remove saved
references. In live camera mode, a server SFace result for a known roster member
with `identityMatched: true` and finite cosine similarity **strictly above 0.55**
saves attendance automatically. Similarity of exactly 0.55 or below, unknown
faces, and temporary LBPH suggestions do not save automatically. The first
qualifying face creates a one-hour session if none is selected and opens a
planned session only during its scheduled time. Starting the camera alone does
not create a session. Closed sessions require selecting a new session.

Automatic check-ins use the authorized teacher API (`source: teacher`) without
sending camera confidence. The roster displays Present or Late only after the
server acknowledges the save; late-arrival rules still apply. Repeated frames
and concurrent faces share session preparation and save each student once.
Failed saves leave attendance pending and retry when that face is seen again
after a five-second cooldown. The team reference camera hides the student picker
and Confirm button; stop the camera to use manual attendance as a fallback.
Other groups' temporary LBPH enrollment retains manual confirmation controls.
Reference-photo tests do not establish live-camera accuracy.

The Camera selector below the preview lists available video inputs. Choose a
device before starting, or switch while live to reopen recognition on that
device. Refresh cameras updates the list; permission approval refreshes device
labels. Removing the active device stops its stream and asks for another camera.
Switching devices does not reset saved attendance.

Approve attendance finalizes the current roster and opens its next one-hour
session in one database transaction. The previous attendance remains in history;
the new roster starts pending and the selected camera keeps running. A unique
predecessor link in migration 008 makes duplicate approval requests return the
same next session. Only frames from the new session context can check in again.
