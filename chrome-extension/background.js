// ─── In-memory store for in-flight requests ──────────────────────────────────
// Keyed by requestId. Cleared once the response body is retrieved.
const pendingRequests = new Map();

// Track which tab IDs have an active debugger session
const attachedTabs = new Set();

// Last seen session context (bearer token + tenant) — updated from every captured request
const lastSessionCtx = { bearer: null, tenantId: null };

// Track the current page-stage per tab so every captured request is labelled
// Stages: 'search' | 'job' | 'apply' | 'company' | 'other'
const tabPageStage = new Map();

// Track last job URL per tab for auto-capture on navigation-away
const tabLastJobUrl = new Map();

// ─── Keep service worker alive ────────────────────────────────────────────────
// Chrome MV3 service workers are terminated after ~30 s of inactivity.
// A periodic alarm prevents that while the extension is in use.
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  // no-op; just wakes the service worker
});

// ─── Attach to existing Upwork tabs on install / browser startup / SW restart ──
// onInstalled fires on first install/update; onStartup fires on browser start.
// Neither fires on MV3 service-worker restart — so we also call immediately.
chrome.runtime.onInstalled.addListener(attachToAllUpworkTabs);
chrome.runtime.onStartup.addListener(attachToAllUpworkTabs);
attachToAllUpworkTabs(); // runs every time the service worker (re-)starts

async function attachToAllUpworkTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.url.includes('upwork.com')) {
      attachDebugger(tab.id);
    }
  }
}

// ─── Attach when user navigates to Upwork ────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.status || !tab.url) return;
  if (!tab.url.includes('upwork.com')) return;

  if (changeInfo.status === 'loading') {
    attachDebugger(tabId);

    // Classify new URL into a page stage
    const url = tab.url;
    let stage = 'other';
    if (/\/nx\/search\/jobs|\?q=|\?skills=|\?category2_uid=|search\/jobs/.test(url)) stage = 'search';
    else if (/\/jobs\/(~0[^/?#]+).*apply|apply-direct/.test(url))                    stage = 'apply';
    else if (/\/jobs\/(~0[^/?#]+)|contracts\/new/.test(url))                         stage = 'job';
    else if (/\/companies\/|\/(agencies|clients)\/|org\//.test(url))                 stage = 'company';
    tabPageStage.set(tabId, stage);

    // Auto-capture if user is navigating away from a job/apply page
    const prevJobUrl = tabLastJobUrl.get(tabId);
    if (prevJobUrl && prevJobUrl !== url && attachedTabs.has(tabId)) {
      // Fire-and-forget silent capture of the previous job page
      triggerAutoCapture(tabId, prevJobUrl);
    }
    // Record job/apply URLs so we can auto-capture on leave
    if (stage === 'job' || stage === 'apply') {
      tabLastJobUrl.set(tabId, url);
    } else {
      tabLastJobUrl.delete(tabId);
    }
  }
});

// ─── Clean up when a tab is closed ───────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabPageStage.delete(tabId);
  tabLastJobUrl.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    tabPageStage.delete(source.tabId);
    tabLastJobUrl.delete(source.tabId);
  }
});

// ─── Auto-capture on navigation away from a job page ─────────────────────────
// Silently builds and persists a job record in the background; no popup needed.
async function triggerAutoCapture(tabId, prevJobUrl) {
  try {
    const job = jcEmptyRecord(prevJobUrl);
    const uidFromUrl    = (prevJobUrl.match(/\/jobs\/~0(\d+)/) || prevJobUrl.match(/uid=(\d{15,})/))?.[1] || null;
    const cipherFromUrl = (prevJobUrl.match(/\/jobs\/(~0[^/?#\s]+)/))?.[1] || null;
    if (uidFromUrl)    job._uid    = uidFromUrl;
    if (cipherFromUrl) job._cipher = cipherFromUrl;

    // Scan stored requests for this job's data
    const stored = await new Promise(res => chrome.storage.local.get(['requests'], r => res(r)));
    const SKIP_EXT  = ['.js','.css','.png','.jpg','.jpeg','.gif','.svg','.woff','.woff2','.ttf','.ico','.webp','.mp4'];
    const SKIP_PATH = ['/analytics','/pixel','/beacon','/track','/metrics','/telemetry','/collect','/favicon','/__webpack'];
    for (const req of (stored.requests || [])) {
      if (!req.url || !req.url.includes('upwork.com')) continue;
      if (SKIP_EXT.some(e => req.url.toLowerCase().includes(e))) continue;
      if (SKIP_PATH.some(p => req.url.includes(p))) continue;
      if (!req.responseBody) continue;
      const body = typeof req.responseBody === 'string' ? tryParseJson(req.responseBody) : req.responseBody;
      if (!body || typeof body !== 'object') continue;
      const isApiEndpoint = req.url.includes('/api/') || req.url.includes('/graphql/');
      const bodyStr = JSON.stringify(body);
      if (!isApiEndpoint) {
        if (!bodyStr.includes('"buyer"') && !bodyStr.includes('"jobDetails"') &&
            !bodyStr.includes('"ciphertext"') && !bodyStr.includes('"opening"')) continue;
      }
      if (!job._cipher) { const cm = bodyStr.match(/"ciphertext"\s*:\s*"(~0[^"]+)"/); if (cm) job._cipher = cm[1]; }
      if (!job._uid)    { const um = req.url.match(/uid=(\d{15,})/) || bodyStr.match(/"uid"\s*:\s*"(\d{15,})"/); if (um) job._uid = um[1]; }
      jcFold(job, body, (req._pageStage || 'stored') + ':' + req.url.replace(/https?:\/\/[^/]+/, '').replace(/[?#].*/, '').slice(0, 50));
    }

    job._capturedAt = new Date().toISOString();
    job._autoCapture = true;

    if (!job._uid && !job._cipher) return; // nothing useful

    chrome.storage.local.get(['capturedJobs'], (s) => {
      const jobs = s.capturedJobs || [];
      const idx  = jobs.findIndex(j => j._tabUrl === prevJobUrl || (job._uid && j._uid === job._uid));
      if (idx >= 0) jobs[idx] = job; else jobs.unshift(job);
      chrome.storage.local.set({ capturedJobs: jobs.slice(0, 50) });
    });
  } catch (_) { /* silent */ }
}

// ─── Debugger attachment ──────────────────────────────────────────────────────
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);

    // Enable Network domain so we receive all network events
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxResourceBufferSize: 10 * 1024 * 1024,  // 10 MB per resource
      maxTotalBufferSize:   100 * 1024 * 1024   // 100 MB total
    });

    console.log(`[UpworkCapture] Debugger attached → tab ${tabId}`);
  } catch (e) {
    // Common causes: DevTools already open on the tab, tab closed, non-http tab
    console.warn(`[UpworkCapture] Could not attach to tab ${tabId}: ${e.message}`);
  }
}

// ─── Network event handling ───────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!source.tabId) return;
  const tabId = source.tabId;

  // ── Request started ──────────────────────────────────────────────────────
  if (method === 'Network.requestWillBeSent') {
    const { requestId, request, initiator, type, wallTime } = params;

    const postData = request.postData || null;

    pendingRequests.set(requestId, {
      tabId,
      requestId,
      url:            request.url,
      method:         request.method,
      requestHeaders: request.headers,
      requestBody:    postData ? tryParseJson(postData) : null,
      resourceType:   type || null,
      initiatorType:  initiator?.type || null,
      initiatorUrl:   initiator?.url || null,
      timestamp:      wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
      // filled in later
      status:              null,
      statusText:          null,
      responseHeaders:     null,
      mimeType:            null,
      responseBody:        null,
      responseBase64:      false,
      encodedDataLength:   null,
      error:               null
    });

    // Also capture extra request headers (cookies, authorisation, etc.)
    // These arrive in a separate event just after requestWillBeSent.
  }

  // ── Extra request headers (cookies, auth tokens, etc.) ───────────────────
  if (method === 'Network.requestWillBeSentExtraInfo') {
    const { requestId, headers } = params;
    const entry = pendingRequests.get(requestId);
    if (entry) {
      // Merge extra headers on top of the regular ones
      entry.requestHeaders = Object.assign({}, entry.requestHeaders, headers);
    }
  }

  // ── Response metadata ────────────────────────────────────────────────────
  if (method === 'Network.responseReceived') {
    const { requestId, response } = params;
    const entry = pendingRequests.get(requestId);
    if (!entry) return;

    entry.status         = response.status;
    entry.statusText     = response.statusText;
    entry.responseHeaders = response.headers;
    entry.mimeType       = response.mimeType;
  }

  // ── Extra response headers ────────────────────────────────────────────────
  if (method === 'Network.responseReceivedExtraInfo') {
    const { requestId, headers } = params;
    const entry = pendingRequests.get(requestId);
    if (entry) {
      entry.responseHeaders = Object.assign({}, entry.responseHeaders, headers);
    }
  }

  // ── Response body available ───────────────────────────────────────────────
  if (method === 'Network.loadingFinished') {
    const { requestId, encodedDataLength } = params;
    const entry = pendingRequests.get(requestId);
    if (!entry) return;

    entry.encodedDataLength = encodedDataLength;
    pendingRequests.delete(requestId);

    try {
      const result = await chrome.debugger.sendCommand(
        { tabId },
        'Network.getResponseBody',
        { requestId }
      );

      if (result.base64Encoded) {
        // Binary content – keep raw base64 string
        entry.responseBody   = result.body;
        entry.responseBase64 = true;
      } else {
        // Text content – try to parse as JSON
        entry.responseBody   = tryParseJson(result.body);
        entry.responseBase64 = false;
      }
    } catch (_) {
      // Body not buffered (e.g. streaming, large binary) – that is fine
    }

    await saveRequest(entry);
  }

  // ── Request failed ────────────────────────────────────────────────────────
  if (method === 'Network.loadingFailed') {
    const { requestId, errorText, canceled } = params;
    const entry = pendingRequests.get(requestId);
    if (!entry) return;

    entry.error    = errorText;
    entry.canceled = canceled || false;
    pendingRequests.delete(requestId);

    await saveRequest(entry);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function tryParseJson(str) {
  if (!str || typeof str !== 'string') return str;
  const trimmed = str.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try { return JSON.parse(trimmed); } catch (_) { /* not JSON */ }
  }
  return str;
}

// Truncate oversized string values so storage doesn't overflow
const MAX_BODY_CHARS = 100 * 1024; // 100 KB per body

function truncateBody(body) {
  if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
    return body.slice(0, MAX_BODY_CHARS) + '…[truncated]';
  }
  return body;
}

async function saveRequest(entry) {
  // Update last-seen session context from this request's headers
  const h = entry.requestHeaders || {};
  const bearer = (h['Authorization'] || h['authorization'] || '').replace('Bearer ', '').trim();
  if (bearer) lastSessionCtx.bearer = bearer;
  const tid = h['X-Upwork-API-TenantId'] || h['x-upwork-api-tenantid'];
  if (tid) lastSessionCtx.tenantId = tid;

  // ── Extract and persist Upwork session tokens from Cookie header ───────────
  // document.cookie won't expose HttpOnly cookies, so we harvest them here
  // from the raw request headers captured by the debugger.
  const cookieStr = h['Cookie'] || h['cookie'] || '';
  if (cookieStr || bearer || tid) {
    const TOKEN_NAMES = [
      'UniversalSearchNuxt_vt', 'JobDetailsNuxt_vt', 'oauth2_global_js_token',
      'XSRF-TOKEN', 'current_organization_uid', 'ag_vs_ui_gql_token'
    ];
    const found = {};
    for (const name of TOKEN_NAMES) {
      const m = cookieStr.match(new RegExp('(?:^|; )' + name.replace(/[-]/g, '\\-') + '=([^;]*)'));
      if (m) found[name] = decodeURIComponent(m[1]);
    }
    if (bearer) found._bearer = bearer;
    if (tid)    found._tenantId = tid;
    if (Object.keys(found).length > 0) {
      chrome.storage.local.get(['sessionTokens'], (st) => {
        chrome.storage.local.set({ sessionTokens: Object.assign({}, st.sessionTokens || {}, found) });
      });
    }
  }

  // Tag this request with the page stage of its originating tab
  entry._pageStage = tabPageStage.get(entry.tabId) || 'other';

  // Cap body sizes to protect chrome.storage.local (10 MB quota)
  const safe = {
    ...entry,
    requestBody:  truncateBody(entry.requestBody),
    responseBody: truncateBody(entry.responseBody)
  };

  // Auto-detect buyer company from job-details responses
  maybeExtractCompany(entry);

  return new Promise((resolve) => {
    chrome.storage.local.get(['requests', 'totalCount'], (result) => {
      const requests   = result.requests   || [];
      const totalCount = (result.totalCount || 0) + 1;

      requests.push(safe);

      // Rolling window: keep the newest 500 entries
      const trimmed = requests.length > 500 ? requests.slice(-500) : requests;

      chrome.storage.local.set({ requests: trimmed, totalCount }, resolve);
    });
  });
}

// ─── Message API (used by popup) ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.action === 'getRequests') {
    chrome.storage.local.get(['requests', 'totalCount'], (result) => {
      sendResponse({
        requests:   result.requests   || [],
        totalCount: result.totalCount || 0
      });
    });
    return true; // keep channel open for async sendResponse
  }

  if (message.action === 'clearRequests') {
    chrome.storage.local.set({ requests: [], totalCount: 0 }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'getStatus') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      sendResponse({
        isUpwork:         !!(tab?.url?.includes('upwork.com')),
        isAttached:       !!(tab && attachedTabs.has(tab.id)),
        attachedTabsCount: attachedTabs.size
      });
    });
    return true;
  }

  if (message.action === 'attachCurrent') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (tab) {
        await attachDebugger(tab.id);
        sendResponse({ success: true, attached: attachedTabs.has(tab.id) });
      } else {
        sendResponse({ success: false });
      }
    });
    return true;
  }

  if (message.action === 'exportAndDownload') {
    chrome.storage.local.get(['requests'], (result) => {
      const requests = result.requests || [];
      const json = JSON.stringify(requests, null, 2);
      const filename = `upwork_api_capture_${Date.now()}.json`;

      // Use data URL with downloads API for service-worker context
      const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
      chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, () => {
        sendResponse({ success: true, count: requests.length });
      });
    });
    return true;
  }

  // ── Company Lookup handlers ──────────────────────────────────────────────

  if (message.action === 'getDetectedCompanies') {
    chrome.storage.local.get(['detectedCompanies'], (result) => {
      sendResponse({ companies: result.detectedCompanies || [] });
    });
    return true;
  }

  if (message.action === 'runCompanyLookup') {
    const { companyId, jobCiphertext, jobTitle } = message;
    chrome.tabs.query({}, async (tabs) => {
      const upworkTab = tabs.find(t => t.url && t.url.includes('upwork.com') && attachedTabs.has(t.id));
      if (!upworkTab) {
        sendResponse({ success: false, error: 'No attached Upwork tab found. Navigate to Upwork first.' });
        return;
      }
      try {
        // Read company name cached from Vue $store at detection time
        const prefill = await new Promise(resolve => {
          chrome.storage.local.get(['detectedCompanies'], (stored) => {
            const dc = (stored.detectedCompanies || []).find(c => c.companyId === companyId);
            resolve(dc ? { companyName: dc.companyName || null, location: dc.location || null, jobTitle: dc.jobTitle || null, source: 'cached-detection' } : null);
          });
        });
        let results = await runQueriesInTab(upworkTab.id, companyId, jobCiphertext, prefill);

        // ── Run fetchjobdetailsandcontext + agency lookup in PARALLEL ──────────
        const jaBuyerR = results.find(r => r.alias === 'jobAuth-buyer');
        const agencyCId = jaBuyerR?.data?.data?.jobAuthDetails?.buyer?.info?.company?.companyId || companyId;

        const [jcResult, rawCp] = await Promise.all([
          jobCiphertext
            ? runJobContextLookup(jobCiphertext)
            : Promise.resolve({ alias: 'fetchjobdetailsandcontext', skipped: true, reason: 'no jobCiphertext' }),
          agencyCId
            ? runAgencyLookupInNewTab(agencyCId)
            : Promise.resolve({ alias: 'company-page', skipped: true, reason: 'no companyId' })
        ]);

        // Split agency profiles into separate result entries
        const { profiles: cpProfiles, ...cpResult } = rawCp;
        const cdResult      = { alias: 'client-details',   companyId: rawCp.companyId, profiles: cpProfiles || [] };
        const compDetResult = { alias: 'company-details',  companyId: rawCp.companyId, profiles: cpProfiles || [] };

        results = results.filter(r =>
          r.alias !== 'fetchjobdetailsandcontext' &&
          r.alias !== 'company-page' &&
          r.alias !== 'client-details' &&
          r.alias !== 'company-details'
        );
        results = [...results, jcResult, cpResult, cdResult, compDetResult];

        chrome.storage.local.get(['companyLookups', 'webhookUrl'], (stored) => {
          const lookups = stored.companyLookups || [];
          const idx = lookups.findIndex(l => l.companyId === companyId);
          const entry = { companyId, jobCiphertext: jobCiphertext || null, jobTitle: jobTitle || 'Unknown', runAt: new Date().toISOString(), results };
          if (idx >= 0) lookups[idx] = entry; else lookups.push(entry);
          chrome.storage.local.set({ companyLookups: lookups }, () => {
            // Forward full combined JSON to configured webhook + hardcoded test endpoint
            const payload = JSON.stringify(cleanForWebhook({ companyId, jobCiphertext: jobCiphertext || null, jobTitle: jobTitle || 'Unknown', runAt: entry.runAt, results }));
            const targets = ['https://auto.moezzhioua.com/webhook/test'];
            if (stored.webhookUrl && stored.webhookUrl !== targets[0]) targets.push(stored.webhookUrl);
            for (const url of targets) {
              fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
                .catch(e => console.warn('[upwork-ext] lookup webhook error:', url, e.message));
            }
            sendResponse({ success: true, results });
          });
        });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    });
    return true;
  }

  if (message.action === 'getCompanyLookups') {
    chrome.storage.local.get(['companyLookups'], (result) => {
      sendResponse({ lookups: result.companyLookups || [] });
    });
    return true;
  }

  if (message.action === 'clearCompanyData') {
    chrome.storage.local.set({ detectedCompanies: [], companyLookups: [] }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // ── Job Details query (jobPostingByUid) ───────────────────────────────────
  if (message.action === 'runJobDetailsQuery') {
    const { jobUid } = message;
    chrome.tabs.query({}, async (tabs) => {
      const upworkTab = tabs.find(t => t.url && t.url.includes('upwork.com') && attachedTabs.has(t.id));
      if (!upworkTab) {
        sendResponse({ success: false, error: 'No attached Upwork tab found. Navigate to Upwork first.' });
        return;
      }
      try {
        const expression = `
(async () => {
  const getCookie = name => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const token = getCookie('oauth2_global_js_token')
             || getCookie('UniversalSearchNuxt_vt')
             || getCookie('JobDetailsNuxt_vt');
  const xsrf  = getCookie('XSRF-TOKEN');
  if (!token) return JSON.stringify({ fatalError: 'No auth token cookie found — are you logged in to Upwork?' });

  const query = \`query GetJobDetails($jobId: String!) {
    jobPostingByUid(uid: $jobId) {
      buyer {
        info {
          company { name id companyUid contractDate isEDCReplicated profile { size industry visible } }
          location { country city state countryTimezone offsetFromUtcMillis }
          jobs { postedCount filledCount openCount }
          stats { feedbackCount hoursCount totalAssignments score totalJobsWithHires }
        }
        isPaymentMethodVerified
        isEnterprise
        cssTier
      }
      currentUserInfo {
        owner
        freelancerInfo {
          qualificationsMatches {
            totalQualifications
            totalMatches
            matches { qualification qualified clientPreferred freelancerValue freelancerValueLabel clientPreferredLabel }
          }
        }
      }
      similarJobs { uid title }
    }
  }\`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-upwork-accept-language': 'en-US',
    'Authorization': 'Bearer ' + token
  };
  if (xsrf) headers['x-xsrf-token'] = xsrf;

  const resp = await fetch('https://www.upwork.com/api/graphql/v1', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ query, variables: { jobId: ${JSON.stringify(jobUid)} } })
  });

  let data;
  try { data = await resp.json(); } catch(_) { data = null; }
  return JSON.stringify({ status: resp.status, data });
})()
        `;

        const evalResult = await chrome.debugger.sendCommand(
          { tabId: upworkTab.id },
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true }
        );

        if (evalResult.exceptionDetails) {
          const msg = evalResult.exceptionDetails.exception?.description
            || evalResult.exceptionDetails.text
            || 'Runtime.evaluate failed';
          sendResponse({ success: false, error: msg });
          return;
        }

        const parsed = JSON.parse(evalResult.result.value);
        if (parsed?.fatalError) {
          sendResponse({ success: false, error: parsed.fatalError });
        } else {
          sendResponse({ success: true, status: parsed.status, data: parsed.data });
        }
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    });
    return true; // keep channel open for async sendResponse
  }

  // ── Full Job Capture (capture.js logic inside the extension) ─────────────
  if (message.action === 'runFullJobCapture') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes('upwork.com')) {
        sendResponse({ success: false, error: 'Please navigate to a job page on Upwork first.' });
        return;
      }
      // Auto-attach if the service worker was restarted (in-memory Set is empty)
      if (!attachedTabs.has(tab.id)) {
        await attachDebugger(tab.id);
      }
      if (!attachedTabs.has(tab.id)) {
        sendResponse({ success: false, error: 'Could not attach debugger — close Chrome DevTools on this tab and try again.' });
        return;
      }
      try {
        const job = jcEmptyRecord(tab.url);

        // ── STEP 1: Extract full page state from the live page ──────────────
        const nuxtExpr = `(function() {
          try {
            // ── Nuxt 3: __NUXT_DATA__ flat reactive array ─────────────────
            var s = document.getElementById('__NUXT_DATA__');
            if (s) {
              var arr = JSON.parse(s.textContent);

              // ── Deep resolver with memoisation + cycle detection ──────────
              // Values in __NUXT_DATA__ objects are integer indices into arr[].
              // We resolve them recursively; cache prevents redundant work.
              var cache = {};
              var rr = function(v, d) {
                if ((d||0) > 22) return null;
                if (typeof v === 'number' && v >= 0 && v < arr.length) {
                  if (v in cache) return cache[v];
                  cache[v] = null; // sentinel — breaks any cycle
                  var raw = arr[v];
                  if (Array.isArray(raw) && raw.length === 2 && raw[0] === 'Reactive') {
                    return (cache[v] = rr(raw[1], (d||0)+1));
                  }
                  return (cache[v] = rr(raw, (d||0)+1));
                }
                if (v === null || v === undefined || typeof v !== 'object') return v;
                if (Array.isArray(v)) {
                  return v.map(function(x) { return rr(x, (d||0)+1); });
                }
                var o = {}, ks = Object.keys(v);
                for (var ki = 0; ki < ks.length; ki++) o[ks[ki]] = rr(v[ks[ki]], (d||0)+1);
                return o;
              };

              // ── Extract legacy scalar fields (existing behaviour) ─────────
              var result = { _source: 'nuxt3' };
              var scalarKeys = ['organizationUid','companyUid','rid','companyName','buyer','company',
                                'stats','location','title','description','skills','category',
                                'engagement','duration','budget','amount'];
              var walk = function(o, depth) {
                if (depth > 15 || !o || typeof o !== 'object') return;
                for (var k in o) {
                  if (scalarKeys.indexOf(k) >= 0 && result[k] === undefined) result[k] = rr(o[k], 0);
                  walk(Array.isArray(o[k]) ? null : (typeof o[k] === 'object' ? o[k] : null), depth+1);
                }
              };
              walk(arr, 0);

              // ── Extract raw state nodes for webhook payload ───────────────
              // opening state: has 'occupation' + 'qualificationsLoaded'
              // jobDetails state: has 'context' + 'jobDetails'
              // teams state: has 'combined' + 'freelancer'
              var rawOpening = null, rawJobDetails = null, rawTeams = null;
              for (var si = 0; si < arr.length; si++) {
                var ai = arr[si];
                if (!ai || typeof ai !== 'object' || Array.isArray(ai)) continue;
                var aik = Object.keys(ai);
                if (!rawOpening    && aik.indexOf('occupation') >= 0   && aik.indexOf('qualificationsLoaded') >= 0) rawOpening    = rr(si, 0);
                if (!rawJobDetails && aik.indexOf('context') >= 0       && aik.indexOf('jobDetails') >= 0)           rawJobDetails = rr(si, 0);
                if (!rawTeams      && aik.indexOf('combined') >= 0      && aik.indexOf('freelancer') >= 0)            rawTeams      = rr(si, 0);
                if (rawOpening && rawJobDetails && rawTeams) break;
              }
              result._rawOpening    = rawOpening;
              result._rawJobDetails = rawJobDetails;
              result._rawTeams      = rawTeams;

              // Legacy fullJobNode fallback
              for (var i = 0; i < arr.length; i++) {
                var item = arr[i];
                if (item && typeof item === 'object' && (item.opening || item.buyer) && !result._fullJobNode) {
                  result._fullJobNode = item; break;
                }
              }
              return JSON.stringify(result);
            }
            // ── Nuxt 2: window.__NUXT__ ───────────────────────────────────
            if (window.__NUXT__) return JSON.stringify(Object.assign({ _source: 'nuxt2' }, window.__NUXT__));
          } catch(e) { return JSON.stringify({ _error: e.message }); }
          return null;
        })()`;

        const nuxtEval = await chrome.debugger.sendCommand(
          { tabId: tab.id }, 'Runtime.evaluate', { expression: nuxtExpr, returnByValue: true }
        );
        if (nuxtEval?.result?.value) {
          const nuxt = tryParseJson(nuxtEval.result.value);
          if (nuxt && !nuxt._error) {
            jcFold(job, nuxt, 'nuxt-page-state');
            // Stash raw state objects for webhook payload
            if (nuxt._rawOpening)    job._rawNuxt.opening    = nuxt._rawOpening;
            if (nuxt._rawJobDetails) job._rawNuxt.jobDetails = nuxt._rawJobDetails;
            if (nuxt._rawTeams)      job._rawNuxt.teams      = nuxt._rawTeams;
          }
        }

        // Extract job UID + ciphertext from the URL
        // Handles: /jobs/~0CIPHER, /jobs/details/~0CIPHER, /nx/search/jobs/details/~0CIPHER
        const uidFromUrl    = (tab.url.match(/\/jobs\/(?:details\/)?~0(\d+)/) || tab.url.match(/uid=(\d{15,})/))?.[1] || null;
        const cipherFromUrl = (tab.url.match(/\/jobs\/(?:details\/)?(~0[^/?#\s]+)/) ||
                               tab.url.match(/jobUid=(~0[^&]+)/))?.[1] || null;
        if (uidFromUrl)    job._uid    = job._uid    || uidFromUrl;
        if (cipherFromUrl) job._cipher = job._cipher || cipherFromUrl;

        // ── STEP 2: Scan ALL stored requests from this session ──────────────
        const stored = await new Promise(res => chrome.storage.local.get(['requests'], r => res(r)));

        // ── Cipher fallback: scan RECENT requests in reverse to find the last-viewed job.
        // When on search page, the cipher is NOT in the URL — it's in GQL request bodies,
        // referer headers, or response bodies from gql-query-get-visitor-job-details etc.
        if (!job._cipher) {
          const allReqs = stored.requests || [];
          for (let i = allReqs.length - 1; i >= 0; i--) {
            const r = allReqs[i];
            if (!r.url || !r.url.includes('upwork.com')) continue;
            // GQL request body: variables.id or variables.ciphertext
            if (r.requestBody && typeof r.requestBody === 'object') {
              const v = r.requestBody.variables || r.requestBody;
              if (v && v.id && typeof v.id === 'string' && v.id.startsWith('~0')) { job._cipher = v.id; break; }
              if (v && v.ciphertext && typeof v.ciphertext === 'string' && v.ciphertext.startsWith('~0')) { job._cipher = v.ciphertext; break; }
            }
            // Referer header contains job detail URL (e.g. /nx/search/jobs/details/~0CIPHER)
            const ref = (r.requestHeaders?.Referer || r.requestHeaders?.referer || '');
            const rm = ref.match(/\/jobs\/(?:details\/)?(~0[^/?#\s&"]+)/);
            if (rm) { job._cipher = rm[1]; break; }
            // Response body ciphertext field
            if (r.responseBody && typeof r.responseBody === 'object') {
              const bs = JSON.stringify(r.responseBody);
              const cm = bs.match(/"ciphertext"\s*:\s*"(~0[^"]+)"/);
              if (cm) { job._cipher = cm[1]; break; }
            }
          }
        }

        // Skip static assets and tracking pixels — everything else is fair game
        const SKIP_EXT = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
                          '.woff', '.woff2', '.ttf', '.ico', '.webp', '.mp4'];
        const SKIP_PATH = ['/analytics', '/pixel', '/beacon', '/track', '/metrics',
                           '/telemetry', '/collect', '/favicon', '/__webpack'];

        for (const req of (stored.requests || [])) {
          if (!req.url) continue;
          if (!req.url.includes('upwork.com')) continue;
          // Use ALL stored requests from this session — captures search → job → apply flow.
          // If we know the cipher, skip requests that clearly belong to a different job.
          if (cipherFromUrl && req.url.indexOf(cipherFromUrl) === -1) {
            // Allow cross-requests that don't embed the cipher in the URL (e.g. GQL POST bodies)
            const bodyStr2 = typeof req.responseBody === 'string' ? req.responseBody : JSON.stringify(req.responseBody || '');
            if (req.url.includes('/api/') || req.url.includes('/graphql/')) {
              // Only skip if the body mentions a DIFFERENT cipher explicitly
              const otherCipher = bodyStr2.match(/"ciphertext"\s*:\s*"(~0[^"]+)"/);
              if (otherCipher && otherCipher[1] !== cipherFromUrl) continue;
            }
          }
          if (SKIP_EXT.some(e => req.url.toLowerCase().includes(e))) continue;
          if (SKIP_PATH.some(p => req.url.includes(p))) continue;
          if (!req.responseBody) continue;

          const body = typeof req.responseBody === 'string'
            ? tryParseJson(req.responseBody)
            : req.responseBody;
          if (!body || typeof body !== 'object') continue;

          // All /api/ and /graphql/ endpoints are captured unconditionally.
          // For other Upwork URLs (SSR pages, etc.) require at least one job-signal keyword.
          const isApiEndpoint = req.url.includes('/api/') || req.url.includes('/graphql/');
          const bodyStr = JSON.stringify(body);
          if (!isApiEndpoint) {
            const relevant = bodyStr.includes('"buyer"')         || bodyStr.includes('"jobDetails"')    ||
                             bodyStr.includes('"jobPosting"')    || bodyStr.includes('"opening"')        ||
                             bodyStr.includes('"companyId"')     || bodyStr.includes('"ciphertext"')     ||
                             bodyStr.includes('"proposals"')     || bodyStr.includes('"searchResults"')  ||
                             bodyStr.includes('"jobPostingByUid"') || bodyStr.includes('"jobAuthDetails"') ||
                             bodyStr.includes('"feedbackCount"') || bodyStr.includes('"hoursCount"');
            if (!relevant) continue;
          }

          // Extract cipher/uid from this request if still missing
          if (!job._cipher) {
            const cm = bodyStr.match(/"ciphertext"\s*:\s*"(~0[^"]+)"/);
            if (cm) job._cipher = cm[1];
          }
          if (!job._uid) {
            const um = req.url.match(/uid=(\d{15,})/) || bodyStr.match(/"uid"\s*:\s*"(\d{15,})"/);
            if (um) job._uid = um[1];
          }

          const alias = (req._pageStage || 'stored') + ':' + req.url
            .replace(/https?:\/\/[^/]+/, '')
            .replace(/[?#].*/, '')
            .slice(0, 60);
          jcFold(job, body, alias);

          // Keep raw copy (capped at 50 entries, 16 KB each)
          if (job._rawAll.length < 50) {
            job._rawAll.push({
              url:       req.url,
              method:    req.method,
              status:    req.status,
              ts:        req.timestamp,
              pageStage: req._pageStage || 'other',
              body:      JSON.stringify(body).slice(0, 16000)
            });
          }
        }

        // ── STEP 3: Fire all live queries from the page context ─────────────
        const cipher    = job._cipher || cipherFromUrl;
        const uid       = job._uid    || uidFromUrl;
        // Pass IDs harvested in Steps 1-2 so Step 3 can fire extra REST calls
        const companyId = job.company?.companyId || job.company?.id || null;
        const orgUid    = job.buyer?.organizationUid || job.buyer?.rid || null;

        // Read persisted session tokens (harvested from request Cookie headers).
        // These survive service-worker restarts and bypass the HttpOnly restriction
        // that prevents document.cookie from seeing them in the page context.
        const tkStore = await new Promise(r => chrome.storage.local.get(['sessionTokens'], r));
        const tk = tkStore.sessionTokens || {};

        const gqlExpr = `(async () => {
  const gc = n => { const m = document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)')); return m?decodeURIComponent(m[1]):null; };
  // Primary tokens injected from background (extracted from real request Cookie headers).
  // gc() is a fallback for non-HttpOnly cookies only.
  const searchTok  = ${JSON.stringify(tk.UniversalSearchNuxt_vt || null)} || gc('UniversalSearchNuxt_vt');
  const jobTok     = ${JSON.stringify(tk.JobDetailsNuxt_vt || tk.oauth2_global_js_token || null)} || gc('JobDetailsNuxt_vt') || gc('oauth2_global_js_token');
  const globalTok  = ${JSON.stringify(tk.oauth2_global_js_token || tk._bearer || null)} || gc('oauth2_global_js_token');
  const agencyTok  = ${JSON.stringify(tk.ag_vs_ui_gql_token || null)} || gc('ag_vs_ui_gql_token');
  const tenantId   = ${JSON.stringify(tk.current_organization_uid || tk._tenantId || null)} || gc('current_organization_uid');
  const xsrf       = ${JSON.stringify(tk['XSRF-TOKEN'] || null)} || gc('XSRF-TOKEN');
  if (!globalTok && !searchTok && !jobTok) return JSON.stringify({ fatalError: 'No auth token — browse any Upwork page first so the extension can capture your session tokens.' });

  const hdr = (tok, withTenant) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-upwork-accept-language': 'en-US',
      'Authorization': 'Bearer ' + tok
    };
    if (xsrf) h['x-xsrf-token'] = xsrf;
    if (withTenant && tenantId) h['X-Upwork-API-TenantId'] = tenantId;
    return h;
  };

  const gql = async (alias, tok, query, variables, withTenant) => {
    try {
      const r = await fetch('https://www.upwork.com/api/graphql/v1?alias=' + alias, {
        method: 'POST', credentials: 'include', headers: hdr(tok, withTenant),
        body: JSON.stringify(variables ? { query, variables } : { query })
      });
      return { status: r.status, data: await r.json() };
    } catch(e) { return { error: e.message }; }
  };

  const rest = async (path) => {
    try {
      const r = await fetch('https://www.upwork.com' + path, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + globalTok,
                   'x-upwork-accept-language': 'en-US' }
      });
      if (!r.ok) return { status: r.status, error: 'HTTP ' + r.status };
      return { status: r.status, data: await r.json() };
    } catch(e) { return { error: e.message }; }
  };

  // Cipher: injected from background, with DOM URL as fallback
  const urlM   = location.href.match(/\\/jobs\\/(?:details\\/)?(~0[^/?#\\s]+)/);
  let   cipher = ${JSON.stringify(cipher)} || (urlM ? urlM[1] : null);
  const uid       = ${JSON.stringify(uid)};
  const companyId = ${JSON.stringify(companyId)};
  const orgUid    = ${JSON.stringify(orgUid)};
  const out       = {};

  // ── 1. Public visitor job details (gql-query-get-visitor-job-details) ──────
  // Uses UniversalSearchNuxt_vt — the search-page session token.
  if (cipher && searchTok) {
    out.jobPubDetails = await gql('gql-query-get-visitor-job-details', searchTok, \`
      query JobPubDetailsQuery(\$id: ID!, \$isLoggedIn: Boolean!) {
        jobPubDetails(id: \$id) {
          opening {
            status postedOn publishTime workload contractorTier description
            info { ciphertext id type access title hideBudget createdOn
                   notSureProjectDuration notSureFreelancersToHire notSureExperienceLevel premium }
            segmentationData { customValue label name sortOrder type value
              skill { description prettyName skill id } }
            sandsData {
              occupation { freeText ontologyId prefLabel id uid: id }
              ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance }
              additionalSkills { groupId id freeText prefLabel relevance }
            }
            category { name urlSlug }
            categoryGroup { name urlSlug }
            budget { amount currencyCode }
            annotations { customFields tags }
            engagementDuration { label weeks }
            extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
            attachments @include(if: \$isLoggedIn) { fileName length uri }
            clientActivity { lastBuyerActivity totalApplicants totalHired
                             totalInvitedToInterview unansweredInvites
                             invitationsSent numberOfPositionsToHire }
            deliverables deadline tools { name }
          }
          qualifications {
            countries earnings groupRecno languages localDescription localFlexibilityDescription
            localMarket minJobSuccessScore minOdeskHours onSiteType prefEnglishSkill regions
            risingTalent shouldHavePortfolio states tests timezones type locationCheckRequired
            group { groupId groupLogo groupName }
            location { city country countryTimezone offsetFromUtcMillis state worldRegion }
            locations { id type }
          }
          buyer {
            location { offsetFromUtcMillis countryTimezone city country }
            stats { totalAssignments activeAssignmentsCount hoursCount feedbackCount score
                    totalJobsWithHires totalCharges { amount } }
            company {
              name @include(if: \$isLoggedIn) companyId @include(if: \$isLoggedIn)
              isEDCReplicated contractDate profile { industry size }
            }
            jobs {
              openCount postedCount @include(if: \$isLoggedIn)
              openJobs { id uid: id isPtcPrivate ciphertext title type }
            }
            avgHourlyJobsRate @include(if: \$isLoggedIn) { amount }
          }
          similarJobs {
            id ciphertext title description engagement durationLabel contractorTier
            type createdOn hourlyBudgetMin hourlyBudgetMax
            amount { amount } ontologySkills { id prefLabel }
          }
          buyerExtra { isPaymentMethodVerified }
        }
      }
    \`, { id: cipher, isLoggedIn: true }, false);
  }

  // ── 2. Full auth job details (gql-query-get-auth-job-details) ────────────
  // Uses JobDetailsNuxt_vt (falls back to oauth2_global_js_token).
  if (cipher && jobTok) {
    out.jobAuthDetails = await gql('gql-query-get-auth-job-details', jobTok, \`
      query JobAuthDetailsQuery(\$id: ID!, \$isFreelancerOrAgency: Boolean!, \$isLoggedIn: Boolean!) {
        jobAuthDetails(id: \$id) {
          hiredApplicantNames
          opening {
            job {
              status postedOn publishTime workload contractorTier description
              info { ciphertext id type access title hideBudget createdOn
                     notSureProjectDuration notSureFreelancersToHire notSureExperienceLevel premium }
              segmentationData { customValue label name sortOrder type value }
              sandsData {
                occupation { freeText ontologyId prefLabel id uid: id }
                ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance }
                additionalSkills { groupId id freeText prefLabel relevance }
              }
              category { name urlSlug }
              categoryGroup { name urlSlug }
              budget { amount currencyCode }
              annotations { customFields tags }
              engagementDuration { label weeks }
              extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
              attachments @include(if: \$isLoggedIn) { fileName length uri }
              clientActivity { lastBuyerActivity totalApplicants totalHired
                               totalInvitedToInterview unansweredInvites
                               invitationsSent numberOfPositionsToHire }
              deliverables deadline tools { name }
            }
            qualifications {
              countries earnings groupRecno languages localDescription localFlexibilityDescription
              localMarket minJobSuccessScore minOdeskHours onSiteType prefEnglishSkill regions
              risingTalent shouldHavePortfolio states tests timezones type locationCheckRequired
              group { groupId groupLogo groupName }
              location { city country countryTimezone offsetFromUtcMillis state worldRegion }
              locations { id type }
            }
            questions { question position }
          }
          buyer {
            enterprise isPaymentMethodVerified
            info {
              location { offsetFromUtcMillis countryTimezone city country }
              stats { totalAssignments activeAssignmentsCount hoursCount feedbackCount score
                      totalJobsWithHires totalCharges { amount } }
              company { name companyId isEDCReplicated contractDate profile { industry size } }
              jobs {
                openCount postedCount
                openJobs { id uid: id isPtcPrivate ciphertext title type }
              }
              avgHourlyJobsRate { amount }
            }
            workHistory {
              isPtcJob status isEDCReplicated isPtcPrivate startDate endDate
              totalCharge totalHours
              jobInfo { title id uid: id access type ciphertext }
              contractorInfo { contractorName accessType ciphertext }
              rate { amount }
              feedback { feedbackSuppressed score comment }
              feedbackToClient { feedbackSuppressed score comment }
            }
          }
          currentUserInfo {
            owner
            freelancerInfo {
              profileState applied devProfileCiphertext hired
              application { vjApplicationId }
              pendingInvite { inviteId }
              contract { contractId status }
              hourlyRate { amount }
              qualificationsMatches {
                matches { clientPreferred clientPreferredLabel
                          freelancerValue freelancerValueLabel qualification qualified }
              }
            }
          }
          similarJobs { id uid: id ciphertext title snippet }
          workLocation { onSiteCity onSiteCountry onSiteReason onSiteReasonFlexible onSiteState onSiteType }
          phoneVerificationStatus { status }
          applicantsBidsStats { avgRateBid { amount currencyCode }
                                minRateBid { amount currencyCode }
                                maxRateBid { amount currencyCode } }
          specializedProfileOccupationId @include(if: \$isFreelancerOrAgency)
          applicationContext @include(if: \$isFreelancerOrAgency) { freelancerAllowed clientAllowed }
        }
      }
    \`, { id: cipher, isFreelancerOrAgency: true, isLoggedIn: true }, false);
  }

  // ── 3. Apply page context (gql-query-fetchjobdetailsandcontext) ───────────
  // NOTE: variable is 'ciphertext' (String!), NOT 'id' (ID!).
  if (cipher && globalTok) {
    out.fetchJobDetailsAndContext = await gql('gql-query-fetchjobdetailsandcontext', globalTok, \`
      query fetchJobDetailsAndContext(\$ciphertext: String!) {
        fetchJobDetailsAndContext(ciphertext: \$ciphertext) {
          affiliateContractorInCurrentOrg canViewAgencyContractorsInSomeOrg
          companyId eacInSomeOrg enterpriseClient
          idVerificationRequired phoneVerificationRequired
          engagementDurations { id label type weeks }
          qualifications {
            locationCheckRequired localMarket minHoursWeek minJobSuccessScore
            minOdeskHours prefEnglishSkill risingTalent shouldHavePortfolio type countries
          }
          opening {
            description duration durationLabel durationId startDate postedOn publishTime
            sourcingTime status visibility workload companyRecno contractorTier openingId
            budget { amount currencyCode }
            extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
            deliveryDate
            category { name urlSlug }
            categoryGroup { name urlSlug }
            clientActivity { numberOfPositionsToHire totalApplicants }
            info { access ciphertext createdOn hideBudget notSureExperienceLevel
                   notSureFreelancersToHire notSureLocationPreference notSureProjectDuration
                   premium title type id }
            engagementDuration { id label type weeks }
            annotations { customFields tags }
            segmentationData { customValue label name sortOrder type value }
            sandsData {
              occupation { id freeText ontologyId prefLabel }
              ontologySkills { attributeGroupId attributeId freeText ontologyId prefLabel }
              occupations { id freeText ontologyId prefLabel }
            }
          }
        }
      }
    \`, { ciphertext: cipher }, true);
  }

  // ── 4. Search card (marketplaceJobPosting) ────────────────────────────────
  if (cipher && searchTok) {
    out.searchJobCard = await gql('searchJobCard', searchTok, \`
      query SearchJobCard(\$id: ID!) {
        marketplaceJobPosting(id: \$id) {
          jobTs openingUid
          job {
            ciphertext
            info {
              title description
              category { uid name }
              subCategory { uid name }
              contractorTier engagement
              durationV3 { weeks label }
              hourlyBudgetMin hourlyBudgetMax
              amount { amount currencyCode }
              skills { uid prettyName }
            }
            opening {
              connectedRecruiters { totalCount }
              applicantsCount invitedToInterviewCount
              totalApplicantsBidsAmount connectsRequired
            }
            client {
              totalPostedJobs totalJobsWithHires totalFeedback feedbackScore
              paymentVerificationStatus
              location { country }
              totalSpent { amount currencyCode }
            }
          }
        }
      }
    \`, { id: cipher }, false);
  }

  // ── 5. My application / ready-to-submit ───────────────────────────────────
  if (cipher) {
    out.myApplication = await rest('/api/v3/proposals/jobs/' + encodeURIComponent(cipher) + '/ready_to_submit?include_test_stats=true');
  }

  // ── 6. Company / org profile ──────────────────────────────────────────────
  const resolvedOrgId = companyId || orgUid;
  if (resolvedOrgId) {
    out.companyOrg = await rest('/api/v2/org/companies/' + encodeURIComponent(resolvedOrgId) + '/');
  }

  // ── 7. Job v2 REST ────────────────────────────────────────────────────────
  if (cipher) {
    out.jobV2 = await rest('/api/v2/jobs/' + encodeURIComponent(cipher) + '/');
  }

  // ── 8. Agency staffs auth (gql-query-agencystaffsauth) ───────────────────
  // agencyId comes from jobAuthDetails → buyer.info.company.companyId,
  // falling back to the companyId injected from background.
  const agencyIdFromAuth = out.jobAuthDetails?.data?.jobAuthDetails?.buyer?.info?.company?.companyId
                        || out.jobPubDetails?.data?.jobPubDetails?.buyer?.company?.companyId
                        || companyId;
  if (agencyIdFromAuth && agencyTok) {
    out.agencyStaffsAuth = await gql('gql-query-agencystaffsauth', agencyTok, \`
      query getAgencyStaffsAuth(\$agencyId: ID!, \$agencyTeamId: ID!, \$limit: Int, \$offset: String) {
        agencyStaffsAuth(
          agencyId: \$agencyId
          agencyTeamId: \$agencyTeamId
          limit: \$limit
          offset: \$offset
        ) {
          totalCount
          staffs {
            id
            agencyOwner
            memberType
            vetted
            active
            canBeViewed
            personalData {
              id
              rid
              name
              portrait
              ciphertext
              topRatedStatus
              topRatedPlusStatus
              jobSuccessScore
              profileAccess
              hideJss
              provider
            }
          }
        }
      }
    \`, { agencyId: agencyIdFromAuth, agencyTeamId: agencyIdFromAuth, limit: 50, offset: '' }, true);
  }

  return JSON.stringify(out);
})()`;

        const gqlEval = await chrome.debugger.sendCommand(
          { tabId: tab.id }, 'Runtime.evaluate',
          { expression: gqlExpr, awaitPromise: true, returnByValue: true }
        );
        if (gqlEval?.exceptionDetails) {
          throw new Error(gqlEval.exceptionDetails.exception?.description || 'GraphQL eval error');
        }

        const gqlData = tryParseJson(gqlEval?.result?.value);
        if (gqlData?.fatalError) throw new Error(gqlData.fatalError);

        // Fold every query result
        const gqlKeys = ['jobPubDetails','jobAuthDetails','fetchJobDetailsAndContext',
                         'searchJobCard','myApplication','companyOrg','jobV2'];
        for (const key of gqlKeys) {
          if (gqlData?.[key]?.data) jcFold(job, gqlData[key].data, 'live-' + key);
          if (gqlData?.[key]?.status) {
            job._queryStatuses = job._queryStatuses || {};
            job._queryStatuses[key] = gqlData[key].status;
          }
        }

        job._capturedAt = new Date().toISOString();

        // ── STEP 4: Persist captured job ─────────────────────────────────────
        chrome.storage.local.get(['capturedJobs'], (s) => {
          const jobs = s.capturedJobs || [];
          const idx  = jobs.findIndex(j => j._tabUrl === tab.url || (job._uid && j._uid === job._uid));
          if (idx >= 0) jobs[idx] = job; else jobs.unshift(job);
          chrome.storage.local.set({ capturedJobs: jobs.slice(0, 50) }, () => {
            sendResponse({ success: true, job });
            // Fire webhook if a URL is configured
            chrome.storage.local.get(['webhookUrl'], (ws) => {
              if (ws.webhookUrl) sendWebhook(job, gqlData, ws.webhookUrl);
            });
          });
        });

      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    });
    return true;
  }

  if (message.action === 'getCapturedJobs') {
    chrome.storage.local.get(['capturedJobs'], (s) => {
      sendResponse({ jobs: s.capturedJobs || [] });
    });
    return true;
  }

  if (message.action === 'clearCapturedJobs') {
    chrome.storage.local.set({ capturedJobs: [] }, () => sendResponse({ success: true }));
    return true;
  }

  // ── Extract all jobs from already-captured request data ───────────────────
  // Mines stored network captures without requiring GQL calls.
  // Useful after browsing a search page — all job data is already in the stored requests.
  if (message.action === 'extractJobsFromRequests') {
    chrome.storage.local.get(['requests', 'capturedJobs', 'webhookUrl'], async (s) => {
      const requests    = s.requests    || [];
      const existing    = s.capturedJobs || [];
      const webhookUrl  = s.webhookUrl  || null;
      const existingCiphers = new Set(existing.map(j => j._cipher).filter(Boolean));

      // ── Pass 1: collect unique ciphers ────────────────────────────────────
      const cipherMap = new Map(); // cipher → Set of request indices
      for (let i = 0; i < requests.length; i++) {
        const req = requests[i];
        if (!req.url || !req.url.includes('upwork.com')) continue;
        const body = typeof req.responseBody === 'string'
          ? tryParseJson(req.responseBody) : req.responseBody;
        if (!body || typeof body !== 'object') continue;
        const bodyStr = JSON.stringify(body);
        // Extract all ciphers referenced in this response
        for (const m of bodyStr.matchAll(/"ciphertext"\s*:\s*"(~0[^"]+)"/g)) {
          const c = m[1];
          if (!cipherMap.has(c)) cipherMap.set(c, new Set());
          cipherMap.get(c).add(i);
        }
        // Also check request body (GQL POST variables)
        const rb = req.requestBody;
        if (rb && typeof rb === 'object') {
          const v = rb.variables || rb;
          if (v?.id?.startsWith?.('~0'))        { if (!cipherMap.has(v.id)) cipherMap.set(v.id, new Set()); cipherMap.get(v.id).add(i); }
          if (v?.ciphertext?.startsWith?.('~0')) { if (!cipherMap.has(v.ciphertext)) cipherMap.set(v.ciphertext, new Set()); cipherMap.get(v.ciphertext).add(i); }
        }
      }

      // ── Pass 2: build a job record per cipher ─────────────────────────────
      const newJobs = [];
      const SKIP_EXT  = ['.js','.css','.png','.jpg','.jpeg','.gif','.svg','.woff','.woff2','.ttf','.ico','.webp'];
      const SKIP_PATH = ['/analytics','/pixel','/beacon','/track','/metrics','/telemetry','/collect','/favicon'];

      for (const [cipher, idxSet] of cipherMap) {
        if (existingCiphers.has(cipher)) continue; // already captured
        const job = jcEmptyRecord(null);
        job._cipher = cipher;
        job._autoCapture = true;

        for (const i of idxSet) {
          const req = requests[i];
          if (!req.url) continue;
          if (SKIP_EXT.some(e => req.url.toLowerCase().includes(e))) continue;
          if (SKIP_PATH.some(p => req.url.includes(p))) continue;
          const body = typeof req.responseBody === 'string'
            ? tryParseJson(req.responseBody) : req.responseBody;
          if (!body || typeof body !== 'object') continue;
          const alias = (req._pageStage || 'stored') + ':' + req.url
            .replace(/https?:\/\/[^/]+/, '')
            .replace(/[?#].*/, '')
            .slice(0, 60);
          jcFold(job, body, alias);
          if (!job._uid) {
            const um = req.url.match(/uid=(\d{15,})/);
            if (um) job._uid = um[1];
          }
          if (job._rawAll.length < 50) {
            job._rawAll.push({
              url: req.url, method: req.method, status: req.status,
              ts: req.timestamp, pageStage: req._pageStage || 'other',
              body: JSON.stringify(body).slice(0, 8000)
            });
          }
        }

        if (job._sources.length > 0) {
          job._capturedAt = new Date().toISOString();
          newJobs.push(job);
        }
      }

      if (newJobs.length === 0) {
        sendResponse({ success: true, added: 0, total: existing.length });
        return;
      }

      // ── Save all new jobs ─────────────────────────────────────────────────
      const merged = [...newJobs, ...existing].slice(0, 200);
      chrome.storage.local.set({ capturedJobs: merged }, () => {
        sendResponse({ success: true, added: newJobs.length, total: merged.length });
        // Webhook each new job
        if (webhookUrl) {
          for (const j of newJobs) sendWebhook(j, null, webhookUrl);
        }
      });
    });
    return true;
  }

  // ── Open a search URL in a new tab + return its stored search data ────────
  if (message.action === 'openSearchTab') {
    const { url } = message;
    chrome.tabs.create({ url, active: true }, (tab) => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  // ── Run full lookup for every job found on a search URL ─────────────────────
  if (message.action === 'runSearchLookup') {
    const { searchUrl } = message;
    (async () => {
      let tab = null;
      let detached = false;
      const collectedBodies = [];
      const pendingHdrs = {};

      const cleanup = () => {
        if (detached) return;
        detached = true;
        chrome.debugger.onEvent.removeListener(searchListener);
        if (tab) chrome.debugger.detach({ tabId: tab.id }, () => chrome.tabs.remove(tab.id, () => {}));
      };

      // Collect all GQL response bodies from the search page
      const searchListener = async (source, method, params) => {
        if (!tab || source.tabId !== tab.id) return;
        if (method === 'Network.requestWillBeSentExtraInfo') {
          pendingHdrs[params.requestId] = Object.assign(pendingHdrs[params.requestId] || {}, params.headers || {});
        }
        if (method === 'Network.responseReceived' &&
            params.response?.url?.includes('/api/graphql/v1')) {
          try {
            const body = await chrome.debugger.sendCommand(
              { tabId: tab.id }, 'Network.getResponseBody', { requestId: params.requestId }
            );
            if (body?.body) collectedBodies.push(body.body);
          } catch(_) {}
        }
      };

      try {
        tab = await new Promise(r =>
          chrome.tabs.create({ url: searchUrl, active: false }, r)
        );
        await new Promise((res, rej) =>
          chrome.debugger.attach({ tabId: tab.id }, '1.3', () =>
            chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
          )
        );
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});
        chrome.debugger.onEvent.addListener(searchListener);

        // Wait for page to load + GQL responses to settle (8 seconds)
        await new Promise(r => setTimeout(r, 8000));
        cleanup();

        // Extract unique job ciphertexts from all collected bodies
        const cipherSet = new Set();
        for (const bodyStr of collectedBodies) {
          for (const m of bodyStr.matchAll(/"ciphertext"\s*:\s*"(~0[^"]+)"/g)) {
            cipherSet.add(m[1]);
          }
          // Also grab from jobId/id fields shaped like ~0...
          for (const m of bodyStr.matchAll(/"id"\s*:\s*"(~0[^"]+)"/g)) {
            cipherSet.add(m[1]);
          }
        }

        const ciphers = [...cipherSet];
        if (!ciphers.length) {
          sendResponse({ success: false, error: 'No job ciphertexts found on that page. Make sure the search URL returns results.' });
          return;
        }

        sendResponse({ success: true, found: ciphers.length, status: 'running' });

        // Open a fresh Upwork page to use as the GQL query host (has cookies, attached via CDP)
        let queryTab = null;
        let queryDetached = false;
        try {
          queryTab = await new Promise(r =>
            chrome.tabs.create({ url: 'https://www.upwork.com/nx/search/jobs/?nbs=1&q=n8n', active: false }, r)
          );
          await new Promise((res2, rej2) =>
            chrome.debugger.attach({ tabId: queryTab.id }, '1.3', () =>
              chrome.runtime.lastError ? rej2(chrome.runtime.lastError) : res2()
            )
          );
          await chrome.debugger.sendCommand({ tabId: queryTab.id }, 'Network.enable', {});
          attachedTabs.add(queryTab.id);
          // Wait for the page to be ready so cookies are available
          await new Promise(r => setTimeout(r, 6000));
        } catch(e) {
          console.warn('[upwork-ext] runSearchLookup: failed to open query tab:', e.message);
          if (queryTab) chrome.tabs.remove(queryTab.id, () => {});
          return;
        }
        const cleanupQueryTab = () => {
          if (queryDetached) return;
          queryDetached = true;
          attachedTabs.delete(queryTab.id);
          chrome.debugger.detach({ tabId: queryTab.id }, () => chrome.tabs.remove(queryTab.id, () => {}));
        };

        for (let i = 0; i < ciphers.length; i++) {
          const cipher = ciphers[i];
          console.log(`[upwork-ext] runSearchLookup: processing ${i + 1}/${ciphers.length} — ${cipher}`);
          try {
            const prefill = null;
            let results = await runQueriesInTab(queryTab.id, null, cipher, prefill);

            const jaBuyerR = results.find(r => r.alias === 'jobAuth-buyer');
            const agencyCId = jaBuyerR?.data?.data?.jobAuthDetails?.buyer?.info?.company?.companyId || null;
            const jobTitle = jaBuyerR?.data?.data?.jobAuthDetails?.opening?.job?.info?.title
                          || results.find(r => r.alias === 'page-state')?.data?.jobTitle
                          || 'Unknown';

            const [jcResult, rawCp] = await Promise.all([
              runJobContextLookup(cipher),
              agencyCId
                ? runAgencyLookupInNewTab(agencyCId)
                : Promise.resolve({ alias: 'company-page', skipped: true, reason: 'no companyId' })
            ]);

            const { profiles: cpProfiles, ...cpResult } = rawCp;
            const cdResult      = { alias: 'client-details',  companyId: agencyCId, profiles: cpProfiles || [] };
            const compDetResult = { alias: 'company-details', companyId: agencyCId, profiles: cpProfiles || [] };

            results = results.filter(r =>
              r.alias !== 'fetchjobdetailsandcontext' &&
              r.alias !== 'company-page' &&
              r.alias !== 'client-details' &&
              r.alias !== 'company-details'
            );
            results = [...results, jcResult, cpResult, cdResult, compDetResult];

            // Save + webhook
            const companyId = agencyCId;
            await new Promise(res => {
              chrome.storage.local.get(['companyLookups', 'webhookUrl'], (stored) => {
                const lookups = stored.companyLookups || [];
                const idx = lookups.findIndex(l => l.companyId === companyId && l.jobCiphertext === cipher);
                const entry = { companyId, jobCiphertext: cipher, jobTitle, runAt: new Date().toISOString(), results };
                if (idx >= 0) lookups[idx] = entry; else lookups.push(entry);
                chrome.storage.local.set({ companyLookups: lookups }, () => {
                  const payload = JSON.stringify(cleanForWebhook({ companyId, jobCiphertext: cipher, jobTitle, runAt: entry.runAt, results }));
                  const targets = ['https://auto.moezzhioua.com/webhook/test'];
                  if (stored.webhookUrl && stored.webhookUrl !== targets[0]) targets.push(stored.webhookUrl);
                  for (const url of targets) {
                    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
                      .catch(e => console.warn('[upwork-ext] search-lookup webhook error:', e.message));
                  }
                  res();
                });
              });
            });

            // Small pause between jobs so we don't hammer the API
            if (i < ciphers.length - 1) await new Promise(r => setTimeout(r, 2000));
          } catch(e) {
            console.warn(`[upwork-ext] runSearchLookup error for ${cipher}:`, e.message);
          }
        }

        console.log('[upwork-ext] runSearchLookup: all done');
        cleanupQueryTab();
      } catch(e) {
        cleanup();
        if (typeof cleanupQueryTab === 'function') cleanupQueryTab();
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // ── Get stored session tokens (for Config tab diagnostics) ───────────────
  if (message.action === 'getSessionTokens') {
    chrome.storage.local.get(['sessionTokens'], (s) => {
      const tk = s.sessionTokens || {};
      // Return presence flags, not actual values
      sendResponse({
        hasSearchTok:  !!(tk.UniversalSearchNuxt_vt),
        hasJobTok:     !!(tk.JobDetailsNuxt_vt),
        hasGlobalTok:  !!(tk.oauth2_global_js_token || tk._bearer),
        hasTenantId:   !!(tk.current_organization_uid || tk._tenantId),
        hasXsrf:       !!(tk['XSRF-TOKEN']),
        hasAgencyTok:  !!(tk.ag_vs_ui_gql_token),
      });
    });
    return true;
  }
});

// ─── Job Capture helpers (mirrors capture.js deepMerge / foldIntoJob) ─────────

function jcDeepMerge(base, incoming) {
  if (!incoming) return base || {};
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const existing = Array.isArray(out[k]) ? out[k] : [];
      const combined = [...existing];
      for (const item of v) {
        if (!combined.some(x => JSON.stringify(x) === JSON.stringify(item))) combined.push(item);
      }
      out[k] = combined;
    } else if (typeof v === 'object') {
      out[k] = jcDeepMerge(out[k] || {}, v);
    } else {
      if (!out[k] && v) out[k] = v;
    }
  }
  return out;
}

function jcEmptyRecord(tabUrl) {
  return {
    _uid: null, _cipher: null, _tabUrl: tabUrl || null, _capturedAt: null,
    _autoCapture: false,
    _rawNuxt: { opening: null, jobDetails: null, teams: null },
    _sources: [], _queryStatuses: {}, _rawAll: [],
    job: {}, buyer: {}, company: {}, location: {}, stats: {},
    activity: {}, history: [], skills: [], proposals: {}, apply: {}
  };
}

function jcFold(job, data, alias) {
  if (!data) return;
  if (!job._sources.includes(alias)) job._sources.push(alias);

  // ── jobAuthDetails ─────────────────────────────────────────────────────────
  const jad = data?.data?.jobAuthDetails;
  if (jad) {
    const b = jad.buyer || {};
    job.buyer = jcDeepMerge(job.buyer, {
      enterprise: b.enterprise,
      isPaymentMethodVerified: b.isPaymentMethodVerified
    });
    const info = b.info || {};
    job.company  = jcDeepMerge(job.company,  info.company  || {});
    job.location = jcDeepMerge(job.location, info.location || {});
    job.stats    = jcDeepMerge(job.stats,    info.stats    || {});
    if (Array.isArray(b.workHistory)) {
      for (const w of b.workHistory) {
        if (!job.history.some(h => JSON.stringify(h) === JSON.stringify(w))) job.history.push(w);
      }
    }
    const op = jad.opening?.job;
    if (op) {
      job.job = jcDeepMerge(job.job, {
        title:          op.info?.title,
        description:    op.description || op.info?.description,
        status:         op.status,
        postedOn:       op.postedOn,
        publishTime:    op.publishTime,
        workload:       op.workload,
        contractorTier: op.contractorTier,
        category:       op.category?.name,
        categoryGroup:  op.categoryGroup?.name,
        engagement:     op.engagement?.engagementType,
        durationWeeks:  op.engagementDuration?.weeks || op.duration?.weeks,
        hourlyBudgetMin: op.extendedBudgetInfo?.hourlyBudgetMin,
        hourlyBudgetMax: op.extendedBudgetInfo?.hourlyBudgetMax,
        amount:         op.budget,
        clientActivity: op.clientActivity,
        sandsData:      op.sandsData,
        segmentationData: op.segmentationData,
      });
      // Questions from new query shape: opening.questions
      const questions = jad.opening?.questions || op.questions;
      if (Array.isArray(questions) && questions.length) {
        if (!job.apply) job.apply = {};
        job.apply.questions = questions;
      }
      // Skills from sandsData in opening.job
      const jadSands = op.sandsData;
      if (jadSands) {
        for (const s of [...(jadSands.ontologySkills || []), ...(jadSands.additionalSkills || [])]) {
          const label = s.prefLabel || s.freeText;
          if (label && !job.skills.includes(label)) job.skills.push(label);
        }
      }
    }
    if (Array.isArray(jad.hiredApplicantNames)) job.job.hiredApplicantNames = jad.hiredApplicantNames;
    if (jad.workLocation) job.job.workLocation = jad.workLocation;
    if (jad.phoneVerificationStatus) job.apply = jcDeepMerge(job.apply || {}, { phoneVerificationStatus: jad.phoneVerificationStatus.status });
    if (jad.currentUserInfo) job.apply = jcDeepMerge(job.apply || {}, { currentUserInfo: jad.currentUserInfo });
    // Proposals / activity from jobAuthDetails
    if (jad.applicantsBidsStats !== undefined && jad.applicantsBidsStats !== null) {
      job.proposals.applicantsBidsStats = jad.applicantsBidsStats;
    }
    if (jad.applicationContext) job.apply = jcDeepMerge(job.apply || {}, jad.applicationContext);
    const openJobs = jad.buyer?.info?.jobs;
    if (openJobs) {
      job.activity = jcDeepMerge(job.activity, {
        openCount:   openJobs.openCount,
        postedCount: openJobs.postedCount,
        openJobs:    openJobs.openJobs,
      });
    }
    if (jad.buyer?.info?.avgHourlyJobsRate !== undefined) {
      job.stats.avgHourlyJobsRate = job.stats.avgHourlyJobsRate || jad.buyer.info.avgHourlyJobsRate;
    }
    const pFields = ['proposals','invitedToInterview','messaged','hired','proposalsTier'];
    for (const pf of pFields) {
      if (jad[pf] !== undefined) job.proposals[pf] = jad[pf];
    }
  }

  // ── jobPubDetails (gql-query-get-visitor-job-details) ─────────────────────
  const jpd = data?.data?.jobPubDetails;
  if (jpd) {
    const op  = jpd.opening || {};
    const bi  = jpd.buyer   || {};
    if (op.info?.ciphertext) job._cipher = job._cipher || op.info.ciphertext;
    if (op.info?.id) job._uid = job._uid || op.info.id?.toString().replace(/^~0/, '');
    job.job = jcDeepMerge(job.job, {
      title:            op.info?.title,
      description:      op.description,
      status:           op.status,
      postedOn:         op.postedOn,
      publishTime:      op.publishTime,
      workload:         op.workload,
      contractorTier:   op.contractorTier,
      category:         op.category?.name,
      categoryGroup:    op.categoryGroup?.name,
      amount:           op.budget,
      hourlyBudgetMin:  op.extendedBudgetInfo?.hourlyBudgetMin,
      hourlyBudgetMax:  op.extendedBudgetInfo?.hourlyBudgetMax,
      engagementLabel:  op.engagementDuration?.label,
      durationWeeks:    op.engagementDuration?.weeks,
      clientActivity:   op.clientActivity,
      similarJobs:      jpd.similarJobs,
      segmentationData: op.segmentationData,
      sandsData:        op.sandsData,
      deliverables:     op.deliverables,
      deadline:         op.deadline,
      tools:            op.tools,
    });
    job.buyer    = jcDeepMerge(job.buyer,    { isPaymentMethodVerified: jpd.buyerExtra?.isPaymentMethodVerified });
    job.location = jcDeepMerge(job.location, bi.location || {});
    job.stats    = jcDeepMerge(job.stats,    { ...(bi.stats || {}), avgHourlyJobsRate: bi.avgHourlyJobsRate });
    job.company  = jcDeepMerge(job.company,  bi.company  || {});
    if (bi.jobs) job.activity = jcDeepMerge(job.activity, bi.jobs);
    if (jpd.qualifications) job.apply = jcDeepMerge(job.apply || {}, { qualifications: jpd.qualifications });
    // Skills from sandsData
    const sands = op.sandsData;
    if (sands) {
      for (const s of [...(sands.ontologySkills || []), ...(sands.additionalSkills || [])]) {
        const label = s.prefLabel || s.freeText;
        if (label && !job.skills.includes(label)) job.skills.push(label);
      }
    }
    // Proposals from clientActivity
    if (op.clientActivity) {
      job.proposals = jcDeepMerge(job.proposals, {
        totalApplicants:        op.clientActivity.totalApplicants,
        totalHired:             op.clientActivity.totalHired,
        totalInvitedToInterview: op.clientActivity.totalInvitedToInterview,
        invitationsSent:        op.clientActivity.invitationsSent,
        numberOfPositions:      op.clientActivity.numberOfPositionsToHire,
      });
    }
  }

  // ── fetchJobDetailsAndContext (gql-query-fetchjobdetailsandcontext) ────────
  const fjdc = data?.data?.fetchJobDetailsAndContext;
  if (fjdc) {
    const op = fjdc.opening || {};
    if (op.info?.ciphertext) job._cipher = job._cipher || op.info.ciphertext;
    if (fjdc.companyId) job.company = jcDeepMerge(job.company, { companyId: fjdc.companyId });
    job.job = jcDeepMerge(job.job, {
      title:            op.info?.title,
      description:      op.description,
      status:           op.status,
      contractorTier:   op.contractorTier,
      category:         op.category?.name,
      categoryGroup:    op.categoryGroup?.name,
      amount:           op.budget,
      hourlyBudgetMin:  op.extendedBudgetInfo?.hourlyBudgetMin,
      hourlyBudgetMax:  op.extendedBudgetInfo?.hourlyBudgetMax,
      durationLabel:    op.durationLabel,
      engagementDuration: op.engagementDuration,
      clientActivity:   op.clientActivity,
      segmentationData: op.segmentationData,
      sandsData:        op.sandsData,
      engagementDurations: fjdc.engagementDurations,
      enterpriseClient: fjdc.enterpriseClient,
    });
    if (fjdc.qualifications) job.apply = jcDeepMerge(job.apply || {}, { qualifications: fjdc.qualifications });
    if (fjdc.idVerificationRequired !== undefined) job.apply = jcDeepMerge(job.apply || {}, { idVerificationRequired: fjdc.idVerificationRequired });
    if (fjdc.phoneVerificationRequired !== undefined) job.apply = jcDeepMerge(job.apply || {}, { phoneVerificationRequired: fjdc.phoneVerificationRequired });
    // Skills from sandsData
    const sands2 = op.sandsData;
    if (sands2) {
      for (const s of [...(sands2.ontologySkills || []), ...(sands2.occupations || [])]) {
        const label = s.prefLabel || s.freeText;
        if (label && !job.skills.includes(label)) job.skills.push(label);
      }
    }
  }

  // ── jobPostingByUid ────────────────────────────────────────────────────────
  const jpbu = data?.data?.jobPostingByUid;
  if (jpbu) {
    const b = jpbu.buyer || {}, info = b.info || {};
    job.buyer    = jcDeepMerge(job.buyer,    { enterprise: b.enterprise, isPaymentMethodVerified: b.isPaymentMethodVerified, cssTier: b.cssTier });
    job.company  = jcDeepMerge(job.company,  info.company  || {});
    job.location = jcDeepMerge(job.location, info.location || {});
    job.stats    = jcDeepMerge(job.stats,    info.stats    || {});
    if (info.jobs) job.activity = jcDeepMerge(job.activity || {}, info.jobs);
    if (Array.isArray(jpbu.similarJobs)) job.job.similarJobs = jpbu.similarJobs;
    if (jpbu.currentUserInfo) job.job.currentUserInfo = jpbu.currentUserInfo;
    if (jpbu.ciphertext) job._cipher = job._cipher || jpbu.ciphertext;
    if (jpbu.uid)        job._uid    = job._uid    || jpbu.uid;
  }

  // ── marketplaceJobPosting (search card — new schema with nested job{}) ──────
  const mjp = data?.data?.marketplaceJobPosting;
  if (mjp) {
    // New schema: { jobTs, openingUid, job: { ciphertext, info{...}, opening{...}, client{...} } }
    const mjpJob   = mjp.job     || {};
    const mjpInfo  = mjpJob.info || {};
    const mjpOpen  = mjpJob.opening || {};
    const mjpClient = mjpJob.client || {};

    if (mjp.openingUid) job._uid    = job._uid    || mjp.openingUid;
    if (mjpJob.ciphertext) job._cipher = job._cipher || mjpJob.ciphertext;

    job.job = jcDeepMerge(job.job, {
      title:         mjpInfo.title,
      description:   mjpInfo.description,
      category:      mjpInfo.category?.name,
      subcategory:   mjpInfo.subCategory?.name,
      contractorTier: mjpInfo.contractorTier,
      engagement:    mjpInfo.engagement,
      durationWeeks: mjpInfo.durationV3?.weeks,
      hourlyBudgetMin: mjpInfo.hourlyBudgetMin,
      hourlyBudgetMax: mjpInfo.hourlyBudgetMax,
      amount:        mjpInfo.amount,
      connectsRequired: mjpOpen.connectsRequired,
      applicantsCount: mjpOpen.applicantsCount,
      invitedToInterviewCount: mjpOpen.invitedToInterviewCount,
    });
    // Skills from info.skills[]
    if (Array.isArray(mjpInfo.skills)) {
      for (const s of mjpInfo.skills) {
        const label = s.prettyName || s.uid;
        if (label && !job.skills.includes(label)) job.skills.push(label);
      }
    }
    // Apply: connects cost
    if (mjpOpen.connectsRequired !== undefined) {
      if (!job.apply) job.apply = {};
      job.apply.connectsRequired = mjpOpen.connectsRequired;
    }
    // Proposals from opening
    if (mjpOpen.applicantsCount !== undefined) job.proposals.totalCount = mjpOpen.applicantsCount;
    // Client/buyer stats from new schema
    if (mjpClient.location) job.location = jcDeepMerge(job.location, mjpClient.location);
    job.stats = jcDeepMerge(job.stats, {
      totalPostedJobs: mjpClient.totalPostedJobs,
      totalJobsWithHires: mjpClient.totalJobsWithHires,
      feedbackCount:  mjpClient.totalFeedback,
      feedbackScore:  mjpClient.feedbackScore,
      totalSpent:     mjpClient.totalSpent,
      paymentVerified: mjpClient.paymentVerificationStatus === 'VERIFIED',
    });
  }

  // ── Search results (edge / array shapes) ──────────────────────────────────
  const searchEdges =
    data?.data?.marketplacejobpostings?.results ||
    data?.data?.search?.jobPostings?.edges      ||
    data?.results                               ||
    null;
  if (Array.isArray(searchEdges)) {
    for (const edge of searchEdges) {
      const node = edge.node || edge;
      if (!node) continue;
      const nodeUid = node.uid || node.id;
      if (nodeUid === job._uid || !job._uid) {
        job._uid = nodeUid || job._uid;
        if (node.ciphertext) job._cipher = job._cipher || node.ciphertext;
        job.job = jcDeepMerge(job.job, {
          title:       node.title,
          description: node.description,
          publishTime: node.publishTime,
          isFixed:     node.isFixed,
          amount:      node.amount,
          engagement:  node.engagement,
          duration:    node.duration,
          category:    node.category?.prefLabel || node.category?.name,
        });
        if (Array.isArray(node.attrs || node.skills)) {
          for (const a of (node.attrs || node.skills || [])) {
            const label = a.prefLabel || a.skillAlias || a.name || a;
            if (label && typeof label === 'string' && !job.skills.includes(label)) job.skills.push(label);
          }
        }
        job.buyer    = jcDeepMerge(job.buyer,    node.buyer    || {});
        job.company  = jcDeepMerge(job.company,  node.company  || {});
        job.location = jcDeepMerge(job.location, node.location || {});
      }
    }
  }

  // ── REST: auth_job_detail / summary ───────────────────────────────────────
  const rjd = data?.authJobDetail ?? data?.jobDetail ?? data?.opening ?? null;
  if (rjd && !jad && !jpbu) {
    const rjob = rjd?.job?.info         || rjd?.info || {};
    const rbuyer = rjd?.buyer           || {};
    const rinfo  = rbuyer.info          || {};
    job.job      = jcDeepMerge(job.job,      { title: rjob.title, description: rjob.description });
    job.buyer    = jcDeepMerge(job.buyer,    rbuyer);
    job.company  = jcDeepMerge(job.company,  rinfo.company  || {});
    job.location = jcDeepMerge(job.location, rinfo.location || {});
    job.stats    = jcDeepMerge(job.stats,    rinfo.stats    || {});
  }

  // ── Proposals / applicant counts ──────────────────────────────────────────
  const prop = data?.proposals ?? data?.data?.proposals ?? null;
  if (prop && !jad) {
    job.proposals = jcDeepMerge(job.proposals, typeof prop === 'object' ? prop : { raw: prop });
  }

  // ── Apply page: ready_to_submit REST (/api/v3/proposals/jobs/.../ready_to_submit) ──
  // Shape: { profile, connectsBalance, job: { connectPrice, questions[], milestones[] } }
  const rts = data?.job?.connectPrice !== undefined ? data
            : data?.readyToSubmit ?? null;
  if (rts && !jad && !jpbu && !mjp) {
    if (!job.apply) job.apply = {};
    if (rts.job?.connectPrice !== undefined) job.apply.connectPrice = rts.job.connectPrice;
    if (Array.isArray(rts.job?.questions) && rts.job.questions.length) {
      job.apply.questions = rts.job.questions;
    }
    if (Array.isArray(rts.job?.milestones) && rts.job.milestones.length) {
      job.apply.milestones = rts.job.milestones;
    }
    if (rts.connectsBalance !== undefined) job.apply.connectsBalance = rts.connectsBalance;
    if (rts.profile) job.apply.profileUid = rts.profile?.uid || rts.profileUid;
  }

  // ── Apply page: job questions from jobAuthDetails opening ────────────────
  const openingWithQ = data?.data?.jobAuthDetails?.opening?.job?.questions
                    ?? data?.opening?.job?.questions ?? null;
  if (Array.isArray(openingWithQ) && openingWithQ.length) {
    if (!job.apply) job.apply = {};
    job.apply.questions = openingWithQ;
  }

  // ── getPersonSavedJobs (savedJobStatus) ───────────────────────────────────
  const savedJobs = data?.data?.getPersonSavedJobs?.personSavedJobs;
  if (Array.isArray(savedJobs)) {
    job.job.isSaved = savedJobs.some(s => s.ciphertext === job._cipher);
  }

  // ── Nuxt SSR page state ────────────────────────────────────────────────────
  if (alias === 'nuxt-page-state') {
    if (data.companyUid)      job.company.companyUid    = job.company.companyUid    || data.companyUid;
    if (data.organizationUid) job.buyer.organizationUid = job.buyer.organizationUid || data.organizationUid;
    if (data.rid)             job.buyer.rid             = job.buyer.rid             || data.rid;
    if (data.companyName)     job.company.name          = job.company.name          || data.companyName;
    if (data.title)           job.job.title             = job.job.title             || data.title;
    if (data.description)     job.job.description       = job.job.description       || data.description;
    if (data.budget || data.amount) job.job.amount      = job.job.amount || data.budget || data.amount;
    if (data.buyer && typeof data.buyer === 'object') {
      const bi = data.buyer.info || {};
      job.buyer    = jcDeepMerge(job.buyer,    data.buyer);
      job.company  = jcDeepMerge(job.company,  bi.company  || {});
      job.location = jcDeepMerge(job.location, bi.location || {});
      job.stats    = jcDeepMerge(job.stats,    bi.stats    || {});
    }
    if (data.company  && typeof data.company  === 'object') job.company  = jcDeepMerge(job.company,  data.company);
    if (data.location && typeof data.location === 'object') job.location = jcDeepMerge(job.location, data.location);
    if (data.stats    && typeof data.stats    === 'object') job.stats    = jcDeepMerge(job.stats,    data.stats);
    if (data.skills   && Array.isArray(data.skills)) {
      for (const s of data.skills) {
        const label = s?.prefLabel || s?.name || s;
        if (label && typeof label === 'string' && !job.skills.includes(label)) job.skills.push(label);
      }
    }
    if (data._fullJobNode) jcFold(job, data._fullJobNode, 'nuxt-full-node');
  }

  // ── Company/Org REST endpoint (/api/v2/org/companies/{id}/) ──────────────
  const orgResponse = data?.org ?? null;
  if (orgResponse && typeof orgResponse === 'object' && !jad && !jpbu && !mjp) {
    job.company = jcDeepMerge(job.company, {
      name:        orgResponse.name,
      description: orgResponse.description,
      website:     orgResponse.website,
      industry:    orgResponse.industry    || orgResponse.profile?.industry,
      size:        orgResponse.size        || orgResponse.profile?.size,
      uid:         orgResponse.uid         || orgResponse.id,
    });
    if (orgResponse.location) job.location = jcDeepMerge(job.location, orgResponse.location);
  }

  // ── Job v2 REST (/api/v2/jobs/{cipher}/) ─────────────────────────────────
  const jv2 = (!jad && !jpbu && !mjp && !searchEdges && !rjd) ? (data?.job ?? null) : null;
  if (jv2 && typeof jv2 === 'object' && (jv2.title || jv2.description || jv2.skills)) {
    job.job = jcDeepMerge(job.job, {
      title:       jv2.title,
      description: jv2.description,
      amount:      jv2.amount || jv2.budget,
    });
    const rawSkills = jv2.skills || jv2.attrs || [];
    if (Array.isArray(rawSkills)) {
      for (const s of rawSkills) {
        const label = s?.prefLabel || s?.skillAlias || s?.name || (typeof s === 'string' ? s : null);
        if (label && !job.skills.includes(label)) job.skills.push(label);
      }
    }
  }

  // ── Org / company direct endpoints ───────────────────────────────────────
  const co = data?.orgDetails ?? data?.company ?? ((!jad && !jpbu && !mjp) ? data?.data?.company : null) ?? null;
  if (co && !jad && !jpbu && !mjp) job.company = jcDeepMerge(job.company, co);
}

// ─── Webhook payload cleaner ─────────────────────────────────────────────────────
// Strips noise (query strings, debug fields, raw duplicates) before sending.
function cleanForWebhook({ companyId, jobCiphertext, jobTitle, runAt, results }) {
  // Build a keyed object: alias → clean data (no alias field, no noise)
  const data = {};
  for (const r of results) {
    const alias = r.alias;

    // Profile-bearing results: strip rawResponse, surface error message if no agencies
    if (r.profiles) {
      data[alias] = r.profiles.map(p => {
        const { rawResponse, ...clean } = p;
        if (!clean.agencies?.length && rawResponse?.errors?.length) {
          clean.error = rawResponse.errors[0]?.message || 'unknown error';
        }
        return clean;
      });
      continue;
    }

    // GQL results: unwrap data.data → data, drop query/tokenUsed/withTenant/alias
    if (r.data?.data) {
      data[alias] = { status: r.status, ...r.data.data };
      continue;
    }

    // page-state, skipped results, etc.
    const { alias: _a, query: _q, tokenUsed: _t, withTenant: _w, ...rest } = r;
    data[alias] = rest;
  }

  return { companyId, jobCiphertext, jobTitle, runAt, data };
}


// ─── Webhook sender ─────────────────────────────────────────────────────────────
// Sends the captured job to the configured n8n / automation webhook.
// Payload shape matches what the user's proxy expects (n8n webhook trigger format).
function sendWebhook(job, gqlData, webhookUrl) {
  // Parse stored raw network captures back to objects
  const networkCaptures = (job._rawAll || []).map(r => {
    let body = null;
    try { body = JSON.parse(r.body); } catch(e) {}
    return { url: r.url, method: r.method, status: r.status, ts: r.ts, pageStage: r.pageStage, body };
  });

  // Live query raw results (GQL + REST fired in Step 3) — not stored, passed in-memory only
  const liveQueries = gqlData || null;

  const payload = [{
    headers: {},
    params: {},
    query: {},
    body: {
      passed: true,
      payload: {
        meta: {
          uid:          job._uid        || null,
          cipher:       job._cipher     || null,
          capturedAt:   job._capturedAt || null,
          tabUrl:       job._tabUrl     || null,
          queryStatuses: job._queryStatuses || {}
        },
        job:        job.job        || null,
        buyer:      job.buyer      || null,
        company:    job.company    || null,
        location:   job.location   || null,
        stats:      job.stats      || null,
        activity:   job.activity   || null,
        history:    job.history    || [],
        skills:     job.skills     || [],
        proposals:  job.proposals  || null,
        apply:      job.apply      || null,
        networkCaptures,
        liveQueries
      },
      webhookUrl,
      executionMode: 'production'
    }
  }];

  fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  }).then(r => {
    if (!r.ok) console.warn('[upwork-ext] webhook responded', r.status);
    else console.log('[upwork-ext] webhook sent OK', r.status);
  }).catch(e => console.warn('[upwork-ext] webhook error:', e.message));
}

// ─── Company auto-detection ───────────────────────────────────────────────────

function maybeExtractCompany(entry) {
  if (!entry.url || !entry.url.includes('get-auth-job-details')) return;
  const jad = entry.responseBody?.data?.jobAuthDetails;
  if (!jad) return;

  const companyId = jad?.buyer?.info?.company?.companyId;
  if (!companyId) return;

  const apiCompanyName = jad?.buyer?.info?.company?.name || null;
  const jobTitle = (jad?.opening?.job?.info?.title || 'Unknown').replace(/\s+/g, ' ').trim();
  const location = jad?.buyer?.info?.location || null;
  const jobCiphertext = extractJobCiphertext(entry.requestBody);
  const tabId = entry.tabId;

  const persist = (companyName) => {
    chrome.storage.local.get(['detectedCompanies'], (result) => {
      const companies = result.detectedCompanies || [];
      const existing = companies.find(c => c.companyId === companyId);
      if (existing) {
        if (!existing.companyName && companyName) {
          existing.companyName = companyName;
          chrome.storage.local.set({ detectedCompanies: companies });
        }
        return;
      }
      companies.push({ companyId, companyName, jobCiphertext, jobTitle, location, detectedAt: new Date().toISOString() });
      chrome.storage.local.set({ detectedCompanies: companies });
    });
  };

  // If API already returned the name, persist immediately
  if (apiCompanyName) { persist(apiCompanyName); return; }

  // API returns null — wait 400 ms for Vue's async fetch to populate the store,
  // then read the company name from DOM + Vuex + __NUXT__
  if (tabId && attachedTabs.has(tabId)) {
    setTimeout(() => {
      if (!attachedTabs.has(tabId)) { persist(null); return; }
      const expr = '(function(){' +
        'try{' +
        // 1. DOM: company name link inside the modal (most reliable)
        'var links=document.querySelectorAll(\'[href*="/companies/"],[href*="/agencies/"],[href*="/org/"]\'  );' +
        'for(var li=0;li<links.length;li++){' +
          'var t=links[li].textContent.trim();' +
          'if(t&&t.length>1)return t;' +
        '}' +
        // 2. Vuex live store via __vue__ root
        'var el=document.getElementById("__nuxt");' +
        'var store=el&&el.__vue__&&el.__vue__.$store;' +
        'if(store&&store.state){' +
          // jobDetails module (registered by ModalJobDetails)
          'var jdm=store.state.jobDetails;' +
          'if(jdm){' +
            'var jd=jdm.jobDetails||jdm;' +
            'var b=jd.buyer;' +
            'if(b&&b.info&&b.info.company&&b.info.company.name)return b.info.company.name;' +
          '}' +
          // Any other module with buyer.info.company.name
          'var mkeys=Object.keys(store.state);' +
          'for(var mi=0;mi<mkeys.length;mi++){' +
            'var mod=store.state[mkeys[mi]];' +
            'if(!mod||typeof mod!=="object")continue;' +
            'var mjd=mod.jobDetails||mod;' +
            'var mb=mjd&&mjd.buyer;' +
            'if(mb&&mb.info&&mb.info.company&&mb.info.company.name)return mb.info.company.name;' +
          '}' +
        '}' +
        // 3. window.__NUXT__.fetch (populated after fetch() completes)
        'var nuxt=window.__NUXT__;' +
        'if(nuxt&&nuxt.fetch){' +
          'var fvals=Object.values(nuxt.fetch);' +
          'for(var fi=0;fi<fvals.length;fi++){' +
            'if(!fvals[fi]||typeof fvals[fi]!=="object")continue;' +
            'var fjd=fvals[fi].jobDetails?(fvals[fi].jobDetails.jobDetails||fvals[fi].jobDetails):fvals[fi];' +
            'if(fjd&&fjd.buyer&&fjd.buyer.info&&fjd.buyer.info.company&&fjd.buyer.info.company.name)return fjd.buyer.info.company.name;' +
          '}' +
        '}' +
        // 4. window.__NUXT__.state (Vuex initial SSR state)
        'if(nuxt&&nuxt.state&&nuxt.state.jobDetails){' +
          'var sjd=nuxt.state.jobDetails.jobDetails||nuxt.state.jobDetails;' +
          'var sb=sjd&&sjd.buyer;' +
          'if(sb&&sb.info&&sb.info.company&&sb.info.company.name)return sb.info.company.name;' +
        '}' +
        // 5. window.__NUXT__.data (asyncData results array)
        'if(nuxt&&Array.isArray(nuxt.data)){' +
          'for(var di=0;di<nuxt.data.length;di++){' +
            'var dp=nuxt.data[di];' +
            'if(!dp)continue;' +
            'var djd=dp.jobDetails?(dp.jobDetails.jobDetails||dp.jobDetails):dp;' +
            'if(djd&&djd.buyer&&djd.buyer.info&&djd.buyer.info.company&&djd.buyer.info.company.name)return djd.buyer.info.company.name;' +
          '}' +
        '}' +
        // 6. window.__NUXT__.payload (friend's extension reads this path)
        'if(nuxt&&nuxt.payload){' +
          'var pjd=nuxt.payload.jobDetails;' +
          'if(pjd){' +
            'var pjd2=pjd.jobDetails||pjd;var pb=pjd2.buyer;' +
            'if(pb&&pb.info&&pb.info.company&&pb.info.company.name)return pb.info.company.name;' +
          '}' +
          'var pkeys=Object.keys(nuxt.payload);' +
          'for(var pi=0;pi<pkeys.length;pi++){' +
            'var pval=nuxt.payload[pkeys[pi]];' +
            'if(!pval||typeof pval!=="object")continue;' +
            'var pvjd=pval.jobDetails?(pval.jobDetails.jobDetails||pval.jobDetails):pval;' +
            'if(pvjd&&pvjd.buyer&&pvjd.buyer.info&&pvjd.buyer.info.company&&pvjd.buyer.info.company.name)return pvjd.buyer.info.company.name;' +
          '}' +
        '}' +
        'return null;' +
        '}catch(e){return null;}' +
      '})()';
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: expr, returnByValue: true }, (res) => {
        const liveCompanyName = (res && res.result && typeof res.result.value === 'string' && res.result.value) ? res.result.value : null;
        persist(liveCompanyName);
      });
    }, 400);
  } else {
    persist(null);
  }
}
function extractJobCiphertext(body) {
  if (!body) return null;
  // Check variables object (standard GraphQL format)
  if (typeof body === 'object' && body.variables) {
    for (const v of Object.values(body.variables)) {
      if (typeof v === 'string' && /^~0\d{10,}/.test(v)) return v;
    }
  }
  // Fallback: regex in stringified body
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  const m = str.match(/"(~0[0-9a-zA-Z]{10,})"/);
  return m ? m[1] : null;
}

// ─── Company lookup query builder ─────────────────────────────────────────────

function buildLookupQueries(companyId, jobCiphertext) {
  const queries = [];

  // ── page-state: read window.__NUXT__ directly ────────────────────────────────
  // Upwork SSR injects full buyer info incl. company name into the page state.
  // No auth token required — it's already on the page.
  queries.push({
    alias: 'page-state',
    type: 'page-state'
  });

  // ── jobAuthDetails — use the job ciphertext to get buyer details ──────────────
  // The arg type is ID!, and the token used MUST be the JobDetailsNuxt_vt token.
  // The root company() field has been confirmed to have no accessible fields at all.
  if (jobCiphertext) {
    // Minimal: just buyer.enterprise to confirm access works at all
    queries.push({
      alias: 'jobAuth-access-check',
      query: `query JobAuthCheck($id: ID!) {
        jobAuthDetails(id: $id) { buyer { enterprise } }
      }`,
      variables: { id: jobCiphertext },
      useJobToken: true
    });

    // Core buyer info with company details
    queries.push({
      alias: 'jobAuth-buyer',
      query: `query JobAuthBuyer($id: ID!) {
        jobAuthDetails(id: $id) {
          buyer {
            enterprise
            isPaymentMethodVerified
            info {
              company { companyId contractDate isEDCReplicated name profile { industry size } }
              location { city country countryTimezone }
              stats {
                score feedbackCount totalAssignments hoursCount
                totalCharges { amount } totalJobsWithHires activeAssignmentsCount
              }
            }
          }
        }
      }`,
      variables: { id: jobCiphertext },
      useJobToken: true
    });

    // Full — including work history, opening info
    queries.push({
      alias: 'jobAuth-full',
      query: `query JobAuthFull($id: ID!) {
        jobAuthDetails(id: $id) {
          buyer {
            enterprise
            isPaymentMethodVerified
            info {
              company { companyId contractDate isEDCReplicated name profile { industry size } }
              location { city country countryTimezone }
              stats {
                score feedbackCount totalAssignments
                totalCharges { amount }
                activeAssignmentsCount totalJobsWithHires hoursCount
              }
            }
            workHistory {
              contractorInfo { contractorName }
              jobInfo { title type }
              startDate endDate status totalCharge
              feedback { score comment }
            }
          }
          opening {
            job {
              info { title }
              category { name }
              categoryGroup { name }
            }
          }
          hiredApplicantNames
        }
      }`,
      variables: { id: jobCiphertext },
      useJobToken: true
    });
  }

  // company-page and fetchjobdetailsandcontext handled separately via CDP tab capture

  // ── org-context is intentionally excluded ────────────────────────────────
  // It only returns the logged-in freelancer's own org data (confirmed), not
  // the client's — so it provides no value for company lookup.

  return queries;
}




// ─── fetchJobDetailsAndContext via real proposals page tab ────────────────────────────────────
// Opens /nx/proposals/job/{ciphertext}/apply/ — the page naturally fires the request.
// We capture the real response via Network.getResponseBody (bypasses HttpOnly auth token issue).
async function runJobContextLookup(jobCiphertext) {
  return new Promise(async (resolve) => {
    let tab = null;
    let detached = false;
    let targetRequestId = null;

    const done = (result) => {
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(listener);
      if (!detached) {
        detached = true;
        if (tab) chrome.debugger.detach({ tabId: tab.id }, () => chrome.tabs.remove(tab.id, () => {}));
      }
      resolve(result);
    };

    const timeout = setTimeout(
      () => done({ alias: 'fetchjobdetailsandcontext', skipped: true, reason: 'timeout' }),
      30000
    );

    const listener = async (source, method, params) => {
      if (!tab || source.tabId !== tab.id) return;

      if (method === 'Network.requestWillBeSent' &&
          params.request?.url?.includes('fetchjobdetailsandcontext')) {
        targetRequestId = params.requestId;
      }

      if (method === 'Network.responseReceived' &&
          targetRequestId && params.requestId === targetRequestId) {
        chrome.debugger.onEvent.removeListener(listener);
        try {
          const body = await chrome.debugger.sendCommand(
            { tabId: tab.id }, 'Network.getResponseBody', { requestId: targetRequestId }
          );
          let data;
          try { data = JSON.parse(body.body); } catch(_) { data = body.body || null; }
          done({ alias: 'fetchjobdetailsandcontext', status: params.response.status, data });
        } catch(e) {
          done({ alias: 'fetchjobdetailsandcontext', error: 'getResponseBody: ' + e.message });
        }
      }
    };

    try {
      tab = await new Promise(r =>
        chrome.tabs.create({ url: `https://www.upwork.com/nx/proposals/job/${jobCiphertext}/apply/`, active: false }, r)
      );
      await new Promise((res, rej) =>
        chrome.debugger.attach({ tabId: tab.id }, '1.3', () =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
        )
      );
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});
      chrome.debugger.onEvent.addListener(listener);
    } catch(e) {
      clearTimeout(timeout);
      resolve({ alias: 'fetchjobdetailsandcontext', error: e.message });
    }
  });
}


// ─── Agency lookup via real agency page tab ─────────────────────────────────────────────────
// Phase 1: opens agency page, captures agencystaffsauth headers + staff list.
// Phase 2: opens freelancers/moezz, captures getDetails headers, fires getDetails
//          for each staff ciphertext using those headers (moezz URL stays hardcoded).
async function runAgencyLookupInNewTab(cId) {
  return new Promise(async (resolve) => {
    let agencyTab = null, freelancerTab = null;
    let agencyDetached = false, freelancerDetached = false;
    const agencyPendingHdrs = {}, freelancerPendingHdrs = {};
    let agencyRequestId = null, freelancerRequestId = null;
    let capturedStaffs = null, capturedAgencyData = null, capturedAgencyStatus = null;
    let phase2Started = false;

    const done = (result) => {
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(agencyListener);
      chrome.debugger.onEvent.removeListener(freelancerListener);
      if (!agencyDetached)    { agencyDetached    = true; if (agencyTab)     chrome.debugger.detach({ tabId: agencyTab.id },     () => chrome.tabs.remove(agencyTab.id,     () => {})); }
      if (!freelancerDetached){ freelancerDetached = true; if (freelancerTab) chrome.debugger.detach({ tabId: freelancerTab.id }, () => chrome.tabs.remove(freelancerTab.id, () => {})); }
      resolve(result);
    };

    const timeout = setTimeout(
      () => done({ alias: 'company-page', skipped: true, reason: 'agency lookup timeout' }),
      40000
    );

    const GET_DETAILS_QUERY = 'query GetTalentProfile($profileUrl: String, $jobProposalId: ID, $openingId: ID, $viewerMode: Boolean, $freeText: String, $skillIds: [ID!], $occupationIds: [ID!]) { talentVPDAuthProfile(filter: { profileUrl: $profileUrl, jobProposalId: $jobProposalId, openingId: $openingId, viewerMode: $viewerMode, freeText: $freeText, skillIds: $skillIds, occupationIds: $occupationIds, excludePortfolio: true, excludeAgencies: false }) { ...AuthProfileResponseFragment } } fragment BaseProfileResponseFragment on TalentVPDProfileResponse { identity { uid: id id userId ciphertext recno } profile { name title description location { country city state } portrait { portrait } skills { node { id name prettyName } } } stats { totalHours totalFeedback rating hourlyRate { node { currencyCode amount } } memberSince totalEarnings topRatedStatus topRatedPlusStatus } agencies { name logo recentHours score recno scoreRecent totalFeedback totalHours agencyRate { node { currencyCode amount } } nSS100BwScore topRatedStatus topRatedPlusStatus hideEacEarnings ciphertext uid: id id defaultAgency } languages { language { englishName } proficiencyLevel { proficiencyTitle } } } fragment AuthProfileResponseFragment on TalentVPDProfileResponse { ...BaseProfileResponseFragment vettedBadge { vetted } }';

    // ── PHASE 2 LISTENER: freelancer page (moezz) ──────────────────────────────
    // The moezz page fires its own alias=getDetails request. Capture those exact
    // headers via CDP, then replay with each staff's ciphertext as profileUrl.
    const freelancerListener = async (source, method, params) => {
      if (!freelancerTab || source.tabId !== freelancerTab.id) return;

      if (method === 'Network.requestWillBeSentExtraInfo') {
        freelancerPendingHdrs[params.requestId] = Object.assign(
          freelancerPendingHdrs[params.requestId] || {}, params.headers || {}
        );
      }
      if (method === 'Network.requestWillBeSent' &&
          params.request?.url?.includes('alias=getDetails')) {
        freelancerRequestId = params.requestId;
        freelancerPendingHdrs[params.requestId] = Object.assign(
          params.request.headers || {}, freelancerPendingHdrs[params.requestId] || {}
        );
      }
      if (method === 'Network.responseReceived' &&
          freelancerRequestId && params.requestId === freelancerRequestId) {
        chrome.debugger.onEvent.removeListener(freelancerListener);

        // Use the exact same headers moezz page sent — only swap profileUrl variable
        const h = freelancerPendingHdrs[freelancerRequestId] || {};

        const expr = `(async () => {
  const capturedHdrs = ${JSON.stringify(h)};
  const commonHdrs = {
    'Content-Type':              capturedHdrs['content-type']               || capturedHdrs['Content-Type']              || 'application/json',
    'Accept':                    capturedHdrs['accept']                     || capturedHdrs['Accept']                    || '*/*',
    'Authorization':             capturedHdrs['authorization']              || capturedHdrs['Authorization']             || '',
    'X-Upwork-Accept-Language':  capturedHdrs['x-upwork-accept-language']  || capturedHdrs['X-Upwork-Accept-Language']  || 'en-US',
    'X-XSRF-TOKEN':              capturedHdrs['x-xsrf-token']              || capturedHdrs['X-XSRF-TOKEN']              || ''
  };
  const staffs   = ${JSON.stringify(capturedStaffs || [])};
  const detailsQ = ${JSON.stringify(GET_DETAILS_QUERY)};
  const profiles = [];
  for (const st of staffs) {
    const ciphertext = st.personalData ? st.personalData.ciphertext : null;
    const personName = st.personalData ? st.personalData.name : null;
    try {
      const pr = await fetch('https://www.upwork.com/api/graphql/v1?alias=getDetails', {
        method: 'POST', credentials: 'include', headers: commonHdrs,
        body: JSON.stringify({ query: detailsQ, variables: { personId: null, profileUrl: ciphertext, viewerMode: false } })
      });
      let pd; try { pd = await pr.json(); } catch(_e) { pd = null; }
      const agencies = (pd && pd.data && pd.data.talentVPDAuthProfile && pd.data.talentVPDAuthProfile.agencies) || [];
      profiles.push({ ciphertext, name: personName, status: pr.status, agencies, rawResponse: pd });
    } catch(fe) {
      profiles.push({ ciphertext, name: personName, error: fe.message });
    }
  }
  return JSON.stringify(profiles);
})()`;

        try {
          const evalRes = await chrome.debugger.sendCommand(
            { tabId: freelancerTab.id }, 'Runtime.evaluate',
            { expression: expr, awaitPromise: true, returnByValue: true }
          );
          const profiles = evalRes.result?.value ? JSON.parse(evalRes.result.value) : [];
          done({ alias: 'company-page', companyId: cId, status: capturedAgencyStatus, data: capturedAgencyData, profiles });
        } catch(e) {
          done({ alias: 'company-page', error: 'phase2 eval: ' + e.message });
        }
      }
    };

    // ── PHASE 1 LISTENER: agency page ──────────────────────────────────────────
    const agencyListener = async (source, method, params) => {
      if (!agencyTab || source.tabId !== agencyTab.id) return;

      if (method === 'Network.requestWillBeSentExtraInfo') {
        agencyPendingHdrs[params.requestId] = Object.assign(
          agencyPendingHdrs[params.requestId] || {}, params.headers || {}
        );
      }
      if (method === 'Network.requestWillBeSent' &&
          params.request?.url?.includes('agencystaffsauth')) {
        agencyRequestId = params.requestId;
        agencyPendingHdrs[params.requestId] = Object.assign(
          params.request.headers || {}, agencyPendingHdrs[params.requestId] || {}
        );
      }
      if (method === 'Network.responseReceived' &&
          agencyRequestId && params.requestId === agencyRequestId && !phase2Started) {
        phase2Started = true;
        chrome.debugger.onEvent.removeListener(agencyListener);

        const h = agencyPendingHdrs[agencyRequestId] || {};
        const auth   = h['authorization']         || h['Authorization']         || '';
        const tenant = h['x-upwork-api-tenantid'] || h['X-Upwork-API-TenantId'] || '';
        const xsrf   = h['x-xsrf-token']          || h['X-XSRF-TOKEN']          || '';

        const agencyExpr = `(async () => {
  const r = await fetch('https://www.upwork.com/api/graphql/v1?alias=gql-query-agencystaffsauth', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': '*/*', 'Authorization': ${JSON.stringify(auth)}, 'X-Upwork-Accept-Language': 'en-US', 'X-Upwork-API-TenantId': ${JSON.stringify(tenant)}, 'X-XSRF-TOKEN': ${JSON.stringify(xsrf)} },
    body: JSON.stringify({ query: 'query getAgencyStaffsAuth($agencyId: ID!, $agencyTeamId: ID!, $limit: Int, $offset: String) { agencyStaffsAuth(agencyId: $agencyId agencyTeamId: $agencyTeamId limit: $limit offset: $offset) { totalCount staffs { id agencyOwner memberType vetted active canBeViewed personalData { id rid name portrait ciphertext topRatedStatus topRatedPlusStatus jobSuccessScore profileAccess hideJss provider } } } }', variables: { agencyId: ${JSON.stringify(cId)}, agencyTeamId: ${JSON.stringify(cId)}, limit: 50, offset: '' } })
  });
  let d; try { d = await r.json(); } catch(_) { d = null; }
  return JSON.stringify({ status: r.status, data: d });
})()`;

        try {
          const agRes = await chrome.debugger.sendCommand(
            { tabId: agencyTab.id }, 'Runtime.evaluate',
            { expression: agencyExpr, awaitPromise: true, returnByValue: true }
          );
          const agParsed = agRes.result?.value ? JSON.parse(agRes.result.value) : null;
          capturedAgencyData   = agParsed?.data;
          capturedAgencyStatus = agParsed?.status;
          capturedStaffs       = agParsed?.data?.data?.agencyStaffsAuth?.staffs || [];

          if (!capturedStaffs.length) {
            done({ alias: 'company-page', companyId: cId, status: capturedAgencyStatus, data: capturedAgencyData, profiles: [] });
            return;
          }

          // Phase 2: open freelancer page — attach CDP in callback, before GQL fires
          freelancerTab = await new Promise(r =>
            chrome.tabs.create({ url: 'https://www.upwork.com/freelancers/moezz', active: false }, r)
          );
          await new Promise((res, rej) =>
            chrome.debugger.attach({ tabId: freelancerTab.id }, '1.3', () =>
              chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
            )
          );
          await chrome.debugger.sendCommand({ tabId: freelancerTab.id }, 'Network.enable', {});
          chrome.debugger.onEvent.addListener(freelancerListener);
        } catch(e) {
          done({ alias: 'company-page', error: 'phase1 eval: ' + e.message });
        }
      }
    };

    try {
      agencyTab = await new Promise(r =>
        chrome.tabs.create({ url: 'https://www.upwork.com/agencies/2012207015295215238/', active: false }, r)
      );
      await new Promise((res, rej) =>
        chrome.debugger.attach({ tabId: agencyTab.id }, '1.3', () =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
        )
      );
      await chrome.debugger.sendCommand({ tabId: agencyTab.id }, 'Network.enable', {});
      chrome.debugger.onEvent.addListener(agencyListener);
    } catch(e) {
      clearTimeout(timeout);
      resolve({ alias: 'company-page', error: e.message });
    }
  });
}


async function runQueriesInTab(tabId, companyId, jobCiphertext, prefill) {
  const queries = buildLookupQueries(companyId, jobCiphertext);

  // For the agency staffs request, find the exact auth token + tenantId from a previously
  // captured agencystaffsauth request (CDP stores real headers including dynamic tokens).
  // Fall back to ag_vs_ui_gql_token via chrome.cookies if no prior request captured.
  const storedData = await new Promise(resolve =>
    chrome.storage.local.get(['requests', 'sessionTokens'], resolve)
  );
  const storedRequests = storedData.requests || [];
  const storedTokens   = storedData.sessionTokens || {};

  // Find most recent captured agencystaffsauth request — reuse its exact auth headers
  const prevAgency = storedRequests.slice().reverse().find(r =>
    r.url && r.url.includes('agencystaffsauth')
  );
  const agencyAuthHeader  = prevAgency?.requestHeaders?.['Authorization']
                         || prevAgency?.requestHeaders?.['authorization']
                         || null;
  const agencyTenantHeader = prevAgency?.requestHeaders?.['X-Upwork-API-TenantId']
                          || prevAgency?.requestHeaders?.['x-upwork-api-tenantid']
                          || null;

  // Fall back: ag_vs_ui_gql_token from sessionTokens (harvested from Cookie headers by CDP)
  const fallbackAgencyTok = storedTokens['ag_vs_ui_gql_token']
                         || storedTokens['oauth2_global_js_token']
                         || '';
  const fallbackTenantId  = storedTokens['current_organization_uid'] || '';

  const injectedAgencyAuth   = agencyAuthHeader   || ('Bearer ' + fallbackAgencyTok);
  const injectedAgencyTenant = agencyTenantHeader || fallbackTenantId;

  // Runs inside the Upwork page JS context.
  // Tries multiple auth tokens in priority order:
  //   1. JobDetailsNuxt_vt   — has jobAuthDetails scope
  //   2. UniversalSearchNuxt_vt — search/browse scope
  //   3. oauth2_global_js_token — general fallback
  const expression = `
(async () => {
  const getCookie = name => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  // ──────────────────────────────────────────────────────────────────────────────
  // STEP 1: Resolve company name
  // Priority: prefill captured at detection time > live Vue $store > window.__NUXT__
  var pre = ${JSON.stringify(prefill || null)};
  var pageStateResult = (function() {
    try {
      // Only skip page read if we already have the name from cache
      if (pre && pre.companyName) return pre;

      // Live Vue $store (works when job page/modal currently open)
      var el = document.getElementById("__nuxt");
      var store = el && el.__vue__ && el.__vue__.$store;
      if (store && store.state && store.state.jobDetails) {
        var jd = store.state.jobDetails;
        var b = (jd.jobDetails || jd).buyer;
        if (b && b.info && b.info.company) {
          return Object.assign({}, pre||{}, { companyName: b.info.company.name || b.info.company.profile&&b.info.company.profile.tagLine || b.info.company.profile&&b.info.company.profile.title || null, companyUid: b.info.company.companyUid || null, location: b.info.location || (pre&&pre.location) || null, stats: b.info.stats || null, source: "vuex-live" });
        }
      }

      // window.__NUXT__.fetch (only populated while modal is open)
      var nuxt = window.__NUXT__;
      if (nuxt && nuxt.fetch) {
        var fvals = Object.values(nuxt.fetch);
        for (var fi = 0; fi < fvals.length; fi++) {
          if (!fvals[fi]) continue;
          var fjd = fvals[fi].jobDetails ? (fvals[fi].jobDetails.jobDetails || fvals[fi].jobDetails) : fvals[fi];
          if (!fjd) continue;
          var fb = fjd.buyer;
          if (fb && fb.info && fb.info.company && fb.info.company.name) {
            return Object.assign({}, pre||{}, { companyName: fb.info.company.name, companyUid: fb.info.company.companyUid || null, location: fb.info.location || (pre&&pre.location) || null, stats: fb.info.stats || null, source: "nuxt-fetch" });
          }
        }
      }

      // window.__NUXT__.payload (Nuxt SSR payload — what friend's extension reads)
      var nuxt2 = window.__NUXT__;
      if (nuxt2 && nuxt2.payload) {
        var pjd = nuxt2.payload.jobDetails;
        if (pjd) {
          var pjd2 = pjd.jobDetails || pjd;
          var pb = pjd2.buyer;
          if (pb && pb.info && pb.info.company && pb.info.company.name) {
            return Object.assign({}, pre||{}, { companyName: pb.info.company.name, companyUid: pb.info.company.companyUid || null, location: pb.info.location || (pre&&pre.location) || null, source: "nuxt-payload" });
          }
        }
        // scan all payload keys
        var pkeys = Object.keys(nuxt2.payload);
        for (var pi = 0; pi < pkeys.length; pi++) {
          var pval = nuxt2.payload[pkeys[pi]];
          if (!pval || typeof pval !== "object") continue;
          var pvjd = pval.jobDetails ? (pval.jobDetails.jobDetails || pval.jobDetails) : pval;
          if (pvjd && pvjd.buyer && pvjd.buyer.info && pvjd.buyer.info.company && pvjd.buyer.info.company.name) {
            return Object.assign({}, pre||{}, { companyName: pvjd.buyer.info.company.name, location: pvjd.buyer.info.location || (pre&&pre.location) || null, source: "nuxt-payload-scan" });
          }
        }
      }

      // Nothing found — return diagnostic info to help debug
      if (pre) return Object.assign({}, pre, { source: 'cached-detection' });
      return { error: 'company name not found', source: 'none' };
    } catch(e) { return { error: e.message }; }
  }());

  // Token priority for job-scoped queries vs general queries
  const jobToken    = getCookie('JobDetailsNuxt_vt')
                   || getCookie('UniversalSearchNuxt_vt')
                   || getCookie('oauth2_global_js_token');
  const globalToken = getCookie('oauth2_global_js_token')
                   || getCookie('UniversalSearchNuxt_vt');
  const tenantId    = getCookie('current_organization_uid');
  const xsrf        = getCookie('XSRF-TOKEN');
  // Agency auth headers injected as literals from captured CDP requests (bypass HttpOnly)
  const agencyAuthInjected   = '';
  const agencyTenantInjected = '';

  if (!jobToken && !globalToken) {
    return JSON.stringify({ fatalError: 'No auth token cookie found — are you logged in to Upwork?' });
  }

  const queries = ${JSON.stringify(queries)};
  const results = [];

  const buildHeaders = (token, includeTenant) => {
    const h = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'X-Upwork-Accept-Language': 'en-US'
    };
    if (includeTenant && tenantId) h['X-Upwork-API-TenantId'] = tenantId;
    if (xsrf) h['X-XSRF-TOKEN'] = xsrf;
    return h;
  };

  const doFetch = async (q, token, includeTenant) => {
    const resp = await fetch(
      'https://www.upwork.com/api/graphql/v1?alias=' + q.alias,
      {
        method: 'POST',
        credentials: 'include',
        headers: buildHeaders(token, includeTenant),
        body: JSON.stringify(q.variables
          ? { query: q.query, variables: q.variables }
          : { query: q.query }
        )
      }
    );
    let data;
    try { data = await resp.json(); } catch (_) { data = null; }
    return { status: resp.status, data };
  };

  const isTenantErr = (data) =>
    data && (
      (typeof data.message === 'string' && data.message.includes('tenant')) ||
      (Array.isArray(data.errors) && data.errors.some(e => e.message && e.message.includes('tenant')))
    );

  for (const q of queries) {
    // page-state is not a GraphQL query — return the already-read page state
    if (q.type === 'page-state') {
      results.push({ alias: 'page-state', type: 'page-state', data: pageStateResult });
      continue;
    }

    // useJobToken=true: try each token, first WITH tenantId then WITHOUT (if tenant error)
    // non-job queries: always include tenantId
    const tokensToTry = q.useJobToken
      ? [
          { name: 'JobDetailsNuxt_vt',      value: getCookie('JobDetailsNuxt_vt') },
          { name: 'UniversalSearchNuxt_vt', value: getCookie('UniversalSearchNuxt_vt') },
          { name: 'oauth2_global_js_token', value: getCookie('oauth2_global_js_token') }
        ].filter(t => t.value)
      : [{ name: 'oauth2_global_js_token', value: getCookie('oauth2_global_js_token') || jobToken }];

    let finalResult = null;
    const tokenAttempts = [];

    outer:
    for (const tok of tokensToTry) {
      // For job-token queries, try with tenant first, then without if we get a tenant error
      const tenantVariants = q.useJobToken ? [true, false] : [true];
      for (const withTenant of tenantVariants) {
        try {
          const { status, data } = await doFetch(q, tok.value, withTenant);
          const hasPermErr = data?.errors?.some(e => e.message && e.message.includes('permission'));
          const hasTenantErr = isTenantErr(data);
          tokenAttempts.push({ tokenName: tok.name, withTenant, status, hasPermErr, hasTenantErr });

          if (hasTenantErr && withTenant && q.useJobToken) {
            // tenant mismatch — retry without tenant header
            continue;
          }
          if (!hasPermErr) {
            finalResult = { alias: q.alias, status, data, tokenUsed: tok.name, withTenant, query: q.query };
            break outer; // success
          }
          // permission error — try next token entirely
          finalResult = { alias: q.alias, status, data, tokenUsed: tok.name, withTenant, tokenAttempts, query: q.query };
          break; // stop tenant variants, move to next token
        } catch (err) {
          tokenAttempts.push({ tokenName: tok.name, withTenant, error: err.message });
          finalResult = { alias: q.alias, error: err.message, tokenUsed: tok.name, withTenant, tokenAttempts, query: q.query };
          break;
        }
      }
    }

    results.push(finalResult);
  }

  return JSON.stringify(results);
})()
  `;

  const evalResult = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }
  );

  if (evalResult.exceptionDetails) {
    const msg = evalResult.exceptionDetails.exception?.description
      || evalResult.exceptionDetails.text
      || 'Runtime.evaluate failed';
    throw new Error(msg);
  }

  const parsed = JSON.parse(evalResult.result.value);
  if (parsed && parsed.fatalError) throw new Error(parsed.fatalError);

  // Post-processing: if page-state has no companyName, pull it from jobAuth-buyer
  if (Array.isArray(parsed)) {
    const psResult = parsed.find(r => r.alias === 'page-state');
    const jabResult = parsed.find(r => r.alias === 'jobAuth-buyer');
    const cpResult  = parsed.find(r => r.alias === 'company-page');
    const apiName   = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name
                   || cpResult?.companyName
                   || null;
    if (psResult && !psResult.data?.companyName && apiName) {
      if (psResult.data && typeof psResult.data === 'object') {
        psResult.data.companyName = apiName;
        psResult.data.source = (psResult.data.source || 'none') + '+api-fallback';
      } else {
        psResult.data = { companyName: apiName, source: 'api-fallback' };
      }
      // Cache it for future lookups
      if (companyId) {
        chrome.storage.local.get(['detectedCompanies'], (stored) => {
          const companies = stored.detectedCompanies || [];
          const existing = companies.find(c => c.companyId === companyId);
          if (existing && !existing.companyName) {
            existing.companyName = apiName;
            chrome.storage.local.set({ detectedCompanies: companies });
          }
        });
      }
    }
  }

  return parsed;
}
