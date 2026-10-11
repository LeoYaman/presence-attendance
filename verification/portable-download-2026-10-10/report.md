# GitHub download portability verification

Verified on Windows with Node.js 24.19, 64-bit Python 3.12.14 and headless Microsoft Edge.

A separate copy contained only repository files, with no `.git`, `node_modules`, Python environment, downloaded models, databases, registry keys or recordings. `npm ci` installed the locked Node workspaces. `npm run setup` created a new Python environment, installed camera/video dependencies, downloaded all three models, checked the four bundled photographs and prepared FFmpeg. This machine's globally registered Python was 32-bit; setup correctly refused it. Supplying the installed 64-bit interpreter via `SETUP_PYTHON` completed setup without using the original repository's environment.

The documented `npm start` command launched both services and served the Use Cases screen. Independent browser contexts selected all four roles without opening a password dialog:

| Selection | Destination | Session | Screenshot |
|---|---|---|---|
| Professor | `/index.html` | server-issued demo teacher | [Professor](professor.png) |
| Student | `/student.html?demo=1` | managed student preview | [Student](student.png) |
| Faculty | `/parent-child.html` | server-issued demo teacher | [Faculty](faculty.png) |
| Security | `/criminal-detection.html` | server-issued demo teacher | [Security](security.png) |

All four pages produced no JavaScript page errors. APIs returned ten catalog courses, 34 people per tested catalog roster, four registered subjects in each workspace, and enabled pickup configuration. Anthony and Olivia each matched in attendance, parent-child and subject-finder through the real local worker, using the original bundled reference photographs. These six checks validate reference loading and API matching; they do not measure live webcam accuracy. Restart retained all four subjects and existing attendance sessions.

The internal registry client remained on loopback even when a remote public-origin setting was present. Authentication tests confirmed Host/Origin and JSON input restrictions, trusted teacher sessions, no password-free entry through ordinary production API startup, and exclusive attendance snapshot ownership. Fixture tests confirmed resumable first-run failure without overwriting changed data and no resurrection of subjects deleted after completed initialization.

Final automated validation: 273 JavaScript tests passed, one native TimescaleDB integration test skipped without its dedicated database configuration, and 36 Python tests passed. Database lease tests cover live owners, stale recovery, simultaneous recovery attempts, orphan recovery claims, invalid owners and failed lock writes.

Prerequisites remain Node.js 22+, 64-bit Python 3.12+, internet for first-time package/model downloads, and browser camera permission/participant consent. Local databases use PGlite rather than native TimescaleDB. RunPod credentials, sessions and private database state are not part of a GitHub download. No cloud database migration or live RunPod deployment was performed by this verification.
