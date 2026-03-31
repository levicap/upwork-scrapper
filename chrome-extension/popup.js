'use strict';

// -- State --------------------------------------------------------------------
let allJobs        = [];
let searchJobs     = [];
let activePanel    = 'jobs';
let drawerJob      = null;
let drawerTab      = 'overview';
let searchDrawerJob = null;
let searchDrawerTab = 'overview';
let cfgInited      = false;
let scrapeRunThisSession = false; // true once Run Scrape is clicked this popup session

// -- Helpers ------------------------------------------------------------------
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function fmtSpent(amount) {
  if (!amount) return null;
  if (amount >= 1000000) return '$' + (amount / 1000000).toFixed(1) + 'M spent';
  if (amount >= 1000)    return '$' + Math.round(amount / 1000) + 'K spent';
  return '$' + Math.round(amount) + ' spent';
}

// -- Init ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const PANELS = ['jobs', 'search', 'config'];

  document.querySelectorAll('.top-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      activePanel = panel;
      document.querySelectorAll('.top-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      PANELS.forEach(p => document.getElementById('panel-' + p).classList.toggle('hidden', p !== panel));
      if (panel === 'jobs')   loadJobs();
      if (panel === 'search') loadSearchJobs();
      if (panel === 'config') initConfigPanel();
    });
  });

  document.getElementById('btn-toggle').addEventListener('click', handleToggle);
  document.getElementById('btn-run-scrape').addEventListener('click', handleRunScrape);
  document.getElementById('btn-jobs-refresh').addEventListener('click', loadJobs);
  document.getElementById('btn-jobs-download').addEventListener('click', handleJobsDownload);
  document.getElementById('btn-jobs-clear').addEventListener('click', handleJobsClear);
  document.getElementById('drawer-close').addEventListener('click', () => {
    document.getElementById('job-drawer').classList.add('hidden');
    drawerJob = null;
  });

  document.getElementById('btn-search-download').addEventListener('click', handleSearchDownload);
  document.getElementById('btn-search-clear').addEventListener('click', handleSearchClear);
  document.getElementById('search-drawer-close').addEventListener('click', () => {
    document.getElementById('search-drawer').classList.add('hidden');
    searchDrawerJob = null;
  });

  // Auto-refresh when background saves new data
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.companyLookups && activePanel === 'jobs')   loadJobs();
    if (changes.lastSearchJobs  && activePanel === 'search') loadSearchJobs();
  });

  // Always start with a clean search tab — wipe any stale results from last session
  chrome.storage.local.remove('lastSearchJobs');
  loadActiveState();
  loadJobs();
  renderSearchGrid();
});

// -- Activate / Deactivate ----------------------------------------------------
function loadActiveState() {
  chrome.runtime.sendMessage({ action: 'getActiveState' }, (res) => {
    setActiveUI(res?.active ?? false);
  });
}

function handleToggle() {
  const btn = document.getElementById('btn-toggle');
  const turnOn = btn.classList.contains('off');
  chrome.runtime.sendMessage({ action: turnOn ? 'activate' : 'deactivate' }, (res) => {
    setActiveUI(res?.active ?? turnOn);
  });
}

function setActiveUI(active) {
  const btn = document.getElementById('btn-toggle');
  const statusEl = document.getElementById('status');
  btn.textContent = active ? 'ON' : 'OFF';
  btn.classList.toggle('on', active);
  btn.classList.toggle('off', !active);
  statusEl.textContent = active ? '\u25CF Active' : '\u25CF Inactive';
  statusEl.className = 'status ' + (active ? 'active' : 'inactive');
}

// -- Load all jobs (passive browse detects) -----------------------------------
function loadJobs() {
  chrome.storage.local.get(['companyLookups'], (s) => {
    allJobs = (s.companyLookups || []).slice().reverse();
    document.getElementById('btn-jobs-download').disabled = allJobs.length === 0;
    renderJobsList();
  });
}

// -- Load search results (last Run Scrape) ------------------------------------
function loadSearchJobs() {
  // Only show results if a scrape was triggered this popup session.
  // This ensures the Search tab is always blank on fresh popup open.
  if (!scrapeRunThisSession) {
    searchJobs = [];
    document.getElementById('btn-search-download').disabled = true;
    document.getElementById('search-count').textContent = 'No results yet \u2014 click \u25B6 Run Scrape in Jobs tab';
    renderSearchGrid();
    return;
  }
  chrome.storage.local.get(['lastSearchJobs'], (s) => {
    searchJobs = s.lastSearchJobs || [];
    const countEl = document.getElementById('search-count');
    document.getElementById('btn-search-download').disabled = searchJobs.length === 0;
    countEl.textContent = searchJobs.length
      ? searchJobs.length + ' job' + (searchJobs.length !== 1 ? 's' : '') + ' from last scrape'
      : 'Scraping\u2026 jobs will appear here as they are processed';
    renderSearchGrid();
  });
}

// -- Extract job info ---------------------------------------------------------
function extractJobInfo(entry) {
  const results  = entry.results || [];
  const buyerR   = results.find(r => r.alias === 'jobAuth-buyer');
  const fullR    = results.find(r => r.alias === 'jobAuth-full');
  const ctxR     = results.find(r => r.alias === 'fetchjobdetailsandcontext');
  const cdR      = results.find(r => r.alias === 'client-details');
  const cpR      = results.find(r => r.alias === 'company-page');
  const compDetR = results.find(r => r.alias === 'company-details');

  // jobAuth-full has opening.job; jobAuth-buyer only has buyer info (no opening)
  const authFull  = fullR?.data?.data?.jobAuthDetails;
  const authBuyer = buyerR?.data?.data?.jobAuthDetails;
  const openingJ  = authFull?.opening || authBuyer?.opening;
  const jobNode   = openingJ?.job || {};
  const jobInfo   = jobNode.info || {};
  const buyer     = authBuyer?.buyer || authFull?.buyer;
  const buyerInfo = buyer?.info || {};
  const company   = buyerInfo?.company || {};
  const stats     = buyerInfo?.stats || {};
  const location  = buyerInfo?.location || buyer?.location || {};

  const ctxData    = ctxR?.data?.data?.fetchJobDetailsAndContext
                  || ctxR?.data?.data?.fetchjobdetailsandcontext;
  const ctxOpening = ctxData?.opening || {};
  // extendedBudgetInfo lives on ctxOpening (fetchjobdetailsandcontext), not jobNode
  const jobExt     = ctxOpening.extendedBudgetInfo || jobNode.extendedBudgetInfo || {};

  // Extract skills from segmentationData or sandsData
  const skills = [];
  const skillSrc = ctxOpening.segmentationData || ctxOpening.sandsData?.ontologySkills
                || jobNode.segmentationData    || jobNode.sandsData?.ontologySkills || [];
  for (const s of skillSrc) {
    const name = s?.skill?.prettyName || s?.prettyName || s?.prefLabel || s?.customValue;
    if (name && typeof name === 'string' && !skills.includes(name)) skills.push(name);
  }
  if (!skills.length) {
    for (const s of (jobInfo.skills || [])) {
      const name = s?.prettyName || s?.name || (typeof s === 'string' ? s : null);
      if (name && !skills.includes(name)) skills.push(name);
    }
  }

  const jobType   = jobExt.hourlyBudgetMin != null ? 'hourly'
    : (jobInfo.jobType || '').toLowerCase() || '';
  const hourlyMin = jobExt.hourlyBudgetMin ?? jobInfo.hourlyBudgetMin;
  const hourlyMax = jobExt.hourlyBudgetMax ?? jobInfo.hourlyBudgetMax;
  const fixedAmt  = ctxOpening.budget?.amount ?? jobNode.budget?.amount ?? jobInfo.amount?.amount;
  const currency  = ctxOpening.budget?.currencyCode || jobNode.budget?.currencyCode || jobInfo.amount?.currencyCode || 'USD';

  const totalSpent = stats.totalCharges?.amount ?? stats.totalSpent?.amount;
  const rating     = stats.score ?? stats.rating;

  const agencySet = new Map();
  for (const r of [cdR, compDetR]) {
    for (const p of (r?.profiles || [])) {
      for (const ag of (p.agencies || [])) {
        if (ag.id && !agencySet.has(ag.id)) agencySet.set(ag.id, ag);
      }
    }
  }

  const staffs = cpR?.data?.data?.agencyStaffsAuth?.staffs || [];

  let proposals = null;
  if (ctxOpening.clientActivity?.totalApplicants != null) {
    proposals = ctxOpening.clientActivity.totalApplicants;
  }

  // companyName: prefer GQL name, fall back to readable country hint, then ID
  const companyName = company.name
    || (location.country ? 'New client \u2014 ' + location.country : null)
    || ('Client #' + entry.companyId);

  return {
    title:       jobNode.info?.title || ctxOpening.info?.title || entry.jobTitle || 'Unknown Job',
    description: ctxOpening.description || jobNode.description || jobInfo.description || '',
    skills,
    jobType, hourlyMin, hourlyMax, fixedAmt, currency,
    category:    jobNode.category?.name || ctxOpening.category?.name || jobInfo.category?.name,
    country:     location.country || location.countryCode,
    city:        location.city,
    companyName,
    companyId:   entry.companyId,
    totalSpent,
    totalJobs:   stats.totalJobsPosted,
    rating,
    reviews:     stats.feedbackCount ?? stats.totalFeedback,
    isPaymentVerified: buyer?.isPaymentMethodVerified ?? company.isPaymentVerified,
    agencies:    [...agencySet.values()],
    staffs,
    proposals,
    jobCiphertext: entry.jobCiphertext,
    runAt:       entry.runAt,
    source:      entry.source,
    _entry:      entry,
  };
}

// -- Render all-jobs list (Jobs tab) ------------------------------------------
function renderJobsList() {
  const el = document.getElementById('jobs-list');
  if (allJobs.length === 0) {
    el.innerHTML = '<div class="empty">Browse a job on Upwork to auto-detect, or click \u25B6 Run Scrape.</div>';
    return;
  }
  el.innerHTML = allJobs.map((entry, i) => jobCardHtml(extractJobInfo(entry), i)).join('');
  el.querySelectorAll('.job-card-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openJobDrawer(allJobs[+btn.dataset.idx]); });
  });
  el.querySelectorAll('.job-card').forEach((card, i) => {
    card.addEventListener('click', () => openJobDrawer(allJobs[i]));
  });
}

// -- Render search results grid (Search tab, 2 columns) -----------------------
function renderSearchGrid() {
  const el = document.getElementById('search-grid');
  if (searchJobs.length === 0) {
    el.innerHTML = '<div class="empty sg-empty">Run Scrape in the Jobs tab to see results here.</div>';
    return;
  }
  el.innerHTML = searchJobs.map((entry, i) => searchCardHtml(extractJobInfo(entry), i)).join('');
  el.querySelectorAll('.search-card').forEach((card, i) => {
    card.addEventListener('click', () => openSearchDrawer(searchJobs[i]));
  });
}

// -- Job card (single-column, Jobs tab) ---------------------------------------
function jobCardHtml(info, i) {
  const budgetLabel = info.jobType === 'hourly' && (info.hourlyMin != null || info.hourlyMax != null)
    ? '$' + (info.hourlyMin ?? '?') + '\u2013$' + (info.hourlyMax ?? '?') + '/hr'
    : info.fixedAmt != null ? '$' + info.fixedAmt + ' ' + info.currency + ' fixed' : '';

  const typeLabel = info.jobType === 'hourly' ? 'Hourly' : info.fixedAmt != null ? 'Fixed' : info.jobType || '';
  const typeClass = info.jobType === 'hourly' ? 'hourly' : 'fixed';
  const descText  = (info.description || '').replace(/\n+/g, ' ').slice(0, 160);
  const spentStr  = fmtSpent(info.totalSpent);
  const agencyHtml = info.agencies.length
    ? '<span class="card-agency">\uD83C\uDFE2 ' + esc(info.agencies[0].name || 'Agency') + '</span>'
    : '';
  const skillsHtml = info.skills.slice(0, 6).map(s => '<span class="skill-tag">' + esc(s) + '</span>').join('');

  return '<div class="job-card" data-idx="' + i + '">' +
    '<div class="card-header">' +
      '<div class="card-title-row">' +
        (typeLabel ? '<span class="job-type-badge ' + esc(typeClass) + '">' + esc(typeLabel) + '</span>' : '') +
        '<span class="card-title">' + esc(info.title) + '</span>' +
      '</div>' +
      '<div class="card-budget-row">' +
        (budgetLabel ? '<span class="card-budget">' + esc(budgetLabel) + '</span>' : '') +
        '<span class="card-time">' + relTime(info.runAt) + '</span>' +
      '</div>' +
    '</div>' +
    (descText ? '<div class="card-desc">' + esc(descText) + (info.description.length > 160 ? '\u2026' : '') + '</div>' : '') +
    (skillsHtml ? '<div class="card-skills">' + skillsHtml + '</div>' : '') +
    '<div class="card-footer">' +
      '<div class="card-stats-left">' +
        (info.country ? '<span class="card-stat">\uD83D\uDCCD ' + esc(info.country) + '</span>' : '') +
        (spentStr    ? '<span class="card-stat">' + esc(spentStr) + '</span>' : '') +
        (info.rating != null ? '<span class="card-stat">\u2605 ' + (+info.rating).toFixed(1) + '</span>' : '') +
      '</div>' +
      '<div class="card-stats-right">' +
        agencyHtml +
        (info.proposals != null ? '<span class="card-stat-right">\uD83D\uDDC2 ' + esc(String(info.proposals)) + ' proposals</span>' : '') +
      '</div>' +
    '</div>' +
    '<button class="job-card-btn" data-idx="' + i + '">Details \u2192</button>' +
  '</div>';
}

// -- Search card (2-column grid, Search tab) ----------------------------------
function searchCardHtml(info, i) {
  const budget = info.jobType === 'hourly' && (info.hourlyMin != null || info.hourlyMax != null)
    ? '$' + (info.hourlyMin ?? '?') + '\u2013$' + (info.hourlyMax ?? '?') + '/hr'
    : info.fixedAmt != null ? '$' + info.fixedAmt + ' fixed' : '';
  const typeLabel = info.jobType === 'hourly' ? 'Hourly' : info.fixedAmt != null ? 'Fixed' : info.jobType || '';
  const typeClass = info.jobType === 'hourly' ? 'hourly' : 'fixed';
  const descText  = (info.description || '').replace(/\n+/g, ' ').slice(0, 130);
  const spentStr  = fmtSpent(info.totalSpent);
  const skillsHtml = info.skills.slice(0, 4).map(s => '<span class="skill-tag">' + esc(s) + '</span>').join('');

  return '<div class="search-card" data-idx="' + i + '">' +
    '<div class="sc-top">' +
      (typeLabel ? '<span class="job-type-badge ' + esc(typeClass) + '">' + esc(typeLabel) + '</span>' : '') +
      (budget ? '<span class="sc-budget">' + esc(budget) + '</span>' : '') +
      '<span class="sc-time">' + relTime(info.runAt) + '</span>' +
    '</div>' +
    '<div class="sc-title">' + esc(info.title) + '</div>' +
    (descText ? '<div class="sc-desc">' + esc(descText) + (info.description.length > 130 ? '\u2026' : '') + '</div>' : '') +
    (skillsHtml ? '<div class="sc-skills">' + skillsHtml + '</div>' : '') +
    '<div class="sc-footer">' +
      (info.country ? '<span class="sc-stat">\uD83D\uDCCD ' + esc(info.country) + '</span>' : '') +
      (spentStr    ? '<span class="sc-stat">' + esc(spentStr) + '</span>' : '') +
      (info.rating != null ? '<span class="sc-stat">\u2605 ' + (+info.rating).toFixed(1) + '</span>' : '') +
      (info.agencies.length ? '<span class="sc-stat sc-agency">\uD83C\uDFE2 ' + esc(info.agencies[0].name || 'Agency') + '</span>' : '') +
    '</div>' +
  '</div>';
}

// -- Job drawer (Jobs tab: targets job-drawer) ---------------------------------
function openJobDrawer(entry) {
  drawerJob = entry;
  const info = extractJobInfo(entry);
  document.getElementById('drawer-title').textContent = info.title.slice(0, 55);
  document.getElementById('job-drawer').classList.remove('hidden');
  buildDrawerTabs('drawer-tabs', drawerTab, (tab) => {
    drawerTab = tab;
    renderDrawerContent('drawer-content', entry, info, tab);
  });
  renderDrawerContent('drawer-content', entry, info, drawerTab);
  document.getElementById('job-drawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// -- Search drawer (Search tab: targets search-drawer) ------------------------
function openSearchDrawer(entry) {
  searchDrawerJob = entry;
  const info = extractJobInfo(entry);
  document.getElementById('search-drawer-title').textContent = info.title.slice(0, 55);
  document.getElementById('search-drawer').classList.remove('hidden');
  buildDrawerTabs('search-drawer-tabs', searchDrawerTab, (tab) => {
    searchDrawerTab = tab;
    renderDrawerContent('search-drawer-content', entry, info, tab);
  });
  renderDrawerContent('search-drawer-content', entry, info, searchDrawerTab);
  document.getElementById('search-drawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// -- Shared drawer tab builder ------------------------------------------------
function buildDrawerTabs(tabsElId, activeTab, onChange) {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'client',   label: 'Client'   },
    { id: 'agency',   label: 'Agency'   },
    { id: 'context',  label: 'Context'  },
    { id: 'raw',      label: 'Raw JSON' },
  ];
  const tabsEl = document.getElementById(tabsElId);
  tabsEl.innerHTML = tabs.map(t =>
    '<button class="tab-btn ' + (t.id === activeTab ? 'active' : '') + '" data-dtab="' + esc(t.id) + '">' + esc(t.label) + '</button>'
  ).join('');
  tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.dtab);
    });
  });
}

// -- Shared drawer content renderer -------------------------------------------
function renderDrawerContent(contentElId, entry, info, tab) {
  const el = document.getElementById(contentElId);
  switch (tab) {
    case 'overview': el.innerHTML = renderOverview(info);          break;
    case 'client':   el.innerHTML = renderClient(info);            break;
    case 'agency':   el.innerHTML = renderAgency(info, entry);     break;
    case 'context':  el.innerHTML = renderJobContext(entry);        break;
    case 'raw':      el.innerHTML = '<pre class="raw-json">' + esc(JSON.stringify(entry, null, 2)) + '</pre>'; break;
    default:         el.innerHTML = '';
  }
}

function dtRow(key, val, isLink) {
  if (val == null || val === '') val = '\u2014';
  const valHtml = isLink && typeof val === 'string' && val.startsWith('http')
    ? '<a href="' + esc(val) + '" target="_blank" class="detail-link">' + esc(val) + '</a>'
    : esc(String(val));
  return '<tr><td class="dt-key">' + esc(key) + '</td><td class="dt-val">' + valHtml + '</td></tr>';
}

function renderOverview(info) {
  const budget = info.jobType === 'hourly' && (info.hourlyMin != null || info.hourlyMax != null)
    ? '$' + (info.hourlyMin ?? '?') + '\u2013$' + (info.hourlyMax ?? '?') + '/hr'
    : info.fixedAmt != null ? '$' + info.fixedAmt + ' ' + info.currency : '\u2014';
  const link = info.jobCiphertext ? 'https://www.upwork.com/jobs/' + info.jobCiphertext : null;
  const skillsHtml = info.skills.length
    ? info.skills.map(s => '<span class="skill-tag">' + esc(s) + '</span>').join('')
    : '<span style="color:#556">\u2014</span>';
  const descHtml = info.description
    ? '<div class="detail-section"><div class="detail-section-title">Description</div><div class="detail-desc">' + esc(info.description) + '</div></div>'
    : '';
  return '<div class="detail-section"><table class="detail-table">' +
    dtRow('Title',     info.title) +
    dtRow('Type',      info.jobType || '\u2014') +
    dtRow('Budget',    budget) +
    dtRow('Category',  info.category || '\u2014') +
    dtRow('Location',  [info.city, info.country].filter(Boolean).join(', ') || '\u2014') +
    dtRow('Proposals', info.proposals ?? '\u2014') +
    dtRow('Scraped',   info.runAt ? new Date(info.runAt).toLocaleString() : '\u2014') +
    dtRow('Link',      link || '\u2014', true) +
    '</table></div>' +
    '<div class="detail-section"><div class="detail-section-title">Skills</div><div class="detail-skills">' + skillsHtml + '</div></div>' +
    descHtml;
}

function renderClient(info) {
  const auth = (info._entry.results || []).find(r => r.alias === 'jobAuth-buyer' || r.alias === 'jobAuth-full');
  const bi   = auth?.data?.data?.jobAuthDetails?.buyer?.info || {};
  const co   = bi.company || {};
  const st   = bi.stats   || {};
  const loc  = bi.location || {};
  return '<div class="detail-section"><table class="detail-table">' +
    dtRow('Company',      co.name || '\u2014') +
    dtRow('Country',      [loc.city, loc.country].filter(Boolean).join(', ') || '\u2014') +
    dtRow('Member Since', co.memberSince || bi.memberSince || '\u2014') +
    dtRow('Total Spent',  fmtSpent(st.totalCharges?.amount ?? st.totalSpent?.amount) || '\u2014') +
    dtRow('Jobs Posted',  st.totalJobsPosted ?? '\u2014') +
    dtRow('Hire Rate',    st.percentHired != null ? Math.round(st.percentHired * 100) + '%' : '\u2014') +
    dtRow('Rating',       st.score != null ? (+st.score).toFixed(2) : '\u2014') +
    dtRow('Reviews',      st.feedbackCount ?? st.totalFeedback ?? '\u2014') +
    dtRow('Verified',     co.isPaymentVerified != null ? (co.isPaymentVerified ? '\u2713 Yes' : '\u2717 No') : '\u2014') +
    '</table></div>';
}

function renderAgency(info, entry) {
  let html = '';
  if (info.agencies.length) {
    for (const ag of info.agencies) {
      html += '<div class="agency-card">' +
        '<div class="agency-name">' + esc(ag.name || 'Agency') + '</div>' +
        '<table class="detail-table">' +
        (ag.id ? dtRow('Link', 'https://www.upwork.com/agencies/' + ag.id + '/', true) : '') +
        (ag.score != null ? dtRow('Score', ag.score) : '') +
        (ag.totalFeedback != null ? dtRow('Reviews', ag.totalFeedback) : '') +
        (ag.totalHours != null ? dtRow('Hours', ag.totalHours) : '') +
        (ag.nSS100BwScore != null ? dtRow('NSS', ag.nSS100BwScore) : '') +
        (ag.topRatedStatus ? dtRow('Top Rated', ag.topRatedStatus) : '') +
        '</table></div>';
    }
  } else {
    html += '<div class="empty" style="padding:16px">No agency data found.</div>';
  }
  if (info.staffs.length) {
    html += '<div class="detail-section-title" style="margin:12px 0 6px">Staff (' + info.staffs.length + ')</div>';
    for (const st of info.staffs) {
      const pd = st.personalData || {};
      html += '<div class="staff-row">' +
        '<div class="staff-name">' + esc(pd.name || '\u2014') + '</div>' +
        '<div class="staff-meta">' +
          (st.memberType ? '<span class="staff-badge">' + esc(st.memberType) + '</span>' : '') +
          (st.agencyOwner ? '<span class="staff-badge owner">Owner</span>' : '') +
          '<span class="staff-jss">JSS: ' + (pd.jobSuccessScore ?? '\u2014') + '</span>' +
          (pd.ciphertext ? '<a href="https://www.upwork.com/freelancers/' + esc(pd.ciphertext) + '" target="_blank" class="detail-link" style="font-size:10px">Profile \u2192</a>' : '') +
        '</div></div>';
    }
  }
  return html;
}

function renderJobContext(entry) {
  const ctxR = (entry.results || []).find(r => r.alias === 'fetchjobdetailsandcontext');
  if (!ctxR || ctxR.skipped) return '<div class="empty" style="padding:16px">No job context data.</div>';
  if (ctxR.error) return '<div class="empty" style="padding:16px;color:#e07070">Error: ' + esc(ctxR.error) + '</div>';
  return '<pre class="raw-json">' + esc(JSON.stringify(ctxR.data || ctxR, null, 2)) + '</pre>';
}

// -- Run Scrape ---------------------------------------------------------------
function handleRunScrape() {
  const btn    = document.getElementById('btn-run-scrape');
  const status = document.getElementById('scrape-status');
  const url     = EXT_CONFIG.SEARCH_URL;
  const maxJobs = EXT_CONFIG.MAX_JOBS;

  btn.disabled = true;
  btn.textContent = '\u23F3 Scraping\u2026';
  status.textContent = 'Starting\u2026';

    // Mark this session as having a scrape so loadSearchJobs() shows real data
    scrapeRunThisSession = true;

    // Clear previous results in storage and UI, then switch to Search tab
    chrome.storage.local.set({ lastSearchJobs: [] }, () => {
      searchJobs = [];
      renderSearchGrid();
      document.getElementById('btn-search-download').disabled = true;
      document.getElementById('search-count').textContent = 'Scraping\u2026 0 jobs so far';

      // Switch to Search tab
      const searchTab = document.querySelector('.top-tab[data-panel="search"]');
      if (searchTab) searchTab.click();

      chrome.runtime.sendMessage({ action: 'runSearchLookup', searchUrl: url, maxJobs }, (res) => {
        btn.disabled = false;
        btn.textContent = '\u25B6 Run Scrape';
        if (chrome.runtime.lastError) {
          status.textContent = '\u2717 ' + chrome.runtime.lastError.message;
          showToast('Error: ' + chrome.runtime.lastError.message);
          return;
        }
        if (!res) { status.textContent = '\u2717 No response'; return; }
        if (!res.success) {
          status.textContent = '\u2717 ' + (res.error || 'Unknown error');
          showToast(res.error || 'Scrape failed');
          return;
        }
        if (res.started) {
          status.textContent = '\u23F3 Scraping\u2026 results appear as processed';
          showToast('Scraping started \u2014 cards appear as processed');
          return;
        }
        const pages = res.pages || 1;
        status.textContent = '\u23F3 Scraping ' + res.found + ' jobs across ' + pages + ' page' + (pages !== 1 ? 's' : '') + '\u2026';
        showToast('Scraping ' + res.found + ' jobs \u2014 cards appear as processed');
      });
    });
}

// -- Download / Clear (Jobs tab) ----------------------------------------------
function handleJobsDownload() {
  if (!allJobs.length) { showToast('Nothing to download'); return; }
  const blob = new Blob([JSON.stringify(allJobs, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'upwork_jobs_' + Date.now() + '.json' }).click();
  URL.revokeObjectURL(url);
  showToast('Downloaded ' + allJobs.length + ' job(s)');
}

function handleJobsClear() {
  if (!confirm('Clear all scraped jobs?')) return;
  chrome.storage.local.set({ companyLookups: [] }, () => {
    allJobs = [];
    document.getElementById('btn-jobs-download').disabled = true;
    document.getElementById('job-drawer').classList.add('hidden');
    drawerJob = null;
    renderJobsList();
    showToast('Cleared');
  });
}

// -- Download / Clear (Search tab) --------------------------------------------
function handleSearchDownload() {
  if (!searchJobs.length) { showToast('Nothing to download'); return; }
  const blob = new Blob([JSON.stringify(searchJobs, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'upwork_search_' + Date.now() + '.json' }).click();
  URL.revokeObjectURL(url);
  showToast('Downloaded ' + searchJobs.length + ' job(s)');
}

function handleSearchClear() {
  if (!confirm('Clear search results?')) return;
  scrapeRunThisSession = false;
  chrome.storage.local.set({ lastSearchJobs: [] }, () => {
    searchJobs = [];
    document.getElementById('btn-search-download').disabled = true;
    document.getElementById('search-drawer').classList.add('hidden');
    searchDrawerJob = null;
    renderSearchGrid();
    document.getElementById('search-count').textContent = 'No results yet \u2014 click \u25B6 Run Scrape in Jobs tab';
    showToast('Cleared');
  });
}

// -- Config panel -------------------------------------------------------------
function initConfigPanel() {
  refreshTokenStatus();
  if (cfgInited) return;
  cfgInited = true;
}

function cfgLog(msg) {
  const el = document.getElementById('cfg-log');
  if (!el) return;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + new Date().toLocaleTimeString() + '  ' + msg;
  el.scrollTop = el.scrollHeight;
}

function refreshTokenStatus() {
  chrome.runtime.sendMessage({ action: 'getSessionTokens' }, (res) => {
    if (!res) return;
    const map = {
      'tok-search': [res.hasSearchTok, 'search'],
      'tok-job':    [res.hasJobTok,    'job'],
      'tok-global': [res.hasGlobalTok, 'global'],
      'tok-tenant': [res.hasTenantId,  'tenant'],
      'tok-xsrf':   [res.hasXsrf,      'xsrf'],
      'tok-agency': [res.hasAgencyTok, 'agency'],
    };
    for (const [id, [ok, label]] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = (ok ? '\uD83D\uDFE2 ' : '\uD83D\uDD34 ') + label;
      el.classList.toggle('ok', !!ok);
    }
  });
}