"use strict";

(() => {
  const page = document.body.dataset.subjectsApp;
  if (page !== 'parent-child') return;

  const video = document.getElementById('workspace-video');
  const result = document.getElementById('pickup-demo-result');
  const config = document.getElementById('pickup-demo-config');
  const requestsList = document.getElementById('pickup-demo-requests');
  const refreshButton = document.getElementById('pickup-demo-refresh');
  const approvalStatus = document.getElementById('pickup-demo-approval');
  const pairStatus = document.getElementById('pickup-pair-status');
  const history = document.getElementById('pickup-demo-history');
  const attention = document.getElementById('pickup-approval-attention');
  const attentionNames = document.getElementById('pickup-attention-names');
  const attentionButton = document.getElementById('pickup-attention-approve');
  let activeApprovalButton = null;
  attentionButton?.addEventListener('click', () => activeApprovalButton?.click());
  function renderHistory(approvals) {
    if (!history || !Array.isArray(approvals)) return;
    history.replaceChildren();
    for (const approval of approvals) {
      const item = document.createElement('li');
      item.className = 'student';
      item.textContent = `Approved — ${(approval.matchedNames || []).join(' and ')} were seen together. Demo exit approved. · ${new Date(approval.createdAt).toLocaleString('en-US')}`;
      history.append(item);
    }
    if (!approvals.length) {
      const item = document.createElement('li'); item.className = 'usecase-empty';
      item.textContent = 'No approved exits recorded yet.'; history.append(item);
    }
  }
  const setPairStatus = text => { if(pairStatus)pairStatus.textContent=text; };
  let csrfToken = '';
  let enabled = false;
  let recognitionGeneration = 0;
  let recognitionRequest = null;
  let refreshGeneration = 0;
  let currentRequests = [];
  let archiveExpanded = false;
  let approvalInFlight = false;

  let cameraGeneration = 0;
  let cameraActive = Boolean(video?.dataset.active);
  let resetInFlight = null;
  let resetNeeded = false;

  async function fetchJson(path, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(payload?.error?.message || `Request failed (${response.status}).`); error.code = payload?.error?.code; throw error; }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function renderRequests(requests) {
    activeApprovalButton = null;
    if (attention) attention.hidden = true;
    currentRequests = Array.isArray(requests) ? requests : [];
    requestsList.replaceChildren();
    if (!currentRequests.length) {
      const empty = document.createElement('li');
      empty.className = 'usecase-empty';
      empty.textContent = 'No pickup requests are available.';
      requestsList.append(empty);
      return;
    }
    const inactive = currentRequests.filter(request => ['superseded', 'expired'].includes(request.status));
    let archiveList;
    const archive = document.createElement('li');
    if (inactive.length) {
      archive.className = 'pickup-archive';
      const details = document.createElement('details');
      details.open = archiveExpanded;
      details.addEventListener('toggle', () => { if (details.isConnected) archiveExpanded = details.open; });
      const summary = document.createElement('summary');
      summary.textContent = `Previous requests (${inactive.length})`;
      const explanation = document.createElement('p');
      explanation.className = 'pickup-archive-note';
      explanation.textContent = 'These requests are no longer available for approval. A new camera observation creates a new request when needed.';
      archiveList = document.createElement('ul');
      archiveList.className = 'pickup-archive-list';
      details.append(summary, explanation, archiveList);
      archive.append(details);
    }
    if (inactive.length === currentRequests.length) {
      const empty = document.createElement('li');
      empty.className = 'pickup-current-empty';
      empty.textContent = 'No pickup is waiting for approval.';
      requestsList.append(empty);
    }
    for (const request of currentRequests) {
      const item = document.createElement('li');
      item.className = 'pickup-request';
      const info = document.createElement('span');
      info.className = 'pickup-request-info';
      const title = document.createElement('span');
      title.className = 'pickup-request-title';
      const participants = Array.isArray(request.matchedNames) ? request.matchedNames.filter(name => typeof name === 'string' && name.trim()) : [];
      title.textContent = participants.length ? `Pickup for ${participants.join(' + ')}` : 'Pickup request';
      const badge = document.createElement('span');
      badge.className = `pickup-request-badge pickup-request-badge--${['pending','approved','expired','superseded'].includes(request.status) ? request.status : 'unknown'}`;
      badge.textContent = {pending:'Pending approval',approved:'Approved',expired:'Expired',superseded:'No longer active'}[request.status] || 'Status unavailable';
      const description = document.createElement('span');
      description.className = 'pickup-request-description';
      description.textContent = request.status === 'superseded'
        ? 'The camera observation changed or ended. This earlier request can no longer be approved.'
        : request.status === 'expired' ? 'The approval window ended. Check the participants again to create a new request.'
        : request.status === 'approved' ? 'The operator approved this demo pickup.'
        : participants.length === 1 ? 'Cannot exit alone.' : String(request.reason || 'Review the participants before approving this demo pickup.');
      const meta = document.createElement('span');
      meta.className = 'pickup-request-time';
      const date = request.createdAt ? new Date(request.createdAt) : null;
      const created = date && !Number.isNaN(date.valueOf()) ? date.toLocaleString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Time unavailable';
      meta.textContent = `Requested ${created}`;
      info.append(title, badge, description, meta);
      item.append(info);
      if (request.canApprove === true && participants.length === 2) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'button button--secondary';
        button.textContent = 'Approve demo pickup';
        button.disabled = approvalInFlight;
        button.addEventListener('click', async () => {
          if (approvalInFlight) return;
          approvalInFlight = true;
          button.disabled = true;
          window.dispatchEvent(new CustomEvent('pickup:approval-start'));
          try {
            let data;
            for (let attempt = 0; attempt < 5; attempt++) {
              try { data = await fetchJson(`/api/pickup-demo/requests/${encodeURIComponent(request.id)}/approve`, {method:'POST',body:{}}); break; }
              catch (error) { if (error.code !== 'pickup_busy' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
            }
            if (cameraActive) result.textContent = `Approved · ${data.reason || 'Demo pickup approved.'}`;
            approvalStatus.textContent = 'Demo pickup approved by the operator.';
            await refresh();
          } catch (error) { approvalStatus.textContent = error.message; await refresh(); }
          finally { approvalInFlight = false; window.dispatchEvent(new CustomEvent('pickup:approval-end')); }
        });
        item.append(button);
        if (attention && attentionNames && attentionButton && request.status === 'pending' && !activeApprovalButton && participants.length === 2) {
          activeApprovalButton = button;
          attention.hidden = false;
          attentionNames.textContent = `${participants.join(' + ')} identified together. Review and approve this demo pickup.`;
          attentionButton.disabled = approvalInFlight;
        }
      }
      if (['superseded','expired'].includes(request.status)) archiveList.append(item);
      else requestsList.append(item);
    }
    if (inactive.length) requestsList.append(archive);
  }

  function renderConfiguration(data) {
    enabled = data?.enabled === true;
    if (!enabled) {
      config.textContent = 'Exit approval is not configured. Face recognition runs independently; see the live recognition result above the camera.';
      return;
    }
    config.textContent = 'Manual demo approval requires two verified participants.';
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    refreshButton.disabled = true;
    try {
      const data = await fetchJson('/api/pickup-demo');
      if (generation !== refreshGeneration) return;
      renderConfiguration(data);
      renderRequests(data.requests);
      renderHistory(data.approvals);
      if (resetNeeded && csrfToken) void resetServerState(cameraGeneration);
    } catch (error) {
      if (generation === refreshGeneration && error.name !== 'AbortError') {
        config.textContent = error.message;
        renderRequests([]);
      }
    } finally {
      if (generation === refreshGeneration) refreshButton.disabled = false;
    }
  }

  async function initialize() {
    try {
      const session = await fetchJson('/api/me');
      if (!session.user || !['teacher', 'admin'].includes(session.user.role) || typeof session.csrfToken !== 'string' || !session.csrfToken) {
        throw new Error('Sign in with an authorized teacher or admin account to use this demo.');
      }
      csrfToken = session.csrfToken;
      await refresh();

      if (resetNeeded) void resetServerState(cameraGeneration);
      window.setInterval(() => { void refresh(); }, 5000);
    } catch (error) {
      config.textContent = error.message;
      renderRequests([]);
    }
  }

  async function onRecognition(event) {
    if (event.detail?.app !== 'parent-child') return;
    if (!cameraActive || !video?.dataset.active) return;
    const matches = Array.isArray(event.detail.result?.matches) ? event.detail.result.matches : [];
    const names = matches.filter(m => m?.identityMatched===true && typeof m.subjectId==='string' && typeof m.name==='string').map(m=>m.name.trim().toLowerCase());
    const leo=names.includes('leo'), rebeca=names.includes('rebeca')||names.includes('rebbeca'), anthony=names.includes('anthony');
    setPairStatus(matches.length === 1 ? 'Cannot exit alone.' : matches.length > 2 ? 'More than two participants identified. No pickup approval.' : matches.some(m => m?.identityMatched !== true) ? 'An unknown participant is present. No pickup approval.' : anthony && rebeca ? 'Rebeca and Anthony identified. Manual demo approval required.' : leo && anthony ? 'Leo and Anthony were identified in the same frame.' : names.length === 2 ? 'Two participants identified. Manual demo approval required.' : names.length ? 'Cannot exit alone.' : 'No participants identified.');
    if (!enabled && !event.detail.pickupDecision) {
      result.textContent = 'Face recognition is active. Exit approval is not configured; no pickup decision was made.';
      return;
    }
    if (event.detail.pickupDecision) {
      const data = event.detail.pickupDecision;
      if (!data.request && attention) { attention.hidden = true; activeApprovalButton = null; }
      renderHistory(data.approvals);
      const names = Array.isArray(data.matchedNames) ? data.matchedNames.join(', ') : '';
      const label = {approved:'Approved',blocked:'Blocked',pending:'Pending approval',waiting:'Waiting'}[data.state] || 'Waiting';
      result.textContent = Array.isArray(data.matchedNames) && data.matchedNames.length === 1 ? 'Blocked \u00b7 Cannot exit alone.' : [label, data.reason || '', names ? `Matched: ${names}` : ''].filter(Boolean).join(' \u00b7 ');
      if (data.request) { refreshGeneration++; refreshButton.disabled = false; renderRequests([data.request, ...currentRequests.filter(request => request.id !== data.request.id)]); }
      return;
    }
    if (recognitionRequest || resetInFlight) return;
    if (!video?.dataset.active || typeof event.detail.image !== 'string' || !event.detail.image) return;
    const generation = ++recognitionGeneration;
    const controller = new AbortController();
    recognitionRequest = controller;
    const image = event.detail.image.replace(/^data:image\/jpeg;base64,/, '');
    result.textContent = 'Checking pickup demo rules with the server…';
    try {
      const data = await fetchJson('/api/pickup-demo/decide', {
        method: 'POST', body: { image }, signal: controller.signal
      });
      if (generation !== recognitionGeneration || !video.dataset.active) return;
      const names = Array.isArray(data.matchedNames) ? data.matchedNames.join(', ') : '';
      result.textContent = Array.isArray(data.matchedNames) && data.matchedNames.length === 1 ? 'Blocked \u00b7 Cannot exit alone.' : [data.state || 'waiting', data.reason || '', names ? `Matched: ${names}` : ''].filter(Boolean).join(' \u00b7 ');
      if (data.request) { refreshGeneration++; refreshButton.disabled = false; renderRequests([data.request, ...currentRequests.filter(request => request.id !== data.request.id)]); }
    } catch (error) {
      if (generation === recognitionGeneration && error.name !== 'AbortError') result.textContent = `Pickup check unavailable: ${error.message}`;
    } finally {
      if (recognitionRequest === controller) recognitionRequest = null;
    }
  }

  async function resetServerState(stopGeneration) {
    if (!csrfToken || resetInFlight) return resetInFlight;
    const reset = fetchJson('/api/pickup-demo/reset', { method: 'POST', body: {} });
    resetInFlight = reset;
    try {
      await reset;
      resetNeeded = false;
      if (stopGeneration === cameraGeneration && !cameraActive) result.textContent = 'Camera is off. Server pickup state was reset.';
    } catch (error) {
      if (stopGeneration === cameraGeneration) result.textContent = `${cameraActive ? 'Recognition unavailable' : 'Camera is off'}. Server reset failed: ${error.message}`;
    } finally {
      if (resetInFlight === reset) resetInFlight = null;
    }
  }

  window.addEventListener('workspace:camera-start', () => {
    cameraGeneration++;
    cameraActive = true;
    setPairStatus('No participants identified.');
    result.textContent = resetInFlight ? 'Camera is on. Waiting for the server reset to finish…' : 'Camera is on. Waiting for server verification…';
  });

  window.addEventListener('subjects:recognition-error', event => {
    if (event.detail?.app && event.detail.app !== 'parent-child') return;
    if (attention) attention.hidden = true;
    activeApprovalButton = null;
    recognitionGeneration++;
    recognitionRequest?.abort();
    recognitionRequest = null;
    setPairStatus('Recognition unavailable. No participants verified.');
    if (cameraActive) result.textContent = `Recognition unavailable: ${String(event.detail?.error || event.detail?.message || 'Camera recognition failed.')}`;
    resetNeeded = true;
    if (csrfToken) void resetServerState(cameraGeneration);
  });

  window.addEventListener('subjects:pickup-error', event => {
    result.textContent = `Pickup decision unavailable: ${String(event.detail?.message || 'The server could not evaluate the pickup rules.')}`;
  });

  window.addEventListener('subjects:recognition', onRecognition);
  window.addEventListener('workspace:camera-stop', () => {
    if (attention) attention.hidden = true;
    activeApprovalButton = null;
    cameraGeneration++;
    cameraActive = false;
    setPairStatus('Camera is off.');
    recognitionGeneration++;
    recognitionRequest?.abort();
    recognitionRequest = null;
    result.textContent = 'Camera is off. Clearing server pickup state…';
    resetNeeded = true;
    if (csrfToken) void resetServerState(cameraGeneration);
    else result.textContent = 'Camera is off. Server reset will run after sign-in.';
  });
  refreshButton.addEventListener('click', refresh);
  void initialize();
})();
