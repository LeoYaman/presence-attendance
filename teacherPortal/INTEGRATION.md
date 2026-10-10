# Presence — frontend ↔ recognition backend

The frontend does **not** recognize faces. It shows the camera preview, draws
whatever the backend reports, checks students in, and lets the teacher fix or
approve the list. Everything goes through `window.Presence`.

## 1. Send recognition results

Call once per processed frame, with one entry per face:

```js
window.Presence.recognize([
  {
    studentId: "s05",          // roster id, or null if nobody matched
    confidence: 0.91,          // 0–1
    box: { x: 0.38, y: 0.20, width: 0.24, height: 0.42 } // optional, normalized 0–1 of the camera frame
  }
]);
```

Send `[]` when no face is in frame. Boxes use the **un-mirrored** camera frame;
the UI handles the mirror and cropping.

What the UI does with each result:

| Confidence | Level | UI behavior |
|---|---|---|
| ≥ 0.85 | High | Checks the student in automatically (Present, or Late after 10 min) |
| 0.60–0.85 | Uncertain | Suggests the student; teacher confirms or picks someone else |
| < 0.60 | Low | Shows "Unknown student"; teacher picks from the list |

Thresholds are placeholders: change them in `THRESHOLDS` in `app.js`
(also readable as `window.Presence.thresholds`).

## 2. Get camera frames

The UI owns the camera. When it starts, it fires:

```js
document.addEventListener("presence:camera-start", e => {
  const video = e.detail.video;   // same as window.Presence.getVideo()
  // grab frames from `video` (canvas.drawImage / ImageCapture) and send them to the model
});
document.addEventListener("presence:camera-stop", () => { /* stop sending */ });
```

If the backend would rather own the camera (e.g. a classroom camera on a
server), skip this and just call `recognize()` — the overlay still works,
but the preview area will be empty. Tell the frontend and we can swap the
`<video>` for an image/stream URL.

## 3. Load the real roster

```js
window.Presence.setRoster([
  { id: "s01", number: "001", name: "Alex Morgan" },
  // ...
]);
```

`studentId` values in `recognize()` must match these `id`s.

## 4. Receive results

```js
// every check-in (camera or teacher)
document.addEventListener("presence:checkin", e => {
  // e.detail = { studentId, status: "present"|"late", source: "camera"|"teacher", time }
});

// teacher pressed "Approve the attendance"
document.addEventListener("presence:approved", e => {
  // e.detail = { approvedAt, sessionStart, students: [{ id, name, status, source, time }] }
});
```

`window.Presence.getRoster()` returns the current state at any time.

## Demo mode

"Run demo" feeds mock results through the same `recognize()` path
(high → uncertain → low …), so it behaves exactly like the real backend.
