'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let allRequests = [];
let selectedRequest = null;
let activeTab = 'overview';

// Patterns that mark a request as an "API call"
const API_PATTERNS = [
  'upwork.com/api/',
  'upwork.com/graphql',
  'upwork.com/ab/',
  'api.upwork.com',
  '/search/jobs',
  '/talent/',
  '/freelancers/',
  '/jobs/'
];

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadRequests();
  checkStatus();

  document.getElementById('btn-refresh').addEventListener('click', loadRequests);
  document.getElementById('btn-clear').addEventListener('click', handleClear);
  document.getElementById('btn-download').addEventListener('click', handleDownload);
  document.getElementById('btn-attach').addEventListener('click', handleAttach);
  document.getElementById('filter').addEventListener('input', render);
  document.getElementById('chk-api-only').addEventListener('change', render);
  document.getElementById('detail-close').addEventListener('click', closeDetail);

  // Tab buttons in detail panel
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (selectedRequest) showDetailTab(selectedRequest, activeTab);
    });
  });

  document.getElementById('detail-copy').addEventListener('click', () => {
    const text = document.getElementById('detail-content').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
  });

  // ── Top-level panel tabs ─────────────────────────────────────────────────
  document.querySelectorAll('.top-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      document.querySelectorAll('.top-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-capture').classList.toggle('hidden', panel !== 'capture');
      document.getElementById('panel-lookup').classList.toggle('hidden', panel !== 'lookup');
      document.getElementById('panel-job-details').classList.toggle('hidden', panel !== 'job-details');
      document.getElementById('panel-config').classList.toggle('hidden', panel !== 'config');
      if (panel === 'lookup') initLookupPanel();
      if (panel === 'job-details') jdLoadJobs();
      if (panel === 'config') initConfigPanel();
    });
  });

  // ── Job details panel (init once) ────────────────────────────────────────
  initJobDetailsPanel();
  // ── Lookup panel controls ────────────────────────────────────────────────
  document.getElementById('btn-lookup-refresh').addEventListener('click', loadDetectedCompanies);
  document.getElementById('btn-lookup-run-all').addEventListener('click', handleRunAll);
  document.getElementById('btn-lookup-clear').addEventListener('click', handleLookupClear);
  document.getElementById('btn-lookup-download').addEventListener('click', handleLookupDownload);
  document.getElementById('lookup-result-close').addEventListener('click', () => {
    document.getElementById('lookup-result-panel').classList.add('hidden');
  });
  document.getElementById('lookup-result-copy').addEventListener('click', () => {
    const text = document.getElementById('lookup-result-content').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
  });
});

// ── Data loading ──────────────────────────────────────────────────────────────
function loadRequests() {
  chrome.runtime.sendMessage({ action: 'getRequests' }, (res) => {
    if (res) {
      allRequests = res.requests || [];
      updateStats(allRequests.length, res.totalCount || 0);
      render();
    }
  });
}

function checkStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (res) => {
    if (!res) return;
    const el = document.getElementById('status');
    const n = res.attachedTabsCount;
    if (res.isUpwork && res.isAttached) {
      el.textContent = `● Active (${n} tab${n !== 1 ? 's' : ''})`;
      el.className = 'status active';
    } else if (res.isUpwork) {
      el.textContent = '● On Upwork – not attached';
      el.className = 'status partial';
    } else {
      el.textContent = n > 0
        ? `● Monitoring ${n} Upwork tab${n !== 1 ? 's' : ''}`
        : '● Not on Upwork';
      el.className = n > 0 ? 'status active' : 'status inactive';
    }
  });
}

// ── Filtering ─────────────────────────────────────────────────────────────────
function isApiRequest(req) {
  return API_PATTERNS.some(p => req.url.includes(p));
}

function applyFilters(requests) {
  const filterText = document.getElementById('filter').value.trim().toLowerCase();
  const apiOnly = document.getElementById('chk-api-only').checked;

  return requests.filter(req => {
    if (apiOnly && !isApiRequest(req)) return false;
    if (filterText) {
      const haystack = (req.url + ' ' + req.method + ' ' + (req.status || '')).toLowerCase();
      if (!haystack.includes(filterText)) return false;
    }
    return true;
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  const filtered = applyFilters(allRequests);
  updateStats(filtered.length, allRequests.length);

  const list = document.getElementById('request-list');

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">No requests match the current filter.</div>';
    return;
  }

  // Newest first, cap at 200 rows for performance
  const rows = [...filtered].reverse().slice(0, 200);
  list.innerHTML = rows.map((req, i) => rowHtml(req, i)).join('');

  // Attach click handlers
  list.querySelectorAll('.req-row').forEach((el, i) => {
    el.addEventListener('click', () => openDetail(rows[i]));
  });
}

function rowHtml(req, _i) {
  const statusClass = statusToClass(req.status, req.error);
  const badgeClass  = statusClass;
  const label       = req.error ? 'ERR' : (req.status || '…');
  const url         = friendlyUrl(req.url);
  const ts          = formatTs(req.timestamp);
  const mime        = req.mimeType ? shortMime(req.mimeType) : '';

  return `
    <div class="req-row ${statusClass}">
      <div class="req-method">${esc(req.method || 'GET')}</div>
      <div class="req-info">
        <div class="req-url" title="${esc(req.url)}">${esc(url)}</div>
        <div class="req-meta">
          <span class="badge ${badgeClass}">${esc(String(label))}</span>
          <span class="ts">${ts}</span>
          ${mime ? `<span class="mime">${esc(mime)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function openDetail(req) {
  selectedRequest = req;
  document.getElementById('detail-title').textContent = friendlyUrl(req.url);
  document.getElementById('detail-panel').classList.remove('hidden');
  showDetailTab(req, activeTab);
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
  selectedRequest = null;
}

function showDetailTab(req, tab) {
  const pre = document.getElementById('detail-content');

  switch (tab) {
    case 'overview':
      pre.textContent = JSON.stringify({
        url:          req.url,
        method:       req.method,
        status:       req.status,
        statusText:   req.statusText,
        mimeType:     req.mimeType,
        resourceType: req.resourceType,
        timestamp:    req.timestamp,
        error:        req.error || undefined,
        encodedDataLength: req.encodedDataLength
      }, null, 2);
      break;
    case 'reqHeaders':
      pre.textContent = formatHeaders(req.requestHeaders);
      break;
    case 'reqBody':
      pre.textContent = req.requestBody
        ? (typeof req.requestBody === 'string' ? req.requestBody : JSON.stringify(req.requestBody, null, 2))
        : '(no request body)';
      break;
    case 'resHeaders':
      pre.textContent = formatHeaders(req.responseHeaders);
      break;
    case 'resBody':
      if (req.responseBase64) {
        pre.textContent = '(binary / base64)\n\n' + req.responseBody;
      } else if (!req.responseBody && req.responseBody !== 0) {
        pre.textContent = '(no response body captured)';
      } else {
        pre.textContent = typeof req.responseBody === 'string'
          ? req.responseBody
          : JSON.stringify(req.responseBody, null, 2);
      }
      break;
    case 'full':
      pre.textContent = JSON.stringify(req, null, 2);
      break;
    default:
      pre.textContent = '';
  }
}

function formatHeaders(obj) {
  if (!obj) return '(none)';
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// ── Actions ───────────────────────────────────────────────────────────────────
function handleClear() {
  if (!confirm('Clear all captured requests?')) return;
  chrome.runtime.sendMessage({ action: 'clearRequests' }, () => {
    allRequests = [];
    render();
    updateStats(0, 0);
    closeDetail();
    showToast('Cleared');
  });
}

function handleDownload() {
  const filtered = applyFilters(allRequests);

  // Build JSON blob in popup context (no downloads permission needed)
  const json = JSON.stringify(filtered, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `upwork_api_capture_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${filtered.length} requests`);
}

function handleAttach() {
  chrome.runtime.sendMessage({ action: 'attachCurrent' }, (res) => {
    if (res?.attached) {
      showToast('Debugger attached');
      checkStatus();
    } else {
      showToast('Could not attach (DevTools open?)');
    }
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(shown, total) {
  const el = document.getElementById('stats-text');
  if (total === 0) {
    el.textContent = 'No requests captured yet';
  } else if (shown === total) {
    el.textContent = `${total} request${total !== 1 ? 's' : ''} captured`;
  } else {
    el.textContent = `Showing ${shown} of ${total} captured`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusToClass(status, error) {
  if (error) return 'failed';
  if (!status) return '';
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redir';
  return 'err';
}

function friendlyUrl(url) {
  try {
    const u = new URL(url);
    const qs = u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search;
    return u.pathname + qs;
  } catch {
    return url.length > 80 ? url.slice(0, 80) + '…' : url;
  }
}

function shortMime(mime) {
  // e.g. "application/x-thrift+json" → "thrift+json"
  return mime.replace('application/', '').replace('text/', '');
}

function formatTs(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANY LOOKUP PANEL
// ═══════════════════════════════════════════════════════════════════════════════

let lookupResults = {}; // keyed by companyId → array of query results
let activeLookupTab = null;

function initLookupPanel() {
  loadDetectedCompanies();
  loadExistingLookupResults();
}

// ── Load detected companies ───────────────────────────────────────────────────
function loadDetectedCompanies() {
  chrome.runtime.sendMessage({ action: 'getDetectedCompanies' }, (res) => {
    renderDetectedList(res?.companies || []);
  });
}

function loadExistingLookupResults() {
  chrome.runtime.sendMessage({ action: 'getCompanyLookups' }, (res) => {
    const lookups = res?.lookups || [];
    lookups.forEach(l => { lookupResults[l.companyId] = l.results; });
    // Update download button state
    document.getElementById('btn-lookup-download').disabled = lookups.length === 0;
    // Refresh detected list to show "done" state on any already-run companies
    loadDetectedCompanies();
  });
}

function renderDetectedList(companies) {
  const el = document.getElementById('detected-list');
  if (companies.length === 0) {
    el.innerHTML = '<div class="empty">Open a job on Upwork — companies are detected automatically.</div>';
    return;
  }

  el.innerHTML = companies.map(c => {
    const hasResult = !!lookupResults[c.companyId];
    const loc = c.location ? `${c.location.city || ''}, ${c.location.country || ''}`.replace(/^, |, $/, '') : '';
    const ts = c.detectedAt ? new Date(c.detectedAt).toLocaleTimeString() : '';
    return `
      <div class="detected-row ${hasResult ? 'has-result' : ''}" data-company-id="${esc(c.companyId)}">
        <div class="detected-info">
          <div class="detected-company-id">${esc(c.companyId)}</div>
          <div class="detected-job-title" title="${esc(c.jobTitle)}">${esc(c.jobTitle)}</div>
          <div class="detected-meta">${loc ? esc(loc) + ' · ' : ''}${ts}</div>
        </div>
        <button class="btn-run ${hasResult ? 'done' : ''}"
          data-company-id="${esc(c.companyId)}"
          data-job-ciphertext="${esc(c.jobCiphertext || '')}"
          data-job-title="${esc(c.jobTitle)}">
          ${hasResult ? '✓ View' : '▶ Run'}
        </button>
      </div>`;
  }).join('');

  // Attach click handlers for run buttons
  el.querySelectorAll('.btn-run').forEach(btn => {
    btn.addEventListener('click', () => handleRunLookup(btn));
  });
}

// ── Run All pending lookups sequentially ─────────────────────────────────────
function handleRunAll() {
  const rows = [...document.querySelectorAll('.btn-run:not(.done):not(.running)')];
  if (rows.length === 0) { showToast('All detected companies already done'); return; }

  const runAllBtn = document.getElementById('btn-lookup-run-all');
  runAllBtn.disabled = true;
  runAllBtn.textContent = `⏳ 0/${rows.length}`;

  let completed = 0;

  const runNext = (i) => {
    if (i >= rows.length) {
      runAllBtn.disabled = false;
      runAllBtn.textContent = '▶▶ Run All';
      showToast(`Run All done — ${completed} completed`);
      return;
    }
    const btn = rows[i];
    // Skip if it's now done (another interaction may have completed it)
    if (btn.classList.contains('done')) { runNext(i + 1); return; }

    const companyId    = btn.dataset.companyId;
    const jobCiphertext = btn.dataset.jobCiphertext || null;
    const jobTitle     = btn.dataset.jobTitle || 'Unknown';

    btn.classList.add('running');
    btn.textContent = '⏳';
    btn.disabled = true;

    chrome.runtime.sendMessage(
      { action: 'runCompanyLookup', companyId, jobCiphertext, jobTitle },
      (res) => {
        btn.disabled = false;
        if (res?.success) {
          lookupResults[companyId] = res.results;
          btn.classList.remove('running');
          btn.classList.add('done');
          btn.textContent = '✓ View';
          document.getElementById('btn-lookup-download').disabled = false;
          const row = document.querySelector(`.detected-row[data-company-id="${companyId}"]`);
          if (row) row.classList.add('has-result');
          completed++;
        } else {
          btn.classList.remove('running');
          btn.textContent = '▶ Retry';
          showToast(`Error for ${companyId}: ` + (res?.error || 'Unknown error'));
        }
        runAllBtn.textContent = `⏳ ${completed}/${rows.length}`;
        runNext(i + 1);
      }
    );
  };

  runNext(0);
}

// ── Run a lookup ──────────────────────────────────────────────────────────────
function handleRunLookup(btn) {
  const companyId    = btn.dataset.companyId;
  const jobCiphertext = btn.dataset.jobCiphertext || null;
  const jobTitle     = btn.dataset.jobTitle || 'Unknown';

  // If already have results, just show them
  if (lookupResults[companyId] && btn.classList.contains('done')) {
    showLookupResults(companyId, jobTitle, lookupResults[companyId]);
    return;
  }

  btn.classList.add('running');
  btn.textContent = '⏳ Running…';
  btn.disabled = true;

  chrome.runtime.sendMessage(
    { action: 'runCompanyLookup', companyId, jobCiphertext, jobTitle },
    (res) => {
      btn.disabled = false;
      if (res?.success) {
        lookupResults[companyId] = res.results;
        btn.classList.remove('running');
        btn.classList.add('done');
        btn.textContent = '✓ View';
        document.getElementById('btn-lookup-download').disabled = false;
        // Mark the row
        const row = document.querySelector(`.detected-row[data-company-id="${companyId}"]`);
        if (row) row.classList.add('has-result');
        showLookupResults(companyId, jobTitle, res.results);
        showToast(`Lookup done — ${res.results.length} queries`);
      } else {
        btn.classList.remove('running');
        btn.textContent = '▶ Retry';
        showToast('Error: ' + (res?.error || 'Unknown error'));
      }
    }
  );
}

// ── Display results ───────────────────────────────────────────────────────────
function showLookupResults(companyId, jobTitle, results) {
  activeLookupTab = results[0]?.alias || null;

  document.getElementById('lookup-result-title').textContent =
    `${companyId} — ${jobTitle.substring(0, 50)}`;
  document.getElementById('lookup-result-panel').classList.remove('hidden');

  // Build tabs (one per query alias + fulljson)
  const tabsEl = document.getElementById('lookup-result-tabs');
  tabsEl.innerHTML = results.map((r, i) =>
    `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-alias="${esc(r.alias)}">${esc(shortAlias(r.alias))}</button>`
  ).join('') + `<button class="tab-btn" data-alias="__fulljson__">full json</button>`;

  tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLookupTab = btn.dataset.alias;
      renderLookupTabContent(results, activeLookupTab);
    });
  });

  renderLookupTabContent(results, activeLookupTab);

  // Scroll result panel into view
  document.getElementById('lookup-result-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLookupTabContent(results, alias) {
  const pre = document.getElementById('lookup-result-content');

  if (alias === '__fulljson__') {
    pre.textContent = JSON.stringify(results, null, 2);
    return;
  }

  const result = results.find(r => r.alias === alias);
  if (!result) return;

  if (alias === 'client-details') {
    const profiles = result.profiles || [];
    if (!profiles.length) { pre.textContent = '(no profiles fetched)'; return; }
    const lines = [];
    for (const p of profiles) {
      lines.push('▶ ' + (p.name || p.ciphertext || '—') + '  [status: ' + (p.status || '?') + ']');
      if (p.error) { lines.push('    Error: ' + p.error); lines.push(''); continue; }
      if (p.ciphertext) lines.push('    Profile    : https://www.upwork.com/freelancers/' + p.ciphertext);
      const agencies = p.agencies || [];
      if (agencies.length) {
        for (const ag of agencies) {
          lines.push('    Agency     : ' + (ag.name || '—') + '  (id: ' + ag.id + ')');
          lines.push('      URL      : https://www.upwork.com/agencies/' + ag.id + '/');
          if (ag.logo)             lines.push('      Logo     : ' + ag.logo);
          if (ag.score != null)    lines.push('      Score    : ' + ag.score);
          if (ag.totalFeedback)    lines.push('      Reviews  : ' + ag.totalFeedback);
          if (ag.totalHours)       lines.push('      Hours    : ' + ag.totalHours);
          if (ag.nSS100BwScore != null) lines.push('      NSS      : ' + ag.nSS100BwScore);
          if (ag.topRatedStatus)   lines.push('      TopRated : ' + ag.topRatedStatus);
          if (ag.hideEacEarnings != null) lines.push('      HideEAC  : ' + ag.hideEacEarnings);
        }
      } else {
        lines.push('    (no agencies in getDetails response)');
        if (p.rawResponse) lines.push('    raw: ' + JSON.stringify(p.rawResponse).slice(0, 300));
      }
      lines.push('');
    }
    pre.textContent = lines.join('\n');
    return;
  }

  if (alias === 'company-details') {
    const profiles = result.profiles || [];
    if (!profiles.length) {
      // fallback: flat agencies list (old format)
      const agencies = result.agencies || [];
      if (!agencies.length) { pre.textContent = '(no agency data found)'; return; }
      pre.textContent = JSON.stringify(agencies, null, 2);
      return;
    }
    const lines = [];
    for (const p of profiles) {
      if (p.error) {
        lines.push('\u25b6 ' + (p.name || p.ciphertext) + '  \u2014  error: ' + p.error);
        lines.push('');
        continue;
      }
      const agList = p.agencies || [];
      if (!agList.length) {
        lines.push('\u25b6 ' + (p.name || p.ciphertext) + '  \u2014  (no agencies)');
        lines.push('');
        continue;
      }
      for (const ag of agList) {
        lines.push('\u25b6 ' + (ag.name || '\u2014') + '  (via ' + (p.name || p.ciphertext) + ')');
        lines.push('    Agency URL : https://www.upwork.com/agencies/' + ag.id + '/');
        if (ag.logo)                                            lines.push('    Logo       : ' + ag.logo);
        if (ag.score != null)                                   lines.push('    Score      : ' + ag.score);
        if (ag.totalFeedback != null)                           lines.push('    Reviews    : ' + ag.totalFeedback);
        if (ag.totalHours != null)                              lines.push('    Hours      : ' + ag.totalHours);
        if (ag.nSS100BwScore != null)                           lines.push('    NSS        : ' + ag.nSS100BwScore);
        if (ag.topRatedStatus)                                  lines.push('    Top Rated  : ' + ag.topRatedStatus);
        if (ag.topRatedPlusStatus)                              lines.push('    Top Rated+ : ' + ag.topRatedPlusStatus);
        if (ag.hideEacEarnings != null)                         lines.push('    Hide EAC   : ' + ag.hideEacEarnings);
        lines.push('');
      }
    }
    pre.textContent = lines.join('\n');
    return;
  }

  const display = {
    alias:  result.alias,
    status: result.status,
    error:  result.error,
    data:   result.data
  };
  pre.textContent = JSON.stringify(display, null, 2);
}

function shortAlias(alias) {
  // Shorten long aliases for tabs
  return alias
    .replace('fetchjobdetailsandcontext', 'job context')
    .replace('company-details', 'company details')
    .replace('client-details', 'client details')
    .replace('company-page', 'client name')
    .replace('introspect-', '⌕ ')
    .replace('gql-query-', '')
    .replace('getCompany', 'company')
    .replace(/Extended|Direct/i, '+');
}

// ── Download all lookup results ───────────────────────────────────────────────
function handleLookupDownload() {
  chrome.runtime.sendMessage({ action: 'getCompanyLookups' }, (res) => {
    const lookups = res?.lookups || [];
    if (lookups.length === 0) { showToast('No results to download yet'); return; }
    const json = JSON.stringify(lookups, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `upwork_company_lookup_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${lookups.length} company lookup(s)`);
  });
}

// ── Clear all company data ────────────────────────────────────────────────────
function handleLookupClear() {
  if (!confirm('Clear all detected companies and lookup results?')) return;
  chrome.runtime.sendMessage({ action: 'clearCompanyData' }, () => {
    lookupResults = {};
    activeLookupTab = null;
    document.getElementById('lookup-result-panel').classList.add('hidden');
    document.getElementById('btn-lookup-download').disabled = true;
    renderDetectedList([]);
    showToast('Cleared');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOB DETAILS PANEL  (capture.js logic inside the extension)
// ═══════════════════════════════════════════════════════════════════════════════

let jdActiveTab  = 'overview';
let jdCurrentJob = null;
let jdAllJobs    = [];

function initJobDetailsPanel() {
  document.getElementById('btn-jd-capture').addEventListener('click', handleJdCapture);
  document.getElementById('btn-jd-clear').addEventListener('click', handleJdClear);
  document.getElementById('btn-jd-download').addEventListener('click', handleJdDownload);
  document.getElementById('jd-result-close').addEventListener('click', () => {
    document.getElementById('jd-result-panel').classList.add('hidden');
    jdCurrentJob = null;
  });
  document.getElementById('jd-result-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('jd-result-content').textContent)
      .then(() => showToast('Copied!'));
  });
  document.querySelectorAll('#jd-result-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#jd-result-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      jdActiveTab = btn.dataset.jdtab;
      if (jdCurrentJob) jdRenderTab(jdCurrentJob, jdActiveTab);
    });
  });
  jdLoadJobs();
}

// ── Load & render job list ────────────────────────────────────────────────────
function jdLoadJobs() {
  chrome.runtime.sendMessage({ action: 'getCapturedJobs' }, (res) => {
    jdAllJobs = res?.jobs || [];
    document.getElementById('btn-jd-download').disabled = jdAllJobs.length === 0;
    jdRenderJobList();
  });
}

function jdRenderJobList() {
  const el = document.getElementById('jd-job-list');
  if (jdAllJobs.length === 0) {
    el.innerHTML = '<div class="empty">Open a job page on Upwork, then click ▶ Capture.</div>';
    return;
  }
  el.innerHTML = jdAllJobs.map((j, i) => {
    const title   = j.job?.title || j.job?.info?.title || '(untitled)';
    const company = j.company?.name || '—';
    const country = j.location?.country || '';
    const sources = j._sources?.length || 0;
    const ts      = j._capturedAt ? new Date(j._capturedAt).toLocaleTimeString() : '';
    // Stage breakdown badge
    const stageCounts = {};
    for (const r of (j._rawAll || [])) { const s = r.pageStage || 'other'; stageCounts[s] = (stageCounts[s] || 0) + 1; }
    const stageBadges = Object.entries(stageCounts).map(([s, n]) => `${s}:${n}`).join(' ');
    const autoBadge = j._autoCapture ? ' <span style="color:#f0a;font-size:10px;">[auto]</span>' : '';
    const hasApply  = j.apply && Object.keys(j.apply).length > 0;
    return `
      <div class="detected-row" data-jd-idx="${i}" style="cursor:pointer;">
        <div class="detected-info">
          <div class="detected-company-id" style="font-size:12px;font-weight:600;">${esc(title.slice(0, 60))}${autoBadge}</div>
          <div class="detected-job-title">${esc(company)}${country ? ' · ' + esc(country) : ''}${hasApply ? ' · <span style="color:#4f4">apply✓</span>' : ''}</div>
          <div class="detected-meta">${sources} sources · ${stageBadges || 'other'} · ${ts}</div>
        </div>
        <button class="btn-run done" data-jd-idx="${i}">View</button>
      </div>`;
  }).join('');

  el.querySelectorAll('.btn-run').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      jdShowJob(jdAllJobs[+btn.dataset.jdIdx]);
    });
  });
  el.querySelectorAll('.detected-row').forEach(row => {
    row.addEventListener('click', () => jdShowJob(jdAllJobs[+row.dataset.jdIdx]));
  });
}

// ── Capture ───────────────────────────────────────────────────────────────────
function handleJdCapture() {
  const statusEl = document.getElementById('jd-status');
  const btn      = document.getElementById('btn-jd-capture');
  statusEl.textContent = '⏳ Capturing — please wait…';
  btn.disabled = true;

  chrome.runtime.sendMessage({ action: 'runFullJobCapture' }, (res) => {
    btn.disabled = false;
    if (res?.success) {
      statusEl.textContent = `✓ Captured — ${res.job._sources.length} sources merged`;
      jdAllJobs.unshift(res.job);
      // deduplicate by tabUrl
      const seen = new Set();
      jdAllJobs = jdAllJobs.filter(j => {
        const k = j._uid || j._tabUrl;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      document.getElementById('btn-jd-download').disabled = false;
      jdRenderJobList();
      jdShowJob(res.job);
    } else {
      statusEl.textContent = '✗ ' + (res?.error || 'Unknown error');
      showToast(res?.error || 'Capture failed');
    }
  });
}

// ── Show a job in the result panel ────────────────────────────────────────────
function jdShowJob(job) {
  jdCurrentJob = job;
  const title = job.job?.title || job.job?.info?.title || job._tabUrl || 'Job Details';
  document.getElementById('jd-result-title').textContent = title.slice(0, 60);
  document.getElementById('jd-result-panel').classList.remove('hidden');
  // Update org-info tab label to company name
  const orgBtn = document.querySelector('#jd-result-tabs .tab-btn[data-jdtab="orginfo"]');
  if (orgBtn) orgBtn.textContent = job.company?.name || 'Org Info';

  // Reset to overview tab
  document.querySelectorAll('#jd-result-tabs .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#jd-result-tabs .tab-btn[data-jdtab="overview"]').classList.add('active');
  jdActiveTab = 'overview';

  jdRenderTab(job, 'overview');
  document.getElementById('jd-result-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Render a tab's content ────────────────────────────────────────────────────
function jdRenderTab(job, tab) {
  const pre = document.getElementById('jd-result-content');
  switch (tab) {
    case 'overview':
      pre.textContent = JSON.stringify({
        _uid:         job._uid,
        _cipher:      job._cipher,
        _capturedAt:  job._capturedAt,
        _autoCapture: job._autoCapture,
        _tabUrl:      job._tabUrl,
        _sourceCount: job._sources?.length,
        _queryStatuses: job._queryStatuses,
        job:          job.job,
        skills:       job.skills,
        location:     job.location,
        activity:     job.activity,
        apply:        Object.keys(job.apply || {}).length ? {
          connectPrice:    job.apply.connectPrice,
          questionCount:   job.apply.questions?.length,
          milestoneCount:  job.apply.milestones?.length,
          connectsBalance: job.apply.connectsBalance,
        } : undefined,
      }, null, 2);
      break;
    case 'buyer':
      pre.textContent = JSON.stringify(job.buyer || {}, null, 2);
      break;
    case 'company':
      pre.textContent = JSON.stringify(job.company || {}, null, 2);
      break;
    case 'stats':
      pre.textContent = JSON.stringify(job.stats || {}, null, 2);
      break;
    case 'history':
      pre.textContent = JSON.stringify(job.history?.length ? job.history : '(no work history captured)', null, 2);
      break;
    case 'proposals':
      pre.textContent = JSON.stringify(job.proposals && Object.keys(job.proposals).length
        ? job.proposals : '(no proposals data captured)', null, 2);
      break;
    case 'apply':
      pre.textContent = JSON.stringify(job.apply && Object.keys(job.apply).length
        ? job.apply : '(no apply-page data — open the Apply page on Upwork then recapture)', null, 2);
      break;
    case 'sources': {
      // Build per-stage breakdown from _rawAll
      const stageCounts = {};
      for (const r of (job._rawAll || [])) {
        const s = r.pageStage || 'other';
        stageCounts[s] = (stageCounts[s] || 0) + 1;
      }
      const summary = {
        total: job._sources?.length,
        stagesBreakdown: stageCounts,
        sources: job._sources,
        queryStatuses: job._queryStatuses,
        rawResponseCount: job._rawAll?.length,
        rawAll: job._rawAll,
      };
      pre.textContent = JSON.stringify(summary, null, 2);
      break;
    }
    case 'raw':
      pre.textContent = JSON.stringify(job, null, 2);
      break;
    case 'orginfo': {
      pre.textContent = 'Loading org info…';
      chrome.storage.local.get(['companyLookups'], (stored) => {
        const lookups = stored.companyLookups || [];
        // Match by jobCiphertext first, then by companyId from buyer data
        let lookup = lookups.find(l => l.jobCiphertext && job._cipher && l.jobCiphertext === job._cipher);
        if (!lookup) {
          const compId = job.buyer?.info?.company?.companyId || job.company?.companyId;
          if (compId) lookup = lookups.find(l => l.companyId === compId);
        }
        if (!lookup) { pre.textContent = '(no org lookup found — run a Company Lookup for this job first)'; return; }
        const cpResult = lookup.results?.find(r => r.alias === 'company-page');
        if (!cpResult)          { pre.textContent = '(no company-page result in lookup)'; return; }
        if (cpResult.skipped)   { pre.textContent = '(skipped: ' + cpResult.reason + ')'; return; }
        if (cpResult.error)     { pre.textContent = 'Error: ' + cpResult.error; return; }
        const staffsAuth = cpResult.data?.data?.agencyStaffsAuth;
        if (!staffsAuth)        { pre.textContent = JSON.stringify(cpResult, null, 2); return; }
        // profiles may be on company-page (old) or split into client-details (new)
        const cdResult = lookup.results?.find(r => r.alias === 'client-details');
        const profilesMap = {};
        for (const p of ([...(cpResult.profiles || []), ...(cdResult?.profiles || [])])) {
          if (p.personId) profilesMap[p.personId] = p;
        }
        const lines = [];
        lines.push('Company ID : ' + cpResult.companyId);
        lines.push('Total Staff: ' + staffsAuth.totalCount);
        lines.push('');
        for (const st of (staffsAuth.staffs || [])) {
          const pd = st.personalData || {};
          lines.push('▶ ' + (pd.name || '—') + '  [' + st.memberType + ']' + (st.agencyOwner ? '  (owner)' : ''));
          lines.push('    Active    : ' + st.active);
          lines.push('    Viewable  : ' + st.canBeViewed);
          lines.push('    JSS       : ' + pd.jobSuccessScore);
          lines.push('    Profile   : https://www.upwork.com/freelancers/' + pd.ciphertext);
          if (pd.portrait) lines.push('    Portrait  : ' + pd.portrait);
          const pEntry = profilesMap[pd.id];
          if (pEntry) {
            if (pEntry.error) {
              lines.push('    Details   : error — ' + pEntry.error);
            } else {
              const tp = pEntry.data && pEntry.data.data && pEntry.data.data.talentVPDAuthProfile;
              if (tp) {
                const pp = tp.profile || {};
                const ss = tp.stats || {};
                const loc = pp.location || {};
                if (pp.title)                                      lines.push('    Title     : ' + pp.title);
                const locStr = [loc.city, loc.country].filter(Boolean).join(', ');
                if (locStr)                                        lines.push('    Location  : ' + locStr);
                const rate = ss.hourlyRate && ss.hourlyRate.node;
                if (rate && rate.amount)                           lines.push('    Rate      : ' + rate.currencyCode + ' ' + rate.amount + '/hr');
                if (ss.totalHours)                                 lines.push('    Hours     : ' + ss.totalHours);
                if (ss.rating)                                     lines.push('    Rating    : ' + ss.rating + ' (' + (ss.totalFeedback || 0) + ' reviews)');
                if (ss.topRatedStatus && ss.topRatedStatus !== 'not_eligible')
                                                                   lines.push('    Top Rated : ' + ss.topRatedStatus);
                if (ss.memberSince)                                lines.push('    Member    : ' + ss.memberSince);
                const skills = (pp.skills || []).slice(0, 5).map(s => s.node && (s.node.prettyName || s.node.name)).filter(Boolean);
                if (skills.length)                                 lines.push('    Skills    : ' + skills.join(', '));
              }
            }
          }
          lines.push('');
        }
        pre.textContent = lines.join('\n');
      });
      break;
    }
    default:
      pre.textContent = '';
  }
}

// ── Download all captured jobs ────────────────────────────────────────────────
function handleJdDownload() {
  if (jdAllJobs.length === 0) { showToast('Nothing to download yet'); return; }
  const json = JSON.stringify(jdAllJobs, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `upwork_job_details_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${jdAllJobs.length} job(s)`);
}

// ── Clear ──────────────────────────────────────────────────────────────────────
function handleJdClear() {
  if (!confirm('Clear all captured job details?')) return;
  chrome.runtime.sendMessage({ action: 'clearCapturedJobs' }, () => {
    jdAllJobs    = [];
    jdCurrentJob = null;
    document.getElementById('jd-result-panel').classList.add('hidden');
    document.getElementById('btn-jd-download').disabled = true;
    document.getElementById('jd-status').textContent = '';
    jdRenderJobList();
    showToast('Cleared');
  });
}

// -------------------------------------------------------------------------------
// CONFIG PANEL
// -------------------------------------------------------------------------------

let cfgInited = false;

function initConfigPanel() {
  if (cfgInited) {
    // Refresh token status every time tab is opened
    refreshTokenStatus();
    return;
  }
  cfgInited = true;

  // -- Load saved values ------------------------------------------------------
  const DEFAULT_SEARCH_URL = 'https://www.upwork.com/nx/search/jobs/?nbs=1&q=n8n';
  chrome.storage.local.get(['webhookUrl', 'searchUrl'], (s) => {
    if (s.webhookUrl) document.getElementById('webhook-url').value = s.webhookUrl;
    const searchUrl = s.searchUrl || DEFAULT_SEARCH_URL;
    document.getElementById('cfg-search-url').value = searchUrl;
    if (!s.searchUrl) chrome.storage.local.set({ searchUrl: DEFAULT_SEARCH_URL });
  });

  // -- Webhook URL save -------------------------------------------------------
  document.getElementById('btn-webhook-save').addEventListener('click', () => {
    const url = document.getElementById('webhook-url').value.trim();
    const st  = document.getElementById('webhook-status');
    chrome.storage.local.set({ webhookUrl: url || null }, () => {
      st.textContent = url ? '? Saved' : 'Cleared';
      setTimeout(() => { st.textContent = ''; }, 2000);
    });
  });

  // -- Search URL save --------------------------------------------------------
  document.getElementById('cfg-save-search-url').addEventListener('click', () => {
    const url = document.getElementById('cfg-search-url').value.trim();
    chrome.storage.local.set({ searchUrl: url || null }, () => showToast(url ? 'Search URL saved' : 'Cleared'));
  });

  // -- Open search URL in new tab ---------------------------------------------
  document.getElementById('cfg-open-search').addEventListener('click', () => {
    const url = document.getElementById('cfg-search-url').value.trim();
    if (!url) { showToast('Enter a search URL first'); return; }
    // Save it while we're here
    chrome.storage.local.set({ searchUrl: url });
    chrome.runtime.sendMessage({ action: 'openSearchTab', url }, (res) => {
      if (res?.success) showToast('Opened search tab � browse jobs, then click Extract All');
    });
  });

  // -- Extract all jobs from captured requests --------------------------------
  document.getElementById('cfg-extract-jobs').addEventListener('click', handleExtractJobs);
  document.getElementById('cfg-run-search-lookup').addEventListener('click', handleSearchLookup);

  // -- Token status -----------------------------------------------------------
  refreshTokenStatus();
}

function refreshTokenStatus() {
  chrome.runtime.sendMessage({ action: 'getSessionTokens' }, (res) => {
    if (!res) return;
    const map = {
      'tok-search':  [res.hasSearchTok,  'search'],
      'tok-job':     [res.hasJobTok,     'job'],
      'tok-global':  [res.hasGlobalTok,  'global'],
      'tok-tenant':  [res.hasTenantId,   'tenant'],
      'tok-xsrf':    [res.hasXsrf,       'xsrf'],
      'tok-agency':  [res.hasAgencyTok,  'agency'],
    };
    for (const [id, [ok, label]] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = (ok ? '?? ' : '?? ') + label;
      el.classList.toggle('ok', !!ok);
    }
  });
}

function cfgLog(msg) {
  const el = document.getElementById('cfg-log');
  const line = new Date().toLocaleTimeString() + '  ' + msg;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function handleSearchLookup() {
  console.log('[popup] handleSearchLookup called');
  const urlInput = document.getElementById('cfg-search-url');
  const url = urlInput ? urlInput.value.trim() : '';
  console.log('[popup] search url:', url);
  if (!url || !url.includes('upwork.com')) {
    showToast('Enter a valid Upwork search URL in the Search URL field first');
    cfgLog('ERROR: enter a valid Upwork search URL first');
    return;
  }
  const btn  = document.getElementById('cfg-run-search-lookup');
  const stat = document.getElementById('cfg-extract-status');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  stat.textContent = 'Opening search page, collecting jobs…';
  cfgLog('Starting search lookup: ' + url);

  chrome.runtime.sendMessage({ action: 'runSearchLookup', searchUrl: url }, (res) => {
    if (!res) {
      btn.disabled = false;
      btn.textContent = '▶ Run Lookup on Search URL';
      stat.textContent = '✗ No response from background';
      cfgLog('ERROR: no response');
      return;
    }
    if (!res.success) {
      btn.disabled = false;
      btn.textContent = '▶ Run Lookup on Search URL';
      stat.textContent = '✗ ' + (res.error || 'Unknown error');
      cfgLog('ERROR: ' + (res.error || 'Unknown error'));
      return;
    }
    stat.textContent = `✓ Found ${res.found} job(s) — running lookups in background, results sent to webhook`;
    cfgLog(`Found ${res.found} jobs, processing sequentially in background…`);
    // Re-enable after a delay (lookups continue async in background)
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '▶ Run Lookup on Search URL';
      jdLoadJobs();
    }, 5000);
  });
}

function handleExtractJobs() {  const btn  = document.getElementById('cfg-extract-jobs');
  const stat = document.getElementById('cfg-extract-status');
  btn.disabled = true;
  btn.textContent = '? Extracting�';
  stat.textContent = 'Scanning captured requests�';
  cfgLog('Starting extraction from captured requests�');

  chrome.runtime.sendMessage({ action: 'extractJobsFromRequests' }, (res) => {
    btn.disabled = false;
    btn.textContent = '? Extract All Jobs from Captured Requests';

    if (!res) {
      stat.textContent = '? No response from background';
      cfgLog('ERROR: no response');
      return;
    }
    if (!res.success) {
      stat.textContent = '? ' + (res.error || 'Unknown error');
      cfgLog('ERROR: ' + (res.error || 'Unknown error'));
      return;
    }

    const msg = `? Added ${res.added} new job${res.added !== 1 ? 's' : ''} (${res.total} total in store)`;
    stat.textContent = msg;
    cfgLog(msg);

    if (res.added > 0) {
      // Refresh the jobs panel list
      jdLoadJobs();
      showToast(`${res.added} new job${res.added !== 1 ? 's' : ''} extracted`);
    } else {
      cfgLog('Tip: browse Upwork search & job pages first, then extract.');
    }
  });
}
