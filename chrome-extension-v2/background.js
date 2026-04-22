importScripts('config.js');

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — TOKEN STORE
// ──────────────────────────────────────────────────────────────────────────────
// Cookie-based tokens are read directly via chrome.cookies API (reads HttpOnly
// cookies — a privilege only available to extensions, not page scripts).
// NO tab is opened for token refresh. If a cookie doesn't exist yet (user
// hasn't visited that microapp page), the value stays empty and the fallback
// chain kicks in at query time.
//
// Live-captured tokens (msgAuth, detailsAuth) require a single CDP tab opened
// ONCE per scrape run, then reused for all jobs in that run.
// ══════════════════════════════════════════════════════════════════════════════

const tokens = {
  // Read from chrome.cookies (HttpOnly-capable)
  UniversalSearchNuxt_vt: '',   // userJobSearch
  JobDetailsNuxt_vt:      '',   // jobAuthDetails (primary)
  FxJobPosting_vt:        '',   // jobAuthDetails (fallback)
  oauth2_global_js_token: '',   // fetchJobDetailsAndContext + global fallback
  ag_vs_ui_gql_token:     '',   // agency staff list
  xsrf:                   '',   // X-XSRF-TOKEN header
  tenantId:               '',   // X-Upwork-API-TenantId (global token only)
  lastRefresh:            0,

  // Live-captured: open messages/rooms ONCE per run, reuse for all restricted queries
  msgAuth:     '', // Authorization header value from messages/rooms page
  msgTenantId: '', // X-Upwork-API-TenantId from messages/rooms page
  msgXsrf:     '', // X-XSRF-TOKEN from messages/rooms page
  msgTs:       0,

  // Live-captured: open freelancer page ONCE per run, reuse for all getDetails calls
  detailsAuth: '',
  detailsXsrf: '',
  detailsTs:   0,

  // Live-captured: open a job page ONCE per run, reuse for all jobAuthDetails calls.
  // Fallback when cookie-based _vt tokens are missing/expired (e.g. after Cloudflare ban).
  jobDetailsAuth: '',
  jobDetailsXsrf: '',
  jobDetailsTs:   0,

  // Live-captured: open an agency page ONCE per run, reuse for all agencyStaffsAuth calls.
  // Any /agencies/<id>/ page (agency or not) fires GQL with the ag_vs_ui microapp token.
  // This token is session-scoped (not tied to a specific agency) so it works for all companyIds.
  agencyAuth:     '',
  agencyXsrf:     '',
  agencyTenantId: '',
  agencyTs:       0,

  // Live-captured: open search page ONCE per run — real token differs from UniversalSearchNuxt_vt cookie
  searchAuth:     '',
  searchTenantId: '',
  searchXsrf:     '',
  searchTs:       0,
};

// Restore persisted tokens on SW restart
chrome.storage.local.get(['v2_tokens'], s => {
  if (s.v2_tokens) Object.assign(tokens, s.v2_tokens);
});

function persistTokens() {
  chrome.storage.local.set({ v2_tokens: { ...tokens } });
}

function hasTokens() {
  // xsrf + tenantId come from cookies; search/job tokens are CDP-captured at runtime.
  // We just need xsrf + tenantId to confirm the user is logged in on Upwork.
  return !!(tokens.xsrf && tokens.tenantId);
}
function tokenAge() { return Date.now() - tokens.lastRefresh; }
function msgTokenFresh() { return !!tokens.msgAuth && (Date.now() - tokens.msgTs) < EXT_CONFIG_V2.MSG_TOKEN_TTL_MS; }
function detailsTokenFresh() { return !!tokens.detailsAuth && (Date.now() - tokens.detailsTs) < EXT_CONFIG_V2.DETAILS_TOKEN_TTL_MS; }
function searchTokenFresh() { return !!tokens.searchAuth && (Date.now() - tokens.searchTs) < EXT_CONFIG_V2.MSG_TOKEN_TTL_MS; }
function agencyTokenFresh() { return !!tokens.agencyAuth && !!tokens.agencyTenantId && (Date.now() - tokens.agencyTs) < EXT_CONFIG_V2.MSG_TOKEN_TTL_MS; }

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const log  = (msg, ...a) => console.log(`[v2] ${msg}`, ...a);
const warn = (msg, ...a) => console.warn(`[v2] ${msg}`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryJson = s => { try { return JSON.parse(s); } catch(_) { return null; } };

function storageGet(key) {
  return new Promise(r => chrome.storage.local.get([key], s => r(s[key] ?? null)));
}
function storageSet(key, val) {
  return new Promise(r => chrome.storage.local.set({ [key]: val }, r));
}

// Upwork ciphertext → numeric openingId: "~021234567890" → "1234567890"
function cipherToOpeningId(cipher) {
  if (!cipher || typeof cipher !== 'string') return '';
  return cipher.replace(/^~0./, ''); // remove ~0 + one char prefix
}

// Broadcast a progress update to any open popup
function broadcastProgress(data) {
  chrome.storage.local.set({ v2_progress: { ...data, ts: Date.now() } });
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — GQL QUERY STRINGS
// ══════════════════════════════════════════════════════════════════════════════

const Q_USER_JOB_SEARCH = `
query UserJobSearch($requestVariables: UserJobSearchV1Request!) {
  search {
    universalSearchNuxt {
      userJobSearchV1(request: $requestVariables) {
        paging { total }
        results { id }
      }
    }
  }
}`;

// Full job auth details (identical to v1 — using proven fragment structure)
const Q_JOB_AUTH_DETAILS = `fragment JobPubOpeningInfoFragment on Job { ciphertext id type access title hideBudget createdOn notSureProjectDuration notSureFreelancersToHire notSureExperienceLevel premium }
fragment JobPubOpeningSegmentationDataFragment on JobSegmentation { customValue label name sortOrder type value }
fragment JobPubOpeningSandDataFragment on SandsData { occupation { freeText ontologyId prefLabel id uid: id } ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance } additionalSkills { groupId id freeText prefLabel relevance } }
fragment JobPubOpeningFragment on JobPubOpeningInfo { status postedOn publishTime sourcingTime startDate deliveryDate workload contractorTier description info { ...JobPubOpeningInfoFragment } segmentationData { ...JobPubOpeningSegmentationDataFragment } sandsData { ...JobPubOpeningSandDataFragment } category { name urlSlug } categoryGroup { name urlSlug } budget { amount currencyCode } annotations { customFields tags } engagementDuration { label weeks } extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType } attachments @include(if: $isLoggedIn) { fileName length uri } clientActivity { lastBuyerActivity totalApplicants totalHired totalInvitedToInterview unansweredInvites invitationsSent numberOfPositionsToHire } deliverables deadline tools { name } }
fragment JobQualificationsFragment on JobQualifications { countries earnings groupRecno languages localDescription localFlexibilityDescription localMarket minJobSuccessScore minOdeskHours onSiteType prefEnglishSkill regions risingTalent shouldHavePortfolio states tests timezones type locationCheckRequired group { groupId groupLogo groupName } location { city country countryTimezone offsetFromUtcMillis state worldRegion } locations { id type } minHoursWeek @skip(if: $isLoggedIn) }
fragment JobAuthDetailsOpeningFragment on JobAuthOpeningInfo { job { ...JobPubOpeningFragment } qualifications { ...JobQualificationsFragment } questions { question position } }
fragment JobPubBuyerInfoFragment on JobPubBuyerInfo { location { offsetFromUtcMillis countryTimezone city country } stats { totalAssignments activeAssignmentsCount hoursCount feedbackCount score totalJobsWithHires totalCharges { amount } } company { name @include(if: $isLoggedIn) companyId @include(if: $isLoggedIn) isEDCReplicated contractDate profile { industry size } } jobs { openCount postedCount @include(if: $isLoggedIn) openJobs { id uid: id isPtcPrivate ciphertext title type } } avgHourlyJobsRate @include(if: $isLoggedIn) { amount } }
fragment JobAuthDetailsBuyerWorkHistoryFragment on BuyerWorkHistoryItem { isPtcJob status isEDCReplicated isPtcPrivate startDate endDate totalCharge totalHours jobInfo { title id uid: id access type ciphertext } contractorInfo { contractorName accessType ciphertext } rate { amount } feedback { feedbackSuppressed score comment } feedbackToClient { feedbackSuppressed score comment } }
fragment JobAuthDetailsBuyerFragment on JobAuthBuyerInfo { enterprise isPaymentMethodVerified info { ...JobPubBuyerInfoFragment } workHistory { ...JobAuthDetailsBuyerWorkHistoryFragment } }
fragment JobAuthDetailsCurrentUserInfoFragment on JobCurrentUserInfo { owner freelancerInfo { profileState applied devProfileCiphertext hired application { vjApplicationId } pendingInvite { inviteId } contract { contractId status } hourlyRate { amount } qualificationsMatches { matches { clientPreferred clientPreferredLabel freelancerValue freelancerValueLabel qualification qualified } } } }
query JobAuthDetailsQuery($id: ID! $isFreelancerOrAgency: Boolean! $isLoggedIn: Boolean!) { jobAuthDetails(id: $id) { hiredApplicantNames opening { ...JobAuthDetailsOpeningFragment } buyer { ...JobAuthDetailsBuyerFragment } currentUserInfo { ...JobAuthDetailsCurrentUserInfoFragment } similarJobs { id uid: id ciphertext title snippet } workLocation { onSiteCity onSiteCountry onSiteReason onSiteReasonFlexible onSiteState onSiteType } phoneVerificationStatus { status } applicantsBidsStats { avgRateBid { amount currencyCode } minRateBid { amount currencyCode } maxRateBid { amount currencyCode } } specializedProfileOccupationId @include(if: $isFreelancerOrAgency) applicationContext @include(if: $isFreelancerOrAgency) { freelancerAllowed clientAllowed } } }`;

// Restricted fields (logo, avgHourlyJobsRate, cssTier, visible, l3Occupations) removed —
// they cause ExecutionAborted with the messages/rooms microapp token.
const Q_CLIENT_INFO_BY_OPENING = `
query clientInfoByOpening($openingId: ID!) {
  clientInfoByOpening(openingId: $openingId) {
    buyer {
      info {
        company { contractDate name profile { industry size } id: companyId }
        location { country city state countryTimezone worldRegion offsetFromUtcMillis }
        jobs { postedCount filledCount openCount }
        stats { feedbackCount hoursCount totalCharges { amount currencyCode }
                totalAssignments activeAssignmentsCount score totalJobsWithHires }
      }
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

const Q_CLIENT_COMPANY_METADATA = `
query($uid: ID!) {
  clientCompanyMetadata(id: $uid) { rid uid name }
}`;

const Q_AGENCY_STAFFS = `
query getAgencyStaffsAuth($agencyId: ID!, $agencyTeamId: ID!, $limit: Int, $offset: String) {
  agencyStaffsAuth(agencyId: $agencyId agencyTeamId: $agencyTeamId limit: $limit offset: $offset) {
    totalCount
    staffs {
      id agencyOwner memberType vetted active canBeViewed
      personalData { id rid name portrait ciphertext topRatedStatus topRatedPlusStatus
                     jobSuccessScore }
    }
  }
}`;

const Q_GET_TALENT_PROFILE = `
query GetTalentProfile($profileUrl: String, $viewerMode: Boolean) {
  talentVPDAuthProfile(filter: {
    profileUrl: $profileUrl, viewerMode: $viewerMode,
    excludePortfolio: true, excludeAgencies: false
  }) {
    identity { uid: id id userId ciphertext recno }
    profile { name title description location { country city state }
              portrait { portrait } skills { node { id name prettyName } } }
    stats { totalHours totalFeedback rating
            hourlyRate { node { currencyCode amount } }
            memberSince totalEarnings topRatedStatus topRatedPlusStatus }
    agencies { name logo recentHours score recno scoreRecent totalFeedback totalHours
               agencyRate { node { currencyCode amount } }
               ciphertext uid: id id defaultAgency }
    languages { language { englishName } proficiencyLevel { proficiencyTitle } }
    vettedBadge { vetted }
  }
}`;

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — DIRECT API LAYER (no tabs — runs from service worker)
// ──────────────────────────────────────────────────────────────────────────────
// The SW has host_permissions for *.upwork.com, so it can fetch() directly.
// We supply the Authorization header explicitly using stored/captured tokens.
// No credentials:include needed — bearer token auth is stateless.
// ══════════════════════════════════════════════════════════════════════════════

async function gql(alias, query, variables, auth, opts = {}) {
  const { tenantId = '', xsrf = tokens.xsrf, timeoutMs = 20000 } = opts;
  const url = alias
    ? `https://www.upwork.com/api/graphql/v1?alias=${encodeURIComponent(alias)}`
    : 'https://www.upwork.com/api/graphql/v1';

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Upwork-Accept-Language': 'en-US',
  };
  if (auth) {
    headers['Authorization'] = (auth.toLowerCase().startsWith('bearer ') ? '' : 'bearer ') + auth;
  }
  if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
  if (tenantId) headers['X-Upwork-API-TenantId'] = tenantId;

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r    = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: ctrl.signal });
    // Cloudflare 429 / 1015 rate-limit: back off and retry once
    if (r.status === 429 || r.status === 1015) {
      clearTimeout(tid);
      const backoff = 15000 + Math.floor(Math.random() * 10000);
      warn('gql: rate-limited (HTTP', r.status, ') — backing off', Math.round(backoff/1000), 's then retrying');
      await sleep(backoff);
      const r2    = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
      const text2 = await r2.text();
      return { status: r2.status, data: tryJson(text2) };
    }
    const text = await r.text();
    return { status: r.status, data: tryJson(text) };
  } catch(e) {
    return { status: 0, data: null, error: e.message };
  } finally {
    clearTimeout(tid);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — TOKEN REFRESH (zero tabs — uses chrome.cookies)
// ──────────────────────────────────────────────────────────────────────────────
// chrome.cookies.getAll() in an extension reads ALL cookies including HttpOnly.
// The _vt cookie values ARE the OAuth bearer tokens — we store them directly.
// ══════════════════════════════════════════════════════════════════════════════

let _refreshLock = false;

async function refreshTokens(force = false) {
  if (_refreshLock) return false;
  if (!force && tokenAge() < EXT_CONFIG_V2.TOKEN_REFRESH_INTERVAL_MS && hasTokens()) return true;

  _refreshLock = true;
  try {
    // Read all upwork.com cookies (incl. HttpOnly) — no tab needed
    const cookies = await new Promise(r => chrome.cookies.getAll({ domain: '.upwork.com' }, r));
    const getCk = name => {
      const c = cookies.find(c => c.name === name);
      return c ? decodeURIComponent(c.value) : '';
    };

    // Only overwrite if non-empty (preserve stale value as fallback)
    const upd = (key, val) => { if (val) tokens[key] = val; };
    upd('UniversalSearchNuxt_vt', getCk('UniversalSearchNuxt_vt'));
    upd('JobDetailsNuxt_vt',      getCk('JobDetailsNuxt_vt'));
    upd('FxJobPosting_vt',        getCk('FxJobPosting_vt'));
    upd('oauth2_global_js_token', getCk('oauth2_global_js_token'));
    upd('ag_vs_ui_gql_token',     getCk('ag_vs_ui_gql_token'));
    upd('xsrf',                   getCk('XSRF-TOKEN'));
    upd('tenantId',               getCk('current_organization_uid'));

    tokens.lastRefresh = Date.now();
    persistTokens();
    log('refreshTokens (cookies)', {
      search: !!tokens.UniversalSearchNuxt_vt, job: !!tokens.JobDetailsNuxt_vt,
      global: !!tokens.oauth2_global_js_token, xsrf: !!tokens.xsrf, tenant: !!tokens.tenantId
    });
    return hasTokens();
  } catch(e) {
    warn('refreshTokens error:', e.message);
    return false;
  } finally {
    _refreshLock = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — LIVE TOKEN CAPTURES (CDP, ONE tab per run)
// ──────────────────────────────────────────────────────────────────────────────
// Two restricted queries need a live runtime token that cannot be read from
// cookies: companyBuyer and clientCompanyMetadata use the messages/rooms
// microapp token; getDetails uses the talentVPD microapp token.
// Each is captured ONCE per scrape run and shared across all jobs.
// ══════════════════════════════════════════════════════════════════════════════

// ── Shared CDP capture helper ──────────────────────────────────────────────────
// Fixes the ExtraInfo race condition: Chrome can emit Network.requestWillBeSentExtraInfo
// (which carries the browser-injected Authorization header) either BEFORE or AFTER
// Network.requestWillBeSent for the same requestId. We store both sides and match them
// bi-directionally so neither ordering is missed.
//
// urlMatch: function(url) → bool — determines which requests to capture from
// Returns { auth, tenantId, xsrf } or null on timeout.
async function _cdpCapture(tabId, urlMatch, timeoutMs, requireTenantId = false) {
  const extraHdrs = new Map();  // requestId → { auth, tenantId }
  const pendingWBS = new Map(); // requestId → { rh }  (requestWillBeSent arrived first)

  return new Promise(resolve => {
    const done = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    const finish = result => {
      clearTimeout(done);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(result);
    };

    const tryResolve = (rh, extra) => {
      const auth = extra?.auth || rh['Authorization'] || rh['authorization'] || '';
      const tid  = extra?.tenantId || rh['X-Upwork-API-TenantId'] || rh['x-upwork-api-tenantid'] || '';
      const xsrf = rh['X-XSRF-TOKEN'] || rh['x-xsrf-token'] || tokens.xsrf || '';
      if (!auth || !auth.toLowerCase().includes('bearer')) return false;
      if (requireTenantId && !tid) return false; // skip tokens without tenantId
      finish({ auth, tenantId: tid, xsrf });
      return true;
    };

    const listener = (src, method, params) => {
      if (src.tabId !== tabId) return;

      if (method === 'Network.requestWillBeSentExtraInfo') {
        const h    = params.headers || {};
        const auth = h['Authorization'] || h['authorization'] || '';
        const tid  = h['X-Upwork-API-TenantId'] || h['x-upwork-api-tenantid'] || '';
        if (!auth && !tid) return;
        const extra = { auth, tenantId: tid };

        if (pendingWBS.has(params.requestId)) {
          // requestWillBeSent already arrived — process now
          const { rh } = pendingWBS.get(params.requestId);
          pendingWBS.delete(params.requestId);
          tryResolve(rh, extra);
        } else {
          // Store and wait for requestWillBeSent
          extraHdrs.set(params.requestId, extra);
        }
      }

      if (method === 'Network.requestWillBeSent') {
        const url = params.request?.url || '';
        if (!urlMatch(url)) return;
        const rh = params.request.headers || {};

        if (extraHdrs.has(params.requestId)) {
          // ExtraInfo already arrived — process now
          const extra = extraHdrs.get(params.requestId);
          extraHdrs.delete(params.requestId);
          tryResolve(rh, extra);
        } else {
          // Store and wait for requestWillBeSentExtraInfo
          pendingWBS.set(params.requestId, { rh });
        }
      }
    };

    chrome.debugger.onEvent.addListener(listener);
  });
}

// Open a tab, attach CDP, navigate, capture first matching GQL auth.
// active=false for background captures (messages/rooms — fires GQL early in load)
// active=true when the page needs JS hydration to trigger the GQL call (freelancer page)
async function _cdpCaptureTab(navUrl, urlMatch, timeoutMs, requireTenantId = false, active = false) {
  let tabId = null;
  try {
    const t = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active }, r));
    tabId = t.id;
    await new Promise((res, rej) => chrome.debugger.attach({ tabId }, '1.3', () =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
    ));
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable',
      { maxResourceBufferSize: 5 * 1024 * 1024, maxTotalBufferSize: 20 * 1024 * 1024 });
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    // Start capture listener BEFORE navigate so no events are missed
    const capturePromise = _cdpCapture(tabId, urlMatch, timeoutMs, requireTenantId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: navUrl });
    return await capturePromise;
  } finally {
    if (tabId) {
      try { chrome.debugger.detach({ tabId }, () => {}); } catch(_) {}
      chrome.tabs.remove(tabId, () => {});
    }
  }
}

// ── captureSearchPage ─────────────────────────────────────────────────────────
// Opens a VISIBLE (active:true) tab — required so Chrome doesn't throttle Vue/Nuxt
// hydration in background tabs. Navigates to search page 1 (SSR), waits for the
// search page to finish loading (via Page.frameNavigated + Page.loadEventFired),
// then CLICKS the "Next Page" button to trigger the SPA navigation that fires
// userJobSearch with the real runtime oauth2v2_int_* token.
//
// Key timing fix: Page.loadEventFired fires for about:blank immediately after
// Page.enable is called (before our Page.navigate). We guard against this by
// only reacting to loadEventFired AFTER Page.frameNavigated has confirmed we
// are actually on the Upwork search page.
//
// Returns { auth, xsrf, firstPage: { total, ciphers } } or null on timeout.
async function captureSearchPage(searchUrl) {
  const page1Url = (() => {
    try {
      const u = new URL(searchUrl || EXT_CONFIG_V2.SEARCH_URL);
      u.searchParams.set('nbs', '1');
      u.searchParams.delete('page');
      return u.toString();
    } catch(_) { return EXT_CONFIG_V2.SEARCH_URL; }
  })();

  // Fallback: if Next Page button not found, navigate directly to page 2 URL
  const page2Url = (() => {
    try {
      const u = new URL(page1Url);
      u.searchParams.set('page', '2');
      return u.toString();
    } catch(_) { return page1Url + '&page=2'; }
  })();

  let tabId = null;
  try {
    // active: true — prevents Chrome background-tab JS throttling that kills Vue hydration
    const t = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: true }, r));
    tabId = t.id;

    await new Promise((res, rej) => chrome.debugger.attach({ tabId }, '1.3', () =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
    ));

    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});

    // Suppress navigator.webdriver to avoid bot-detection serving a no-JS page
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument',
        { source: `Object.defineProperty(navigator,'webdriver',{get:()=>undefined});` });
    } catch(_) {}

    await chrome.debugger.sendCommand({ tabId }, 'Network.enable',
      { maxResourceBufferSize: 50 * 1024 * 1024, maxTotalBufferSize: 200 * 1024 * 1024 });

    const result = await new Promise(resolve => {
      const timeoutHandle = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener);
        warn('captureSearchPage: timed out waiting for userJobSearch');
        resolve(null);
      }, 50000);

      const finish = val => {
        clearTimeout(timeoutHandle);
        chrome.debugger.onEvent.removeListener(listener);
        resolve(val);
      };

      const extraHdrs  = new Map();
      const pendingWBS = new Map();
      const capturedAuth = { auth: null, xsrf: null };
      let searchRequestId = null;

      // TIMING GUARD: only allow loadEventFired to trigger the click AFTER
      // Page.frameNavigated has confirmed we are on the Upwork search page.
      // Without this, Page.enable fires loadEventFired for about:blank immediately,
      // setting the flag before the real search page navigation even starts.
      let onSearchPage = false;
      let clickScheduled = false;
      const ssrCiphers = [];

      const tryMatchHeaders = (rh, extra) => {
        const auth = (extra?.auth || rh['Authorization'] || rh['authorization'] || '').trim();
        const xsrf = (extra?.xsrf || rh['X-XSRF-TOKEN'] || rh['x-xsrf-token'] || tokens.xsrf || '').trim();
        if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;
        capturedAuth.auth = auth;
        capturedAuth.xsrf = xsrf;
        log('captureSearchPage: auth captured:', auth.slice(0, 35));
        return true;
      };

      const doClickOrNavigate = async () => {
        // Try clicking the Next Page button (SPA nav → fires userJobSearch)
        try {
          const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(() => {
              const selectors = [
                '[data-test="pagination-next"] a',
                '[data-test="pagination-next"]',
                'button[aria-label="Next page"]', 'a[aria-label="Next page"]',
                '[data-ev-label="pagination_next"]', '.air3-pagination a[href*="page=2"]',
                'nav[aria-label*="agination"] a:last-child', '[data-cy="pagination-btn-next"]',
                'a[href*="page=2"]'
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && !el.hasAttribute('disabled') && !el.classList.contains('disabled')) {
                  el.click(); return sel;
                }
              }
              // Debug: return article count so we know if the page rendered
              return 'no-button articles=' + document.querySelectorAll('article').length;
            })()`,
            returnByValue: true
          });
          const sel = res?.result?.value || 'error';
          log('captureSearchPage: Next Page attempt →', sel);
          if (sel && !sel.startsWith('no-button')) return; // clicked successfully
        } catch(e) {
          warn('captureSearchPage: click error:', e.message);
        }
        // Fallback: direct URL navigation to page 2 (fires GQL if SPA is hydrated)
        log('captureSearchPage: falling back to direct page-2 URL navigation');
        chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: page2Url });
      };

      const listener = async (src, method, params) => {
        if (src.tabId !== tabId) return;

        // Step 1: detect when the search page navigation starts
        if (method === 'Page.frameNavigated') {
          const url = params.frame?.url || '';
          if (url.includes('upwork.com') &&
              (url.includes('search/jobs') || url.includes('/nx/search')) &&
              !url.includes('page=2')) {
            onSearchPage = true;
            log('captureSearchPage: search page frame navigated to:', url.slice(0, 100));
          }
        }

        // Step 2: once the search page has loaded, extract SSR page-1 ciphers then click Next Page.
        // Page 1 is server-side rendered — no GQL fires for it, so job IDs must be read from
        // the Nuxt state embedded in the HTML (__NUXT_DATA__ or window.__NUXT__).
        if (method === 'Page.loadEventFired' && onSearchPage && !clickScheduled) {
          clickScheduled = true;
          log('captureSearchPage: page-1 loaded — extracting SSR ciphers before click...');
          try {
            const evalRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
              expression: `(() => {
                const cs = new Set();
                // Nuxt 3: __NUXT_DATA__ script tag
                try {
                  const el = document.getElementById('__NUXT_DATA__');
                  if (el) JSON.stringify(JSON.parse(el.textContent)).replace(/"(~[0-9A-Za-z]{10,})"/g, (_, c) => cs.add(c));
                } catch(e) {}
                // Nuxt 2: window.__NUXT__
                if (!cs.size && window.__NUXT__) {
                  try { JSON.stringify(window.__NUXT__).replace(/"(~[0-9A-Za-z]{10,})"/g, (_, c) => cs.add(c)); } catch(e) {}
                }
                // Fallback: extract from job link hrefs
                if (!cs.size) {
                  document.querySelectorAll('a[href*="/jobs/"]').forEach(a => {
                    const m = a.href.match(/_(~[0-9A-Za-z]{10,})/);
                    if (m) cs.add(m[1]);
                  });
                }
                return JSON.stringify([...cs]);
              })()`,
              returnByValue: true
            });
            const raw = evalRes?.result?.value ? JSON.parse(evalRes.result.value) : [];
            ssrCiphers.push(...raw);
            log('captureSearchPage: SSR page-1 ciphers:', ssrCiphers.length);
          } catch(e) {
            warn('captureSearchPage: SSR extraction error:', e.message);
          }
          setTimeout(doClickOrNavigate, 3000);
        }

        // Capture Authorization header from the userJobSearch request
        if (method === 'Network.requestWillBeSentExtraInfo') {
          const h    = params.headers || {};
          const auth = h['Authorization'] || h['authorization'] || '';
          const xsrf = h['X-XSRF-TOKEN'] || h['x-xsrf-token'] || '';
          if (!auth) return;
          const extra = { auth, xsrf };
          if (pendingWBS.has(params.requestId)) {
            pendingWBS.delete(params.requestId);
            tryMatchHeaders({}, extra);
          } else {
            extraHdrs.set(params.requestId, extra);
          }
        }

        if (method === 'Network.requestWillBeSent') {
          const url = params.request?.url || '';
          if (!url.includes('alias=userJobSearch')) return;
          searchRequestId = params.requestId;
          const rh = params.request.headers || {};
          if (extraHdrs.has(params.requestId)) {
            const extra = extraHdrs.get(params.requestId);
            extraHdrs.delete(params.requestId);
            tryMatchHeaders(rh, extra);
          } else {
            pendingWBS.set(params.requestId, true);
            tryMatchHeaders(rh, null);
          }
          log('captureSearchPage: userJobSearch request intercepted, requestId:', searchRequestId);
        }

        // Fetch the response body once the GQL request finishes loading
        if (method === 'Network.loadingFinished') {
          if (params.requestId !== searchRequestId) return;
          try {
            const resp = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody',
              { requestId: params.requestId });
            const body = resp?.body ? (resp.base64Encoded ? atob(resp.body) : resp.body) : null;
            if (!body) {
              finish(capturedAuth.auth ? { auth: capturedAuth.auth, xsrf: capturedAuth.xsrf, firstPage: null, ssrCiphers } : null);
              return;
            }
            let parsed = null;
            try { parsed = JSON.parse(body); } catch(_) {}
            const ujsData = parsed?.data?.search?.universalSearchNuxt?.userJobSearchV1;
            if (!ujsData) {
              log('captureSearchPage: response parsed but no ujsData — errors:', JSON.stringify(parsed?.errors)?.slice(0, 200));
              finish(capturedAuth.auth ? { auth: capturedAuth.auth, xsrf: capturedAuth.xsrf, firstPage: null, ssrCiphers } : null);
              return;
            }
            const total = ujsData.paging?.total || 0;
            const ciphers = (ujsData.results || []).map(r => {
              const c = r?.jobTile?.job?.ciphertext || r?.jobTile?.job?.id || r?.id || null;
              if (!c) return null;
              return String(c).startsWith('~') ? String(c) : '~02' + String(c);
            }).filter(Boolean);
            log('captureSearchPage: success — total:', total, 'page-2 ciphers:', ciphers.length, 'ssr page-1 ciphers:', ssrCiphers.length);
            finish({ auth: capturedAuth.auth, xsrf: capturedAuth.xsrf, firstPage: { total, ciphers }, ssrCiphers });
          } catch(e) {
            warn('captureSearchPage: getResponseBody failed:', e.message);
            finish(capturedAuth.auth ? { auth: capturedAuth.auth, xsrf: capturedAuth.xsrf, firstPage: null, ssrCiphers } : null);
          }
        }
      };

      chrome.debugger.onEvent.addListener(listener);
      chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: page1Url });
    });

    return result;
  } catch(e) {
    warn('captureSearchPage error:', e.message);
    return null;
  } finally {
    if (tabId) {
      try { chrome.debugger.detach({ tabId }, () => {}); } catch(_) {}
      chrome.tabs.remove(tabId, () => {});
    }
  }
}

// Keep captureSearchAuth as a thin alias for backward compat with token-only callers
async function captureSearchAuth(searchUrl) {
  const r = await captureSearchPage(searchUrl);
  if (!r) return null;
  tokens.searchAuth = r.auth; tokens.searchXsrf = r.xsrf || tokens.xsrf; tokens.searchTs = Date.now();
  persistTokens();
  return r;
}

// ── captureMessagesRoomsAuth ──────────────────────────────────────────────────
let _msgCaptureLock = false;

async function captureMessagesRoomsAuth() {
  if (msgTokenFresh()) return { auth: tokens.msgAuth, tenantId: tokens.msgTenantId, xsrf: tokens.msgXsrf };
  if (_msgCaptureLock) {
    for (let i = 0; i < 70; i++) { await sleep(500); if (!_msgCaptureLock) break; }
    if (msgTokenFresh()) return { auth: tokens.msgAuth, tenantId: tokens.msgTenantId, xsrf: tokens.msgXsrf };
    return null;
  }
  _msgCaptureLock = true;
  try {
    const captured = await _cdpCaptureTab(
      'https://www.upwork.com/ab/messages/rooms/',
      url => url.includes('api/graphql/v1'),
      30000,
      true  // requireTenantId — main messages/rooms token always sends it; skip unrelated microapp tokens
    );
    if (captured) {
      tokens.msgAuth = captured.auth; tokens.msgTenantId = captured.tenantId;
      tokens.msgXsrf = captured.xsrf || tokens.xsrf; tokens.msgTs = Date.now();
      persistTokens();
      log('captureMessagesRoomsAuth: ok, tenant:', !!captured.tenantId);
    } else {
      warn('captureMessagesRoomsAuth: timed out');
    }
    return captured;
  } catch(e) {
    warn('captureMessagesRoomsAuth error:', e.message); return null;
  } finally {
    _msgCaptureLock = false;
  }
}

// ── captureDetailsAuth ────────────────────────────────────────────────────────
async function captureDetailsAuth() {
  if (detailsTokenFresh()) return { auth: tokens.detailsAuth, xsrf: tokens.detailsXsrf };
  try {
    const captured = await _cdpCaptureTab(
      'https://www.upwork.com/freelancers/moezz',
      url => url.includes('alias=getDetails'),
      30000,
      false,
      true  // active: true — page needs JS hydration to fire getDetails GQL
    );
    if (captured) {
      tokens.detailsAuth = captured.auth; tokens.detailsXsrf = captured.xsrf || tokens.xsrf;
      tokens.detailsTs = Date.now();
      persistTokens();
      log('captureDetailsAuth: ok');
    } else {
      warn('captureDetailsAuth: timed out');
    }
    return captured;
  } catch(e) {
    warn('captureDetailsAuth error:', e.message); return null;
  }
}

// ── captureJobDetailsAuth ─────────────────────────────────────────────────────
// Opens a real job page ONCE per run to capture the JobDetailsNuxt microapp
// Authorization token via CDP. Used as a live-token fallback when cookie-based
// _vt tokens are missing or expired (e.g. after a Cloudflare rate-limit reset).
let _jobDetailsCaptureLock = false;

async function captureJobDetailsAuth(cipher) {
  const TTL = EXT_CONFIG_V2.DETAILS_TOKEN_TTL_MS;
  if (tokens.jobDetailsAuth && (Date.now() - tokens.jobDetailsTs) < TTL) {
    return { auth: tokens.jobDetailsAuth, xsrf: tokens.jobDetailsXsrf };
  }
  if (_jobDetailsCaptureLock) {
    for (let i = 0; i < 40; i++) { await sleep(500); if (!_jobDetailsCaptureLock) break; }
    if (tokens.jobDetailsAuth) return { auth: tokens.jobDetailsAuth, xsrf: tokens.jobDetailsXsrf };
    return null;
  }
  _jobDetailsCaptureLock = true;
  try {
    // Upwork redirects unknown-title job URLs to the correct page — GQL still fires.
    const jobUrl = `https://www.upwork.com/jobs/placeholder_${cipher}/`;
    const captured = await _cdpCaptureTab(
      jobUrl,
      url => url.includes('api/graphql/v1'),
      35000,
      false,
      true  // active: true — needs JS hydration to fire job details GQL
    );
    if (captured) {
      tokens.jobDetailsAuth = captured.auth;
      tokens.jobDetailsXsrf = captured.xsrf || tokens.xsrf;
      tokens.jobDetailsTs   = Date.now();
      persistTokens();
      log('captureJobDetailsAuth: ok', captured.auth.slice(0, 30));
    } else {
      warn('captureJobDetailsAuth: timed out for cipher', cipher);
    }
    return captured;
  } catch(e) {
    warn('captureJobDetailsAuth error:', e.message); return null;
  } finally {
    _jobDetailsCaptureLock = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — QUEUE (concurrency control)
// ══════════════════════════════════════════════════════════════════════════════

class Queue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.running     = 0;
    this.pending     = [];
  }
  add(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this._tick();
    });
  }
  _tick() {
    while (this.running < this.concurrency && this.pending.length) {
      const { task, resolve, reject } = this.pending.shift();
      this.running++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        this.running--;
        this._tick();
      });
    }
  }
  get size() { return this.pending.length + this.running; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — AGENCY LOOKUP (batched per unique companyId, token cached per run)
// ══════════════════════════════════════════════════════════════════════════════

const agencyCache   = new Map();  // companyId → profiles[] (per SW lifetime)
const agencyPending = new Map();  // companyId → Promise (dedup concurrent requests)
let _agencyCaptureLock = false;   // prevents concurrent captureAgencyStaffs calls

// Fixed known-agency URL used for every token capture — we always load the SAME
// page, capture the ag_vs_ui OAuth headers, then replay agencyStaffsAuth with
// the actual job companyId in the GQL variables. Never route to per-job URLs.
const AGENCY_CAPTURE_URL = 'https://www.upwork.com/agencies/2012207015295215238/';

// ── captureAgencyStaffs ──────────────────────────────────────────────────────
// Opens the fixed known-agency page via CDP, captures the ag_vs_ui microapp
// auth headers from the first GQL request the page fires (which has both
// Authorization + X-Upwork-API-TenantId), then closes the tab.
// Returns { auth, tenantId, xsrf } — caller fires agencyStaffsAuth with the
// real companyId in the variables.
async function captureAgencyStaffs() {
  let tabId = null;
  let done  = false;

  return new Promise(async (resolve) => {
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      if (tabId) {
        try { chrome.debugger.detach({ tabId }, () => {}); } catch(_) {}
        chrome.tabs.remove(tabId, () => {});
        tabId = null;
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      warn('captureAgencyStaffs: timeout for', companyId);
      finish(null);
    }, 20000);

    const extraHdrs  = new Map();
    const pendingWBS = new Map();

    const tryResolve = (rh, extra) => {
      const auth = extra?.auth || rh['Authorization'] || rh['authorization'] || '';
      const tid  = extra?.tenantId || rh['X-Upwork-API-TenantId'] || rh['x-upwork-api-tenantid'] || '';
      const xsrf = rh['X-XSRF-TOKEN'] || rh['x-xsrf-token'] || tokens.xsrf || '';
      if (!auth || !auth.toLowerCase().includes('bearer')) return false;
      if (!tid) return false; // agencyStaffsAuth requires tenantId — skip requests without it
      log('captureAgencyStaffs: captured ag_vs_ui headers — auth: true tenant: true');
      finish({ auth, tenantId: tid, xsrf });
      return true;
    };

    const listener = (src, method, params) => {
      if (!tabId || src.tabId !== tabId) return;

      if (method === 'Network.requestWillBeSentExtraInfo') {
        const h    = params.headers || {};
        const auth = h['Authorization'] || h['authorization'] || '';
        const tid  = h['X-Upwork-API-TenantId'] || h['x-upwork-api-tenantid'] || '';
        if (!auth && !tid) return;
        const extra = { auth, tenantId: tid };
        if (pendingWBS.has(params.requestId)) {
          const { rh } = pendingWBS.get(params.requestId);
          pendingWBS.delete(params.requestId);
          tryResolve(rh, extra);
        } else {
          extraHdrs.set(params.requestId, extra);
        }
      }

      if (method === 'Network.requestWillBeSent') {
        const url = params.request?.url || '';
        if (!url.includes('api/graphql/v1')) return;
        const rh = params.request.headers || {};
        if (extraHdrs.has(params.requestId)) {
          const extra = extraHdrs.get(params.requestId);
          extraHdrs.delete(params.requestId);
          tryResolve(rh, extra);
        } else {
          pendingWBS.set(params.requestId, { rh });
        }
      }
    };

    try {
      const t = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: true }, r));
      tabId = t.id;

      chrome.debugger.onEvent.addListener(listener);

      await new Promise((res, rej) => chrome.debugger.attach({ tabId }, '1.3', () =>
        chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
      ));
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable',
        { maxResourceBufferSize: 5 * 1024 * 1024, maxTotalBufferSize: 20 * 1024 * 1024 });
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
      await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
        source: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });'
      });
      await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: AGENCY_CAPTURE_URL });
    } catch(e) {
      warn('captureAgencyStaffs: setup error:', e.message);
      if (tabId) {
        try { chrome.debugger.detach({ tabId }, () => {}); } catch(_) {}
        chrome.tabs.remove(tabId, () => {});
      }
      finish(null);
    }
  });
}

async function runAgencyLookup(companyId, detailsHeaders) {
  if (agencyCache.has(companyId)) return agencyCache.get(companyId);
  if (agencyPending.has(companyId)) return agencyPending.get(companyId);

  const promise = _doAgencyLookup(companyId, detailsHeaders);
  agencyPending.set(companyId, promise);
  try {
    const result = await promise; // { profiles, rawStaffs, rawProfiles }
    agencyCache.set(companyId, result);
    return result;
  } finally {
    agencyPending.delete(companyId);
  }
}

async function _doAgencyLookup(companyId, detailsHeaders) {
  const empty = { profiles: [], rawStaffs: null, rawProfiles: [] };
  try {
    // ── Phase 1: fire agencyStaffsAuth (direct call — no tab per job) ────────
    //
    // Strategy:
    //  1. If tokens.agencyAuth is fresh → use it directly (no tab needed).
    //  2. If stale/missing → open AGENCY_CAPTURE_URL ONCE via CDP to capture the
    //     ag_vs_ui microapp token, store globally, then fire the query with the
    //     real companyId in the variables.
    //  3. If agencyStaffsAuth returns "Authorization failed" → not an agency, return empty.
    //  4. If agencyStaffsAuth returns 200 → agency found, proceed to Phase 2.
    //
    // The ag_vs_ui token is session-scoped (not tied to a specific agency ID), so
    // capturing it from AGENCY_CAPTURE_URL works for queries about any companyId.

    let staffsRes = null;

    if (agencyTokenFresh()) {
      // Fast path: use cached token — no tab opened
      log('agencyLookup: using cached agency token for', companyId);
      staffsRes = await gql(
        'gql-query-agencystaffsauth',
        Q_AGENCY_STAFFS,
        { agencyId: companyId, agencyTeamId: companyId, limit: 50, offset: '' },
        tokens.agencyAuth,
        { xsrf: tokens.agencyXsrf, tenantId: tokens.agencyTenantId }
      );

      // If token hard-failed (401 or unexpected error that isn't a clean "not an agency" 403)
      // → clear cached token and fall through to CDP capture
      const isNotAgency403 = staffsRes.data?.errors?.some(e =>
        e.message?.includes('Authorization failed')) ||
        staffsRes.data?.message?.includes('Authorization failed');
      if (staffsRes.status === 401 || (staffsRes.status >= 400 && !isNotAgency403)) {
        log('agencyLookup: cached token rejected (status', staffsRes.status, '), refreshing...');
        tokens.agencyAuth = ''; // invalidate
        staffsRes = null; // fall through to CDP capture
      }
    }

    if (!staffsRes) {
      // Slow path: open agency page via CDP to capture the ag_vs_ui token.
      // Lock prevents concurrent calls from the 3-worker queue all opening tabs at once.
      if (_agencyCaptureLock) {
        // Another worker is already capturing — wait up to 20s for it to finish
        for (let i = 0; i < 40; i++) { await sleep(500); if (!_agencyCaptureLock) break; }
      }

      if (agencyTokenFresh()) {
        // The parallel worker finished — use its token now
        staffsRes = await gql(
          'gql-query-agencystaffsauth',
          Q_AGENCY_STAFFS,
          { agencyId: companyId, agencyTeamId: companyId, limit: 50, offset: '' },
          tokens.agencyAuth,
          { xsrf: tokens.agencyXsrf, tenantId: tokens.agencyTenantId }
        );
      } else {
        _agencyCaptureLock = true;
        try {
          log('agencyLookup: opening fixed agency page to capture ag_vs_ui token...');
          const capture = await captureAgencyStaffs();
          if (!capture) {
            warn('agencyLookup: failed to capture ag_vs_ui token (timeout)');
            return empty;
          }

          // Persist captured token for all subsequent jobs in this run
          tokens.agencyAuth     = capture.auth;
          tokens.agencyXsrf     = capture.xsrf;
          tokens.agencyTenantId = capture.tenantId;
          tokens.agencyTs       = Date.now();
          persistTokens();

          // Replay the query with the ACTUAL job's companyId in the variables.
          // The token is from the fixed known-agency page but is valid for any companyId.
          staffsRes = await gql(
            'gql-query-agencystaffsauth',
            Q_AGENCY_STAFFS,
            { agencyId: companyId, agencyTeamId: companyId, limit: 50, offset: '' },
            capture.auth,
            { xsrf: capture.xsrf, tenantId: capture.tenantId }
          );
        } finally {
          _agencyCaptureLock = false;
        }
      }
    }

    const rawStaffs = staffsRes.data || null;

    // 403 "Authorization failed" or errors → not an agency (or no permission)
    const authFailed = staffsRes.status === 403 ||
      rawStaffs?.message?.includes('Authorization failed') ||
      rawStaffs?.errors?.some(e => e.message?.includes('Authorization failed'));
    if (authFailed) {
      log('agencyLookup: company', companyId, 'is not an Upwork agency, skipping');
      return { profiles: [], rawStaffs, rawProfiles: [] };
    }

    if (staffsRes.status !== 200 || rawStaffs?.errors) {
      warn('agencyLookup: agencyStaffsAuth error for', companyId, '—',
        staffsRes.status, JSON.stringify(rawStaffs).slice(0, 120));
      return { profiles: [], rawStaffs, rawProfiles: [] };
    }

    const staffs = rawStaffs?.data?.agencyStaffsAuth?.staffs || [];
    log('agencyLookup: staffs captured:', staffs.length, 'for', companyId);

    const freelancers = staffs.filter(s =>
      s.memberType !== 'CLIENT' && s.personalData?.ciphertext && s.canBeViewed
    ).slice(0, 15);

    if (freelancers.length === 0) return { profiles: [], rawStaffs, rawProfiles: [] };

    // Phase 2: fetch freelancer profiles
    // Use the globally cached agency token (same session scope as getDetails).
    const dAuth = tokens.agencyAuth || detailsHeaders?.auth || tokens.detailsAuth;
    const dXsrf = tokens.agencyXsrf || detailsHeaders?.xsrf || tokens.detailsXsrf || tokens.xsrf;
    if (!dAuth) { warn('agencyLookup: no details token for profiles of', companyId); return { profiles: [], rawStaffs, rawProfiles: [] }; }

    const profiles    = [];
    const rawProfiles = [];
    for (const fl of freelancers) {
      const r = await gql(
        'getDetails',
        Q_GET_TALENT_PROFILE,
        { profileUrl: fl.personalData.ciphertext, viewerMode: false },
        dAuth, { xsrf: dXsrf }
      );
      rawProfiles.push(r.data || null);
      const p = r.data?.data?.talentVPDAuthProfile;
      if (p) {
        profiles.push({
          ciphertext: p.identity?.ciphertext || fl.personalData.ciphertext,
          name:       p.profile?.name        || fl.personalData.name || '',
          title:      p.profile?.title       || '',
          location:   p.profile?.location    || {},
          skills:     (p.profile?.skills     || []).map(s => s.node?.prettyName || s.node?.name).filter(Boolean),
          hourlyRate: p.stats?.hourlyRate?.node?.amount || null,
          currency:   p.stats?.hourlyRate?.node?.currencyCode || null,
          totalHours: p.stats?.totalHours  || null,
          jss:        p.stats?.rating      || null,
          topRated:   p.stats?.topRatedStatus || null,
          agencies:   p.agencies           || [],
          vetted:     p.vettedBadge?.vetted ?? null,
        });
      }
      await sleep(300);
    }
    return { profiles, rawStaffs, rawProfiles };
  } catch(e) {
    warn('agencyLookup error for', companyId, ':', e.message);
    return empty;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — JOB PROCESSOR
// ──────────────────────────────────────────────────────────────────────────────
// All API calls here are direct SW fetches — NO tabs opened per job.
// msgHeaders and detailsHeaders are captured ONCE per run and passed in.
// ══════════════════════════════════════════════════════════════════════════════

async function processJob(cipher, msgHeaders, detailsHeaders, searchQuery) {
  const openingId = cipherToOpeningId(cipher);

  // ── Step 1: Job Auth Details (direct SW call — NO tab) ──────────────────
  // Helper: pick freshest token and fire the request
  const fetchJAD = () => {
    // Cookie tokens first; fall back to live-captured job details token if all are empty
    const tok = tokens.JobDetailsNuxt_vt || tokens.FxJobPosting_vt || tokens.oauth2_global_js_token || tokens.jobDetailsAuth;
    return gql(
      'gql-query-get-auth-job-details',
      Q_JOB_AUTH_DETAILS,
      { id: cipher, isFreelancerOrAgency: true, isLoggedIn: true },
      tok,
      { xsrf: tokens.xsrf } // NO tenantId — _vt token
    );
  };

  let jadRes = await fetchJAD();

  // Detect "Authentication failed" — stale cached _vt/global token.
  // Force-refresh cookies and retry ONCE.
  const isAuthFail = res =>
    res.status === 401 ||
    res.data?.message?.toLowerCase?.().includes('authentication failed') ||
    res.data?.errors?.some(e => e.message?.toLowerCase?.().includes('authentication failed'));

  if (isAuthFail(jadRes)) {
    warn('processJob: auth failed for', cipher, '— refreshing tokens and retrying...');
    await refreshTokens(true);
    jadRes = await fetchJAD();
  }

  const jad = jadRes.data?.data?.jobAuthDetails;
  if (!jad) {
    warn('processJob: no jobAuthDetails for', cipher, 'status:', jadRes.status,
      jadRes.data?.message || jadRes.error || '');
    return null;
  }

  const opening   = jad.opening?.job   || {};
  const buyer     = jad.buyer          || {};
  const jobInfo   = opening.info       || {};
  const buyerInfo = buyer.info         || {};
  const company   = buyerInfo.company  || {};
  const stats     = buyerInfo.stats    || {};
  const location  = buyerInfo.location || {};
  const companyId = company.companyId  || null;

  // ── Step 2: clientCompanyMetadata (company name backfill) ───────────────
  // companyBuyer (clientInfoByOpening) removed — jobAuthDetails already returns
  // identical buyer/company/stats/activity data, so it was 100% redundant and
  // caused persistent ExecutionAborted errors regardless of which token was used.
  let metaName = null;
  let metaRes  = null;

  // clientCompanyMetadata — messages/rooms live token with tenantId
  // Provides company name when jobAuthDetails.buyer.info.company.name is null.
  if (msgHeaders?.auth && companyId) {
    metaRes  = await gql(
      '',
      Q_CLIENT_COMPANY_METADATA,
      { uid: companyId },
      msgHeaders.auth,
      { xsrf: msgHeaders.xsrf || tokens.xsrf, tenantId: msgHeaders.tenantId || tokens.tenantId }
    );
    metaName = metaRes.data?.data?.clientCompanyMetadata?.name || null;
  }

  await sleep(EXT_CONFIG_V2.API_DELAY_MS);

  // ── Step 3: Agency lookup (direct SW calls, cached per companyId) ────────
  let agencyData = { profiles: [], rawStaffs: null, rawProfiles: [] };
  if (companyId) {
    try { agencyData = await runAgencyLookup(companyId, detailsHeaders); } catch(_) {}
  }
  const profiles = agencyData.profiles || [];

  // ── Step 4: Assemble webhook payload ────────────────────────────────────
  const payload = {
    _version:    'v2-hybrid',
    source:      'search',
    query:       searchQuery,
    jobCiphertext:  cipher,
    jobTitle:       jobInfo.title  || 'Unknown',
    jobType:        jobInfo.type   || null,
    jobCategory:    opening.category?.name || null,
    description:    opening.description   || null,
    budget:         opening.budget        || null,
    hourlyBudget:   opening.extendedBudgetInfo || null,
    postedOn:       opening.postedOn || null,
    skills: (opening.segmentationData || []).filter(s => s.type === 'SKILL').map(s => s.label || s.value),
    companyId:      companyId || null,
    companyName:    metaName  || company.name || null,
    industry:       company.profile?.industry || null,
    companySize:    company.profile?.size     || null,
    companyContractDate: company.contractDate || null,
    clientCountry:   location.country || null,
    clientCity:      location.city    || null,
    clientState:     location.state   || null,
    clientScore:     stats.score      || null,
    totalJobsPosted: stats.totalAssignments   || null,
    totalHired:      stats.totalJobsWithHires || null,
    totalSpent:      stats.totalCharges?.amount || null,
    totalHoursWorked: stats.hoursCount  || null,
    feedbackCount:   stats.feedbackCount || null,
    activeContracts: stats.activeAssignmentsCount || null,
    paymentVerified: buyer.isPaymentMethodVerified ?? null,
    enterprise:      buyer.enterprise ?? null,
    totalApplicants:         opening.clientActivity?.totalApplicants         ?? null,
    totalInvitedToInterview: opening.clientActivity?.totalInvitedToInterview ?? null,
    totalHiredForOpening:    opening.clientActivity?.totalHired              ?? null,
    numberOfPositions:       opening.clientActivity?.numberOfPositionsToHire ?? null,
    lastBuyerActivity:       opening.clientActivity?.lastBuyerActivity       ?? null,
    jobStatus:       opening.status || null,
    hiredApplicants: jad.hiredApplicantNames || [],
    clientDetails:   profiles,
    runAt:           new Date().toISOString(),

    // Full raw API responses — complete GQL data from every query
    _raw: {
      jobAuthDetails:        jadRes.data  || null,
      clientCompanyMetadata: metaRes?.data || null,
      agencyStaffs:          agencyData.rawStaffs   || null,
    },
  };

  // Strip top-level nulls/undefined (but keep _raw as-is)
  for (const k of Object.keys(payload)) {
    if (k !== '_raw' && (payload[k] === null || payload[k] === undefined)) delete payload[k];
  }

  return payload;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — MAIN PIPELINE (search → process → webhook)
// ══════════════════════════════════════════════════════════════════════════════

let _pipelineRunning = false;

async function searchAndProcess(searchUrl, maxJobs = EXT_CONFIG_V2.MAX_JOBS) {
  if (_pipelineRunning) { warn('pipeline already running, skipping'); return; }
  _pipelineRunning = true;

  // MV3 service-worker keepalive
  const keepAlive = setInterval(() => chrome.storage.local.get(['_ka'], () => {}), 20000);

  try {
    let rawQuery = EXT_CONFIG_V2.SEARCH_QUERY;
    try { rawQuery = new URL(searchUrl).searchParams.get('q') || rawQuery; } catch(_) {}

    broadcastProgress({ running: true, phase: 'init', query: rawQuery, total: 0, processed: 0 });

    // Step 0: Refresh cookie tokens (xsrf, tenantId, etc.)
    await refreshTokens(true);
    if (!hasTokens()) { warn('pipeline: no tokens after refresh'); return; }

    broadcastProgress({ running: true, phase: 'search', query: rawQuery, total: 0, processed: 0 });

    // Step 1: Capture search token + first page via CDP.
    // Cookie-based tokens (_vt, oauth2_global_js_token) ALL get ExecutionAborted on
    // userJobSearch — only the runtime microapp token the browser generates at page load works.
    // We intercept both the real auth header AND the response body from the page's own request.
    log('pipeline: capturing search token via CDP (hidden tab)...');
    const searchCapture = await captureSearchPage(searchUrl);
    if (!searchCapture?.auth) {
      warn('pipeline: failed to capture search token — aborting');
      broadcastProgress({ running: false, phase: 'done', query: rawQuery, total: 0, processed: 0 });
      return;
    }
    const searchAuth = searchCapture.auth;
    const searchXsrf = searchCapture.xsrf || tokens.xsrf;
    log('pipeline: search token captured:', searchAuth.slice(0, 30));

    // Seed ciphers from the intercepted first page (free — no extra API call)
    const ciphers = [];
    const seen    = new Set();
    const pageSize = 10;
    let totalAvailable = maxJobs;

    // Seed SSR page-1 ciphers (extracted directly from Nuxt __NUXT_DATA__ DOM, no GQL needed)
    if (searchCapture.ssrCiphers?.length) {
      for (const c of searchCapture.ssrCiphers) {
        if (!seen.has(c)) { seen.add(c); ciphers.push(c); }
      }
      log(`pipeline: seeded ${searchCapture.ssrCiphers.length} SSR page-1 ciphers`);
    }

    // Seed page-2 ciphers from intercepted GQL response (from the Next Page click)
    if (searchCapture.firstPage) {
      totalAvailable = Math.min(searchCapture.firstPage.total || maxJobs, maxJobs);
      for (const c of searchCapture.firstPage.ciphers) {
        if (!seen.has(c)) { seen.add(c); ciphers.push(c); }
      }
      log(`pipeline: seeded ${searchCapture.firstPage.ciphers.length} page-2 ciphers from GQL intercept (total=${totalAvailable})`);
    }

    // page 1 (SSR) + page 2 (GQL intercept) already captured → start pagination at offset 20
    // only page 2 captured → start at offset 10
    // nothing captured → start at offset 0
    let offset = searchCapture.ssrCiphers?.length > 0
      ? pageSize * 2
      : (searchCapture.firstPage?.ciphers?.length > 0) ? pageSize : 0;

    while (ciphers.length < maxJobs && offset < totalAvailable) {
      log('search offset', offset, '— using captured token:', searchAuth.slice(0, 25) + '...');
      const r = await gql(
        'userJobSearch',
        Q_USER_JOB_SEARCH,
        { requestVariables: { userQuery: rawQuery, sort: 'recency', highlight: false, paging: { offset, count: pageSize } } },
        searchAuth,
        { xsrf: searchXsrf } // NO tenantId — microapp token
      );

      const ujsData = r.data?.data?.search?.universalSearchNuxt?.userJobSearchV1;
      if (!ujsData) {
        const msg = r.data?.message || JSON.stringify(r.data)?.slice(0,200);
        if (r.status === 401 || r.data?.message?.toLowerCase?.().includes('authentication failed')) {
          warn('search: auth failed at offset', offset, '— search token expired, stopping pagination');
          break; // can't recover mid-pagination; pipeline will recapture next run
        }
        warn('search: no data at offset', offset, 'status:', r.status, msg);
        break;
      }

      const remoteTotal = ujsData.paging?.total || 0;
      totalAvailable = Math.min(remoteTotal, maxJobs);
      const results  = ujsData.results || [];
      if (results.length === 0) break;

      for (const item of results) {
        // With the real browser token, results.id is a numeric job ID
        const rawId = item?.id || null;
        if (!rawId) continue;
        const cipher = String(rawId).startsWith('~') ? String(rawId) : '~02' + String(rawId);
        if (!seen.has(cipher)) { seen.add(cipher); ciphers.push(cipher); }
      }

      log(`search offset=${offset}: ${results.length} results, total=${remoteTotal}, collected=${ciphers.length}`);
      offset += pageSize;
      await sleep(EXT_CONFIG_V2.API_DELAY_MS);
    }

    log('pipeline: collected', ciphers.length, 'ciphers');
    if (ciphers.length === 0) { broadcastProgress({ running: false, phase: 'done', query: rawQuery, total: 0, processed: 0 }); return; }

    broadcastProgress({ running: true, phase: 'capture-tokens', query: rawQuery, total: ciphers.length, processed: 0 });

    // Step 2: Capture live tokens ONCE for the entire batch
    // messages/rooms token — used by companyBuyer + clientCompanyMetadata
    const msgHeaders = await captureMessagesRoomsAuth();
    if (!msgHeaders) warn('pipeline: msg/rooms token unavailable — restricted queries skipped');

    // getDetails token — used by freelancer profile lookups
    const detailsHeaders = await captureDetailsAuth();
    if (!detailsHeaders) warn('pipeline: details token unavailable — agency profiles skipped');

    // job details token — live fallback for jobAuthDetails when cookie _vt tokens are missing
    const jobDetailsHeaders = await captureJobDetailsAuth(ciphers[0]);
    if (!jobDetailsHeaders) warn('pipeline: job details token unavailable — will rely on cookie tokens');

    broadcastProgress({ running: true, phase: 'processing', query: rawQuery, total: ciphers.length, processed: 0 });

    // Step 3: Process all jobs with queue (no tabs per job)
    const queue     = new Queue(EXT_CONFIG_V2.QUEUE_CONCURRENCY);
    let processed   = 0;
    const allJobs   = await storageGet('v2_lastJobs') || [];

    await Promise.all(ciphers.map(cipher => queue.add(async () => {
      try {
        // Staggered start delay to avoid thundering herd on concurrent queue slots
        await sleep(EXT_CONFIG_V2.JOB_DELAY_MS + Math.floor(Math.random() * 3000));

        const payload = await processJob(cipher, msgHeaders, detailsHeaders, rawQuery);
        if (!payload) return;

        // Upsert into local storage
        const idx = allJobs.findIndex(j => j.jobCiphertext === cipher);
        if (idx >= 0) allJobs[idx] = payload; else allJobs.unshift(payload);
        await storageSet('v2_lastJobs', allJobs.slice(0, 200));

        // Fire-and-forget webhook
        fetch(EXT_CONFIG_V2.WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(e => warn('webhook error:', e.message));

        processed++;
        log(`processed ${processed}/${ciphers.length}: ${payload.jobTitle}`);
        broadcastProgress({ running: true, phase: 'processing', query: rawQuery, total: ciphers.length, processed });
      } catch(e) {
        warn('processJob error for', cipher, ':', e.message);
      }
    })));

    log('pipeline done:', processed, '/', ciphers.length);
    broadcastProgress({ running: false, phase: 'done', query: rawQuery, total: ciphers.length, processed });
  } catch(e) {
    warn('pipeline outer error:', e.message);
    broadcastProgress({ running: false, phase: 'error', error: e.message });
  } finally {
    clearInterval(keepAlive);
    _pipelineRunning = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — AUTO-TRIGGER ON SEARCH PAGE NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════

const SEARCH_RE   = /\/nx\/search\/jobs|\?q=|\?skills=|\?category2_uid=|search\/jobs/;
const _autoCooldown = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Fires on SPA navigation (changeInfo.url only) and full-page loads (status=complete)
  const url = changeInfo.url || (changeInfo.status === 'complete' ? tab.url : null);
  if (!url || !url.includes('upwork.com')) return;
  if (!SEARCH_RE.test(url)) return;

  let norm = url;
  try { const u = new URL(url); norm = u.origin + u.pathname + u.search; } catch(_) {}

  const last = _autoCooldown.get(norm) || 0;
  if (!_pipelineRunning && (Date.now() - last) > EXT_CONFIG_V2.AUTO_SCRAPE_COOLDOWN_MS) {
    _autoCooldown.set(norm, Date.now());
    log('auto-scrape triggered:', norm);
    searchAndProcess(norm, EXT_CONFIG_V2.MAX_JOBS);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — ALARMS (SW keepalive + periodic token refresh)
// ══════════════════════════════════════════════════════════════════════════════

chrome.alarms.create('v2_keepAlive',    { periodInMinutes: 0.4 });
chrome.alarms.create('v2_tokenRefresh', { periodInMinutes: 8   });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'v2_tokenRefresh') refreshTokens(false).catch(() => {});
  // v2_keepAlive: just wakes the SW — no action needed
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — MESSAGE HANDLER (popup ↔ background)
// ══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === 'v2_getStatus') {
    chrome.storage.local.get(['v2_progress', 'v2_lastJobs'], s => {
      sendResponse({
        running:    _pipelineRunning,
        progress:   s.v2_progress || null,
        jobCount:   (s.v2_lastJobs || []).length,
        hasTokens:  hasTokens(),
        hasMsgToken: msgTokenFresh(),
        tokenAge:   Math.round(tokenAge() / 1000),
        tokens: {
          search:  !!tokens.UniversalSearchNuxt_vt,
          job:     !!tokens.JobDetailsNuxt_vt,
          global:  !!tokens.oauth2_global_js_token,
          xsrf:    !!tokens.xsrf,
          tenant:  !!tokens.tenantId,
          agency:  !!tokens.ag_vs_ui_gql_token,
          msgAuth: msgTokenFresh(),
        },
      });
    });
    return true;
  }

  if (msg.action === 'v2_runScrape') {
    const url     = msg.searchUrl || EXT_CONFIG_V2.SEARCH_URL;
    const maxJobs = msg.maxJobs   || EXT_CONFIG_V2.MAX_JOBS;
    sendResponse({ started: !_pipelineRunning });
    if (!_pipelineRunning) searchAndProcess(url, maxJobs).catch(() => {});
    return true;
  }

  if (msg.action === 'v2_refreshTokens') {
    refreshTokens(true).then(ok => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'v2_getJobs') {
    chrome.storage.local.get(['v2_lastJobs'], s => sendResponse({ jobs: s.v2_lastJobs || [] }));
    return true;
  }

  if (msg.action === 'v2_clearJobs') {
    chrome.storage.local.set({ v2_lastJobs: [], v2_progress: null }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'v2_exportJobs') {
    chrome.storage.local.get(['v2_lastJobs'], s => {
      const jobs = s.v2_lastJobs || [];
      const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(jobs, null, 2));
      chrome.downloads.download({ url: dataUrl, filename: `upwork_v2_${Date.now()}.json`, saveAs: false }, () => {
        sendResponse({ ok: true, count: jobs.length });
      });
    });
    return true;
  }

  // ── Debug: test a single userJobSearch GQL call and return raw result ──────
  if (msg.action === 'v2_testSearch') {
    (async () => {
      const query = msg.query || EXT_CONFIG_V2.SEARCH_QUERY;
      log('v2_testSearch: capturing search token via CDP for query:', query);
      const capture = await captureSearchPage(
        `https://www.upwork.com/nx/search/jobs/?nbs=1&q=${encodeURIComponent(query)}`
      );
      if (!capture?.auth) {
        sendResponse({ ok: false, error: 'CDP capture failed — no userJobSearch intercepted', status: 0 }); return;
      }
      const ujsData = capture.firstPage;
      sendResponse({
        ok: !!ujsData,
        status: 200,
        tokenUsed: capture.auth.slice(0, 20) + '...',
        xsrfUsed: capture.xsrf ? capture.xsrf.slice(0, 8) + '...' : '(none)',
        total: ujsData?.total ?? '?',
        ciphers: (ujsData?.ciphers || []).slice(0, 3),
        data: ujsData
          ? `total=${ujsData.total} ciphers=[${(ujsData.ciphers || []).join(',')}]`
          : 'token captured but firstPage is null (response parse failed)',
      });
    })();
    return true;
  }
});
