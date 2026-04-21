importScripts('config.js');

// ─── In-memory store for in-flight requests ──────────────────────────────────
// Keyed by requestId. Cleared once the response body is retrieved.
const pendingRequests = new Map();

// Track which tab IDs have an active debugger session
const attachedTabs = new Set();

// Active/inactive state — persisted to storage
let _isActive = true;
chrome.storage.local.get(['scraperActive'], (s) => {
  _isActive = s.scraperActive !== false; // default ON
});

// Last seen session context (bearer token + tenant) — updated from every captured request
const lastSessionCtx = { bearer: null, tenantId: null };

// Track the current page-stage per tab so every captured request is labelled
// Stages: 'search' | 'job' | 'apply' | 'company' | 'other'
const tabPageStage = new Map();

// Track last job URL per tab for auto-capture on navigation-away
const tabLastJobUrl = new Map();

// Per-tab captured GQL responses for passive job detection.
// Key: `${tabId}` → [{ url, status, data, requestBody }]
// Accumulated by saveRequest, consumed by triggerJobLookup.
const _capturedGqlByTab = new Map();

function jobCipherToOpeningId(cipher) {
  if (!cipher || typeof cipher !== 'string') return '';
  return cipher.replace(/^~02/, '');
}

// ─── GQL query for job auth details (exact query Upwork's frontend uses) ──────
const JOB_AUTH_DETAILS_QUERY = `fragment JobPubOpeningInfoFragment on Job { ciphertext id type access title hideBudget createdOn notSureProjectDuration notSureFreelancersToHire notSureExperienceLevel notSureLocationPreference premium }
fragment JobPubOpeningSegmentationDataFragment on JobSegmentation { customValue label name sortOrder type value skill { description externalLink prettyName skill id } }
fragment JobPubOpeningSandDataFragment on SandsData { occupation { freeText ontologyId prefLabel id uid: id } ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance } additionalSkills { groupId id freeText prefLabel relevance } }
fragment JobPubOpeningFragment on JobPubOpeningInfo { status postedOn publishTime sourcingTime startDate deliveryDate workload contractorTier description info { ...JobPubOpeningInfoFragment } segmentationData { ...JobPubOpeningSegmentationDataFragment } sandsData { ...JobPubOpeningSandDataFragment } category { name urlSlug } categoryGroup { name urlSlug } budget { amount currencyCode } annotations { customFields tags } engagementDuration { label weeks } extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType } attachments @include(if: $isLoggedIn) { fileName length uri } clientActivity { lastBuyerActivity totalApplicants totalHired totalInvitedToInterview unansweredInvites invitationsSent numberOfPositionsToHire } deliverables deadline tools { name } }
fragment JobQualificationsFragment on JobQualifications { countries earnings groupRecno languages localDescription localFlexibilityDescription localMarket minJobSuccessScore minOdeskHours onSiteType prefEnglishSkill regions risingTalent shouldHavePortfolio states tests timezones type locationCheckRequired group { groupId groupLogo groupName } location { city country countryTimezone offsetFromUtcMillis state worldRegion } locations { id type } minHoursWeek @skip(if: $isLoggedIn) }
fragment JobAuthDetailsOpeningFragment on JobAuthOpeningInfo { job { ...JobPubOpeningFragment } qualifications { ...JobQualificationsFragment } questions { question position } }
fragment JobPubBuyerInfoFragment on JobPubBuyerInfo { location { offsetFromUtcMillis countryTimezone city country } stats { totalAssignments activeAssignmentsCount hoursCount feedbackCount score totalJobsWithHires totalCharges { amount } } company { name @include(if: $isLoggedIn) companyId @include(if: $isLoggedIn) isEDCReplicated contractDate profile { industry size } } jobs { openCount postedCount @include(if: $isLoggedIn) openJobs { id uid: id isPtcPrivate ciphertext title type } } avgHourlyJobsRate @include(if: $isLoggedIn) { amount } }
fragment JobAuthDetailsBuyerWorkHistoryFragment on BuyerWorkHistoryItem { isPtcJob status isEDCReplicated isPtcPrivate startDate endDate totalCharge totalHours jobInfo { title id uid: id access type ciphertext } contractorInfo { contractorName accessType ciphertext } rate { amount } feedback { feedbackSuppressed score comment } feedbackToClient { feedbackSuppressed score comment } }
fragment JobAuthDetailsBuyerFragment on JobAuthBuyerInfo { enterprise isPaymentMethodVerified info { ...JobPubBuyerInfoFragment } workHistory { ...JobAuthDetailsBuyerWorkHistoryFragment } }
fragment JobAuthDetailsCurrentUserInfoFragment on JobCurrentUserInfo { owner freelancerInfo { profileState applied devProfileCiphertext hired application { vjApplicationId } pendingInvite { inviteId } contract { contractId status } hourlyRate { amount } qualificationsMatches { matches { clientPreferred clientPreferredLabel freelancerValue freelancerValueLabel qualification qualified } } } }
query JobAuthDetailsQuery($id: ID! $isFreelancerOrAgency: Boolean! $isLoggedIn: Boolean!) { jobAuthDetails(id: $id) { hiredApplicantNames opening { ...JobAuthDetailsOpeningFragment } buyer { ...JobAuthDetailsBuyerFragment } currentUserInfo { ...JobAuthDetailsCurrentUserInfoFragment } similarJobs { id uid: id ciphertext title snippet } workLocation { onSiteCity onSiteCountry onSiteReason onSiteReasonFlexible onSiteState onSiteType } phoneVerificationStatus { status } applicantsBidsStats { avgRateBid { amount currencyCode } minRateBid { amount currencyCode } maxRateBid { amount currencyCode } } specializedProfileOccupationId @include(if: $isFreelancerOrAgency) applicationContext @include(if: $isFreelancerOrAgency) { freelancerAllowed clientAllowed } } }`;

// ─── GQL query for client info by opening (buyer company details + activity) ──
const CLIENT_INFO_BY_OPENING_QUERY = `
query clientInfoByOpening($openingId: ID!) {
  clientInfoByOpening(openingId: $openingId) {
    buyer {
      info {
        company {
          contractDate
          name
          profile { industry size visible l3Occupations }
          id: companyId
        }
        location { country city state countryTimezone worldRegion offsetFromUtcMillis }
        jobs { postedCount filledCount openCount }
        stats {
          feedbackCount hoursCount
          totalCharges { amount currencyCode }
          totalAssignments activeAssignmentsCount score totalJobsWithHires
        }
        logo
        avgHourlyJobsRate { amount currencyCode }
      }
      cssTier
      isPaymentMethodVerified
      isEnterprise: enterprise
    }
    activity {
      lastBuyerActivity numberOfPositionsToHire totalApplicants
      totalInvitedToInterview totalHired unansweredInvites invitationsSent
    }
    jobInfo { status }
  }
}`;

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
  // effectiveUrl: for full loads changeInfo.url is set on 'loading'; for SPA nav only changeInfo.url.
  // tab.url is reliable on 'complete' (after any redirects) but lags on SPA nav.
  const effectiveUrl = changeInfo.url || tab.url;
  if (!effectiveUrl || !effectiveUrl.includes('upwork.com')) return;

  // ── Stage classification ──────────────────────────────────────────────────
  // Run on BOTH full-load 'loading' events AND SPA url-only nav (no status).
  // This ensures tabPageStage and tabLastJobUrl are always current.
  const urlForClassify = changeInfo.url; // only update when URL actually changes
  if (urlForClassify) {
    let stage = 'other';
    if (/\/nx\/search\/jobs|\?q=|\?skills=|\?category2_uid=|search\/jobs/.test(urlForClassify)) stage = 'search';
    else if (/\/jobs\/(~0[^/?#]+).*apply|apply-direct/.test(urlForClassify))                   stage = 'apply';
    else if (/\/jobs\/(~0[^/?#]+)|contracts\/new/.test(urlForClassify))                         stage = 'job';
    else if (/\/companies\/|\/(agencies|clients)\/|org\//.test(urlForClassify))                 stage = 'company';
    tabPageStage.set(tabId, stage);

    // Auto-capture if user navigated away from a job/apply page
    const prevJobUrl = tabLastJobUrl.get(tabId);
    if (prevJobUrl && prevJobUrl !== urlForClassify && attachedTabs.has(tabId)) {
      triggerAutoCapture(tabId, prevJobUrl);
    }
    if (stage === 'job' || stage === 'apply') {
      tabLastJobUrl.set(tabId, urlForClassify);
    } else {
      tabLastJobUrl.delete(tabId);
    }
  }

  // ── Attach debugger on full-load navigation ───────────────────────────────
  if (changeInfo.status === 'loading') {
    attachDebugger(tabId);
  }

  // ── Passive single-job lookup: SPA nav OR full-page load ─────────────────
  // changeInfo.url fires on SPA navigation; status='complete' fires on full load.
  if (_isActive && (changeInfo.url || changeInfo.status === 'complete')) {
    const urlToCheck = changeInfo.url || tab.url;
    if (!urlToCheck) return;
    const cipher = urlToCheck.match(/\/jobs\/(?:details\/)?(~0[^/?#\s]+)/)?.[1];
    if (cipher) {
      const delay = changeInfo.status === 'complete' ? 3000 : 2000;
      if (!attachedTabs.has(tabId)) {
        // Re-attach (handles SW restart where attachedTabs was cleared)
        attachDebugger(tabId).then(() =>
          setTimeout(() => triggerJobLookup(tabId, cipher).catch(() => {}), delay)
        );
      } else {
        setTimeout(() => triggerJobLookup(tabId, cipher).catch(() => {}), delay);
      }
    }
  }

  // ── Auto-scrape search results ────────────────────────────────────────────
  // Fires on BOTH SPA navigation (changeInfo.url only) and full-page load (status=complete).
  // SPA nav is the common case on Upwork — without this, auto-scrape never triggers for
  // in-page navigation (e.g. user clicks search or navigates the Upwork navbar).
  if (_isActive) {
    // Use changeInfo.url for SPA nav; tab.url at 'complete' for full loads.
    // On full loads changeInfo.url also fires during 'loading' — that's fine, the
    // cooldown guard prevents a second run when 'complete' fires for the same URL.
    const autoUrl = changeInfo.url || (changeInfo.status === 'complete' ? tab.url : null);
    if (autoUrl && /\/nx\/search\/jobs|\?q=|\?skills=|\?category2_uid=|search\/jobs/.test(autoUrl)
                && autoUrl.includes('upwork.com')) {
      let normalizedUrl = autoUrl;
      try { const u = new URL(autoUrl); normalizedUrl = u.origin + u.pathname + u.search; } catch(_) {}

      const lastRun = _autoSearchLastRun.get(normalizedUrl) || 0;
      const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per URL
      if (!_activeSearchScrapes.has(normalizedUrl) && (Date.now() - lastRun) > COOLDOWN_MS) {
        _activeSearchScrapes.add(normalizedUrl);
        _autoSearchLastRun.set(normalizedUrl, Date.now());
        console.log('[upwork-ext] auto-scrape triggered for', normalizedUrl);
        runSearchLookupCore(normalizedUrl, EXT_CONFIG.MAX_JOBS || 100, () => {}, normalizedUrl)
          .finally(() => _activeSearchScrapes.delete(normalizedUrl));
      }
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

// ─── Passive full lookup when user opens a job page ─────────────────────────
// Runs the same pipeline as runSearchLookup for a single cipher.
// Uses the already-loaded Upwork tab as query host (has cookies + CDP attached).
const _activeJobLookups = new Set(); // prevent duplicate concurrent lookups

// ─── Auto-search-scrape deduplication ────────────────────────────────────────
// Prevents multiple concurrent runs for the same search URL.
const _activeSearchScrapes = new Set();
// Last auto-scrape timestamp per normalized search URL (5-min cooldown).
const _autoSearchLastRun = new Map();
async function triggerJobLookup(tabId, cipher) {
  if (_activeJobLookups.has(cipher)) return;
  _activeJobLookups.add(cipher);
  try {
    // Skip if we already have a result for this cipher captured within the last 5 min
    const stored = await new Promise(r => chrome.storage.local.get(['companyLookups'], r));
    const existing = (stored.companyLookups || []).find(l => l.jobCiphertext === cipher);
    // Only skip if we already have a GOOD result (title isn't 'Unknown') captured within 5 min.
    if (existing && existing.jobTitle && existing.jobTitle !== 'Unknown' && (Date.now() - new Date(existing.runAt).getTime()) < 5 * 60 * 1000) return;

    console.log('[upwork-ext] passive lookup start:', cipher);

    // Wait for Upwork's natural GQL requests to complete.
    // The CDP handler captures them into _capturedGqlByTab via saveRequest.
    // Poll up to 15 seconds — GQL requests typically finish within 3-5s of page load.
    let results = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const tabGql = _capturedGqlByTab.get(tabId) || [];

      // Try cipher-matched responses first
      const matching = tabGql.filter(r => {
        const cipherInReq = extractJobCiphertext(r.requestBody);
        return cipherInReq === cipher;
      });
      if (matching.length >= 1) {
        results = buildResultsFromGqlResponses(matching);
        if (results.length > 0) break;
      }

      // Fallback: try ALL GQL responses from this tab (persisted queries may not
      // have the cipher in the request body, only in the response)
      if (attempt >= 2) {
        const byContent = tabGql.filter(r => {
          const d = r.data;
          return d && typeof d === 'object' && (d.data?.jobAuthDetails || d.data?.fetchJobDetailsAndContext || d.data?.fetchjobdetailsandcontext || d.jobAuthDetails || d.fetchJobDetailsAndContext || d.fetchjobdetailsandcontext);
        });
        if (byContent.length > 0) {
          results = buildResultsFromGqlResponses(byContent);
          if (results.length > 0) {
            console.log('[upwork-ext] passive capture: found results by response content');
            break;
          }
        }
      }
    }

    if (results.length > 0) {
      console.log('[upwork-ext] passive capture found', results.length, 'results');
    }

    // Fallback: if debugger was attached AFTER page load, GQL requests were missed.
    // Reload the page via CDP to trigger fresh GQL requests with debugger now active.
    if (results.length === 0 && attachedTabs.has(tabId)) {
      console.log('[upwork-ext] no passive data — reloading page via CDP...');
      _capturedGqlByTab.delete(tabId);
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
        const reloadDone = new Promise(res => {
          const ll = (src, meth) => {
            if (src.tabId !== tabId) return;
            if (meth === 'Page.loadEventFired') { chrome.debugger.onEvent.removeListener(ll); res(); }
          };
          chrome.debugger.onEvent.addListener(ll);
          setTimeout(() => { chrome.debugger.onEvent.removeListener(ll); res(); }, 20000);
        });
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', {});
        await reloadDone;

        // Poll for GQL responses after reload
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise(r => setTimeout(r, 3000));
          const tabGql = _capturedGqlByTab.get(tabId) || [];
          // Try cipher match
          const matching = tabGql.filter(r => extractJobCiphertext(r.requestBody) === cipher);
          if (matching.length >= 1) {
            results = buildResultsFromGqlResponses(matching);
            if (results.length > 0) { console.log('[upwork-ext] post-reload capture found', results.length, 'results'); break; }
          }
          // Try content match
          if (attempt >= 2) {
            const byContent = tabGql.filter(r => {
              const d = r.data;
              return d && typeof d === 'object' && (d.data?.jobAuthDetails || d.data?.fetchJobDetailsAndContext || d.data?.fetchjobdetailsandcontext || d.jobAuthDetails || d.fetchJobDetailsAndContext || d.fetchjobdetailsandcontext);
            });
            if (byContent.length > 0) {
              results = buildResultsFromGqlResponses(byContent);
              if (results.length > 0) { console.log('[upwork-ext] post-reload content match:', results.length, 'results'); break; }
            }
          }
        }
      } catch(e) {
        console.warn('[upwork-ext] page reload failed:', e.message);
      }
    }

    // Fallback 2: direct GQL fetch from page context (most reliable)
    if (results.length === 0 && attachedTabs.has(tabId)) {
      console.log('[upwork-ext] trying direct GQL fetch from page context...');
      try {
        // Get stored session tokens as fallback
        const storedTk = await new Promise(r => chrome.storage.local.get(['sessionTokens'], r));
        const tk = storedTk.sessionTokens || {};
        const storedBearer = tk['oauth2_global_js_token'] || tk['master_access_token'] || tk['_bearer'] || '';
        const storedTenant = tk['current_organization_uid'] || '';

        const directExpr = `(async () => {
          try {
            var ck = {};
            document.cookie.split(';').forEach(function(c) {
              var parts = c.trim().split('=');
              ck[parts[0]] = parts.slice(1).join('=');
            });
            var bearer = ck['oauth2_global_js_token'] || ck['master_access_token'] || ${JSON.stringify(storedBearer)} || '';
            var tenantId = ck['current_organization_uid'] || ${JSON.stringify(storedTenant)} || '';
            if (!bearer) return JSON.stringify({ error: 'no bearer token' });
            var resp = await fetch('https://www.upwork.com/api/graphql/v1?alias=gql-query-get-auth-job-details', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'bearer ' + bearer, 'X-Upwork-API-TenantId': tenantId, 'X-Upwork-Accept-Language': 'en-US' },
              body: JSON.stringify({ query: ${JSON.stringify(JOB_AUTH_DETAILS_QUERY)}, variables: { id: ${JSON.stringify(cipher)}, isFreelancerOrAgency: true, isLoggedIn: true } })
            });
            var data; try { data = await resp.json(); } catch(e) { data = null; }
            return JSON.stringify({ status: resp.status, data: data });
          } catch(e) { return JSON.stringify({ error: e.message }); }
        })()`;
        const evalRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: directExpr, awaitPromise: true, returnByValue: true });
        const fetchResult = evalRes?.result?.value ? JSON.parse(evalRes.result.value) : null;
        console.log('[upwork-ext] passive direct fetch:', fetchResult?.status, 'hasData:', !!(fetchResult?.data?.data?.jobAuthDetails));
        if (fetchResult && !fetchResult.error && fetchResult.status === 200 && fetchResult.data?.data?.jobAuthDetails) {
          const wrapped = fetchResult.data;
          results.push({ alias: 'jobAuth-buyer', status: 200, data: wrapped, source: 'direct-fetch' });
          results.push({ alias: 'jobAuth-full',  status: 200, data: wrapped, source: 'direct-fetch' });
        }
      } catch(dfErr) {
        console.warn('[upwork-ext] passive direct fetch error:', dfErr.message);
      }
    }

    // Fallback 3: template replay
    if (results.length === 0 && attachedTabs.has(tabId)) {
      console.log('[upwork-ext] trying template replay...');
      results = await replayTemplatesForJob(tabId, cipher);
    }

    if (results.length === 0) {
      console.warn('[upwork-ext] passive lookup: no data captured for', cipher);
      return;
    }

    const entry = await buildJobEntry(tabId, cipher, results);
    saveJobEntry(entry);
  } catch(e) {
    console.warn('[upwork-ext] triggerJobLookup error:', e.message);
  } finally {
    _activeJobLookups.delete(cipher);
  }
}

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
  } catch (e) {
    // On MV3 SW restart the in-memory attachedTabs Set is cleared, but Chrome
    // keeps the debugger physically attached to the tab. Adopt it instead of failing.
    if (/already attached|Another debugger/i.test(e.message || '')) {
      console.log(`[UpworkCapture] Re-adopting already-attached debugger → tab ${tabId}`);
    } else {
      // Real failure (DevTools open, tab closed, non-http tab, etc.)
      console.warn(`[UpworkCapture] Could not attach to tab ${tabId}: ${e.message}`);
      return;
    }
  }

  // Whether fresh-attached or re-adopted, mark known and enable Network domain.
  attachedTabs.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxTotalBufferSize:   100 * 1024 * 1024
    });
  } catch (e) {
    console.warn(`[UpworkCapture] Network.enable failed for tab ${tabId}: ${e.message}`);
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
  } catch (e) {
    console.warn(`[UpworkCapture] Runtime.enable failed for tab ${tabId}: ${e.message}`);
  }
  console.log(`[UpworkCapture] Debugger ready → tab ${tabId}`);
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

  // ── Capture GQL request template for future replay ────────────────────────
  // When a successful GQL request completes, store its exact headers + query
  // as a "template". Search scraping and manual URL lookup can replay these
  // templates with swapped variables instead of building custom queries.
  if (entry.url?.includes('/api/graphql/v1') && !entry.error && entry.requestBody) {
    const reqBody = typeof entry.requestBody === 'string' ? tryParseJson(entry.requestBody) : entry.requestBody;

    // Template capture — only possible when the request has an explicit query string
    if (reqBody?.query) {
      try {
        const u = new URL(entry.url);
        const alias = u.searchParams.get('alias');
        if (alias) {
          const rh = entry.requestHeaders || {};
          chrome.storage.local.get(['requestTemplates'], (st) => {
            const templates = st.requestTemplates || {};
            templates[alias] = {
              url: entry.url,
              query: reqBody.query,
              variables: reqBody.variables || {},
              headers: {
                'Authorization': rh['Authorization'] || rh['authorization'] || '',
                'X-Upwork-API-TenantId': rh['X-Upwork-API-TenantId'] || rh['x-upwork-api-tenantid'] || '',
                'X-XSRF-TOKEN': rh['X-XSRF-TOKEN'] || rh['x-xsrf-token'] || '',
                'Content-Type': 'application/json',
                'Accept': rh['Accept'] || rh['accept'] || '*/*',
                'X-Upwork-Accept-Language': 'en-US'
              },
              capturedAt: Date.now()
            };
            chrome.storage.local.set({ requestTemplates: templates });
          });
        }
      } catch(_) {}
    }

    // ── Accumulate GQL responses per tab for passive detection ───────────────
    // This must run for ALL GQL responses (including persisted queries that have
    // no 'query' field — only extensions.persistedQuery.sha256Hash + variables).
    if (entry.responseBody && typeof entry.responseBody === 'object' && entry.tabId) {
      if (!_capturedGqlByTab.has(entry.tabId)) _capturedGqlByTab.set(entry.tabId, []);
      _capturedGqlByTab.get(entry.tabId).push({
        url: entry.url,
        status: entry.status,
        data: entry.responseBody,
        requestBody: typeof reqBody === 'object' ? reqBody : (typeof entry.requestBody === 'object' ? entry.requestBody : null)
      });
      // Auto-prune: keep last 50 per tab
      const arr = _capturedGqlByTab.get(entry.tabId);
      if (arr.length > 50) arr.splice(0, arr.length - 50);
    }
  }

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

// ─── runSearchLookupCore: shared by runSearchLookup message + searchByQuery ───
async function runSearchLookupCore(searchUrl, maxJobs, setSearchProgress, searchQuery) {
  // ── MV3 service-worker keepalive ─────────────────────────────────────────
  // Chrome kills SW after ~30 s of no Chrome API activity. setInterval here
  // fires a storage read every 20 s — fast enough to always have a Chrome API
  // call in flight, keeping the SW alive for the full function duration.
  const _swKeepAlive = setInterval(
    () => chrome.storage.local.get(['_swKeepAlive'], () => {}),
    20000
  );

  try {

  // Extract bare search query from URL (for template variable injection)
  let rawQuery = searchQuery;
  try { rawQuery = new URL(searchUrl).searchParams.get('q') || searchQuery; } catch(_) {}

  const store = await new Promise(r => chrome.storage.local.get(['sessionTokens', 'requestTemplates'], r));
  const tk       = store.sessionTokens    || {};
  const tmplMap  = store.requestTemplates || {};
  const searchTmpl = tmplMap['smf.retrieve.top'] || null;

  const cipherSet = new Set();
  const searchJobMap = new Map();
  let liveGraphqlHeaders = null;
  const postSearchEvent = () => {};

  // ── Debug: function entry ────────────────────────────────────────────────
  fetch(EXT_CONFIG.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _debug: true,
      event: 'core_start',
      v: 'v5',
      searchUrl,
      maxJobs,
      searchQuery,
      hasSessionTokens: Object.keys(tk).length > 0,
      tokenKeys: Object.keys(tk),
      hasRequestTemplates: Object.keys(tmplMap).length > 0,
      ts: new Date().toISOString()
    })
  }).catch(() => {});

  // ── Shared helpers ────────────────────────────────────────────────────────

  const addCiphersFromText = (text) => {
    if (!text || typeof text !== 'string') return 0;
    let n = 0;
    for (const m of text.matchAll(/"(~0[0-9a-zA-Z]{8,35})"/g))
      if (!cipherSet.has(m[1])) { cipherSet.add(m[1]); n++; }
    return n;
  };

  const USER_JOB_SEARCH_FALLBACK_QUERY = `
  query UserJobSearch($requestVariables: UserJobSearchV1Request!) {
    search {
      universalSearchNuxt {
        userJobSearchV1(request: $requestVariables) {
          paging { total }
          results { id }
        }
      }
    }
  }
  `;

  // Run a fetch() from inside a tab so it carries that tab's session cookies.
  const tabFetch = async (tabId, url, method, headers, bodyStr) => {
    const expr = `(async () => {
  try {
    const r = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)}, credentials: 'include',
      headers: ${JSON.stringify(headers)},
      ${bodyStr ? `body: ${JSON.stringify(bodyStr)}` : ''}
    });
    if (!r.ok) return JSON.stringify({ _status: r.status });
    return r.text();
  } catch(e) { return JSON.stringify({ _error: e.message }); }
})()`;
    const res = await chrome.debugger.sendCommand(
      { tabId }, 'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }
    );
    return res.result?.value || '';
  };

  // Scan the rendered search page for job ciphers.
  // Prefer real job card links/hrefs because Upwork's search page is heavily client-rendered
  // and the raw HTML regex can miss results even when the cards are visible.
  const domScan = async (tabId) => {
    try {
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _debug: true, event: 'scan_dom_start', tabId, ts: new Date().toISOString() })
      });

      const r = await Promise.race([
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){
  try {
    var seen=new Set(), found=[];
    var pushCipher = function(v) {
      if (!v || typeof v !== 'string') return;
      var m = v.match(/~0[0-9a-zA-Z]{8,35}/);
      if (m && !seen.has(m[0])) { seen.add(m[0]); found.push(m[0]); }
    };
    var pushUid = function(v) {
      if (!v || typeof v !== 'string') return;
      var m = v.match(/^(\d{15,})$/);
      if (m) {
        var cipher = '~02' + m[1];
        if (!seen.has(cipher)) { seen.add(cipher); found.push(cipher); }
      }
    };

    // 1) Real job links in rendered cards
    var selectors = [
      'article[data-ev-job-uid] a[href*="/jobs/"]',
      'a[href*="/jobs/details/"]',
      'a[href*="/jobs/~0"]',
      'a[href*="/nx/search/jobs/details/~0"]',
      '[data-test="job-tile-title-link"]',
      'h2 a[href*="/jobs/"]',
      'h3 a[href*="/jobs/"]'
    ];
    selectors.forEach(function(sel) {
      document.querySelectorAll(sel).forEach(function(a) {
        pushCipher(a.href || '');
        pushCipher(a.getAttribute('href') || '');
      });
    });

    // 1b) Numeric opening IDs stored on rendered cards/attributes
    document.querySelectorAll('article[data-ev-job-uid]').forEach(function(node) {
      pushUid(node.getAttribute('data-ev-job-uid') || '');
    });
    ['data-ev-job-uid','data-job-uid','data-job-id','data-uid'].forEach(function(attr) {
      document.querySelectorAll('[' + attr + ']').forEach(function(node) {
        pushUid(node.getAttribute(attr) || '');
      });
    });

    // 2) Card HTML as fallback
    document.querySelectorAll('article, section, main').forEach(function(node) {
      pushCipher(node.innerHTML || '');
    });

    // 3) Whole-page HTML as final fallback
    var html = document.documentElement ? document.documentElement.innerHTML : document.body ? document.body.innerHTML : '';
    var re=/~0[0-9a-zA-Z]{8,35}/g, m;
    while ((m=re.exec(html))!==null) if(!seen.has(m[0])){seen.add(m[0]);found.push(m[0]);}

    return JSON.stringify({
      found: found,
      title: document.title,
      articleCount: document.querySelectorAll('article').length,
      linkCount: document.querySelectorAll('a[href*="/jobs/"]').length,
      uidCardCount: document.querySelectorAll('article[data-ev-job-uid]').length,
      bodyTextPreview: (document.body && document.body.innerText ? document.body.innerText.slice(0, 400) : '')
    });
  } catch(e){return JSON.stringify({ found: [], error: e.message });}
})()`,
          returnByValue: true,
          timeout: 4000
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('domScan timeout after 5s')), 5000))
      ]);
      const out = JSON.parse(r.result?.value || '{"found":[]}');
      const arr = Array.isArray(out?.found) ? out.found : [];
      arr.forEach(c => cipherSet.add(c));
      console.log(`[upwork-ext] search: DOM scan found ${arr.length} ciphers (articles=${out?.articleCount || 0}, links=${out?.linkCount || 0}, set total: ${cipherSet.size})`);
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _debug: true,
          event: 'scan_dom_done',
          tabId,
          found: arr.length,
          articleCount: out?.articleCount || 0,
          linkCount: out?.linkCount || 0,
          uidCardCount: out?.uidCardCount || 0,
          ts: new Date().toISOString()
        })
      });
      if (!arr.length) {
        postSearchEvent({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'scan_dom_empty',
            title: out?.title || null,
            articleCount: out?.articleCount || 0,
            linkCount: out?.linkCount || 0,
            uidCardCount: out?.uidCardCount || 0,
            bodyTextPreview: out?.bodyTextPreview || '',
            error: out?.error || null,
            ts: new Date().toISOString()
          })
        });
      }
    } catch(e) {
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _debug: true, event: 'scan_dom_error', tabId, error: e.message, ts: new Date().toISOString() })
      });
      console.warn('[upwork-ext] search: DOM scan failed:', e.message);
    }
  };

  // Build auth headers from stored tokens
  const makeAuthHeaders = () => {
    const tok      = tk.UniversalSearchNuxt_vt || tk.oauth2_global_js_token || tk._bearer || '';
    const tenantId = tk.current_organization_uid || tk._tenantId || '';
    const h = { 'Content-Type': 'application/json', 'X-Upwork-Accept-Language': 'en-US' };
    if (tok)      h['Authorization']        = 'Bearer ' + tok;
    if (tenantId) h['X-Upwork-API-TenantId'] = tenantId;
    return h;
  };

  // ── Approach A: replay stored smf.retrieve.top template ───────────────────
  // Fastest path — no tab navigation, runs fetch() directly in an existing
  // Approach A: smf.retrieve.top is a SITE NOTIFICATION endpoint, not a job
  // search. Ciphers are embedded in SSR HTML and only obtainable by loading the
  // search page. Skip Approach A entirely — go straight to Approach B.
  if (false && searchTmpl?.query) {
    console.log('[upwork-ext] search: have stored smf.retrieve.top template, using direct fetch');

    // Find an open Upwork tab to borrow, or open the home page
    let proxyTab = null;
    let didOpenProxy = false;
    let proxyAttached = false;

    const existingUpworkTabs = await new Promise(r =>
      chrome.tabs.query({ url: '*://www.upwork.com/*', status: 'complete' }, r)
    );
    if (existingUpworkTabs.length > 0) {
      proxyTab = existingUpworkTabs[0];
      console.log('[upwork-ext] search: borrowing existing Upwork tab', proxyTab.id);
    } else {
      proxyTab = await new Promise(r => chrome.tabs.create({ url: 'https://www.upwork.com/', active: false }, r));
      didOpenProxy = true;
      // Wait for load
      await new Promise(res => {
        const onUpdated = (tid, info) => {
          if (tid === proxyTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated); res();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(res, 15000);
      });
    }

    await new Promise(res =>
      chrome.debugger.attach({ tabId: proxyTab.id }, '1.3', () => {
        proxyAttached = !chrome.runtime.lastError;
        res();
      })
    );

    if (proxyAttached) {
      const headers = { ...searchTmpl.headers, ...makeAuthHeaders() };
      const maxPages = Math.min(Math.ceil(maxJobs / 10), 20);

      for (let page = 1; page <= maxPages && cipherSet.size < maxJobs; page++) {
        const vars = JSON.parse(JSON.stringify(searchTmpl.variables || {}));
        // Inject query + paging into whatever variable shape the template uses
        [vars, vars.searchRequest, vars.searchInput, vars.searchRequestInput, vars.request]
          .filter(Boolean)
          .forEach(v => {
            if ('query'       in v) v.query       = rawQuery;
            if ('searchQuery' in v) v.searchQuery  = rawQuery;
            if ('paging'      in v) v.paging       = { offset: (page - 1) * 10, count: 10 };
            if ('pagination'  in v) v.pagination   = { first: 10, after: String((page - 1) * 10) };
          });

        const bodyStr = JSON.stringify({ query: searchTmpl.query, variables: vars });
        const text = await tabFetch(proxyTab.id, searchTmpl.url, 'POST', headers, bodyStr).catch(() => '');
        const added = addCiphersFromText(text);
        console.log(`[upwork-ext] search: template page ${page} → +${added} ciphers (total ${cipherSet.size})`);
        if (added === 0) break;
      }

      await new Promise(res => chrome.debugger.detach({ tabId: proxyTab.id }, res));
    }

    if (didOpenProxy && proxyTab) chrome.tabs.remove(proxyTab.id, () => {});
  }

  // ── Approach B: navigate search page, passive capture + DOM scan ───────────
  // Used when no stored template exists OR template returned 0 ciphers.
  // Opens a VISIBLE (active:true) tab so Chrome doesn't throttle Vue hydration.
  // searchTab is kept alive after scanning so the lookup loop can reuse it
  // (already on www.upwork.com with CDP attached and cookies in place).
  let searchTab = null;

  if (cipherSet.size === 0) {
    console.log('[upwork-ext] search: falling back to page navigation (active tab)');
    postSearchEvent({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _debug: true, event: 'scan_approach_b_start', searchUrl, ts: new Date().toISOString() })
    });

    let tab = null;
    let detached = false;
    const collectedResponses = [];
    const pendingGqlRequests = new Map();
    let replayCandidate = null;
    let capturedPostBody = null;
    let sawUserJobSearchRequest = false;
    let sawUserJobSearchResponse = false;
    let lastUserJobSearchDebug = null;

    const getAliasFromUrl = (url) => {
      try { return new URL(url).searchParams.get('alias') || ''; } catch(_) { return ''; }
    };

    const isUserJobSearchRequest = (reqMeta = {}) => {
      const alias = getAliasFromUrl(reqMeta.url || '');
      const queryText = reqMeta.requestBody?.query || '';
      return alias === 'userJobSearch'
        || /query\s+UserJobSearch\b/.test(queryText)
        || /userJobSearchV1\s*\(/.test(queryText);
    };

    const countCipherHits = (text) => ((text || '').match(/~0[A-Za-z0-9]+/g) || []).length;

    const pickReplayHeaders = (headers = {}) => {
      const out = {
        'Content-Type': 'application/json',
        'X-Upwork-Accept-Language': 'en-US'
      };
      const wanted = [
        'Authorization',
        'X-XSRF-TOKEN',
        'X-Upwork-API-TenantId',
        'apollographql-client-name',
        'apollographql-client-version',
        'x-odesk-user-agent',
        'x-requested-with'
      ];
      for (const key of wanted) {
        const foundKey = Object.keys(headers).find((headerKey) => headerKey.toLowerCase() === key.toLowerCase());
        if (foundKey && headers[foundKey]) out[key] = headers[foundKey];
      }
      return out;
    };

    const inspectUserJobSearchText = (text) => {
      if (!text || typeof text !== 'string') {
        return {
          added: 0,
          returnedCount: 0,
          totalAvailable: 0,
          ids: [],
          errors: [],
          status: null,
          preview: ''
        };
      }
      try {
        const payload = JSON.parse(text);
        const searchResp = payload?.data?.search?.universalSearchNuxt?.userJobSearchV1;
        const results = Array.isArray(searchResp?.results) ? searchResp.results : [];
        const ids = [];
        for (const item of results) {
          const jobId = item?.jobTile?.job?.id || item?.id || null;
          const cipher = item?.jobTile?.job?.ciphertext || item?.jobTile?.job?.cipherText || null;
          if (jobId) ids.push(jobId);
        }
        return {
          added: 0,
          returnedCount: results.length,
          totalAvailable: Number(searchResp?.paging?.total || 0),
          ids,
          errors: Array.isArray(payload?.errors) ? payload.errors : [],
          status: payload?._status || null,
          preview: text.slice(0, 4000)
        };
      } catch(_) {
        return {
          added: 0,
          returnedCount: 0,
          totalAvailable: 0,
          ids: [],
          errors: [],
          status: null,
          preview: text.slice(0, 4000)
        };
      }
    };

    const addCiphersFromUserJobSearchText = (text, source = 'unknown') => {
      if (!text || typeof text !== 'string') return { added: 0, returnedCount: 0, totalAvailable: 0 };
      try {
        const payload = JSON.parse(text);
        const searchResp = payload?.data?.search?.universalSearchNuxt?.userJobSearchV1;
        const results = Array.isArray(searchResp?.results) ? searchResp.results : [];
        let added = 0;
        for (const item of results) {
          const jobId = item?.jobTile?.job?.id || item?.id || null;
          const cipher = item?.jobTile?.job?.ciphertext || item?.jobTile?.job?.cipherText
            || (jobId ? '~02' + jobId : null);
          if (jobId && cipher && !searchJobMap.has(cipher)) {
            searchJobMap.set(cipher, {
              id: jobId,
              cipher,
              title: item?.title || '',
              publishTime: item?.jobTile?.job?.publishTime || null
            });
          }
          if (cipher && !cipherSet.has(cipher)) {
            cipherSet.add(cipher);
            added++;
          }
        }
        const inspected = inspectUserJobSearchText(text);
        lastUserJobSearchDebug = {
          source,
          returnedCount: inspected.returnedCount,
          totalAvailable: inspected.totalAvailable,
          ids: inspected.ids.slice(0, 20),
          errors: inspected.errors,
          status: inspected.status,
          preview: inspected.preview
        };
        return {
          added,
          returnedCount: results.length,
          totalAvailable: Number(searchResp?.paging?.total || 0)
        };
      } catch(_) {
        const inspected = inspectUserJobSearchText(text);
        lastUserJobSearchDebug = {
          source,
          returnedCount: inspected.returnedCount,
          totalAvailable: inspected.totalAvailable,
          ids: inspected.ids.slice(0, 20),
          errors: inspected.errors,
          status: inspected.status,
          preview: inspected.preview
        };
        return { added: 0, returnedCount: 0, totalAvailable: 0 };
      }
    };

    const mutateReplayVariables = (node, pageNum, pageSize = null) => {
      if (!node || typeof node !== 'object') return;

      if (node.requestVariables && typeof node.requestVariables === 'object') {
        if (rawQuery) node.requestVariables.userQuery = rawQuery;
        const requestPaging = node.requestVariables.paging || {};
        const nextCount = Number.isFinite(pageSize) ? pageSize : (Number.isFinite(requestPaging.count) ? requestPaging.count : 10);
        node.requestVariables.paging = {
          ...requestPaging,
          offset: (pageNum - 1) * nextCount,
          count: nextCount
        };
      }

      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string') {
          if ((key === 'query' || key === 'searchQuery' || key === 'searchTerm' || key === 'q' || key === 'userQuery') && rawQuery) {
            node[key] = rawQuery;
          }
          continue;
        }
        if (!value || typeof value !== 'object') continue;

        if (key === 'paging') {
          const nextCount = Number.isFinite(pageSize) ? pageSize : (Number.isFinite(value.count) ? value.count : (Number.isFinite(value.limit) ? value.limit : 10));
          node[key] = { ...value, offset: (pageNum - 1) * nextCount, count: nextCount };
          continue;
        }
        if (key === 'pagination') {
          const nextFirst = Number.isFinite(pageSize) ? pageSize : (Number.isFinite(value.first) ? value.first : 10);
          node[key] = { ...value, first: nextFirst, after: String((pageNum - 1) * nextFirst) };
          continue;
        }
        if (key === 'page' && typeof value === 'number') {
          node[key] = pageNum;
          continue;
        }
        if (key === 'offset' && typeof value === 'number') {
          const pageSize = Number.isFinite(node.count) ? node.count : (Number.isFinite(node.limit) ? node.limit : 10);
          node[key] = (pageNum - 1) * pageSize;
          continue;
        }
        if (key === 'from' && typeof value === 'number') {
          const pageSize = Number.isFinite(node.size) ? node.size : (Number.isFinite(node.count) ? node.count : 10);
          node[key] = (pageNum - 1) * pageSize;
          continue;
        }
        mutateReplayVariables(value, pageNum, pageSize);
      }
    };

    const replaySearchPage = async (pageNum, pageSize = null) => {
      if (!replayCandidate?.requestBody) {
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'replay_no_candidate',
            pageNum,
            hasCandidateObj: !!replayCandidate,
            sawRequest: sawUserJobSearchRequest,
            sawResponse: sawUserJobSearchResponse,
            ts: new Date().toISOString()
          })
        }).catch(() => {});
        return null;
      }
      const requestBody = JSON.parse(JSON.stringify(replayCandidate.requestBody));
      mutateReplayVariables(requestBody.variables || requestBody, pageNum, pageSize);
      const replayAlias = getAliasFromUrl(replayCandidate.url);

      // XSRF: prefer the value captured live from the page's own requests
      const capturedXsrf = liveGraphqlHeaders?.xsrf
        || replayCandidate.headers?.['X-XSRF-TOKEN']
        || replayCandidate.headers?.['x-xsrf-token']
        || '';

      // The userJobSearch GQL endpoint belongs to the UniversalSearchNuxt microapp.
      // Each Upwork microapp has its own _vt (visitor token) cookie used as Authorization.
      // Use CDP Network.getCookies (reads HttpOnly cookies) to get it.
      // Also read current_organization_uid cookie as the matching tenant ID for this token.
      let ujsToken = '';
      let ujsTenantId = '';
      try {
        const cookieResult = await chrome.debugger.sendCommand(
          { tabId: tab.id }, 'Network.getCookies', { urls: ['https://www.upwork.com'] }
        );
        const cookies = cookieResult?.cookies || [];
        const vtCookie = cookies.find(c => c.name === 'UniversalSearchNuxt_vt');
        if (vtCookie?.value) ujsToken = 'bearer ' + vtCookie.value;
        // Fallback: try asct_vt or any _vt cookie
        if (!ujsToken) {
          const fallbackVt = cookies.find(c => c.name === 'asct_vt' || c.name.endsWith('_vt'));
          if (fallbackVt?.value) ujsToken = 'bearer ' + fallbackVt.value;
        }
        // current_organization_uid is the tenant ID for the logged-in user's active org
        const orgCookie = cookies.find(c => c.name === 'current_organization_uid');
        if (orgCookie?.value) ujsTenantId = orgCookie.value;
      } catch(_) {}

      fetch(EXT_CONFIG.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _debug: true,
          event: 'replay_page_start',
          pageNum,
          pageSize,
          url: replayCandidate.url,
          alias: replayAlias,
          isUserJobSearch: isUserJobSearchRequest(replayCandidate),
          ujsTenantId,
          hasCapturedXsrf: !!capturedXsrf,
          hasCapturedAuth: !!(liveGraphqlHeaders?.authorization),
          hasUjsToken: !!ujsToken,
          hasApolloClientName: !!apolloClientName,
          hasApolloClientVersion: !!apolloClientVersion,
          ts: new Date().toISOString()
        })
      }).catch(() => {});

      // Run the fetch inside the tab so session cookies are sent automatically.
      // Use the UniversalSearchNuxt_vt microapp token (read via CDP getCookies) as Authorization.
      // XSRF: use captured value first, then fall back to reading from document.cookie.
      const capturedAuth = ujsToken || liveGraphqlHeaders?.authorization || '';
      const replayBodyStr = JSON.stringify(requestBody);
      const replayUrl = replayCandidate.url;

      // Forward apollo client identification headers from the original captured request.
      // Upwork's GQL gateway uses apollographql-client-name to resolve the OAuth2 client's
      // allowed field scopes. Without these, the server falls back to a lower-privileged
      // client and rejects protected fields with "ExecutionAborted" permission errors.
      const _rch = replayCandidate.headers || {};
      const _findHeader = (obj, ...names) => {
        for (const n of names) {
          const k = Object.keys(obj).find(h => h.toLowerCase() === n.toLowerCase());
          if (k && obj[k]) return obj[k];
        }
        return '';
      };
      const apolloClientName    = _findHeader(_rch, 'apollographql-client-name');
      const apolloClientVersion = _findHeader(_rch, 'apollographql-client-version');
      const odeskUserAgent      = _findHeader(_rch, 'x-odesk-user-agent');
      const requestedWith       = _findHeader(_rch, 'x-requested-with');

      const replayExpr = `(async () => {
  try {
    const capturedXsrf = ${JSON.stringify(capturedXsrf)};
    const cookieXsrfRaw = (document.cookie.match(/(?:^|;\\s*)XSRF-TOKEN=([^;]+)/) || [])[1] || '';
    const cookieXsrf = cookieXsrfRaw ? decodeURIComponent(cookieXsrfRaw) : '';
    const xsrf = capturedXsrf || cookieXsrf;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (${JSON.stringify(capturedAuth)}) headers['Authorization'] = ${JSON.stringify(capturedAuth)};
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
    // Only send tenantId when it came from live captured headers (matching the real auth token).
    // The UniversalSearchNuxt_vt microapp token is NOT associated with current_organization_uid
    // — sending a mismatched tenantId causes 403 "tenant not found in users tenants".
    if (${JSON.stringify(!ujsToken && !!ujsTenantId)}) headers['X-Upwork-API-TenantId'] = ${JSON.stringify(ujsTenantId)};
    // Forward apollo client headers so Upwork's GQL gateway recognises the OAuth2 client
    // and grants the field-level permissions it needs (prevents ExecutionAborted errors).
    if (${JSON.stringify(apolloClientName)})    headers['apollographql-client-name']    = ${JSON.stringify(apolloClientName)};
    if (${JSON.stringify(apolloClientVersion)}) headers['apollographql-client-version'] = ${JSON.stringify(apolloClientVersion)};
    if (${JSON.stringify(odeskUserAgent)})      headers['x-odesk-user-agent']           = ${JSON.stringify(odeskUserAgent)};
    if (${JSON.stringify(requestedWith)})       headers['x-requested-with']             = ${JSON.stringify(requestedWith)};
    const r = await fetch(${JSON.stringify(replayUrl)}, {
      method: 'POST', credentials: 'include', headers,
      body: ${JSON.stringify(replayBodyStr)}
    });
    const txt = await r.text();
    if (!r.ok) return JSON.stringify({ _status: r.status, _body: txt.slice(0,500) });
    return txt;
  } catch(e) { return JSON.stringify({ _error: e.message }); }
})()`;

      let text = '';
      try {
        const res = await chrome.debugger.sendCommand(
          { tabId: tab.id }, 'Runtime.evaluate',
          { expression: replayExpr, awaitPromise: true, returnByValue: true }
        );
        text = res.result?.value || '';
      } catch(error) {
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'replay_page_error',
            pageNum,
            pageSize,
            error: error.message,
            ts: new Date().toISOString()
          })
        }).catch(() => {});
      }
      const isUJS = isUserJobSearchRequest(replayCandidate);
      const replayStats = isUJS
        ? addCiphersFromUserJobSearchText(text, 'replay')
        : { added: addCiphersFromText(text), returnedCount: 0, totalAvailable: 0 };
      fetch(EXT_CONFIG.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _debug: true,
          event: 'replay_page_done',
          pageNum,
          pageSize,
          alias: replayAlias,
          isUserJobSearch: isUJS,
          added: replayStats.added,
          returnedCount: replayStats.returnedCount,
          totalAvailable: replayStats.totalAvailable,
          totalCiphers: cipherSet.size,
          responseLen: (text || '').length,
          responsePreview: (text || '').slice(0, 4000),
          ts: new Date().toISOString()
        })
      }).catch(() => {});
      return replayStats;
    };

    const waitForUserJobSearchResponse = async (timeoutMs) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (searchJobMap.size > 0 || sawUserJobSearchResponse) return true;
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getNavigationHistory', {}).catch(() => {});
      }
      return searchJobMap.size > 0 || sawUserJobSearchResponse;
    };

    const cleanup = () => {
      if (detached) return;
      detached = true;
      chrome.debugger.onEvent.removeListener(searchListener);
      if (tab) chrome.debugger.detach({ tabId: tab.id }, () => chrome.tabs.remove(tab.id, () => {}));
    };

    const searchListener = async (source, method, params) => {
      if (!tab || source.tabId !== tab.id) return;

      // Track GQL requests from requestWillBeSent (URL always present here, unlike responseReceived)
      if (method === 'Network.requestWillBeSent' && params.request?.url?.includes('/api/graphql/v1')) {
        let requestBody = null;
        if (params.request.postData) {
          try { requestBody = JSON.parse(params.request.postData); } catch(_) {}
        }
        const reqMeta = {
          url: params.request.url,
          headers: params.request.headers || {},
          requestBody
        };
        pendingGqlRequests.set(params.requestId, reqMeta);

        if (reqMeta.requestBody && isUserJobSearchRequest(reqMeta)) {
          sawUserJobSearchRequest = true;
          const currentIsUserJobSearch = isUserJobSearchRequest(replayCandidate || {});
          if (!currentIsUserJobSearch) {
            replayCandidate = {
              url: reqMeta.url,
              headers: reqMeta.headers,
              requestBody: reqMeta.requestBody,
              cipherHits: replayCandidate?.cipherHits || 0
            };
          }
        }

        const rh = params.request.headers || {};
        const auth = rh['Authorization'] || rh['authorization'] || '';
        if (!liveGraphqlHeaders && auth.toLowerCase().startsWith('bearer ') && auth.length > 20) {
          liveGraphqlHeaders = {
            authorization: auth,
            xsrf: rh['X-XSRF-TOKEN'] || rh['x-xsrf-token'] || '',
            tenantId: rh['X-Upwork-API-TenantId'] || rh['x-upwork-api-tenantid'] || ''
          };
          console.log('[upwork-ext] search: captured live GraphQL auth headers from search tab');
        }

        // Legacy capture kept for debug only.
        if (params.request.url.includes('smf.retrieve.top') &&
            params.request?.postData && !capturedPostBody) {
          try { capturedPostBody = JSON.parse(params.request.postData); } catch(_) {}
          console.log('[upwork-ext] search: captured smf.retrieve.top POST body');
        }
      }

      if (method === 'Network.loadingFinished' && pendingGqlRequests.has(params.requestId)) {
        const reqMeta = pendingGqlRequests.get(params.requestId);
        pendingGqlRequests.delete(params.requestId);
        try {
          const body = await chrome.debugger.sendCommand(
            { tabId: tab.id }, 'Network.getResponseBody', { requestId: params.requestId }
          );
          if (body?.body) {
            const text = body.base64Encoded
              ? new TextDecoder().decode(Uint8Array.from(atob(body.body), c => c.charCodeAt(0)))
              : body.body;
            collectedResponses.push({ text, reqMeta });
            const cipherHits = countCipherHits(text);
            if (reqMeta?.requestBody && isUserJobSearchRequest(reqMeta)) {
              sawUserJobSearchResponse = true;
              addCiphersFromUserJobSearchText(text, 'captured-response');
              replayCandidate = {
                url: reqMeta.url,
                headers: reqMeta.headers,
                requestBody: reqMeta.requestBody,
                cipherHits: Math.max(replayCandidate?.cipherHits || 0, cipherHits)
              };
            }
            if (cipherHits > 0 && reqMeta?.requestBody) {
              const reqIsUserJobSearch = isUserJobSearchRequest(reqMeta);
              const currentIsUserJobSearch = isUserJobSearchRequest(replayCandidate || {});
              const currentHits = replayCandidate?.cipherHits || 0;
              if ((reqIsUserJobSearch && !currentIsUserJobSearch) ||
                  (reqIsUserJobSearch === currentIsUserJobSearch && cipherHits > currentHits)) {
                replayCandidate = {
                  url: reqMeta.url,
                  headers: reqMeta.headers,
                  requestBody: reqMeta.requestBody,
                  cipherHits
                };
              }
            }
            console.log(`[upwork-ext] search: passive GQL body captured, len=${text.length}`);
          }
        } catch(_) {}
      }
    };

    try {
      // active: true — prevents Chrome background-tab JS throttling that kills Vue hydration
      tab = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: true }, r));
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _debug: true, event: 'scan_tab_opened', tabId: tab.id, ts: new Date().toISOString() })
      });

      await new Promise((res, rej) =>
        chrome.debugger.attach({ tabId: tab.id }, '1.3', () =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
        )
      );
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _debug: true, event: 'scan_tab_cdp_attached', tabId: tab.id, ts: new Date().toISOString() })
      });

      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable', {});
      try {
        // Suppress webdriver flag so Upwork doesn't bot-detect us
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.addScriptToEvaluateOnNewDocument',
          { source: `Object.defineProperty(navigator,'webdriver',{get:()=>undefined});` });
      } catch(_) {}
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {
        maxResourceBufferSize: 50 * 1024 * 1024, maxTotalBufferSize: 200 * 1024 * 1024
      });
      chrome.debugger.onEvent.addListener(searchListener);

      // cdpWait: keep the MV3 SW alive after page load without depending on a
      // stable JS execution context inside the tab. Runtime.evaluate can hang on
      // Upwork's SPA after load; Page.getNavigationHistory does not.
      const cdpWait = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getNavigationHistory', {}).catch(() => {});
        }
      };

      // waitForPageLoad: resolves once either CDP loadEventFired OR the normal
      // tabs.onUpdated complete event fires for this tab. Some later search pages
      // can hang on Page.navigate in MV3 even though the tab-level navigation works.
      const waitForPageLoad = (pageNum) => new Promise((resolve) => {
        let done = false;
        const finish = (reason) => {
          if (done) return;
          done = true;
          chrome.debugger.onEvent.removeListener(onEvt);
          chrome.tabs.onUpdated.removeListener(onTabUpdated);
          fetch(EXT_CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _debug: true, event: 'page_loaded', reason, pageNum, ts: new Date().toISOString() })
          }).catch(() => {});
          resolve(reason);
        };
        const onEvt = (src, method) => {
          if (src.tabId === tab.id && method === 'Page.loadEventFired') finish('load');
        };
        const onTabUpdated = (updatedTabId, info) => {
          if (updatedTabId === tab.id && info.status === 'complete') finish('tab_complete');
        };
        chrome.debugger.onEvent.addListener(onEvt);
        chrome.tabs.onUpdated.addListener(onTabUpdated);
        // Safety fallback: 20s timeout using the non-JS CDP loop so no bare setTimeout gap.
        (async () => {
          const end = Date.now() + 20000;
          while (Date.now() < end && !done) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getNavigationHistory', {}).catch(() => {});
          }
          finish('timeout_20s');
        })();
      });

      const navigateAndScan = async (url, pageNum) => {
        const prevCount = cipherSet.size;
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _debug: true, event: 'nav_start', pageNum, url, ciphersBefore: prevCount, ts: new Date().toISOString() })
        }).catch(() => {});
        try {
          await new Promise((res, rej) =>
            chrome.tabs.update(tab.id, { url }, (updatedTab) => {
              if (chrome.runtime.lastError) {
                rej(new Error(chrome.runtime.lastError.message));
                return;
              }
              res(updatedTab);
            })
          );
        } catch(navErr) {
          fetch(EXT_CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _debug: true, event: 'nav_error', pageNum, url, error: navErr.message, ts: new Date().toISOString() })
          }).catch(() => {});
        }
        // Phase 1: wait for Page.loadEventFired.
        // CDP events during load (Network.*, etc.) fire through chrome.debugger.onEvent
        // and each event resets the SW idle timer — the page load itself is the keepalive.
        const loadReason = await waitForPageLoad(pageNum);
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _debug: true, event: 'nav_postload_wait', pageNum, loadReason, ts: new Date().toISOString() })
        }).catch(() => {});
        // Phase 2: Vue hydration finishes after load.
        await cdpWait(3000);

        // Phase 3: DOM scan — extract ciphers directly from the SSR HTML.
        // Upwork embeds ~02... ciphertexts in the server-rendered page source.
        try {
          const htmlResult = await chrome.debugger.sendCommand(
            { tabId: tab.id }, 'Runtime.evaluate',
            { expression: `document.documentElement.outerHTML`, returnByValue: true }
          );
          if (htmlResult?.result?.value) {
            const domAdded = addCiphersFromText(htmlResult.result.value);
            console.log(`[upwork-ext] search: DOM scan page ${pageNum} → +${domAdded} ciphers`);
          }
        } catch(_) {}

        if (pageNum === 1 && sawUserJobSearchRequest && searchJobMap.size === 0) {
          fetch(EXT_CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _debug: true, event: 'nav_waiting_for_ujs_response', pageNum, ts: new Date().toISOString() })
          }).catch(() => {});
          await waitForUserJobSearchResponse(8000);
        }
        let usedApiBodies = 0;
        for (const entry of collectedResponses.splice(0)) {
          if (isUserJobSearchRequest(entry.reqMeta)) {
            usedApiBodies += 1;
            addCiphersFromUserJobSearchText(entry.text, 'queued-response');
          }
        }
        let added = cipherSet.size - prevCount;
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'nav_done',
            pageNum, url, added, usedApiBodies,
            totalCiphers: cipherSet.size,
            loadReason,
            sawRequest: sawUserJobSearchRequest,
            sawResponse: sawUserJobSearchResponse,
            hasReplayCandidate: !!replayCandidate?.requestBody,
            hasLiveAuth: !!(liveGraphqlHeaders?.authorization),
            collectedResponsesLen: collectedResponses.length,
            ts: new Date().toISOString()
          })
        }).catch(() => {});
        return added;
      };

      // ── Page 1 ──
      const added1 = await navigateAndScan(searchUrl, 1);
      console.log(`[upwork-ext] search: page 1 → +${added1} ciphers, total ${cipherSet.size}`);

      // ── Page-2 click trigger ──
      // Upwork search page 1 is fully SSR — no userJobSearch GQL fires on initial load.
      // Once the SPA hydrates, clicking "Next Page" triggers a real client-side navigation
      // that fires userJobSearch with the user's actual auth token, which CDP intercepts.
      // We use those real headers as replayCandidate for all subsequent page replays.
      if (!isUserJobSearchRequest(replayCandidate || {})) {
        sawUserJobSearchRequest = false;
        sawUserJobSearchResponse = false;
        let page2ClickedSel = null;
        try {
          const clickRes = await chrome.debugger.sendCommand(
            { tabId: tab.id }, 'Runtime.evaluate',
            {
              expression: `(() => {
                const selectors = [
                  '[data-test="pagination-next"] a',
                  '[data-test="pagination-next"]',
                  'button[aria-label="Next page"]',
                  'a[aria-label="Next page"]',
                  '[data-ev-label="pagination_next"]',
                  '.air3-pagination a[href*="page=2"]',
                  'nav[aria-label*="agination"] a:last-child',
                  '[data-cy="pagination-btn-next"]'
                ];
                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && !el.hasAttribute('disabled') && !el.classList.contains('disabled')) {
                    el.click();
                    return sel;
                  }
                }
                return null;
              })()`,
              returnByValue: true
            }
          );
          page2ClickedSel = clickRes?.result?.value || null;
        } catch(_) {}

        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true, event: 'page2_click_attempt',
            clicked: !!page2ClickedSel, selector: page2ClickedSel,
            hadRealUJS: isUserJobSearchRequest(replayCandidate || {}),
            ts: new Date().toISOString()
          })
        }).catch(() => {});

        if (page2ClickedSel) {
          // Give the SPA time to start the GQL request, then wait for completion.
          // This is a client-side SPA navigation so Page.loadEventFired may not fire.
          await cdpWait(1000);
          await waitForUserJobSearchResponse(10000);
          // DOM scan on page 2 for extra ciphers from SSR fragment (if any)
          try {
            const htmlResult = await chrome.debugger.sendCommand(
              { tabId: tab.id }, 'Runtime.evaluate',
              { expression: `document.documentElement.outerHTML`, returnByValue: true }
            );
            if (htmlResult?.result?.value) {
              const domAdded2 = addCiphersFromText(htmlResult.result.value);
              console.log(`[upwork-ext] search: page 2 DOM scan → +${domAdded2} ciphers`);
            }
          } catch(_) {}
          // Drain any queued responses from the page 2 GQL call
          for (const entry of collectedResponses.splice(0)) {
            if (isUserJobSearchRequest(entry.reqMeta)) {
              addCiphersFromUserJobSearchText(entry.text, 'page2-queued-response');
            }
          }
          fetch(EXT_CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              _debug: true, event: 'page2_nav_done',
              sawRequest: sawUserJobSearchRequest,
              sawResponse: sawUserJobSearchResponse,
              hasRealUJS: isUserJobSearchRequest(replayCandidate || {}),
              hasReplayCandidate: !!replayCandidate?.requestBody,
              totalCiphers: cipherSet.size,
              ts: new Date().toISOString()
            })
          }).catch(() => {});
        }
      }

      if (!replayCandidate?.requestBody) {
        // Always build a fallback — uses the minimal query with only id+paging (no restricted fields).
        // Auth (ujsToken + ujsTenantId) is read fresh from cookies in replaySearchPage.
        replayCandidate = {
          url: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearch',
          headers: {},
          requestBody: {
            query: USER_JOB_SEARCH_FALLBACK_QUERY,
            variables: {
              requestVariables: {
                userQuery: rawQuery,
                sort: 'recency+desc',
                highlight: false,
                paging: { offset: 0, count: 10 }
              }
            }
          },
          cipherHits: 0
        };
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'fallback_candidate_set',
            rawQuery,
            ciphersFromDom: cipherSet.size,
            ts: new Date().toISOString()
          })
        }).catch(() => {});
      }

      if (replayCandidate?.requestBody) {
        postSearchEvent({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'scan_replay_selected',
            url: replayCandidate.url,
            alias: getAliasFromUrl(replayCandidate.url),
            cipherHits: replayCandidate.cipherHits,
            hasAuthorization: !!(replayCandidate.headers?.Authorization || replayCandidate.headers?.authorization || liveGraphqlHeaders?.authorization),
            ts: new Date().toISOString()
          })
        });
      }

      // ── Direct replay path: use one captured userJobSearch request with larger counts ──
      let usedDirectReplay = false;
      if (replayCandidate?.requestBody && isUserJobSearchRequest(replayCandidate)) {
        usedDirectReplay = true;
        const batchSize = Math.min(Math.max(maxJobs, 10), 100);
        const firstReplay = await replaySearchPage(1, batchSize);
        const totalAvailable = Number(firstReplay?.totalAvailable || 0);
        const replayPages = Math.max(1, Math.ceil(Math.min(maxJobs, totalAvailable || maxJobs) / batchSize));
        console.log(`[upwork-ext] search: replay batch 1 → +${firstReplay?.added || 0} ciphers, total ${cipherSet.size}`);
        for (let page = 2; page <= replayPages && cipherSet.size < maxJobs; page++) {
          const replayStats = await replaySearchPage(page, batchSize);
          console.log(`[upwork-ext] search: replay batch ${page} → +${replayStats?.added || 0} ciphers, total ${cipherSet.size}`);
          if (!replayStats || replayStats.returnedCount === 0 || replayStats.added === 0) break;
        }
      }

      if (!usedDirectReplay) {
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _debug: true,
            event: 'replay_skipped',
            reason: replayCandidate?.requestBody ? 'replayCandidate not userJobSearch' : 'no replayCandidate captured',
            hasReplayCandidate: !!replayCandidate?.requestBody,
            isUserJobSearch: isUserJobSearchRequest(replayCandidate || {}),
            sawRequest: sawUserJobSearchRequest,
            sawResponse: sawUserJobSearchResponse,
            hasLiveAuth: !!(liveGraphqlHeaders?.authorization),
            totalCiphers: cipherSet.size,
            ts: new Date().toISOString()
          })
        }).catch(() => {});
      }

      chrome.debugger.onEvent.removeListener(searchListener);
    } catch(e) {
      console.warn('[upwork-ext] search: page navigation approach error:', e.message);
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _debug: true, event: 'scan_approach_b_error', error: e.message, tabId: tab?.id ?? null, ciphersSoFar: cipherSet.size, ts: new Date().toISOString() })
      });
      // On error: keep the tab alive if we have one — hand it off to lookup anyway
      if (!detached && tab) {
        detached = true;
        chrome.debugger.onEvent.removeListener(searchListener);
        searchTab = tab; // still hand off — tab is on Upwork, CDP attached
      }
    } finally {
      // Ensure searchTab is always set if tab exists (even after catch)
      if (tab && !searchTab) {
        searchTab = tab;
      }
      postSearchEvent({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _debug: true, event: 'scan_approach_b_finally', searchTabSet: !!searchTab, searchTabId: searchTab?.id ?? null, ciphersCollected: cipherSet.size, ts: new Date().toISOString() })
      });
    }
  }

  // ── Debug: send collected ciphers to webhook before starting lookup ─────────
  const ciphers = [...cipherSet].slice(0, maxJobs);
  const collectedJobs = ciphers.map((cipher) => searchJobMap.get(cipher) || { id: null, cipher, title: '' });
  console.log(`[upwork-ext] search: total ciphers collected: ${ciphers.length}`);
  fetch(EXT_CONFIG.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _debug: true,
      event: 'search_ids_collected',
      query: searchQuery,
      searchUrl,
      totalFound: ciphers.length,
      ids: collectedJobs.map((job) => job.id).filter(Boolean),
      jobs: collectedJobs,
      ts: new Date().toISOString()
    })
  }).catch(() => {});
  if (!ciphers.length && lastUserJobSearchDebug) {
    fetch(EXT_CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _debug: true,
        event: 'search_api_response_debug',
        query: searchQuery,
        searchUrl,
        source: lastUserJobSearchDebug.source,
        returnedCount: lastUserJobSearchDebug.returnedCount,
        totalAvailable: lastUserJobSearchDebug.totalAvailable,
        idsSample: lastUserJobSearchDebug.ids,
        errors: lastUserJobSearchDebug.errors,
        status: lastUserJobSearchDebug.status,
        responsePreview: lastUserJobSearchDebug.preview,
        ts: new Date().toISOString()
      })
    }).catch(() => {});
  }
  postSearchEvent({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _debug: true,
      event: 'search_ciphers_collected',
      query: searchQuery,
      searchUrl,
      totalFound: ciphers.length,
      ciphers,
      ts: new Date().toISOString()
    })
  });

  if (!ciphers.length) {
    console.warn('[upwork-ext] runSearchLookup: no ciphertexts found');
    setSearchProgress({ active: false, query: searchQuery, phase: 'done', found: 0, processed: 0, total: 0, error: 'No jobs found' });
    return;
  }

  console.log(`[upwork-ext] runSearchLookup: found ${ciphers.length} ciphers, processing...`);
  setSearchProgress({ active: true, query: searchQuery, phase: 'lookup', found: ciphers.length, processed: 0, total: ciphers.length });

  // Load tokens harvested by CDP — HttpOnly cookies are not accessible via document.cookie
  // but are captured here from raw request headers by the network event listener.
  // Refresh from storage (tokens may have been updated during the search navigation above).
  const tkRefresh = await new Promise(r => chrome.storage.local.get(['sessionTokens'], r));
  const tkLatest = tkRefresh.sessionTokens || {};
  let storedBearer   = tkLatest['oauth2_global_js_token'] || tkLatest['master_access_token'] || tkLatest['_bearer'] || '';
  let storedTenantId = tkLatest['current_organization_uid'] || tkLatest['_tenantId'] || '';
  let storedXsrf     = tkLatest['XSRF-TOKEN'] || '';

  // ── Fallback: pull tokens directly from the live search tab context ─────────
  // If the global CDP listener hasn't yet persisted cookies to sessionTokens,
  // extract them via Runtime.evaluate from the tab currently on www.upwork.com.
  if ((!storedBearer || !storedXsrf) && searchTab) {
    try {
      const cookieEval = await chrome.debugger.sendCommand(
        { tabId: searchTab.id }, 'Runtime.evaluate',
        {
          expression: `(function(){
  var c = {};
  document.cookie.split(';').forEach(function(p) {
    var kv = p.trim().split('=');
    if (kv.length >= 2) c[kv[0].trim()] = decodeURIComponent(kv.slice(1).join('='));
  });
  return JSON.stringify({
    bearer:   c['oauth2_global_js_token'] || c['master_access_token'] || '',
    tenantId: c['current_organization_uid'] || '',
    xsrf:     c['XSRF-TOKEN'] || ''
  });
})()`,
          returnByValue: true
        }
      );
      const tabCookies = JSON.parse(cookieEval?.result?.value || '{}');
      if (tabCookies.bearer)   storedBearer   = storedBearer   || tabCookies.bearer;
      if (tabCookies.tenantId) storedTenantId = storedTenantId || tabCookies.tenantId;
      if (tabCookies.xsrf)     storedXsrf     = storedXsrf     || tabCookies.xsrf;
      console.log('[upwork-ext] lookup: extracted cookies from search tab, bearer present:', !!tabCookies.bearer);
    } catch(e) {
      console.warn('[upwork-ext] lookup: could not extract cookies from search tab:', e.message);
    }
  }

  // ── Debug: report token availability before attempting lookup ───────────────
  fetch(EXT_CONFIG.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _debug: true,
      event: 'lookup_token_check',
      hasBearer:   !!storedBearer,
      hasTenantId: !!storedTenantId,
      hasXsrf:     !!storedXsrf,
      bearerPrefix: storedBearer ? storedBearer.slice(0, 12) + '…' : null,
      searchTabId:  searchTab ? searchTab.id : null,
      proxyTabIdWillBe: searchTab ? searchTab.id : 'none—fallback',
      ts: new Date().toISOString()
    })
  }).catch(() => {});

  if (!storedBearer) {
    console.warn('[upwork-ext] runSearchLookup: no bearer token — will rely on cookie-based auth from search tab.');
    // Do NOT abort: fetchJobInTab uses credentials:include so Upwork session cookies
    // will authenticate the request even without an explicit Authorization header.
  }

  // Reuse the search tab for lookups — it's already on www.upwork.com with
  // CDP attached and all session cookies in place.
  // If Approach A was used (no search tab opened), fall back to finding any open Upwork tab.
  let proxyTabId = searchTab ? searchTab.id : null;
  let proxyDidAttach = false;
  let proxyDidOpen = false;

  try {
    if (!proxyTabId) {
      // No search tab — find an existing Upwork tab or open a new one
      const upworkTabs = await new Promise(r =>
        chrome.tabs.query({ url: '*://www.upwork.com/*', status: 'complete' }, r)
      );
      if (upworkTabs.length > 0) {
        proxyTabId = upworkTabs[0].id;
        console.log('[upwork-ext] lookup: borrowing existing Upwork tab', proxyTabId);
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _debug: true, event: 'lookup_borrowed_tab', proxyTabId, ts: new Date().toISOString() })
        }).catch(() => {});
      } else {
        const newTab = await new Promise(r => chrome.tabs.create({ url: 'https://www.upwork.com/', active: false }, r));
        proxyTabId = newTab.id;
        proxyDidOpen = true;
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _debug: true, event: 'lookup_new_tab_opened', proxyTabId, ts: new Date().toISOString() })
        }).catch(() => {});
        await new Promise(res => {
          const onU = (tid, info) => { if (tid === proxyTabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onU); res(); } };
          chrome.tabs.onUpdated.addListener(onU);
          setTimeout(res, 15000);
        });
        console.log('[upwork-ext] lookup: opened new Upwork tab', proxyTabId);
      }
      // Attach CDP to the non-search tab
      if (!attachedTabs.has(proxyTabId)) {
        await new Promise((res, rej) =>
          chrome.debugger.attach({ tabId: proxyTabId }, '1.3', () =>
            chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()
          )
        );
        attachedTabs.add(proxyTabId);
        proxyDidAttach = true;
        try {
          await chrome.debugger.sendCommand({ tabId: proxyTabId }, 'Runtime.enable', {});
        } catch (e) {
          console.warn('[upwork-ext] lookup: Runtime.enable failed for fallback tab:', e.message);
        }
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _debug: true, event: 'lookup_fallback_tab_cdp_attached', proxyTabId, ts: new Date().toISOString() })
        }).catch(() => {});
      }
    }
    console.log('[upwork-ext] lookup: using tab', proxyTabId, 'for', ciphers.length, 'jobs');

    // ── Debug: confirm we reached the lookup phase with a working tab ─────────
    fetch(EXT_CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _debug: true,
        event: 'lookup_tab_ready',
        proxyTabId,
        reusedSearchTab: searchTab ? searchTab.id === proxyTabId : false,
        cipherCount: ciphers.length,
        firstCipher: ciphers[0] || null,
        ts: new Date().toISOString()
      })
    }).catch(() => {});

    // Inner fetch helper — runs both GQL queries in parallel inside the tab
    const fetchJobInTab = async (cipher) => {
      // openingId = cipher stripped of the ~02 prefix (Upwork's numeric opening ID)
      const openingId = jobCipherToOpeningId(cipher);

      const authBody = JSON.stringify({
        query: JOB_AUTH_DETAILS_QUERY,
        variables: { id: cipher, isFreelancerOrAgency: true, isLoggedIn: true }
      });
      const clientBody = JSON.stringify({
        query: CLIENT_INFO_BY_OPENING_QUERY,
        variables: { openingId }
      });

      // Read cookies via CDP (same pattern as replaySearchPage) so we can pick the
      // right auth token for job-detail GQL queries without relying on
      // liveGraphqlHeaders.authorization, which is the search-microapp ujsToken
      // (UniversalSearchNuxt_vt) — too restricted for gql-query-get-auth-job-details.
      let jobToken = '';
      let jobXsrf = '';
      let jobTenant = '';
      let vtCookieNames = [];
      try {
        const cookieResult = await chrome.debugger.sendCommand(
          { tabId: proxyTabId }, 'Network.getCookies', { urls: ['https://www.upwork.com'] }
        );
        const cookies = cookieResult?.cookies || [];

        // XSRF
        const xsrfCookie = cookies.find(c => c.name === 'XSRF-TOKEN');
        if (xsrfCookie?.value) jobXsrf = decodeURIComponent(xsrfCookie.value);

        // Tenant
        const orgCookie = cookies.find(c => c.name === 'current_organization_uid');
        if (orgCookie?.value) jobTenant = orgCookie.value;

        // Collect all _vt cookie names for debugging
        vtCookieNames = cookies.filter(c => c.name.endsWith('_vt')).map(c => c.name);

        // Try known job-page microapp tokens first
        const JOB_VT_NAMES = ['FxJobPosting_vt', 'JobDetailsNuxt_vt', 'jobs_vt', 'job_vt', 'FxJobDetails_vt'];
        for (const name of JOB_VT_NAMES) {
          const c = cookies.find(c => c.name === name);
          if (c?.value) { jobToken = 'bearer ' + c.value; break; }
        }
        // Fallback: any _vt except the search microapp token
        if (!jobToken) {
          const fallbackVt = cookies.find(c =>
            c.name !== 'UniversalSearchNuxt_vt' && c.name.endsWith('_vt') && c.value
          );
          if (fallbackVt?.value) jobToken = 'bearer ' + fallbackVt.value;
        }
      } catch (e) {
        console.warn('[upwork-ext] fetchJobInTab getCookies failed:', e.message);
      }

      // Debug: log which cookies/token we found (first time per lookup run)
      fetch(EXT_CONFIG.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _debug: true,
          event: 'lookup_job_auth',
          cipher,
          hasXsrf: !!jobXsrf,
          hasTenant: !!jobTenant,
          hasJobToken: !!jobToken,
          jobTokenPrefix: jobToken ? jobToken.slice(0, 18) + '…' : null,
          vtCookieNames,
          ts: new Date().toISOString()
        })
      }).catch(() => {});

      // Prefer CDP-read XSRF; fall back to liveGraphqlHeaders.xsrf (captured from search page)
      const xsrfToUse = jobXsrf || liveGraphqlHeaders?.xsrf || '';

      // _vt microapp tokens (FxJobPosting_vt, JobDetailsNuxt_vt, etc.) are per-user-per-microapp
      // and are NOT associated with any tenant/organisation. Sending X-Upwork-API-TenantId
      // alongside them causes a 403 "tenant not found in users tenants". Only send the tenant
      // header when we have no explicit token and rely on cookie-based auth, where the server
      // determines org context from the session cookies directly.
      const sendTenantHeader = !jobToken && !!jobTenant;

      const expr = `(async () => {
  try {
    var hdrs = { 'Content-Type': 'application/json', 'X-Upwork-Accept-Language': 'en-US' };
    if (${JSON.stringify(xsrfToUse)}) hdrs['X-XSRF-TOKEN'] = ${JSON.stringify(xsrfToUse)};
    if (${JSON.stringify(jobToken)}) hdrs['Authorization'] = ${JSON.stringify(jobToken)};
    if (${JSON.stringify(sendTenantHeader)}) hdrs['X-Upwork-API-TenantId'] = ${JSON.stringify(jobTenant)};
    var [r1, r2] = await Promise.all([
      fetch('https://www.upwork.com/api/graphql/v1?alias=gql-query-get-auth-job-details', {
        method: 'POST', credentials: 'include', headers: hdrs, body: ${JSON.stringify(authBody)}
      }),
      fetch('https://www.upwork.com/api/graphql/v1?alias=gql-query-clientinfobyopening', {
        method: 'POST', credentials: 'include', headers: hdrs, body: ${JSON.stringify(clientBody)}
      })
    ]);
    var [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    var d3 = null; var status3 = null;
    var _companyId = (d1 && d1.data && d1.data.jobAuthDetails && d1.data.jobAuthDetails.buyer && d1.data.jobAuthDetails.buyer.info && d1.data.jobAuthDetails.buyer.info.company && d1.data.jobAuthDetails.buyer.info.company.companyId) || null;
    if (_companyId) {
      var hdrs3 = Object.assign({}, hdrs);
      if (${JSON.stringify(jobTenant)}) hdrs3['X-Upwork-API-TenantId'] = ${JSON.stringify(jobTenant)};
      var r3 = await fetch('https://www.upwork.com/api/graphql/v1?alias=gql-query-clientcompanymetadata', {
        method: 'POST', credentials: 'include', headers: hdrs3,
        body: JSON.stringify({ query: 'query($uid: ID!) { clientCompanyMetadata(id: $uid) { rid uid name } }', variables: { uid: _companyId } })
      });
      try { d3 = await r3.json(); } catch(_) { d3 = null; }
      status3 = r3.status;
    }
    return JSON.stringify({ status1: r1.status, status2: r2.status, status3: status3, data1: d1, data2: d2, data3: d3 });
  } catch(e) { return JSON.stringify({ error: e.message }); }
})()`;
      const evalRes = await chrome.debugger.sendCommand(
        { tabId: proxyTabId }, 'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true, timeout: 20000 }
      );
      const out = evalRes?.result?.value ? JSON.parse(evalRes.result.value) : null;
      return {
        raw: out,
        data: out?.data1?.data?.jobAuthDetails || null,
        clientInfo: out?.data2?.data?.clientInfoByOpening || null,
        companyMetadata: out?.data3?.data?.clientCompanyMetadata || null
      };
    };

    // Per-company agency profile cache — avoids opening new tabs multiple times
    // for the same company when multiple jobs come from the same client.
    const agencyProfileCache = new Map(); // companyId -> profiles[]

    for (let i = 0; i < ciphers.length; i++) {
      const cipher = ciphers[i];
      console.log(`[upwork-ext] runSearchLookup: processing ${i + 1}/${ciphers.length} — ${cipher}`);
      try {
        const fetchResult = await Promise.race([
          fetchJobInTab(cipher),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000))
        ]).catch(e => { console.warn('[upwork-ext] fetchJobInTab race:', e.message); return null; });

        // Debug webhook for EVERY cipher
        {
          const raw = fetchResult?.raw ?? null;
          const d1Keys = raw?.data1 ? Object.keys(raw.data1) : null;
          const d2Keys = raw?.data2 ? Object.keys(raw.data2) : null;
          // Include raw response previews when data is missing so we can debug the structure
          const preview1 = (!fetchResult?.data && raw?.data1)
            ? JSON.stringify(raw.data1).slice(0, 800) : null;
          const preview2 = (!fetchResult?.clientInfo && raw?.data2)
            ? JSON.stringify(raw.data2).slice(0, 800) : null;
          fetch(EXT_CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              _debug: true,
              event: 'lookup_fetch_result',
              cipher,
              index: i,
              gotResult: !!fetchResult,
              httpStatus1: raw?.status1 ?? null,
              httpStatus2: raw?.status2 ?? null,
              hasAuthData: !!fetchResult?.data,
              hasClientInfo: !!fetchResult?.clientInfo,
              rawError: raw?.error ?? null,
              data1Keys: d1Keys,
              data2Keys: d2Keys,
              data1Preview: preview1,
              data2Preview: preview2,
              ts: new Date().toISOString()
            })
          }).catch(() => {});
        }

        const jobDetails = fetchResult?.data ?? null;
        const clientInfo = fetchResult?.clientInfo ?? null;

        if (!jobDetails) {
          console.warn('[upwork-ext] search: no data for cipher', cipher,
            'status1:', fetchResult?.raw?.status1, 'status2:', fetchResult?.raw?.status2, 'error:', fetchResult?.raw?.error);
        } else {
          const opening   = jobDetails.opening  || {};
          const buyer     = jobDetails.buyer    || {};
          const jobInfo   = opening.job?.info   || {};
          const buyerInfo = buyer.info          || {};
          const company   = buyerInfo.company   || {};
          const stats     = buyerInfo.stats     || {};
          const location  = buyerInfo.location  || {};

          // clientInfoByOpening supplements — richer data for active jobs
          const ciBuyer    = clientInfo?.buyer    || {};
          const ciActivity = clientInfo?.activity || {};
          const ciBuyerInfo = ciBuyer.info       || {};
          const ciCompany  = ciBuyerInfo.company  || {};
          const ciStats    = ciBuyerInfo.stats    || {};
          const ciLocation = ciBuyerInfo.location || {};

          const webhookPayload = {
            source: 'search',
            query: searchQuery,
            jobCiphertext: cipher,
            jobTitle:        jobInfo.title   || opening.job?.title || 'Unknown',
            jobType:         jobInfo.type    || null,
            jobCategory:     opening.job?.category?.name || null,
            description:     opening.description || null,
            budget:          opening.budget  || null,
            hourlyBudget:    opening.extendedBudgetInfo || null,
            postedOn:        opening.postedOn || null,
            skills:          (opening.segmentationData || []).filter(s => s.type === 'SKILL').map(s => s.label || s.value),
            companyId:       ciCompany.id    || company.companyId   || null,
            companyName:     ciCompany.name  || company.name        || null,
            industry:        ciCompany.profile?.industry || company.profile?.industry || null,
            companySize:     ciCompany.profile?.size     || company.profile?.size     || null,
            companyContractDate: ciCompany.contractDate  || company.contractDate      || null,
            companyL3Occupations: ciCompany.profile?.l3Occupations || null,
            clientCountry:   ciLocation.country  || location.country    || null,
            clientCity:      ciLocation.city     || location.city       || null,
            clientState:     ciLocation.state    || null,
            clientWorldRegion: ciLocation.worldRegion || null,
            clientScore:     ciStats.score       || stats.score         || null,
            totalJobsPosted: ciStats.totalAssignments || stats.totalAssignments || null,
            totalHired:      ciStats.totalJobsWithHires  || stats.totalJobsWithHires  || null,
            totalSpent:      ciStats.totalCharges?.amount || stats.totalCharges?.amount || null,
            totalHoursWorked: ciStats.hoursCount || stats.hoursCount || null,
            feedbackCount:   ciStats.feedbackCount || stats.feedbackCount || null,
            activeContracts: ciStats.activeAssignmentsCount || stats.activeAssignmentsCount || null,
            avgHourlyRate:   ciBuyerInfo.avgHourlyJobsRate?.amount || buyerInfo.avgHourlyJobsRate?.amount || null,
            clientLogo:      ciBuyerInfo.logo || null,
            cssTier:         ciBuyer.cssTier || null,
            paymentVerified: ciBuyer.isPaymentMethodVerified ?? buyer.isPaymentMethodVerified ?? null,
            enterprise:      ciBuyer.isEnterprise ?? buyer.enterprise ?? null,
            // Activity from clientInfoByOpening (more detailed than clientActivity)
            totalApplicants:        ciActivity.totalApplicants ?? opening.clientActivity?.totalApplicants ?? null,
            totalInvitedToInterview: ciActivity.totalInvitedToInterview ?? opening.clientActivity?.totalInvitedToInterview ?? null,
            totalHiredForOpening:   ciActivity.totalHired ?? opening.clientActivity?.totalHired ?? null,
            numberOfPositions:      ciActivity.numberOfPositionsToHire ?? opening.clientActivity?.numberOfPositionsToHire ?? null,
            lastBuyerActivity:      ciActivity.lastBuyerActivity ?? opening.clientActivity?.lastBuyerActivity ?? null,
            jobStatus:       clientInfo?.jobInfo?.status || null,
            hiredApplicants: jobDetails.hiredApplicantNames || [],
            companyMetadata: fetchResult?.companyMetadata || null,
            runAt: new Date().toISOString()
          };

          // ── Agency lookup: client-details + company-details ──────────────────
          // Same flow as manual company lookup — opens real tab to capture live
          // auth headers, returns freelancer profiles attached to this company.
          // Cached per companyId so multiple jobs from the same client only pay once.
          const companyIdForAgency = ciCompany.id || company.companyId || null;
          if (companyIdForAgency) {
            let profiles;
            if (agencyProfileCache.has(companyIdForAgency)) {
              profiles = agencyProfileCache.get(companyIdForAgency);
              console.log(`[upwork-ext] agency profile cache hit for ${companyIdForAgency}`);
            } else {
              try {
                console.log(`[upwork-ext] running agency lookup for company ${companyIdForAgency}`);
                const rawCp = await runAgencyLookupInNewTab(companyIdForAgency);
                // runAgencyLookupInNewTab returns flat {ciphertext, name} objects.
                // .identity/.profile nesting only exists in the raw GET_DETAILS_QUERY response,
                // not in the already-mapped profile objects returned by that function.
                profiles = (rawCp.profiles || []).map(p => ({
                  ciphertext: p.ciphertext || p.identity?.ciphertext || null,
                  name:       p.name       || p.profile?.name        || null,
                  status:     200,
                  agencies:   p.agencies              || []
                }));
                agencyProfileCache.set(companyIdForAgency, profiles);
              } catch(agErr) {
                console.warn(`[upwork-ext] agency lookup failed for ${companyIdForAgency}:`, agErr.message);
                profiles = [];
              }
            }
            webhookPayload['client-details']  = profiles;
            webhookPayload['company-details'] = profiles;
          }

          chrome.storage.local.get(['lastSearchJobs'], (stored) => {
            const arr = stored.lastSearchJobs || [];
            const idx = arr.findIndex(j => j.jobCiphertext === cipher);
            if (idx >= 0) arr[idx] = webhookPayload; else arr.unshift(webhookPayload);
            chrome.storage.local.set({ lastSearchJobs: arr.slice(0, 200) });
          });

          fetch(EXT_CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookPayload)
          }).catch(e => console.warn('[upwork-ext] search webhook error:', e.message));

          console.log(`[upwork-ext] runSearchLookup: sent job ${i + 1}/${ciphers.length} — ${jobInfo.title || cipher}`);
          if (i < ciphers.length - 1) {
            // Wait 3–4 minutes between each lookup to avoid rate-limiting
            const delayMs = 180000 + Math.floor(Math.random() * 60000);
            console.log(`[upwork-ext] lookup: waiting ${Math.round(delayMs/1000)}s before next job...`);
            await new Promise(r => setTimeout(r, delayMs));
          }
        }
      } catch(e) {
        console.warn(`[upwork-ext] runSearchLookup error for ${cipher}:`, e.message);
        fetch(EXT_CONFIG.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _debug: true, event: 'lookup_cipher_exception', cipher, index: i, error: e.message, ts: new Date().toISOString() })
        }).catch(() => {});
      }
      setSearchProgress({ active: true, query: searchQuery, phase: 'lookup', found: ciphers.length, processed: i + 1, total: ciphers.length });
    }

  } catch(outerErr) {
    fetch(EXT_CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _debug: true, event: 'lookup_outer_error', error: outerErr.message, proxyTabId, ts: new Date().toISOString() })
    }).catch(() => {});
    console.warn('[upwork-ext] runSearchLookup outer error:', outerErr.message);
  } finally {
    // Always close the tab we used for lookups
    fetch(EXT_CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _debug: true, event: 'lookup_finally_cleanup', proxyTabId, ts: new Date().toISOString() })
    }).catch(() => {});
    if (proxyTabId) {
      try { chrome.debugger.detach({ tabId: proxyTabId }, () => {}); } catch(_) {}
      chrome.tabs.remove(proxyTabId, () => {});
      attachedTabs.delete(proxyTabId);
    }
  }

  console.log('[upwork-ext] runSearchLookup: all done');
  fetch(EXT_CONFIG.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _debug: true, event: 'lookup_all_done', total: ciphers.length, ts: new Date().toISOString() })
  }).catch(() => {});
  setSearchProgress({ active: false, query: searchQuery, phase: 'done', found: ciphers.length, processed: ciphers.length, total: ciphers.length });

  } finally {
    clearInterval(_swKeepAlive);
  }
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

  if (message.action === 'getActiveState') {
    sendResponse({ active: _isActive });
    return true;
  }

  if (message.action === 'activate') {
    _isActive = true;
    chrome.storage.local.set({ scraperActive: true });
    sendResponse({ active: true });
    return true;
  }

  if (message.action === 'deactivate') {
    _isActive = false;
    chrome.storage.local.set({ scraperActive: false });
    sendResponse({ active: false });
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
        // Replay stored request templates for this job
        let results = await replayTemplatesForJob(upworkTab.id, jobCiphertext);
        if (results.length === 0) {
          // Fallback: try passively captured GQL responses from the tab
          const tabGql = _capturedGqlByTab.get(upworkTab.id) || [];
          results = buildResultsFromGqlResponses(tabGql.filter(r => extractJobCiphertext(r.requestBody) === jobCiphertext));
        }
        if (results.length === 0) {
          // Fallback 2: try runQueriesInTab
          try {
            const raw = await runQueriesInTab(upworkTab.id, companyId, jobCiphertext, null);
            if (Array.isArray(raw)) results = raw;
          } catch(e) {
            console.warn('[upwork-ext] runCompanyLookup runQueriesInTab failed:', e.message);
          }
        }
        if (results.length === 0) {
          sendResponse({ success: false, error: 'No request templates captured yet. Browse a job on Upwork first so the extension can learn the request patterns.' });
          return;
        }

        // ── clientInfoByOpening (companyBuyer) ───────────────────────────────
        // Fired directly — not captured as a template, so must be fetched explicitly.
        if (jobCiphertext) {
          try {
            const _openingId = jobCipherToOpeningId(jobCiphertext);
            const _st = await new Promise(r => chrome.storage.local.get(['sessionTokens'], d => r(d.sessionTokens || {})));
            const _tok  = _st['oauth2_global_js_token'] || _st['JobDetailsNuxt_vt'] || _st['_bearer'] || '';
            const _tid  = _st['current_organization_uid'] || _st['_tenantId'] || '';
            const _xsrf = _st['XSRF-TOKEN'] || '';
            const _ciQuery = `query clientInfoByOpening($openingId: ID!) { clientInfoByOpening(openingId: $openingId) { buyer { info { company { contractDate profile { industry size visible l3Occupations } id: companyId } location { country city state countryTimezone worldRegion offsetFromUtcMillis } jobs { postedCount filledCount openCount } stats { feedbackCount hoursCount totalCharges { amount currencyCode } totalAssignments activeAssignmentsCount score totalJobsWithHires } logo avgHourlyJobsRate { amount currencyCode } } cssTier isPaymentMethodVerified isEnterprise: enterprise } activity { lastBuyerActivity numberOfPositionsToHire totalApplicants totalInvitedToInterview totalHired unansweredInvites invitationsSent } jobInfo { status } } }`;
            const _ciExpr = `(async () => {
              try {
                const h = { 'Content-Type': 'application/json', 'X-Upwork-Accept-Language': 'en-US' };
                if (${JSON.stringify(_tok)}) h['Authorization'] = 'Bearer ' + ${JSON.stringify(_tok)};
                if (${JSON.stringify(_tid)}) h['X-Upwork-API-TenantId'] = ${JSON.stringify(_tid)};
                if (${JSON.stringify(_xsrf)}) h['X-XSRF-TOKEN'] = ${JSON.stringify(_xsrf)};
                const r = await fetch('https://www.upwork.com/api/graphql/v1?alias=companyBuyer', {
                  method: 'POST', credentials: 'include', headers: h,
                  body: JSON.stringify({ query: ${JSON.stringify(_ciQuery)}, variables: { openingId: ${JSON.stringify(_openingId)} } })
                });
                let d; try { d = await r.json(); } catch(_) { d = null; }
                return JSON.stringify({ status: r.status, data: d });
              } catch(e) { return JSON.stringify({ error: e.message }); }
            })()`;
            const _ciEval = await chrome.debugger.sendCommand(
              { tabId: upworkTab.id }, 'Runtime.evaluate',
              { expression: _ciExpr, awaitPromise: true, returnByValue: true }
            );
            if (!_ciEval.exceptionDetails) {
              const _ciOut = _ciEval.result?.value ? JSON.parse(_ciEval.result.value) : null;
              if (_ciOut) {
                results = results.filter(r => r.alias !== 'companyBuyer');
                // Always push so diagnostic info reaches the webhook
                results.push({ alias: 'companyBuyer', status: _ciOut.status || 0, data: _ciOut.data || null, _debug: _ciOut.error || (_ciOut.status >= 400 ? 'http_' + _ciOut.status : undefined) });
              } else {
                results.push({ alias: 'companyBuyer', status: 0, data: null, _debug: 'eval_null: ' + JSON.stringify(_ciEval.result) });
              }
            } else {
              results.push({ alias: 'companyBuyer', status: 0, data: null, _debug: 'exception: ' + JSON.stringify(_ciEval.exceptionDetails) });
            }
          } catch(_ciErr) {
            results.push({ alias: 'companyBuyer', status: 0, data: null, _debug: 'catch: ' + _ciErr.message });
            console.warn('[upwork-ext] companyBuyer fetch failed:', _ciErr.message);
          }
        }

        // ── clientCompanyMetadata — opens messages/rooms tab to capture live headers ──
        const _metaCompanyId = companyId || null;
        if (_metaCompanyId) {
          try {
            const _metaResult = await runClientCompanyMetadataInNewTab(_metaCompanyId);
            results = results.filter(r => r.alias !== 'clientCompanyMetadata');
            results.push(_metaResult);
          } catch(_mErr) {
            console.warn('[upwork-ext] clientCompanyMetadata lookup failed:', _mErr.message);
            results.push({ alias: 'clientCompanyMetadata', status: 0, data: null, _debug: 'catch: ' + _mErr.message });
          }
        }

        // ── Agency lookup — opens real tabs to capture live headers ─────────
        const jaBuyerR = results.find(r => r.alias === 'jobAuth-buyer');
        const agencyCId = jaBuyerR?.data?.data?.jobAuthDetails?.buyer?.info?.company?.companyId || companyId;

        const rawCp = agencyCId
          ? await runAgencyLookupInNewTab(agencyCId)
          : { alias: 'company-page', skipped: true, reason: 'no companyId' };

        // Split agency profiles into separate result entries
        const { profiles: cpProfiles, ...cpResult } = rawCp;
        const cdResult      = { alias: 'client-details',   companyId: rawCp.companyId, profiles: cpProfiles || [] };
        const compDetResult = { alias: 'company-details',  companyId: rawCp.companyId, profiles: cpProfiles || [] };

        results = results.filter(r =>
          r.alias !== 'company-page' &&
          r.alias !== 'client-details' &&
          r.alias !== 'company-details'
        );
        results = [...results, cpResult, cdResult, compDetResult];

        const entry = { companyId, jobCiphertext: jobCiphertext || null, jobTitle: jobTitle || 'Unknown', runAt: new Date().toISOString(), results };
        chrome.storage.local.get(['companyLookups'], (stored) => {
          const lookups = stored.companyLookups || [];
          const idx = lookups.findIndex(l => l.companyId === companyId);
          if (idx >= 0) lookups[idx] = entry; else lookups.push(entry);
          chrome.storage.local.set({ companyLookups: lookups }, () => {
            const payload = JSON.stringify(cleanForWebhook({ companyId, jobCiphertext: jobCiphertext || null, jobTitle: jobTitle || 'Unknown', runAt: entry.runAt, results }));
            fetch(EXT_CONFIG.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
              .catch(e => console.warn('[upwork-ext] lookup webhook error:', e.message));
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
            // Fire webhook
            sendWebhook(job, gqlData, EXT_CONFIG.WEBHOOK_URL);
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

  // ── Lookup a specific job by URL ──────────────────────────────────────────
  // Opens the job page in a bg tab with CDP attached BEFORE navigation so we
  // catch every network request the page makes. We watch ALL graphql endpoints
  // (not just a specific alias) and grab the first response whose body contains
  // jobAuthDetails. This handles both aliased requests AND persisted-query URLs.
  if (message.action === 'lookupJobUrl') {
    const { url } = message;
    const cipher = url.match(/\/jobs\/(?:details\/)?(~0[^/?#\s]+)/)?.[1]
                || url.match(/(~0[0-9a-zA-Z]{8,35})/)?.[1];
    if (!cipher) {
      sendResponse({ success: false, error: 'No job cipher found in URL' });
      return true;
    }
    sendResponse({ success: true, started: true, cipher });

    const debugWH = (step, data) => {
      const payload = JSON.stringify({ _debug: true, step, cipher, ts: new Date().toISOString(), ...data });
      fetch(EXT_CONFIG.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => {});
    };

    (async () => {
      try {
        const jobUrl = `https://www.upwork.com/jobs/${cipher}`;
        debugWH('1-opening-tab', { jobUrl });

        await new Promise((resolve) => {
          let bgTab = null;
          let detached = false;
          let found = false;
          const pendingGqlIds = new Set(); // requestIds of graphql requests
          const pendingHdrs = {};

          const cleanup = () => {
            clearTimeout(timer);
            chrome.debugger.onEvent.removeListener(listener);
            if (!detached && bgTab) {
              detached = true;
              attachedTabs.delete(bgTab.id);
              chrome.debugger.detach({ tabId: bgTab.id }, () =>
                chrome.tabs.remove(bgTab.id, () => {})
              );
            }
            resolve();
          };

          const timer = setTimeout(() => {
            debugWH('ERROR', { error: 'job lookup timeout (40s)' });
            cleanup();
          }, 40000);

          const listener = async (source, method, params) => {
            if (!bgTab || source.tabId !== bgTab.id) return;

            // Accumulate extra headers (cookies, auth) per requestId
            if (method === 'Network.requestWillBeSentExtraInfo') {
              pendingHdrs[params.requestId] = Object.assign(
                pendingHdrs[params.requestId] || {}, params.headers || {}
              );
            }

            // Track every graphql request — any alias, any URL pattern
            if (method === 'Network.requestWillBeSent') {
              const reqUrl = params.request?.url || '';
              if (reqUrl.includes('upwork.com/api/graphql')) {
                pendingGqlIds.add(params.requestId);
                const alias = (reqUrl.match(/alias=([^&]+)/) || [])[1] || 'none';
                debugWH('gql-seen', { alias, rid: params.requestId.substring(0, 8) });
              }
            }

            // Body is fully buffered after loadingFinished — safe to call getResponseBody
            if (method === 'Network.loadingFinished' &&
                pendingGqlIds.has(params.requestId) && !found) {
              pendingGqlIds.delete(params.requestId);
              const rid = params.requestId;
              try {
                const body = await chrome.debugger.sendCommand(
                  { tabId: bgTab.id }, 'Network.getResponseBody', { requestId: rid }
                );
                const parsed = body?.body ? JSON.parse(body.body) : null;
                if (parsed?.data?.jobAuthDetails) {
                  if (found) return; // another request already succeeded
                  found = true;
                  debugWH('3-found', { rid: rid.substring(0, 8) });
                  const results = [
                    { alias: 'jobAuth-buyer', status: 200, data: parsed, source: 'cdp-capture' },
                    { alias: 'jobAuth-full',  status: 200, data: parsed, source: 'cdp-capture' }
                  ];
                  const entry = await buildJobEntry(bgTab.id, cipher, results);
                  debugWH('4-entry-built', { companyId: entry.companyId, jobTitle: entry.jobTitle });
                  saveJobEntry(entry);
                  debugWH('5-saved', { jobTitle: entry.jobTitle, companyId: entry.companyId });
                  cleanup();
                }
              } catch(_) {
                // Body not available or parse error — not the response we want
              }
            }
          };

          // Create as about:blank, attach debugger + Network.enable BEFORE navigating
          // so we don't miss any requests fired right after page load begins.
          chrome.tabs.create({ url: 'about:blank', active: false }, async (tab) => {
            bgTab = tab;
            debugWH('2-tab-created', { tabId: tab.id });
            try {
              await new Promise((res, rej) =>
                chrome.debugger.attach({ tabId: tab.id }, '1.3', () =>
                  chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
                )
              );
              attachedTabs.add(tab.id);
              await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});
              chrome.debugger.onEvent.addListener(listener);
              // Navigate now — CDP is fully armed
              await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.navigate', { url: jobUrl });
            } catch(e) {
              debugWH('ERROR', { error: 'setup failed: ' + e.message });
              cleanup();
            }
          });
        });
      } catch(e) {
        debugWH('ERROR', { error: e.message, stack: e.stack });
      }
    })();
    return true;
  }

  // ── Search Upwork via userJobSearch GQL, then lookup each result ─────────────
  // Phase 1: opens search page, captures userJobSearch headers via CDP, paginates
  //          with fetch() replays to collect all ciphertexts.
  // Phase 2: opens a job tab, navigates to each job page (about:blank → attach →
  //          navigate), captures jobAuthDetails, builds entry. 2-min gap between jobs.
  if (message.action === 'searchByQuery') {
    const { query, maxJobs = 30 } = message;
    // Build a search URL and delegate to the same code as runSearchLookup,
    // which is proven to work. searchByQuery just adds progress tracking.
    const searchUrl = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(query)}&nbs=1`;
    sendResponse({ success: true, started: true });
    chrome.storage.local.set({ lastSearchJobs: [] });

    const setProgress = (data) =>
      chrome.storage.local.set({ searchProgress: { ...data, ts: Date.now() } });

    setProgress({ active: true, query, phase: 'searching', found: 0, processed: 0, total: maxJobs });

    // Call the runSearchLookup core directly (cannot self-message in a service worker)
    runSearchLookupCore(searchUrl, maxJobs, setProgress, query);
    return true;
  }

  // ── Extract all jobs from already-captured request data ───────────────────
  // Mines stored network captures without requiring GQL calls.
  // Useful after browsing a search page — all job data is already in the stored requests.
  if (message.action === 'extractJobsFromRequests') {
    chrome.storage.local.get(['requests', 'capturedJobs'], async (s) => {
      const requests    = s.requests    || [];
      const existing    = s.capturedJobs || [];
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
        for (const j of newJobs) sendWebhook(j, null, EXT_CONFIG.WEBHOOK_URL);
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
    const { searchUrl, maxJobs = 30, _fromSearchByQuery = false, _query = '' } = message;
    // Respond immediately so the popup re-enables — scraping happens fully in background
    sendResponse({ success: true, started: true });
    chrome.storage.local.set({ lastSearchJobs: [] }); // fresh slate for this run

    const setSearchProgress = _fromSearchByQuery
      ? (data) => chrome.storage.local.set({ searchProgress: { ...data, ts: Date.now() } })
      : () => {};
    const searchQuery = _query || searchUrl;
    runSearchLookupCore(searchUrl, maxJobs, setSearchProgress, searchQuery);
    // No return true — sendResponse was already called synchronously above
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
  let _clientCompanyMeta = null;
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
      if (alias === 'clientCompanyMetadata' && r.data.data.clientCompanyMetadata) {
        _clientCompanyMeta = r.data.data.clientCompanyMetadata;
      }
      continue;
    }

    // page-state, skipped results, etc.
    const { alias: _a, query: _q, tokenUsed: _t, withTenant: _w, ...rest } = r;
    data[alias] = rest;
  }

  return { companyId, jobCiphertext, jobTitle, runAt,
           clientCompanyMetadata: _clientCompanyMeta, data };
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
      if (typeof v === 'string' && /^~0[0-9a-zA-Z]{8,}/.test(v)) return v;
    }
  }
  // Fallback: regex in stringified body
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  const m = str.match(/"(~0[0-9a-zA-Z]{10,})"/);
  return m ? m[1] : null;
}

// ─── Build results from passively captured GQL responses ──────────────────────
// Maps raw Upwork GQL responses to the internal alias format expected by popup.js
function buildResultsFromGqlResponses(gqlResponses) {
  const results = [];
  const seen = new Set();
  for (const resp of gqlResponses) {
    const d = resp.data;
    if (!d || typeof d !== 'object') continue;

    // Standard GQL response: { data: { operationName: {...} } }
    const gqlData = d.data || d;  // Some responses may not have the extra wrapper

    // Log all top-level keys for debugging
    const topKeys = Object.keys(gqlData).filter(k => k !== '__typename');
    console.log('[upwork-ext] buildResults: GQL response keys:', topKeys.join(', '), '| URL:', (resp.url || '').slice(-80));

    if (gqlData.jobAuthDetails && !seen.has('jobAuth')) {
      seen.add('jobAuth');
      const wrapped = d.data ? d : { data: d };
      results.push({ alias: 'jobAuth-buyer', status: resp.status, data: wrapped, source: 'passive' });
      results.push({ alias: 'jobAuth-full',  status: resp.status, data: wrapped, source: 'passive' });
    }
    if ((gqlData.fetchJobDetailsAndContext || gqlData.fetchjobdetailsandcontext) && !seen.has('ctx')) {
      seen.add('ctx');
      const wrapped = d.data ? d : { data: d };
      results.push({ alias: 'fetchjobdetailsandcontext', status: resp.status, data: wrapped, source: 'passive' });
    }
  }
  return results;
}

// ─── Replay stored request templates for a job cipher ─────────────────────────
// Uses the exact headers + query text captured from the user's own browsing,
// just swaps the cipher variable. This avoids OAuth2 permission errors.
async function replayTemplatesForJob(tabId, cipher) {
  const st = await new Promise(r => chrome.storage.local.get(['requestTemplates', 'sessionTokens'], r));
  const templates = st.requestTemplates || {};
  const tokens    = st.sessionTokens    || {};

  // Templates we want to replay — map alias → variable key for the cipher
  const WANTED = {};
  // Upwork uses 'get-auth-job-details' for jobAuthDetails
  if (templates['get-auth-job-details'])       WANTED['get-auth-job-details']       = 'id';
  // Alternative alias name
  if (templates['jobAuth'])                    WANTED['jobAuth']                    = 'id';
  // fetchjobdetailsandcontext
  if (templates['fetchjobdetailsandcontext'])  WANTED['fetchjobdetailsandcontext']  = 'ciphertext';
  if (templates['fetchJobDetailsAndContext'])   WANTED['fetchJobDetailsAndContext']   = 'ciphertext';

  if (Object.keys(WANTED).length === 0) {
    console.warn('[upwork-ext] no request templates stored yet — browse a job page first');
    return [];
  }

  const results = [];
  for (const [alias, varKey] of Object.entries(WANTED)) {
    const tmpl = templates[alias];
    if (!tmpl?.query) continue;

    // Swap the cipher variable, keep all other variables unchanged
    const variables = { ...tmpl.variables, [varKey]: cipher };

    // Use stored headers; fall back to sessionTokens if stale
    const headers = { ...tmpl.headers };
    if (!headers['Authorization'] || headers['Authorization'] === 'Bearer ') {
      const tok = tokens.oauth2_global_js_token || tokens.JobDetailsNuxt_vt || tokens._bearer || '';
      if (tok) headers['Authorization'] = 'Bearer ' + tok;
    }
    if (!headers['X-Upwork-API-TenantId']) {
      const tid = tokens.current_organization_uid || tokens._tenantId || '';
      if (tid) headers['X-Upwork-API-TenantId'] = tid;
    }
    if (!headers['X-XSRF-TOKEN']) {
      if (tokens['XSRF-TOKEN']) headers['X-XSRF-TOKEN'] = tokens['XSRF-TOKEN'];
    }

    try {
      const expr = `(async () => {
        try {
          const r = await fetch(${JSON.stringify(tmpl.url)}, {
            method: 'POST', credentials: 'include',
            headers: ${JSON.stringify(headers)},
            body: JSON.stringify({ query: ${JSON.stringify(tmpl.query)}, variables: ${JSON.stringify(variables)} })
          });
          let d; try { d = await r.json(); } catch(_) { d = null; }
          return JSON.stringify({ status: r.status, data: d });
        } catch(e) { return JSON.stringify({ error: e.message }); }
      })()`;

      const evalRes = await chrome.debugger.sendCommand(
        { tabId }, 'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true }
      );
      if (evalRes.exceptionDetails) throw new Error(evalRes.exceptionDetails.text || 'eval error');
      const out = evalRes.result?.value ? JSON.parse(evalRes.result.value) : null;
      if (out?.error) throw new Error(out.error);

      // Skip failed responses: HTTP errors (401, 403, etc.) or GQL-level errors
      if (out?.status >= 400) {
        console.warn(`[upwork-ext] template replay for ${alias}: HTTP ${out.status}`);
        continue;
      }
      if (!out?.data?.data && out?.data?.errors) {
        console.warn(`[upwork-ext] template replay for ${alias}: GQL error:`, out.data.errors[0]?.message);
        continue;
      }
      if (!out?.data?.data) {
        console.warn(`[upwork-ext] template replay for ${alias}: no data in response`);
        continue;
      }

      // Map to internal aliases expected by popup.js
      if (alias === 'get-auth-job-details' || alias === 'jobAuth') {
        results.push({ alias: 'jobAuth-buyer', status: out.status, data: out.data, source: 'template' });
        results.push({ alias: 'jobAuth-full',  status: out.status, data: out.data, source: 'template' });
      } else if (alias.toLowerCase().includes('fetchjobdetails')) {
        results.push({ alias: 'fetchjobdetailsandcontext', status: out.status, data: out.data, source: 'template' });
      } else {
        results.push({ alias, status: out.status, data: out.data, source: 'template' });
      }
    } catch(e) {
      console.warn(`[upwork-ext] template replay failed for ${alias}:`, e.message);
    }
  }
  return results;
}

// ─── Build a complete job entry from results + agency lookup ──────────────────
// Flow:
// 1. Extract job details from results (jobAuth + fetchjobdetailsandcontext)
// 2. If companyId exists → run getStaff (agencyStaffsAuth)
// 3. If staff found → save + webhook immediately
// 4. If any staff are freelancers → run getDetails for them → save + webhook again with profiles
// 5. If no companyId or no staff → save + webhook with whatever we have
async function buildJobEntry(tabId, cipher, results) {
  console.log('[upwork-ext] buildJobEntry called with', results.length, 'results, aliases:', results.map(r => r.alias).join(', '));
  const jobAuthResp = results.find(r => r.alias === 'jobAuth-buyer' || r.alias === 'jobAuth-full');
  const ctxResp     = results.find(r => r.alias === 'fetchjobdetailsandcontext');
  
  // Debug: log what we found
  if (jobAuthResp) {
    const buyerPath = jobAuthResp?.data?.data?.jobAuthDetails?.buyer;
    console.log('[upwork-ext] buildJobEntry: jobAuthResp found (alias:', jobAuthResp.alias, ')');
    console.log('[upwork-ext] buildJobEntry: buyer.info.company:', JSON.stringify(buyerPath?.info?.company || 'NOT FOUND'));
    console.log('[upwork-ext] buildJobEntry: data structure preview:', JSON.stringify(jobAuthResp.data).substring(0, 300));
  } else {
    console.warn('[upwork-ext] buildJobEntry: NO jobAuthResp found! Available aliases:', results.map(r => r.alias).join(', '));
  }

  const agencyCId   = jobAuthResp?.data?.data?.jobAuthDetails?.buyer?.info?.company?.companyId || null;
  const jobTitle    = jobAuthResp?.data?.data?.jobAuthDetails?.opening?.job?.info?.title
                   || ctxResp?.data?.data?.fetchJobDetailsAndContext?.opening?.info?.title
                   || ctxResp?.data?.data?.fetchjobdetailsandcontext?.opening?.info?.title
                   || 'Unknown';

  console.log('[upwork-ext] buildJobEntry: agencyCId =', agencyCId, ', jobTitle =', jobTitle);

  // ── clientInfoByOpening (companyBuyer) ────────────────────────────────────
  // Open messages/rooms, intercept first GQL request the page fires to capture
  // real auth headers, then replay clientInfoByOpening with those exact headers.
  try {
    const _openingId = jobCipherToOpeningId(cipher);
    const _ciQuery = `query clientInfoByOpening($openingId: ID!) { clientInfoByOpening(openingId: $openingId) { buyer { info { company { contractDate name profile { industry size } id: companyId } location { country city state countryTimezone worldRegion offsetFromUtcMillis } jobs { postedCount filledCount openCount } stats { feedbackCount hoursCount totalCharges { amount currencyCode } totalAssignments activeAssignmentsCount score totalJobsWithHires } } isPaymentMethodVerified isEnterprise: enterprise } activity { lastBuyerActivity numberOfPositionsToHire totalApplicants totalInvitedToInterview totalHired unansweredInvites invitationsSent } jobInfo { status } } }`;

    const _ciResult = await new Promise(async (resolve) => {
      let _pTab = null;
      let _resolved = false;
      const _pendingHdrs = {};
      let _capturedReqId = null;
      const _done = (val) => {
        if (_resolved) return; _resolved = true;
        clearTimeout(_ciTimer);
        chrome.debugger.onEvent.removeListener(_netHdl);
        if (_pTab) {
          chrome.debugger.detach({ tabId: _pTab.id }, () => chrome.tabs.remove(_pTab.id, () => {}));
          attachedTabs.delete(_pTab.id);
        }
        resolve(val);
      };
      const _ciTimer = setTimeout(() => _done(null), 30000);
      const _netHdl = async (src, method, params) => {
        if (!_pTab || src.tabId !== _pTab.id) return;
        if (method === 'Network.requestWillBeSentExtraInfo') {
          _pendingHdrs[params.requestId] = Object.assign(_pendingHdrs[params.requestId] || {}, params.headers || {});
        }
        if (method === 'Network.requestWillBeSent' &&
            params.request?.url?.includes('api/graphql/v1') &&
            !_capturedReqId) {
          _capturedReqId = params.requestId;
          const _h = Object.assign({}, params.request.headers || {}, _pendingHdrs[params.requestId] || {});
          const _auth   = _h['authorization']         || _h['Authorization']         || '';
          const _tenant = _h['x-upwork-api-tenantid'] || _h['X-Upwork-API-TenantId'] || '';
          const _xsrf   = _h['x-xsrf-token']          || _h['X-XSRF-TOKEN']          || '';
          console.log('[upwork-ext] companyBuyer: captured GQL headers — auth:', !!_auth, 'tenant:', !!_tenant);
          const _ciExpr = `(async()=>{try{const h={'Content-Type':'application/json','Accept':'application/json','Accept-Language':'en-US,en;q=0.9','Origin':'https://www.upwork.com','Referer':'https://www.upwork.com/ab/messages/rooms/'};if(${JSON.stringify(_auth)})h['Authorization']=${JSON.stringify(_auth)};if(${JSON.stringify(_tenant)})h['X-Upwork-API-TenantId']=${JSON.stringify(_tenant)};if(${JSON.stringify(_xsrf)})h['X-XSRF-TOKEN']=${JSON.stringify(_xsrf)};const r=await fetch('https://www.upwork.com/api/graphql/v1?alias=companyBuyer',{method:'POST',credentials:'include',headers:h,body:JSON.stringify({query:${JSON.stringify(_ciQuery)},variables:{openingId:${JSON.stringify(_openingId)}}})});const d=await r.json().catch(()=>null);return JSON.stringify({status:r.status,data:d});}catch(e){return JSON.stringify({error:e.message});}})()`;
          try {
            const _ev = await chrome.debugger.sendCommand(
              { tabId: _pTab.id }, 'Runtime.evaluate',
              { expression: _ciExpr, awaitPromise: true, returnByValue: true }
            );
            const _out = _ev?.result?.value ? JSON.parse(_ev.result.value) : null;
            _done(_out);
          } catch(e) { _done({ error: 'eval: ' + e.message }); }
        }
      };
      try {
        _pTab = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: false }, r));
        attachedTabs.add(_pTab.id);
        chrome.debugger.onEvent.addListener(_netHdl);
        await new Promise((res, rej) => chrome.debugger.attach({ tabId: _pTab.id }, '1.3', async () => {
          if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
          try {
            await chrome.debugger.sendCommand({ tabId: _pTab.id }, 'Network.enable', {});
            await chrome.debugger.sendCommand({ tabId: _pTab.id }, 'Page.navigate', { url: 'https://www.upwork.com/ab/messages/rooms/' });
            res();
          } catch(e) { rej(e); }
        }));
      } catch(e) { _done({ error: 'tab: ' + e.message }); }
    });

    const _out = _ciResult;
    results.push({ alias: 'companyBuyer', status: _out?.status || 0, data: _out?.data || null, _debug: _out?.error });
    console.log('[upwork-ext] companyBuyer status:', _out?.status, 'hasData:', !!_out?.data?.data);
  } catch (_ciErr) {
    results.push({ alias: 'companyBuyer', status: 0, data: null, _debug: 'catch: ' + _ciErr.message });
    console.warn('[upwork-ext] companyBuyer fetch failed:', _ciErr.message);
  }

  if (!agencyCId) {
    console.warn('[upwork-ext] buildJobEntry: NO companyId → skipping agency lookup');
    results.push({ alias: 'company-page', skipped: true, reason: 'no companyId' });
    return { companyId: null, jobCiphertext: cipher, jobTitle, runAt: new Date().toISOString(), results };
  }

  // clientCompanyMetadata — intercept real GQL headers from messages/rooms
  try {
    const _metaResult = await runClientCompanyMetadataInNewTab(agencyCId);
    results.push(_metaResult);
  } catch(_mErr) {
    results.push({ alias: 'clientCompanyMetadata', status: 0, data: null, _debug: 'catch: ' + _mErr.message });
  }

  // Agency lookup — opens real agency + freelancer tabs to capture live auth headers
  try {
    const rawCp = await runAgencyLookupInNewTab(agencyCId);
    const { profiles: cpProfiles, ...cpResult } = rawCp;
    results.push(cpResult);
    results.push({ alias: 'client-details',  companyId: agencyCId, profiles: cpProfiles || [] });
    results.push({ alias: 'company-details', companyId: agencyCId, profiles: cpProfiles || [] });
  } catch(e) {
    results.push({ alias: 'company-page', skipped: true, reason: 'agency lookup failed: ' + e.message });
  }

  return { companyId: agencyCId, jobCiphertext: cipher, jobTitle, runAt: new Date().toISOString(), results };
}

// ─── Save a job entry to companyLookups + fire webhook ────────────────────────
function saveJobEntry(entry) {
  chrome.storage.local.get(['companyLookups'], (s) => {
    const lookups = s.companyLookups || [];
    const idx = lookups.findIndex(l => l.jobCiphertext === entry.jobCiphertext);
    if (idx >= 0) lookups[idx] = entry; else lookups.unshift(entry);
    chrome.storage.local.set({ companyLookups: lookups.slice(0, 200) }, () => {
      const payload = JSON.stringify(cleanForWebhook(entry));
      fetch(EXT_CONFIG.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
        .catch(e => console.warn('[upwork-ext] webhook error:', e.message));
    });
    console.log('[upwork-ext] job saved:', entry.jobTitle);
  });
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

  // ── fetchJobDetailsAndContext — job description, budget, skills, proposals ──
  // Uses globalToken (not job-scoped). Variable is 'ciphertext' (String!), not 'id' (ID!).
  if (jobCiphertext) {
    queries.push({
      alias: 'fetchjobdetailsandcontext',
      query: `query fetchJobDetailsAndContext($ciphertext: String!) {
        fetchJobDetailsAndContext(ciphertext: $ciphertext) {
          companyId enterpriseClient
          opening {
            description duration durationLabel startDate postedOn publishTime
            status visibility workload contractorTier openingId
            budget { amount currencyCode }
            extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
            category { name urlSlug }
            categoryGroup { name urlSlug }
            clientActivity { numberOfPositionsToHire totalApplicants }
            info { ciphertext title type id }
            segmentationData { customValue label name sortOrder type value }
            sandsData {
              occupation { id freeText ontologyId prefLabel }
              ontologySkills { attributeGroupId attributeId freeText ontologyId prefLabel }
              occupations { id freeText ontologyId prefLabel }
            }
          }
        }
      }`,
      variables: { ciphertext: jobCiphertext },
      useJobToken: false   // uses globalToken + tenant
    });
  }

  // ── clientInfoByOpening — richer buyer stats, activity, job status ──────────
  // Uses globalToken + tenant. openingId strips the ~0 prefix from the ciphertext.
  if (jobCiphertext) {
    const openingId = jobCiphertext.replace(/^~0/, '');
    queries.push({
      alias: 'companyBuyer',
      query: `query clientInfoByOpening($openingId: ID!) {
        clientInfoByOpening(openingId: $openingId) {
          buyer {
            info {
              company {
                contractDate
                name
                profile { industry size visible l3Occupations }
                id: companyId
              }
              location { country city state countryTimezone worldRegion offsetFromUtcMillis }
              jobs { postedCount filledCount openCount }
              stats { feedbackCount hoursCount totalCharges { amount currencyCode } totalAssignments activeAssignmentsCount score totalJobsWithHires }
              logo
              avgHourlyJobsRate { amount currencyCode }
            }
            cssTier isPaymentMethodVerified isEnterprise: enterprise
          }
          activity { lastBuyerActivity numberOfPositionsToHire totalApplicants totalInvitedToInterview totalHired unansweredInvites invitationsSent }
          jobInfo { status }
        }
      }`,
      variables: { openingId },
      useJobToken: false
    });
  }

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


// ─── Agency lookup via Runtime.evaluate on an existing attached tab ─────────────────────────
// Faster and more reliable than opening a real browser tab.
// Uses the Upwork session cookies already present in the existing tab.
async function runAgencyLookupInTab(tabId, cId) {
  const STAFFS_QUERY = 'query getAgencyStaffsAuth($agencyId: ID!, $agencyTeamId: ID!, $limit: Int, $offset: String) { agencyStaffsAuth(agencyId: $agencyId agencyTeamId: $agencyTeamId limit: $limit offset: $offset) { totalCount staffs { id agencyOwner memberType vetted active canBeViewed personalData { id rid name portrait ciphertext topRatedStatus topRatedPlusStatus jobSuccessScore profileAccess hideJss provider } } } }';

  // Read stored tokens (harvested from CDP request headers — bypasses HttpOnly)
  const storedData = await new Promise(resolve =>
    chrome.storage.local.get(['sessionTokens'], resolve)
  );
  const tk = storedData.sessionTokens || {};
  const injAgTok  = tk.ag_vs_ui_gql_token || tk.oauth2_global_js_token || tk._bearer || '';
  const injTenant = tk.current_organization_uid || tk._tenantId || '';
  const injXsrf   = tk['XSRF-TOKEN'] || '';

  const expr = `(async () => {
  try {
    const gc = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
    const agTok  = ${JSON.stringify(injAgTok)} || gc('ag_vs_ui_gql_token') || gc('oauth2_global_js_token') || '';
    const tenant = ${JSON.stringify(injTenant)} || gc('current_organization_uid') || '';
    const xsrf   = ${JSON.stringify(injXsrf)} || gc('XSRF-TOKEN') || '';
    const r = await fetch('https://www.upwork.com/api/graphql/v1?alias=gql-query-agencystaffsauth', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': '*/*',
        'Authorization': 'Bearer ' + agTok, 'X-Upwork-Accept-Language': 'en-US',
        'X-Upwork-API-TenantId': tenant, 'X-XSRF-TOKEN': xsrf },
      body: JSON.stringify({ query: ${JSON.stringify(STAFFS_QUERY)}, variables: { agencyId: ${JSON.stringify(cId)}, agencyTeamId: ${JSON.stringify(cId)}, limit: 50, offset: '' } })
    });
    let d; try { d = await r.json(); } catch(_) { d = null; }
    return JSON.stringify({ status: r.status, data: d });
  } catch(e) { return JSON.stringify({ error: e.message }); }
})()`;

  try {
    const evalRes = await chrome.debugger.sendCommand(
      { tabId }, 'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }
    );
    if (evalRes.exceptionDetails) throw new Error(evalRes.exceptionDetails.text || 'eval error');
    const out = evalRes.result?.value ? JSON.parse(evalRes.result.value) : null;
    if (out?.error) throw new Error(out.error);
    const staffs = out?.data?.data?.agencyStaffsAuth?.staffs || [];
    return { alias: 'company-page', companyId: cId, status: out?.status, data: out?.data, profiles: [] };
  } catch(e) {
    console.warn('[upwork-ext] agency-in-tab failed:', e.message);
    return { alias: 'company-page', skipped: true, reason: 'agency query failed: ' + e.message };
  }
}

// ─── Agency lookup via real agency page tab ─────────────────────────────────────────────────
// Phase 1: opens agency page (about:blank→attach→navigate to avoid race), captures
//          agencystaffsauth headers, replays with real companyId.
// Phase 2: opens freelancers/moezz the same way, captures getDetails headers, fires
//          getDetails for each staff ciphertext using those exact headers.
async function runAgencyLookupInNewTab(cId) {
  console.log('[upwork-ext] runAgencyLookupInNewTab: starting for company', cId);
  return new Promise(async (resolve) => {
    let agencyTab = null, freelancerTab = null;
    let agencyDetached = false, freelancerDetached = false;
    const agencyPendingHdrs = {}, freelancerPendingHdrs = {};
    let agencyRequestId = null, freelancerRequestId = null;
    let capturedStaffs = null, capturedAgencyData = null, capturedAgencyStatus = null;
    let phase2Started = false;
    let resolved = false;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(agencyListener);
      chrome.debugger.onEvent.removeListener(freelancerListener);
      if (!agencyDetached)    { agencyDetached    = true; if (agencyTab)     chrome.debugger.detach({ tabId: agencyTab.id },     () => chrome.tabs.remove(agencyTab.id,     () => {})); }
      if (!freelancerDetached){ freelancerDetached = true; if (freelancerTab) chrome.debugger.detach({ tabId: freelancerTab.id }, () => chrome.tabs.remove(freelancerTab.id, () => {})); }
      resolve(result);
    };

    const timeout = setTimeout(
      () => done({ alias: 'company-page', skipped: true, reason: 'agency lookup timeout' }),
      90000
    );

    const GET_DETAILS_QUERY = 'query GetTalentProfile($profileUrl: String, $jobProposalId: ID, $openingId: ID, $viewerMode: Boolean, $freeText: String, $skillIds: [ID!], $occupationIds: [ID!]) { talentVPDAuthProfile(filter: { profileUrl: $profileUrl, jobProposalId: $jobProposalId, openingId: $openingId, viewerMode: $viewerMode, freeText: $freeText, skillIds: $skillIds, occupationIds: $occupationIds, excludePortfolio: true, excludeAgencies: false }) { ...AuthProfileResponseFragment } } fragment BaseProfileResponseFragment on TalentVPDProfileResponse { identity { uid: id id userId ciphertext recno } profile { name title description location { country city state } portrait { portrait } skills { node { id name prettyName } } } stats { totalHours totalFeedback rating hourlyRate { node { currencyCode amount } } memberSince totalEarnings topRatedStatus topRatedPlusStatus } agencies { name logo recentHours score recno scoreRecent totalFeedback totalHours agencyRate { node { currencyCode amount } } nSS100BwScore topRatedStatus topRatedPlusStatus hideEacEarnings ciphertext uid: id id defaultAgency } languages { language { englishName } proficiencyLevel { proficiencyTitle } } } fragment AuthProfileResponseFragment on TalentVPDProfileResponse { ...BaseProfileResponseFragment vettedBadge { vetted } }';

    // Helper: attach CDP to a tab that was created as about:blank, then navigate
    const attachAndNavigate = (tab, navUrl) => new Promise((res, rej) => {
      chrome.debugger.attach({ tabId: tab.id }, '1.3', async () => {
        if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
        try {
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {});
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.navigate', { url: navUrl });
          res();
        } catch(e) { rej(e); }
      });
    });

    // ── PHASE 2 LISTENER: freelancer page (moezz) ──────────────────────────────
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
    const isFreelancer = st.personalData && st.personalData.provider === true;
    if (!isFreelancer) {
      profiles.push({ ciphertext, name: personName, isClient: true, memberType: st.memberType || 'CLIENT', personalData: st.personalData, agencies: [] });
      continue;
    }
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
          console.log('[upwork-ext] runAgencyLookup phase2: got', profiles.length, 'profiles');
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

          console.log('[upwork-ext] runAgencyLookup phase1: got', capturedStaffs.length, 'staff, HTTP', capturedAgencyStatus);

          if (!capturedStaffs.length) {
            done({ alias: 'company-page', companyId: cId, status: capturedAgencyStatus, data: capturedAgencyData, profiles: [] });
            return;
          }

          const freelancerStaffs = capturedStaffs.filter(st => st.personalData?.provider === true);
          console.log('[upwork-ext] runAgencyLookup: freelancers:', freelancerStaffs.length, 'clients:', capturedStaffs.length - freelancerStaffs.length);

          if (freelancerStaffs.length === 0) {
            const clientProfiles = capturedStaffs.map(st => ({
              ciphertext: st.personalData?.ciphertext, name: st.personalData?.name,
              isClient: true, memberType: st.memberType || 'CLIENT', personalData: st.personalData, agencies: []
            }));
            done({ alias: 'company-page', companyId: cId, status: capturedAgencyStatus, data: capturedAgencyData, profiles: clientProfiles });
            return;
          }

          // Phase 2: open moezz page — blank first, attach, then navigate
          console.log('[upwork-ext] runAgencyLookup phase2: opening moezz...');
          freelancerTab = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: false }, r));
          attachedTabs.add(freelancerTab.id);
          chrome.debugger.onEvent.addListener(freelancerListener);
          await attachAndNavigate(freelancerTab, 'https://www.upwork.com/freelancers/moezz');
        } catch(e) {
          done({ alias: 'company-page', error: 'phase1 eval: ' + e.message });
        }
      }
    };

    // Phase 1: open agency page — blank first, attach, then navigate
    try {
      agencyTab = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: false }, r));
      attachedTabs.add(agencyTab.id);
      chrome.debugger.onEvent.addListener(agencyListener);
      await attachAndNavigate(agencyTab, 'https://www.upwork.com/agencies/2012207015295215238/');
    } catch(e) {
      clearTimeout(timeout);
      resolve({ alias: 'company-page', error: e.message });
    }
  });
}


// ─── clientCompanyMetadata via messages/rooms tab ───────────────────────────
// Opens https://www.upwork.com/ab/messages/rooms/, waits for any GQL request
// the page fires (Network.requestWillBeSent), captures the exact auth headers
// from that live request, then replays clientCompanyMetadata with those headers.
async function runClientCompanyMetadataInNewTab(companyId) {
  console.log('[upwork-ext] runClientCompanyMetadataInNewTab: starting for company', companyId);

  return new Promise(async (resolve) => {
    let msgTab = null;
    let resolved = false;
    const pendingHdrs = {};
    let capturedRequestId = null;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(listener);
      if (msgTab) {
        chrome.debugger.detach({ tabId: msgTab.id }, () => chrome.tabs.remove(msgTab.id, () => {}));
        attachedTabs.delete(msgTab.id);
      }
      resolve(result);
    };

    const timeout = setTimeout(
      () => done({ alias: 'clientCompanyMetadata', status: 0, data: null, _debug: 'timeout' }),
      30000
    );

    const listener = async (source, method, params) => {
      if (!msgTab || source.tabId !== msgTab.id) return;

      // Accumulate extra headers (browser-added, incl. cookies) keyed by requestId
      if (method === 'Network.requestWillBeSentExtraInfo') {
        pendingHdrs[params.requestId] = Object.assign(
          pendingHdrs[params.requestId] || {}, params.headers || {}
        );
      }

      // First GQL request the page fires — capture its auth headers
      if (method === 'Network.requestWillBeSent' &&
          params.request?.url?.includes('api/graphql/v1') &&
          !capturedRequestId) {
        capturedRequestId = params.requestId;
        const h = Object.assign({}, params.request.headers || {}, pendingHdrs[params.requestId] || {});
        const authHdr   = h['authorization']          || h['Authorization']         || '';
        const tenantHdr = h['x-upwork-api-tenantid']  || h['X-Upwork-API-TenantId'] || '';
        const xsrfHdr   = h['x-xsrf-token']           || h['X-XSRF-TOKEN']          || '';
        console.log('[upwork-ext] clientCompanyMetadata: captured GQL headers — auth:', !!authHdr, 'tenant:', !!tenantHdr);

        const expr = `(async () => {
  try {
    const h = {
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'Origin': 'https://www.upwork.com',
      'Referer': 'https://www.upwork.com/ab/messages/rooms/'
    };
    if (${JSON.stringify(authHdr)})   h['Authorization']         = ${JSON.stringify(authHdr)};
    if (${JSON.stringify(tenantHdr)}) h['X-Upwork-API-TenantId'] = ${JSON.stringify(tenantHdr)};
    if (${JSON.stringify(xsrfHdr)})   h['X-XSRF-TOKEN']          = ${JSON.stringify(xsrfHdr)};
    const r = await fetch('https://www.upwork.com/api/graphql/v1', {
      method: 'POST', credentials: 'include', headers: h,
      body: JSON.stringify({
        query: 'query($uid: ID!) { clientCompanyMetadata(id: $uid) { rid uid name } }',
        variables: { uid: ${JSON.stringify(companyId)} }
      })
    });
    let d; try { d = await r.json(); } catch(_) { d = null; }
    return JSON.stringify({ status: r.status, data: d });
  } catch(e) { return JSON.stringify({ error: e.message }); }
})()`;

        try {
          const evalRes = await chrome.debugger.sendCommand(
            { tabId: msgTab.id }, 'Runtime.evaluate',
            { expression: expr, awaitPromise: true, returnByValue: true }
          );
          const out = evalRes.result?.value ? JSON.parse(evalRes.result.value) : null;
          console.log('[upwork-ext] clientCompanyMetadata HTTP', out?.status, 'companyId', companyId);
          done({ alias: 'clientCompanyMetadata', status: out?.status || 0, data: out?.data || null,
                 _debug: out?.error || (out?.status >= 400 ? 'http_' + out?.status : undefined) });
        } catch(e) {
          done({ alias: 'clientCompanyMetadata', status: 0, data: null, _debug: 'eval: ' + e.message });
        }
      }
    };

    try {
      msgTab = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: false }, r));
      attachedTabs.add(msgTab.id);
      chrome.debugger.onEvent.addListener(listener);
      await new Promise((res, rej) => {
        chrome.debugger.attach({ tabId: msgTab.id }, '1.3', async () => {
          if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
          try {
            await chrome.debugger.sendCommand({ tabId: msgTab.id }, 'Network.enable', {});
            await chrome.debugger.sendCommand({ tabId: msgTab.id }, 'Page.navigate',
              { url: 'https://www.upwork.com/ab/messages/rooms/' });
            res();
          } catch(e) { rej(e); }
        });
      });
    } catch(e) {
      done({ alias: 'clientCompanyMetadata', status: 0, data: null, _debug: 'tab: ' + e.message });
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

  // Token priority for job-scoped queries vs general queries.
  // Values injected as literals from background-harvested sessionTokens storage
  // (bypasses the HttpOnly restriction — document.cookie cannot see these cookies).
  // gc() is a fallback for non-HttpOnly cookies only.
  const jobToken    = ${JSON.stringify(storedTokens.JobDetailsNuxt_vt || storedTokens.oauth2_global_js_token || null)} || getCookie('JobDetailsNuxt_vt') || getCookie('oauth2_global_js_token');
  const globalToken = ${JSON.stringify(storedTokens.oauth2_global_js_token || storedTokens._bearer || null)} || getCookie('oauth2_global_js_token');
  const tenantId    = ${JSON.stringify(storedTokens.current_organization_uid || storedTokens._tenantId || null)} || getCookie('current_organization_uid');
  const xsrf        = ${JSON.stringify(storedTokens['XSRF-TOKEN'] || null)} || getCookie('XSRF-TOKEN');
  // Agency auth headers injected as literals from captured CDP requests (bypass HttpOnly)
  const agencyAuthInjected   = ${JSON.stringify(injectedAgencyAuth)};
  const agencyTenantInjected = ${JSON.stringify(injectedAgencyTenant)};

  if (!jobToken && !globalToken) {
    return JSON.stringify({ fatalError: 'No auth token — browse any Upwork page first so the extension can capture your session tokens.' });
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
    // Use the already-resolved token variables (which have injected values with cookie fallback)
    const tokensToTry = q.useJobToken
      ? [
          { name: 'job',    value: jobToken },
          { name: 'global', value: globalToken }
        ].filter(t => t.value)
      : [{ name: 'global', value: globalToken || jobToken }];

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
