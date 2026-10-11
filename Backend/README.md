# Presence backend

Node.js 22+ same-origin HTTP API for the integrated root UI. PostgreSQL owns accounts, rosters, sessions, results and audit history. TimescaleDB owns the append-only `attendance.attendance_events` hypertable. Original migrations 001/002 remain unchanged.

## Configure and run

Install dependencies with `pnpm install --frozen-lockfile` or `npm install`. Copy `.env.example` to `.env` and privately set `DATABASE_URL` to a Timescale-enabled PostgreSQL service URI. Never commit `.env` or put credentials in browser code. The pool and database commands strip URI SSL overrides and always enforce verified TLS using the platform's trusted CAs.

```sh
npm test
npm run db:check
npm run db:migrate
npm run db:verify
npm start
```

Visit `http://localhost:3000`, matching `PUBLIC_ORIGIN` exactly. Default bind is `127.0.0.1`; `HOST`, `PORT` and `PUBLIC_ORIGIN` are configurable. Production requires HTTPS `PUBLIC_ORIGIN`; `NODE_ENV=production` enables Secure cookies. A reverse proxy must route the UI and API on the same origin. Server startup performs no migrations, cloud provisioning, seed or deployment.

`db:check` is read-only. `db:migrate` atomically applies checksum-tracked numbered migrations under an advisory lock. Reruns skip matching files; changed applied files fail. Migration 003 refuses missing TimescaleDB with a clear message and rolls back all changes. Migration 004 adds auth sessions; 005 excludes legacy future finalized absences from allowance reporting. There are no destructive rollback commands. Available extension installation needs appropriate setup privileges.

Use a separate backend LOGIN role in production; keep owner credentials for setup. [db/runtime_grants.sql](db/runtime_grants.sql) is a review-only template and creates no roles/passwords. Existing routines are SECURITY INVOKER, requiring underlying writes. Runtime credentials remain private because direct SQL can bypass API authorization. Timestamp-column UPDATE grants on groups/enrollments allow required row locks without granting changes to their sensitive fields. Runtime cannot modify accounts/rosters, delete attendance history or alter schema.

Only root `index.html`, `app.js` and `styles.css` are served. Source directories, `.env`, Git files, archives and face datasets are outside the static allowlist. CSP permits local application scripts and the specific Google Fonts stylesheet/font hosts used by the design.

## Authentication and authorization

Passwords use salted scrypt (`N=16384,r=8,p=1`, 64-byte derived key) and constant-time verification. Provisioned passwords require 12–256 characters; placeholder hashes cannot log in. Opaque 256-bit session tokens stay in HttpOnly, SameSite=Strict cookies. Only SHA-256 token digests are stored with an absolute eight-hour expiry. Secure cookies are mandatory in production. Logout revokes the server session; expiry and inactive users/people are checked each request. Login permits 15 attempts per direct client address per 15 minutes in this process; multiple production instances should use a shared proxy limiter. Forwarded client-address headers are not trusted.

POST requires JSON and exact `Origin: PUBLIC_ORIGIN`; authenticated POST also requires `X-CSRF-Token` from login/me. Unsupported fields and actor/role injection are rejected. Identity always comes from the cookie. Teachers manage assigned groups; admins manage groups. Students get only their own history/summary and cannot read classmate rosters or manage sessions. Query-string person selection is rejected. No passwords, connection URIs, request bodies, images or embeddings are logged.

## API contract

Responses use snake_case database fields. Request fields are camelCase. Errors are `{error:{code,message}}` with 400 validation, 401 authentication, 403 permission/CSRF/origin, 409 workflow conflict, 429 rate limiting, 501 unavailable camera, or 503 service/configuration failures.

| Method and route | Request | Response |
| --- | --- | --- |
| POST `/api/login` | `{email,password}` | `{user,csrfToken,capabilities}` and cookie |
| GET `/api/me` | — | `{user,csrfToken,capabilities}` |
| POST `/api/logout` | `{}` | `{ok:true}` |
| GET `/api/groups` | — | `{groups:[group rows]}` identity-filtered |
| GET `/api/groups/:id/roster` | — | `{roster:[{person_id,person_code,full_name}]}` managers only |
| GET `/api/groups/:id/sessions` | — | `{sessions:[session rows]}` latest 100 |
| POST `/api/groups/:id/sessions` | `{startsAt,endsAt,lateAfterMinutes?}` | `{session}` |
| GET `/api/sessions/:id` | — | `{session,roster}` |
| POST `/api/sessions/:id/open` | `{}` | `{session,participants}` |
| POST `/api/sessions/:id/close` | `{}` | `{session,absentCount}` |
| POST `/api/sessions/:id/approve-next` | `{}` | `{approvedSession,approvedRoster,session,roster}` |
| POST `/api/sessions/:id/checkins` | `{personId,source:'teacher'|'camera',confidence?}` | `{record,synthetic}` |
| POST `/api/records/:id/correction` | `{status,reason,checkedInAt?}` | `{record}` |
| GET `/api/history` | — | `{history,summary}` current student only |
| GET `/api/sessions/:id/dashboard` | — | `{session,roster,distribution,arrivals,daily}` managers only |

`user` is `{id,email,role,person_id,full_name}`. `capabilities` is `{syntheticCamera:boolean}`, reporting only server demo opt-in. Password hashes never leave the API.

Dashboard roster contains `person_id,person_code,full_name,record_id,status,checked_in_at,method,confidence,source`. Source maps manual to teacher, face to camera and system to system. Opening creates pending roster records once; later membership changes preserve the snapshot. Reopening and repeated check-ins preserve first results. Database time determines arrival and lateness against scheduled start plus threshold. The API prevents opening/finalizing future sessions. Closing atomically marks remaining pending absent. Session row locks serialize check-in/close/correction.

Corrections target present/late/absent, require a trimmed reason of 1–1000 characters and are audited. Present/late require an ISO `checkedInAt` within the actual attendance window and before scheduled end; absent requires no time. An open pending result may be explicitly corrected absent. Identical repeated corrections retain separate explanations in audit history but create no extra state event.

History rows contain `record_id,person_id,session_id,group_id,group_code,course_code,group_name,time_zone,starts_at,ends_at,session_status,status,checked_in_at,method`. Summary rows contain `person_id,group_id,group_code,course_code,term_ends_on,allowed_absences,used_absences,remaining_absences`. Only closed sessions whose scheduled start has arrived count finalized absences. Former memberships retain history. Email preference storage sends no email.

## Events and analytics

`attendance_events` partitions `event_time` in seven-day chunks. Primary key `(event_time,event_id)` includes the time partition column. Foreign keys reference relational record/session/group/person and nullable recorded actor. Pending snapshot events have no record actor; the session-opening audit entry identifies the actual opener. Backfill captures existing current states without inventing past changes.

The AFTER INSERT/UPDATE record trigger writes an event in the workflow transaction. It compares status, check-in time, method and confidence using `IS NOT DISTINCT FROM`; timestamp touches, retries, actor-only changes and identical corrections do not inflate state events. Failed writes roll back their events. Triggers reject event/audit updates or deletes, and restrictive foreign keys protect history. Deactivate subjects/groups instead of deleting them.

Dashboard reads use one REPEATABLE READ transaction. Distribution is `{pending,present,late,absent,total}` from current roster records. Arrivals are `[{bucket,count}]` using native `time_bucket('5 minutes',checked_in_at)` over the latest raw event per record. Corrections immediately remove/rebucket the previous arrival without double counting. Daily is `[{bucket,present,late,absent,pending,total}]` for closed sessions in the selected session's trailing 30-day window, excluding future starts. Native `time_bucket('1 day',starts_at,group.time_zone)` uses course-local midnight; format these timestamptz buckets in the course time zone.

No continuous aggregate is needed for this bounded dashboard: raw events make corrections immediately visible and avoid stale refresh/real-time settings. Larger deployments may later add correction-aware aggregates and a refresh policy. PGlite cannot verify native Timescale extension behavior or performance.

## Synthetic demo and camera boundary

Seeding requires `ALLOW_SYNTHETIC_SEED=true`, a private `DEMO_PASSWORD` of 12–256 characters, and the explicit `--synthetic` argument included in:

```sh
npm run seed:demo
```

It adds `[SYNTHETIC DEMO] Attendance Lab` / `PRESENCE-DEMO-SYNTHETIC`, eight fabricated students, teacher/admin/student accounts, six closed sessions of fabricated history and one hour-long planned session. It performs no deletes. Reruns preserve existing passwords/records; collisions with other identities fail and roll back. Create a new session through the UI after the initial session expires. New-account logins are `teacher@presence-demo.test`, `admin@presence-demo.test`, and `student1@presence-demo.test` through `student8@presence-demo.test`, using the private password. The seed never prints credentials or imports real datasets.

Real camera recognition is unavailable by default. Camera permission or a browser-selected person/confidence is not a trusted match. The adapter receives server request context; a future real adapter must authenticate device/provider proof, enforce consent/liveness and return its own person, enrollment and confidence. The API ignores client confidence for matching. No image-upload endpoint, image persistence or embedding storage exists. Browser video preview remains local.

`ALLOW_SYNTHETIC_CAMERA=true` enables fabricated 0.99 matches only for the exact marked demo group, active membership and active `presence-synthetic-demo` enrollment. Responses are labeled synthetic and results use the face method solely to exercise the workflow. This is not recognition, real consent or evidence about a real person; other groups remain unavailable. Face-enrollment metadata alone cannot perform external provider deletion.

## Verification

`npm test` or `node --test tests/*.test.mjs` runs the unchanged 001/002 baseline through an explicit base-only test path, event/seed/grant checks and a localhost HTTP suite. The separate explicitly labeled PGlite shim removes only Timescale extension/hypertable setup from 003 and supplies local bucket functions. The production missing-extension guard/atomic rollback is independently tested.

Tests cover cookie sessions, scrypt, identity/CSRF/origin checks, group permissions, roster snapshots, deduplication, close/corrections, self-history, raw chart updates, event rollback on audit failure, synthetic recognition guards, future session protection, runtime row-lock privileges, inactive/expired sessions, logout and static credential/data blocks. Localhost tests may need approval in a restricted sandbox; they use isolated synthetic data and no cloud database.

For native Timescale verification, set `TIMESCALE_TEST_DATABASE_URL` to a new empty disposable database named `presence_test...` or `..._test`, and set `TIMESCALE_TEST_ALLOW_EMPTY_DATABASE=true`, then run `npm run test:timescale`. It never falls back to `DATABASE_URL`, refuses existing attendance/tracking/public tables, migrates the schema and verifies native hypertable/timezone buckets, event deduplication and correction/rollback semantics. Synthetic fixtures roll back; only schema setup is committed. No destructive cleanup runs. Without both settings the test skips. A skipped test does not verify a real Timescale service or multi-connection concurrency.
# Persistent local demo

Run `npm run start:local` and open `http://localhost:3000` (use the HTTP URL, not the HTML file). No cloud connection or login page is needed. This separate launcher binds only to loopback and establishes a server-side session for the fixed synthetic demo teacher. It must never be used in production or exposed through a tunnel. It ignores `DATABASE_URL`; the cloud configuration is preserved.

The embedded PGlite database persists at `Backend/.local-db/pgdata`. Eight clearly named synthetic students and example history are seeded additively. Check-ins and corrections are transactional; the existing API and dashboard run against this local data. `npm start` and the existing migration/check commands continue to target the configured PostgreSQL service.

This mode has an ordinary event table and local `date_bin` bucket functions. It has **no TimescaleDB extension or hypertable**, and is not evidence of Tiger Data performance or native Timescale verification. Local schema checksums are tracked separately from production migrations; original migrations are untouched. For the sponsor demo, use a real TimescaleDB service.



## Controlled team recognition camera

From the attendance frontend select **Team camera demo**, or open `/team-demo.html`. In local synthetic mode, with the four team photographs imported using the existing `scripts/import-team-references.mjs` offline workflow, confirm participant consent and start the webcam. Multiple consenting teammates can appear together. The camera shows first names and SFace match scores; these scores are not accuracy probabilities. The Demo participants checkboxes exclude unchecked teammates from the actual matching gallery. Restore everyone re-enables all four. The selection persists in the current browser tab, and stored photos and attendance remain unchanged. An excluded face can still be falsely matched to another enabled reference; Unknown is determined by recognition thresholds, not forced.

The new staff/CSRF-protected `/api/team-demo/detect` route restricts mappings to the four existing team reference records and requires management permission for their group. It saves no attendance, alerts, reviews or camera frames and does not call the existing scenario modules. Existing attendance pages, check-in endpoints and migrations remain unchanged. Models and the Python environment use the existing face-worker setup.


### Temporary demo participant

The team camera can capture one consenting judge/guest and a display name. Up to five guests per staff account, 64 total, are held in memory for at most one hour. Delete participant removes the in-memory SFace feature and name. Server/worker restart also clears temporary references; none are stored in the database, on disk, or in Git. Capture requires exactly one detected face, minimum 80px on each axis and detector confidence >=0.7. Guest features compete with active team references using the same SFace threshold and ambiguity margin. Temporary data is scoped to the authenticated staff account.
