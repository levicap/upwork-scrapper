/* global EXT_CONFIG_V2 */

// ── Elements ──────────────────────────────────────────────────────────────────
const $dot           = document.getElementById('status-dot');
const $tokenBar      = document.getElementById('token-bar');
const $tokenLabel    = document.getElementById('token-label');
const $btnRefresh    = document.getElementById('btn-refresh-tokens');
const $searchInput   = document.getElementById('search-input');
const $maxJobsInput  = document.getElementById('maxjobs-input');
const $btnScrape     = document.getElementById('btn-scrape');
const $btnTest       = document.getElementById('btn-test');
const $debugOut      = document.getElementById('debug-out');
const $progressSec   = document.getElementById('progress-section');
const $progressBar   = document.getElementById('progress-bar');
const $progressLabel = document.getElementById('progress-label');
const $jobsCount     = document.getElementById('jobs-count');
const $jobsList      = document.getElementById('jobs-list');
const $btnExport     = document.getElementById('btn-export');
const $btnClear      = document.getElementById('btn-clear');

// ── State ─────────────────────────────────────────────────────────────────────
let _jobs     = [];
let _running  = false;
let _pollTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  // Restore saved inputs
  chrome.storage.local.get(['v2_savedQuery', 'v2_savedMax'], s => {
    if (s.v2_savedQuery) $searchInput.value = s.v2_savedQuery;
    if (s.v2_savedMax)   $maxJobsInput.value = s.v2_savedMax;
  });

  fetchStatus();
  loadJobs();
  startPolling();
})();

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => {
    fetchStatus();
    if (_running) loadJobs();
  }, 1500);
}

// Listen for storage changes (background writes progress here)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.v2_progress) renderProgress(changes.v2_progress.newValue);
  if (changes.v2_lastJobs) renderJobs(changes.v2_lastJobs.newValue || []);
});

// ── Background communication ──────────────────────────────────────────────────
function fetchStatus() {
  chrome.runtime.sendMessage({ action: 'v2_getStatus' }, resp => {
    if (chrome.runtime.lastError || !resp) return;
    renderTokenStatus(resp);
    if (resp.progress) renderProgress(resp.progress);
    _running = resp.running;
    updateScrapeBtn();
  });
}

function loadJobs() {
  chrome.runtime.sendMessage({ action: 'v2_getJobs' }, resp => {
    if (chrome.runtime.lastError || !resp) return;
    renderJobs(resp.jobs || []);
  });
}

// ── Token status rendering ─────────────────────────────────────────────────────
function renderTokenStatus(resp) {
  const t = resp.tokens || {};
  const hasCoreTokens = resp.hasTokens;
  const hasMsgToken   = resp.hasMsgToken;
  const ageMin        = Math.round((resp.tokenAge || 0) / 60);

  // Dot color
  $dot.className = 'dot ' + (hasCoreTokens ? 'dot-green' : 'dot-red');

  // Token bar
  if (hasCoreTokens) {
    $tokenBar.className = 'token-bar token-ok';
    const parts = [];
    if (t.search) parts.push('search');
    if (t.job)    parts.push('job');
    if (t.global) parts.push('global');
    if (t.agency) parts.push('agency');
    $tokenLabel.textContent = `✓ Tokens ready (${parts.join(', ')}) — ${ageMin}m ago`;
  } else {
    $tokenBar.className = 'token-bar token-missing';
    $tokenLabel.textContent = '✗ No tokens — open Upwork first, then ↻ refresh';
  }

  $btnScrape.disabled = !hasCoreTokens && !resp.running;
}

// ── Progress rendering ─────────────────────────────────────────────────────────
function renderProgress(prog) {
  if (!prog) { $progressSec.classList.add('hidden'); return; }

  _running = prog.running;
  updateScrapeBtn();

  if (!prog.running && prog.phase !== 'processing' && prog.phase !== 'init'
      && prog.phase !== 'search' && prog.phase !== 'capture-tokens') {
    // Done or error — hide after a moment
    setTimeout(() => $progressSec.classList.add('hidden'), 3000);

    if (prog.phase === 'error') {
      $progressSec.classList.remove('hidden');
      $progressLabel.textContent = '✗ Error: ' + (prog.error || 'unknown');
      $progressBar.style.width = '100%';
      $progressBar.style.background = '#dc2626';
    } else {
      $progressSec.classList.remove('hidden');
      $progressLabel.textContent = `✓ Done — ${prog.processed}/${prog.total} jobs scraped`;
      $progressBar.style.width = '100%';
      $progressBar.style.background = '#22c55e';
    }
    return;
  }

  $progressSec.classList.remove('hidden');
  $progressBar.style.background = '#2563eb';

  const total     = prog.total     || 0;
  const processed = prog.processed || 0;
  const pct       = total > 0 ? Math.round((processed / total) * 100) : 0;
  $progressBar.style.width = pct + '%';

  const phaseLabel = {
    'init':           '⏳ Initialising…',
    'search':         '🔍 Searching for jobs…',
    'capture-tokens': '🔑 Capturing live tokens…',
    'processing':     `⚙ Processing ${processed} / ${total} jobs…`,
    'done':           `✓ Done — ${processed} / ${total}`,
  }[prog.phase] || prog.phase;

  $progressLabel.textContent = phaseLabel;
}

// ── Jobs rendering ────────────────────────────────────────────────────────────
function renderJobs(jobs) {
  _jobs = jobs;
  $jobsCount.textContent = jobs.length + ' job' + (jobs.length !== 1 ? 's' : '');
  $btnExport.disabled = jobs.length === 0;

  if (jobs.length === 0) {
    $jobsList.innerHTML = '<div class="empty-state">Browse a search results page on Upwork<br>or click ▶ Run Scrape to start.</div>';
    return;
  }

  $jobsList.innerHTML = jobs.slice(0, 100).map(j => jobCardHtml(j)).join('');
}

function jobCardHtml(job) {
  const title   = esc(job.jobTitle || 'Untitled');
  const company = job.companyName ? `<span class="job-tag tag-company">${esc(job.companyName)}</span>` : '';
  const country = job.clientCountry ? `<span class="job-tag tag-country">${esc(job.clientCountry)}</span>` : '';
  const budget  = budgetLabel(job);
  const type    = job.jobType ? `<span class="job-tag tag-type">${esc(job.jobType)}</span>` : '';
  const status  = job.jobStatus ? `<span class="job-tag tag-status">${esc(job.jobStatus)}</span>` : '';
  return `
    <div class="job-card">
      <div class="job-title" title="${title}">${title}</div>
      <div class="job-meta">${company}${country}${budget}${type}${status}</div>
    </div>`;
}

function budgetLabel(job) {
  if (job.budget?.amount) return `<span class="job-tag tag-budget">$${job.budget.amount}</span>`;
  if (job.hourlyBudget?.hourlyBudgetMin) {
    const lo = job.hourlyBudget.hourlyBudgetMin;
    const hi = job.hourlyBudget.hourlyBudgetMax;
    return `<span class="job-tag tag-budget">$${lo}–$${hi}/hr</span>`;
  }
  return '';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Button state ──────────────────────────────────────────────────────────────
function updateScrapeBtn() {
  if (_running) {
    $btnScrape.textContent = '■ Running…';
    $btnScrape.classList.add('running');
    $btnScrape.disabled = true;
  } else {
    $btnScrape.textContent = '▶ Run Scrape';
    $btnScrape.classList.remove('running');
    $btnScrape.disabled = false;
  }
}

// ── Event Listeners ───────────────────────────────────────────────────────────
$btnScrape.addEventListener('click', () => {
  if (_running) return;
  const query   = $searchInput.value.trim() || EXT_CONFIG_V2.SEARCH_QUERY;
  const maxJobs = parseInt($maxJobsInput.value) || EXT_CONFIG_V2.MAX_JOBS;

  // Build search URL from query
  const searchUrl = `https://www.upwork.com/nx/search/jobs/?nbs=1&q=${encodeURIComponent(query)}`;

  // Persist inputs
  chrome.storage.local.set({ v2_savedQuery: query, v2_savedMax: maxJobs });

  chrome.runtime.sendMessage({ action: 'v2_runScrape', searchUrl, maxJobs }, resp => {
    if (chrome.runtime.lastError) return;
    if (resp?.started) {
      _running = true;
      updateScrapeBtn();
      $progressSec.classList.remove('hidden');
      $progressBar.style.width = '0%';
      $progressBar.style.background = '#2563eb';
      $progressLabel.textContent = '⏳ Starting pipeline…';
    }
  });
});

$btnRefresh.addEventListener('click', () => {
  $btnRefresh.disabled = true;
  $tokenLabel.textContent = 'Refreshing tokens…';
  chrome.runtime.sendMessage({ action: 'v2_refreshTokens' }, resp => {
    $btnRefresh.disabled = false;
    fetchStatus();
  });
});

$btnExport.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'v2_exportJobs' }, resp => {
    if (resp?.ok) {
      $btnExport.textContent = `✓ Saved (${resp.count})`;
      setTimeout(() => { $btnExport.textContent = '⬇ Export'; }, 2000);
    }
  });
});

$btnClear.addEventListener('click', () => {
  if (!confirm('Clear all scraped jobs?')) return;
  chrome.runtime.sendMessage({ action: 'v2_clearJobs' }, () => {
    renderJobs([]);
    $progressSec.classList.add('hidden');
  });
});

$btnTest.addEventListener('click', () => {
  const query = $searchInput.value.trim() || 'n8n';
  $debugOut.style.display = 'block';
  $debugOut.textContent = 'Testing GQL call with query: ' + query + '\nWaiting...';
  chrome.runtime.sendMessage({ action: 'v2_testSearch', query }, resp => {
    if (chrome.runtime.lastError) {
      $debugOut.textContent = 'ERROR: ' + chrome.runtime.lastError.message;
      return;
    }
    $debugOut.textContent = [
      'status: ' + resp.status,
      'ok: ' + resp.ok,
      'token: ' + (resp.tokenUsed || '(none)'),
      'xsrf: ' + (resp.xsrfUsed || '(none)'),
      resp.error ? 'error: ' + resp.error : '',
      '---',
      resp.data || '(no data)',
    ].filter(Boolean).join('\n');
  });
});
