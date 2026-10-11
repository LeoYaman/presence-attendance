(() => {
  const $ = id => document.getElementById(id);
  const elements = {
    panel: $('databricks-panel'), select: $('analytics-report'), file: $('analytics-file'),
    status: $('analytics-status'), listStatus: $('analytics-list-status'), results: $('analytics-results'), clear: $('analytics-clear'),
    group: $('analytics-group'), export: $('analytics-export'), demoDownload: $('analytics-demo-download')
  };
  if (!elements.select || !elements.results || !elements.status) return;

  let requestVersion = 0;
  let listVersion = 0;
  let reportTimer = null;

  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, name, max = 500) => {
    if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid report: ${name}`);
    return value;
  };
  const date = (value, name) => {
    string(value, name, 100);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid report: ${name}`);
    return parsed;
  };
  const count = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid report: ${name}`);
    return value;
  };
  const rate = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Invalid report: ${name}`);
    return value;
  };
  const validUUID = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
  const option = (label, value) => { const node = document.createElement('option'); node.textContent = label; node.value = value; return node; };

  function validateClasses(classes) {
    if (!Array.isArray(classes) || classes.length > 1000) throw new Error('Invalid report: classes');
    for (const item of classes) {
      if (!isRecord(item)) throw new Error('Invalid report: class entry');
      string(item.class_code, 'class_code', 200);
      count(item.total, 'total'); count(item.attended, 'attended');
      count(item.late, 'late'); count(item.absent, 'absent');
      rate(item.attendance_rate, 'attendance_rate'); rate(item.late_rate, 'late_rate');
      string(item.suggestion, 'suggestion', 2000);
      if (item.attended + item.absent !== item.total || item.late > item.attended) throw new Error('Invalid report: inconsistent class metrics');
      const expectedAttendance = item.total === 0 ? 0 : item.attended / item.total * 100;
      const expectedLate = item.total === 0 ? 0 : item.late / item.total * 100;
      if (Math.abs(item.attendance_rate - expectedAttendance) > 0.051 || Math.abs(item.late_rate - expectedLate) > 0.051) throw new Error('Invalid report: rates do not match counts');
    }
  }

  function validateDatabricksReport(data) {
    if (!isRecord(data) || data.version !== 1 || data.engine !== 'Databricks Spark' || typeof data.synthetic !== 'boolean') throw new Error('Invalid Databricks report schema');
    date(data.generated_at, 'generated_at');
    validateClasses(data.classes);
    if (data.quality !== undefined) {
      if (!isRecord(data.quality)) throw new Error('Invalid report: quality');
      for (const key of ['input_rows', 'clean_rows', 'duplicates_removed']) count(data.quality[key], `quality.${key}`);
    }
    if (data.daily !== undefined) {
      if (!Array.isArray(data.daily) || data.daily.length > 10000) throw new Error('Invalid report: daily');
      for (const item of data.daily) {
        if (!isRecord(item)) throw new Error('Invalid report: daily entry');
        string(item.class_code, 'daily.class_code', 200); string(item.day, 'daily.day', 20);
        count(item.total, 'daily.total'); count(item.attended, 'daily.attended'); count(item.late, 'daily.late');
      }
    }
    return data;
  }

  function validatePresenceReport(data) {
    if (!isRecord(data) || data.version !== 1 || data.engine !== 'Presence Attendance' || typeof data.synthetic !== 'boolean' || !isRecord(data.session)) throw new Error('Invalid Presence report schema');
    date(data.generated_at, 'generated_at');
    const session = data.session;
    if (!validUUID(session.id)) throw new Error('Invalid report: session.id');
    string(session.class_code, 'session.class_code', 200); string(session.class_name, 'session.class_name', 500);
    date(session.starts_at, 'session.starts_at'); date(session.ends_at, 'session.ends_at'); date(session.closed_at, 'session.closed_at');
    if (Date.parse(session.ends_at) < Date.parse(session.starts_at) || Date.parse(session.closed_at) < Date.parse(session.starts_at)) throw new Error('Invalid report: session timing');
    validateClasses(data.classes);
    if (data.classes.some(item => item.class_code !== session.class_code)) throw new Error('Invalid report: class does not match session');
    return data;
  }

  function clearContent(message = 'No report selected. Choose a report or import a Databricks JSON file.') {
    elements.results.replaceChildren();
    elements.status.textContent = message;
  }

  function timezoneLabel() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local timezone'; }
    catch { return 'local timezone'; }
  }
  function formatDateTime(value) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }
  function reportLabel(report) {
    return `${report.class_code} · ${report.class_name} — ${formatDateTime(report.starts_at)}`;
  }

  function render(data, source) {
    const classes = data.classes;
    const nodes = classes.map(item => {
      const article = document.createElement('article'); article.className = 'analytics-card';
      const heading = document.createElement('h3'); heading.textContent = item.class_code;
      const metrics = document.createElement('p');
      metrics.textContent = `${item.attendance_rate}% attendance · ${item.late_rate}% late · ${item.total} records (${item.attended} attended, ${item.late} late, ${item.absent} absent)`;
      const suggestion = document.createElement('p'); suggestion.textContent = item.suggestion;
      article.append(heading, metrics, suggestion);
      return article;
    });
    elements.results.replaceChildren(...nodes);

    if (data.engine === 'Presence Attendance') {
      const session = data.session;
      elements.status.textContent = `${source}. Source: finalized Presence Attendance session for ${session.class_name} (${session.class_code}). Session date: ${new Date(session.starts_at).toLocaleDateString()}; start: ${formatDateTime(session.starts_at)}; end: ${formatDateTime(session.ends_at)}; closed: ${formatDateTime(session.closed_at)}. Times shown in ${timezoneLabel()}. Generated: ${formatDateTime(data.generated_at)}. ${data.synthetic ? 'Synthetic data.' : 'Session marked non-synthetic.'}`;
    } else {
      elements.status.textContent = `${source}. Source: Databricks Spark JSON report. Generated: ${formatDateTime(data.generated_at)}. ${data.synthetic ? 'Synthetic data.' : 'Report marked non-synthetic.'} Historical report; this display does not run a live Databricks analysis.`;
    }
  }

  async function fetchJSON(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body;
    try { body = await response.json(); } catch { throw new Error('The server returned an invalid JSON response.'); }
    if (!response.ok) {
      const error = new Error(typeof body?.error === 'string' ? body.error : (typeof body?.error?.message === 'string' ? body.error.message : `Request failed (${response.status}).`));
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function selectReport(value) {
    const token = ++requestVersion;
    clearContent();
    if (!value) return;
    try {
      const data = value === 'demo'
        ? validateDatabricksReport(await fetchJSON('/databricks/demo-results.json'))
        : validatePresenceReport(await fetchJSON(`/api/attendance-insights/reports/${encodeURIComponent(value)}`));
      if (token !== requestVersion) return;
      render(data, value === 'demo' ? 'Bundled demo report' : 'Finalized session report');
    } catch (error) {
      if (token === requestVersion) clearContent(`Could not load the selected report: ${error.message}`);
    }
  }

  async function refreshReports() {
    const token = ++listVersion;
    try {
      const data = await fetchJSON('/api/attendance-insights/reports');
      if (token !== listVersion) return;
      if (!isRecord(data) || !Array.isArray(data.reports)) throw new Error('Invalid report list response.');
      const existing = new Map();
      for (const item of data.reports) {
        if (!isRecord(item) || !validUUID(item.id) || !validUUID(item.group_id) || typeof item.synthetic !== 'boolean') throw new Error('Invalid report list response.');
        string(item.class_code, 'class_code', 200); string(item.class_name, 'class_name', 500);
        date(item.starts_at, 'starts_at'); date(item.ends_at, 'ends_at'); date(item.closed_at, 'closed_at');
        count(item.total, 'total');
        if (Date.parse(item.ends_at) < Date.parse(item.starts_at)) throw new Error('Invalid report list timing.');
        existing.set(item.id, item);
      }
      const chosen = elements.select.value;
      elements.select.replaceChildren(option('Choose a report…', ''), option('Databricks demo report (synthetic)', 'demo'));
      const reports = [...existing.values()].sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));
      for (const item of reports) {
        elements.select.append(option(`${reportLabel(item)}${item.synthetic ? ' · synthetic' : ''}`, item.id));
      }
      elements.select.value = (chosen === 'demo' || existing.has(chosen)) ? chosen : '';
      if (chosen && !elements.select.value) {
        ++requestVersion;
        clearContent('The selected session is no longer available. Choose another report.');
      }
      if (elements.listStatus) elements.listStatus.textContent = '';
    } catch (error) {
      if (token !== listVersion) return;
      if (elements.listStatus) elements.listStatus.textContent = error.status === 401 || error.status === 403
        ? `Finalized reports are unavailable: ${error.message}`
        : `Could not refresh finalized reports: ${error.message}`;
    }
  }

  elements.select.addEventListener('change', () => {
    if (elements.file) elements.file.value = '';
    void selectReport(elements.select.value);
  });

  if (elements.file) elements.file.addEventListener('change', async () => {
    const token = ++requestVersion;
    const file = elements.file.files?.[0];
    elements.select.value = '';
    clearContent();
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('Report must be 2 MB or smaller.');
      const data = validateDatabricksReport(JSON.parse(await file.text()));
      if (token === requestVersion) render(data, 'Imported file; provenance is not independently verified');
    } catch (error) {
      if (token === requestVersion) clearContent(`Could not import report: ${error.message}`);
    }
  });

  if (elements.clear) elements.clear.addEventListener('click', () => {
    ++requestVersion;
    elements.select.value = '';
    if (elements.file) elements.file.value = '';
    clearContent('Report cleared. Choose a report or import a Databricks JSON file.');
  });
  if (elements.demoDownload) elements.demoDownload.href = '/databricks/demo-results.json';

  if (elements.group && elements.export) {
    fetch('/api/groups', { credentials: 'same-origin' }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error('Staff sign-in required.');
      for (const group of data.groups || []) elements.group.append(option(group.name || group.code, group.id));
      elements.export.disabled = !elements.group.options.length;
    }).catch(error => { elements.status.textContent = error.message; });
    elements.export.addEventListener('click', () => {
      if (!elements.group.value) return;
      location.href = '/api/attendance-insights/export?groupId=' + encodeURIComponent(elements.group.value);
    });
  }

  fetch('/api/me', { credentials: 'same-origin' }).then(async response => {
    const data = await response.json();
    if (!response.ok || !['teacher', 'admin'].includes(data.user?.role)) {
      if (elements.panel) elements.panel.hidden = true;
      return;
    }
    await refreshReports();
    reportTimer = setInterval(() => void refreshReports(), 10_000);
  }).catch(() => { if (elements.panel) elements.panel.hidden = true; });

  document.addEventListener('presence:approved', () => void refreshReports());
  window.addEventListener('attendance-session-finalized', () => void refreshReports());
  window.addEventListener('beforeunload', () => { if (reportTimer) clearInterval(reportTimer); });
})();
