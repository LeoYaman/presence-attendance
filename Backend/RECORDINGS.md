# Attendance video

The real live camera automatically records silent video while face recognition
and acknowledged attendance writes continue independently. Synthetic camera
demos never record. The attendance page shows recording/upload/save failures,
saved course recordings and links to a student's acknowledged check-in time.

The browser targets 1 Mbps and sends five-second MediaRecorder chunks over
authenticated requests. It uses the existing camera stream without changing
recognition's camera constraints. Actual video resolution and frame rate depend
on that camera; the bitrate is a browser target, not a fixed storage guarantee.
Uploads are ordered and idempotent, with bounded retries and a 32 MiB browser
backlog. An upload failure never stops recognition or marks video as saved.
Long camera runs are split into continuing segments below the two-hour file
limit; segment upload/finalization does not delay capture of the next segment.

## Storage and processing

`RECORDINGS_DIR` defaults to `Backend/.recordings`. Store this directory on a
persistent volume owned by one server process. Each recording has an atomic
JSON manifest and durable ordered chunks; video does not enter SQL or trigger
full local database snapshots. Chunk uploads are capped at 8 MiB, and each
recording is capped at 1 GiB and two hours of captured video. A fifteen-minute
upload grace allows the final queued chunks to reach the server.

FFmpeg stream-copies uploaded WebM or MP4 into an indexed file after capture
stops; it does not re-encode frames. Provide `FFMPEG_PATH`, place the executable
at `Backend/.tools/ffmpeg/ffmpeg.exe` on Windows (or `ffmpeg` on other systems),
or install `ffmpeg` on the server PATH. A checksum-verified portable Windows
build is provisioned in the current checkout's ignored `.tools` directory.
Provision this binary separately when deploying to another machine.

When processing fails, source chunks remain recoverable. Finished recordings
support authenticated HTTP byte ranges for native video playback and seeking.
Only current managers of that course or an administrator may list/play video;
only its owner can upload/finalize it. Mutations require the session cookie,
matching Origin and CSRF token. Videos are excluded from the public file list.

## Retention

Access expires exactly seven days after the server creates a recording.
Cleanup runs at startup and every five minutes to remove expired files, including unfinished
uploads. Physical deletion can lag expiry until the next cleanup run, but an
expired recording cannot be played. Keep backup retention consistent with this
rule; application cleanup does not control external server backups.

Closing a browser can interrupt the last upload. Server maintenance recovers
already-uploaded footage after fifteen minutes of inactivity and marks it as recovered;
the missing ending is not described as a complete recording.

## Validation

From `Backend`, run `node --test tests/recording-store.test.mjs
tests/recording-api.test.mjs`. The real video tests require FFmpeg and verify
frame preservation, seekable container output, authorized range requests,
idempotent uploads, recovery and expiry. From the repository root, run
`node --test tests/recording-client.test.mjs` for browser lifecycle behavior.
