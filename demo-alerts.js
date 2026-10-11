'use strict';
// This page has no camera, recognition, attendance writes, or emergency-service integration.
const flightDemo = globalThis.location?.search?.includes('scenario=flight') === true;
if(flightDemo){document.title='Presence ? Fictional flight booking';document.querySelector('h1').textContent='Fictional flight booking demo';document.querySelector('.intro').textContent='Manually demonstrate the booking status of a fictional reservation. This does not use face recognition or make a real boarding decision.';}
const element = id => document.getElementById(id);
const state = { authenticated: false, csrf: '', records: [], feedReady: false, refreshing: false, simulating: false, version: 0 };
let timer;
const selectedRecord = () => state.records.find(record => String(record.id) === element('record').value);
function status(message, error = false) {
  element('status').textContent = message;
  element('status').dataset.error = String(error);
}
function controls() {
  element('refresh').disabled = state.refreshing || state.simulating;
  element('record').disabled = !state.authenticated || !state.feedReady || state.simulating;
  element('simulate').disabled = !state.authenticated || !state.feedReady || !selectedRecord() || state.refreshing || state.simulating;
}
function details() {
  const record = selectedRecord();
  element('record-name').textContent = record ? record.name : '—';
  element('record-scenario').textContent = record ? record.scenario : 'Select a record to view its scenario.';
  controls();
}
function clearResult() {
  element('result-heading').textContent = 'Waiting for simulation';
  element('result-message').textContent = 'Choose a fictional record, then press “Simulate demo alert”.';
}
function signedOut() {
  state.version++;
  state.authenticated = false;
  state.csrf = '';
  state.feedReady = false;
  state.records = [];
  clearTimeout(timer);
  element('record').replaceChildren(new Option('Choose a fictional record', ''));
  element('count').textContent = 'No feed loaded.';
  element('source-status').hidden = true;
  element('source-status').textContent = '';
  element('account').textContent = 'Sign in with an authorized demo account, then refresh this page.';
  clearResult();
  details();
}
async function request(path, body) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) })
  });
  if (response.status === 401) signedOut();
  let payload;
  try { payload = await response.json(); } catch { throw new Error('The demo server returned an unreadable response.'); }
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || `Demo request failed (${response.status}).`), { status: response.status });
  return payload;
}
function renderFeed(payload) {
  if (payload.synthetic !== true || !Array.isArray(payload.records)) throw new Error('The server did not return a verified synthetic demo feed.');
  const ids = new Set();
  for (const record of payload.records) {
    if (!record || !['string', 'number'].includes(typeof record.id) || !String(record.id) || typeof record.name !== 'string' || typeof record.scenario !== 'string' || ids.has(String(record.id))) throw new Error('The synthetic demo feed contains an invalid record.');
    ids.add(String(record.id));
  }
  const previous = element('record').value;
  state.records = flightDemo ? payload.records.filter(record=>record.id==='demo-flight-booking') : payload.records;
  element('record').replaceChildren(new Option('Choose a fictional record', ''), ...state.records.map(record => new Option(record.name, String(record.id))));
  if (ids.has(previous)) element('record').value = previous;
  else if(flightDemo && state.records.length===1)element('record').value=state.records[0].id;
  if (previous && !ids.has(previous)) clearResult();
  state.feedReady = true;
  element('count').textContent = `${state.records.length} fictional record${state.records.length === 1 ? '' : 's'} · Last refreshed ${new Date().toLocaleTimeString()}`;
  const sync = payload.sync;
  const sourceError = typeof sync?.lastError === 'string' && sync.lastError;
  const syncTime = sync?.lastSyncedAt ? new Date(sync.lastSyncedAt) : null;
  const validTime = syncTime && Number.isFinite(syncTime.getTime());
  element('source-status').hidden = !sourceError && !validTime;
  element('source-status').dataset.error = String(Boolean(sourceError));
  element('source-status').textContent = sourceError
    ? `Source synchronization warning: ${sourceError} Showing the previous valid database feed; recent file changes may not be reflected.`
    : validTime ? `Source last synchronized ${syncTime.toLocaleString()}.` : '';
  details();
}
async function refresh() {
  if (state.refreshing || state.simulating) return;
  clearTimeout(timer);
  state.refreshing = true;
  controls();
  try {
    if (!state.authenticated) {
      const session = await request('/api/me');
      if (!session.user || typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('An authenticated demo session is required.');
      state.authenticated = true;
      state.csrf = session.csrfToken;
      element('account').textContent = `Signed in · ${session.user.full_name || session.user.email || session.user.role || 'Demo account'}`;
    }
    const version = state.version;
    const payload = await request('/api/demo-alerts');
    if (version !== state.version) return;
    renderFeed(payload);
    status(state.records.length ? 'Synthetic feed connected. Automatic refresh every 10 seconds.' : 'Synthetic feed connected. No fictional records are currently available.');
  } catch (error) {
    state.feedReady = false;
    status(error.status === 401 ? 'Session unavailable. Sign in, then use Refresh feed.' : `Feed unavailable: ${error.message} Simulation is disabled until a successful refresh.`, true);
  } finally {
    state.refreshing = false;
    controls();
    if (state.authenticated) timer = setTimeout(refresh, 10000);
  }
}
element('refresh').addEventListener('click', refresh);
element('record').addEventListener('change', () => { clearResult(); details(); });
element('simulate').addEventListener('click', async () => {
  const record = selectedRecord();
  if (!record || !state.authenticated || !state.feedReady || state.simulating || state.refreshing) return;
  state.simulating = true;
  clearTimeout(timer);
  controls();
  clearResult();
  element('result-message').textContent = 'Running a synthetic scenario… No real notification will be sent.';
  const version = state.version;
  try {
    const payload = await request('/api/demo-alerts/simulate', { id: record.id });
    if (version !== state.version) return;
    const expectedTitle = record.id === 'demo-flight-booking' ? 'Demo — Not allowed on this flight' : 'DEMO — Faculty security is getting informed';
    if (payload.synthetic !== true || payload.notificationSent !== false || payload.title !== expectedTitle) throw new Error('The server did not confirm a safe synthetic result.');
    const explanation = typeof payload.message === 'string' ? payload.message : payload.explanation;
    if (typeof explanation !== 'string' || !explanation) throw new Error('The server did not provide a simulation explanation.');
    element('result-heading').textContent = payload.title;
    element('result-message').textContent = explanation;
    status('Simulation complete. No real call or notification was sent.');
  } catch (error) {
    if (version === state.version) {
      element('result-heading').textContent = 'Simulation unavailable';
      element('result-message').textContent = error.message;
      status('Simulation failed. No successful result is being reported.', true);
      state.feedReady = false;
    }
  } finally {
    state.simulating = false;
    controls();
    if (state.authenticated) timer = setTimeout(refresh, 10000);
  }
});
window.addEventListener('pagehide', () => { clearTimeout(timer); state.version++; });
refresh();
