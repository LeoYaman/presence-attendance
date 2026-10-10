import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Reuses this repository's MediaPipe/OpenCV pipeline. Samples live in RAM only.
export function createFaceWorker({ python = process.env.FACE_PYTHON || fileURLToPath(new URL(process.platform === 'win32' ? '../../face_data/.venv/Scripts/python.exe' : '../../face_data/.venv/bin/python', import.meta.url)), timeout = 30000 } = {}) {
  let child, sequence = 0;
  const pending = new Map();
  function unavailable() { return Object.assign(new Error('Face service unavailable. Set up face_data/.venv and download the model; see face_data/README.md.'), { status: 503, code: 'face_service_unavailable' }); }
  function rejectAll() { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(unavailable()); } pending.clear(); }
  function launch() {
    const process = spawn(python, ['-u', fileURLToPath(new URL('../../face_data/recognition_worker.py', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = process;
    createInterface({ input: process.stdout }).on('line', line => {
      let result; try { result = JSON.parse(line); } catch { return; }
      const request = pending.get(result.id); if (!request) return;
      clearTimeout(request.timer); pending.delete(result.id);
      if (result.error) request.reject(Object.assign(new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Face processing failed'), { status: 422, code: 'invalid_face_frame' }));
      else request.resolve(result);
    });
    process.stderr.on('data', () => {}); // Never log camera frames or biometric samples.
    process.stdin.on('error', () => { if (child === process) { child = null; rejectAll(); process.kill(); } });
    process.on('error', () => { if (child === process) { child = null; rejectAll(); } });
    process.on('exit', () => { if (child === process) { child = null; rejectAll(); } });
  }
  return {
    request(payload) {
      if (pending.size >= 4) return Promise.reject(Object.assign(new Error('Face service busy; retry shortly.'), { status: 429, code: 'face_service_busy' }));
      if (!child) launch();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { const current = child; child = null; rejectAll(); current?.kill(); }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
      });
    },
    close() { const current = child; child = null; rejectAll(); current?.kill(); }
  };
}
