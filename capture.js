/**
 * capture.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Puppeteer-real-browser network capturer.
 *
 * Opens a real Chrome session (bypasses Cloudflare), intercepts EVERY API
 * response on every page it visits, then merges all signals into one unified
 * JSON per job and writes the result to ./captured/<timestamp>.json
 *
 * Usage:
 *   node capture.js                              # interactive: prompts for URL
 *   node capture.js <search-or-job-url>          # single URL
 *   node capture.js --jobs-file urls.txt         # one URL per line in file
 *   node capture.js --search "node.js developer" # run a keyword search
 *
 * Pages handled automatically:
 *   • Search results page  → collects all job cards + their API data
 *   • Individual job page  → collects jobAuthDetails, __NUXT_DATA__, etc.
 *   • Company profile page → collects org info, company name, stats
 *   • Apply page           → collects any extra buyer/job fields
 */

'use strict';
require('dotenv').config();

const { connect } = require('puppeteer-real-browser');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const OUT_DIR          = path.join(__dirname, 'captured');
const COOKIES_FILE     = path.join(__dirname, 'cookies.json');
const RESPONSE_TIMEOUT = 25_000;   // ms to wait after nav for XHR to settle
const MAX_JOBS_PER_RUN = 50;       // safety cap when crawling search pages

// Patterns — a response body is "interesting" if its URL matches one of these
const INTERESTING_URLS = [
  '/api/graphql/v1',
  '/api/v2/profiles/',
  '/api/v3/jobs/',
  '/api/v2/jobs/',
  '/api/v2/ontology/',
  'get-auth-job-details',
  'get-proposals',
  'search/jobs',
  '/talent/api/',
  '/ab/account-security/',
  '/companies/',
  '/org/',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(msg)  { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.warn(`[${ts()}] ⚠ ${msg}`); }

function isInteresting(url) {
  return INTERESTING_URLS.some(p => url.includes(p));
}

function tryParseJson(str) {
  if (!str) return null;
  const t = str.trim();
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.parse(t); } catch (_) {}
  }
  return null;
}

/** Extract all job UIDs and ciphertexts from any object deeply */
function extractJobIds(obj, set = new Set()) {
  if (!obj || typeof obj !== 'object') return set;
  for (const [k, v] of Object.entries(obj)) {
    if ((k === 'uid' || k === 'id') && typeof v === 'string' && /^\d{15,}$/.test(v)) set.add(v);
    if (k === 'ciphertext' && typeof v === 'string' && v.startsWith('~0')) set.add(v);
    if (typeof v === 'object') extractJobIds(v, set);
  }
  return set;
}

/** Deep merge two objects, arrays are concatenated (unique by JSON) */
function deepMerge(base, incoming) {
  if (!incoming) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const existing = Array.isArray(out[k]) ? out[k] : [];
      const combined = [...existing];
      for (const item of v) {
        if (!combined.some(x => JSON.stringify(x) === JSON.stringify(item))) {
          combined.push(item);
        }
      }
      out[k] = combined;
    } else if (typeof v === 'object') {
      out[k] = deepMerge(out[k] || {}, v);
    } else {
      // Prefer non-null truthy value
      if (!out[k] && v) out[k] = v;
    }
  }
  return out;
}

// ── Nuxt data extractor (same logic as server.js, standalone) ─────────────────
function extractNuxtPageState(html) {
  try {
    // Nuxt 3 flat array in <script id="__NUXT_DATA__">
    const m3 = html.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (m3) {
      const arr = JSON.parse(m3[1]);
      const resolve = (v, depth = 0) => {
        if (depth > 20) return v;
        if (typeof v === 'number' && v >= 0 && v < arr.length) {
          const r = arr[v];
          if (Array.isArray(r) && r[0] === 'Reactive') return resolve(r[1], depth + 1);
          return r;
        }
        return v;
      };
      const result = { _source: 'nuxt3-ssr' };
      const findKeys = ['organizationUid','companyUid','rid','buyer','company','stats','location','jobDetails'];
      const walk = (o, depth = 0) => {
        if (depth > 12 || !o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (findKeys.includes(k) && !result[k]) result[k] = resolve(v);
          if (typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(arr);
      return result;
    }
    // Nuxt 2 window.__NUXT__
    const m2 = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]{0,200000}?\})\s*;/);
    if (m2) {
      const nd = JSON.parse(m2[1]);
      return { _source: 'nuxt2-ssr', ...nd };
    }
  } catch (_) {}
  return null;
}

// ── Per-job data model ────────────────────────────────────────────────────────
function emptyJob(uid) {
  return {
    _uid:      uid || null,
    _sources:  [],
    job:       {},
    buyer:     {},
    company:   {},
    location:  {},
    stats:     {},
    activity:  {},
    skills:    [],
    questions: [],
    history:   [],
    rawResponses: []
  };
}

/**
 * Normalise a GraphQL or REST JSON payload and fold it into a job record.
 * Handles: jobAuthDetails, jobPostingByUid, search results, company page, etc.
 */
function foldIntoJob(job, data, sourceAlias) {
  if (!data) return;
  job._sources.push(sourceAlias);

  const s = JSON.stringify(data);

  // ── GraphQL: jobAuthDetails ──────────────────────────────────────────────
  const jad = data?.data?.jobAuthDetails;
  if (jad) {
    const b = jad.buyer || {};
    job.buyer = deepMerge(job.buyer, {
      enterprise:            b.enterprise,
      isPaymentMethodVerified: b.isPaymentMethodVerified,
      cssTier:               b.cssTier,
    });
    const info = b.info || {};
    job.company  = deepMerge(job.company,  info.company  || {});
    job.location = deepMerge(job.location, info.location || {});
    job.stats    = deepMerge(job.stats,    info.stats    || {});
    if (info.jobs) job.activity = deepMerge(job.activity, info.jobs);

    const wh = b.workHistory;
    if (Array.isArray(wh)) {
      for (const w of wh) {
        if (!job.history.some(h => JSON.stringify(h) === JSON.stringify(w))) job.history.push(w);
      }
    }
    const op = jad.opening?.job;
    if (op) job.job = deepMerge(job.job, {
      title:         op.info?.title,
      category:      op.category?.name,
      categoryGroup: op.categoryGroup?.name,
    });
    if (Array.isArray(jad.hiredApplicantNames)) {
      job.job.hiredApplicantNames = jad.hiredApplicantNames;
    }
  }

  // ── GraphQL: jobPostingByUid ─────────────────────────────────────────────
  const jpbu = data?.data?.jobPostingByUid;
  if (jpbu) {
    const b = jpbu.buyer || {};
    const info = b.info || {};
    job.buyer    = deepMerge(job.buyer,    { enterprise: b.enterprise, isPaymentMethodVerified: b.isPaymentMethodVerified, cssTier: b.cssTier });
    job.company  = deepMerge(job.company,  info.company  || {});
    job.location = deepMerge(job.location, info.location || {});
    job.stats    = deepMerge(job.stats,    info.stats    || {});
    if (info.jobs) job.activity = deepMerge(job.activity, info.jobs);
    if (Array.isArray(jpbu.similarJobs)) job.job.similarJobs = jpbu.similarJobs;
    const cui = jpbu.currentUserInfo;
    if (cui) job.job.currentUserInfo = cui;
  }

  // ── GraphQL: search results (jobs edge list) ─────────────────────────────
  const edges = data?.data?.marketplacejobpostings?.results
              ?? data?.data?.search?.jobPostings?.edges
              ?? data?.results
              ?? null;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      const node = edge.node || edge;
      if (!node) continue;
      const nodeUid = node.uid || node.id;
      if (nodeUid && (job._uid === nodeUid || !job._uid)) {
        job._uid      = nodeUid;
        job.job       = deepMerge(job.job,      node);
        job.buyer     = deepMerge(job.buyer,    node.buyer    || {});
        job.company   = deepMerge(job.company,  node.company  || {});
        job.location  = deepMerge(job.location, node.location || {});
      }
    }
  }

  // ── REST: get-auth-job-details ───────────────────────────────────────────
  const gdj = data?.authJobDetail ?? data?.data?.authJobDetail ?? data?.jobDetails ?? null;
  if (gdj) {
    job.job  = deepMerge(job.job,  gdj?.opening?.job?.info || {});
    job.buyer = deepMerge(job.buyer, gdj?.buyer || {});
  }

  // ── Company / org endpoints ──────────────────────────────────────────────
  const co = data?.orgDetails ?? data?.company ?? data?.data?.company ?? null;
  if (co) {
    job.company = deepMerge(job.company, co);
  }

  // ── Nuxt page state folded in ────────────────────────────────────────────
  if (sourceAlias === 'nuxt-page-state') {
    if (data.companyUid)      job.company.companyUid      = job.company.companyUid      || data.companyUid;
    if (data.organizationUid) job.buyer.organizationUid   = job.buyer.organizationUid   || data.organizationUid;
    if (data.rid)             job.buyer.rid               = job.buyer.rid               || data.rid;
    if (data.buyer) {
      const b = data.buyer;
      job.buyer    = deepMerge(job.buyer,    b.info?.company ? {} : b);
      job.company  = deepMerge(job.company,  b.info?.company  || {});
      job.location = deepMerge(job.location, b.info?.location || {});
      job.stats    = deepMerge(job.stats,    b.info?.stats    || {});
    }
  }

  // ── Keep a slim raw copy for debugging ───────────────────────────────────
  if (job.rawResponses.length < 20) {
    const slim = JSON.stringify(data).slice(0, 4000);
    job.rawResponses.push({ alias: sourceAlias, preview: slim });
  }
}

// ── CDP-level interceptor setup ───────────────────────────────────────────────
async function setupInterception(page) {
  const captured = []; // { url, alias, body }

  const client = await page.target().createCDPSession();
  await client.send('Network.enable', {
    maxResourceBufferSize: 10 * 1024 * 1024,
    maxTotalBufferSize:   100 * 1024 * 1024,
  });

  const pending = new Map();

  client.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (isInteresting(request.url)) {
      pending.set(requestId, { url: request.url, method: request.method });
    }
  });

  client.on('Network.loadingFinished', async ({ requestId }) => {
    const req = pending.get(requestId);
    if (!req) return;
    pending.delete(requestId);
    try {
      const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
      if (!base64Encoded) {
        const parsed = tryParseJson(body);
        if (parsed) {
          // build a readable alias from URL
          const alias = req.url
            .replace(/https?:\/\/[^/]+/, '')
            .replace(/[?#].*/, '')
            .replace(/\//g, '_')
            .slice(0, 80);
          captured.push({ url: req.url, alias, data: parsed });
        }
      }
    } catch (_) {}
  });

  return captured;
}

// ── Navigate and collect everything from one page ─────────────────────────────
async function visitPage(page, url, label) {
  log(`  📄 ${label}: ${url.slice(0, 90)}`);

  const captured = await setupInterception(page);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  } catch (_) {
    // timeout is fine — wait a bit then continue
  }
  await new Promise(r => setTimeout(r, RESPONSE_TIMEOUT));

  // Also grab the page HTML for Nuxt SSR state
  const html = await page.content();
  const nuxt  = extractNuxtPageState(html);

  return { captured, nuxt, html };
}

// ── Build ONE merged job object from all page visits ─────────────────────────
async function scrapeJob(page, jobUrl) {
  const job = emptyJob(null);

  // ── Visit the job page ──────────────────────────────────────────────────
  const { captured: jobCap, nuxt: jobNuxt } = await visitPage(page, jobUrl, 'Job page');

  // Fold page Nuxt SSR state first
  if (jobNuxt) foldIntoJob(job, jobNuxt, 'nuxt-page-state');

  // Fold every intercepted API response
  for (const entry of jobCap) {
    foldIntoJob(job, entry.data, entry.alias);

    // Extract job UID from URL path if still unknown
    if (!job._uid) {
      const m = jobUrl.match(/~0(\d+)|\/(\d{15,})/);
      if (m) job._uid = m[1] || m[2];
    }
  }

  job._jobUrl = jobUrl;

  // ── Try to visit company page if we have companyUid ─────────────────────
  const companyUid = job.company?.companyUid || job.company?.id;
  if (companyUid) {
    const companyUrl = `https://www.upwork.com/companies/~${companyUid}/`;
    const { captured: coCap, nuxt: coNuxt } = await visitPage(page, companyUrl, 'Company page');
    if (coNuxt) foldIntoJob(job, coNuxt, 'company-nuxt-state');
    for (const entry of coCap) foldIntoJob(job, entry.data, `co_${entry.alias}`);
  }

  // ── Try apply page for any extra data ───────────────────────────────────
  const applyUrl = jobUrl.replace(/\/$/, '') + '/apply/';
  try {
    const { captured: apCap } = await visitPage(page, applyUrl, 'Apply page');
    for (const entry of apCap) foldIntoJob(job, entry.data, `apply_${entry.alias}`);
  } catch (_) { /* apply page may redirect or be gated */ }

  return job;
}

// ── Extract all job URLs from a search results page ──────────────────────────
async function extractJobUrlsFromSearchPage(page, searchUrl) {
  log(`  🔍 Loading search page…`);
  const { captured, nuxt, html } = await visitPage(page, searchUrl, 'Search page');

  const urls = new Set();

  // From intercepted API responses
  for (const entry of captured) {
    const s = JSON.stringify(entry.data);
    const matches = [...s.matchAll(/"ciphertext"\s*:\s*"(~0[^"]+)"/g)];
    for (const m of matches) urls.add(`https://www.upwork.com/jobs/${m[1]}/`);

    // Also numeric UIDs
    const uidMatches = [...s.matchAll(/"uid"\s*:\s*"(\d{15,})"/g)];
    for (const m of uidMatches) urls.add(`https://www.upwork.com/jobs/~${m[1]}/`);
  }

  // From HTML anchor hrefs
  const hrefMatches = [...html.matchAll(/href="(\/jobs\/[^"]+)"/g)];
  for (const m of hrefMatches) urls.add(`https://www.upwork.com${m[1].split('?')[0]}`);

  // Normalise: only keep /jobs/~… and /jobs/<numeric>
  const clean = [...urls].filter(u => /\/jobs\/(~0\d+|\d{15,})\/?/.test(u));
  log(`  ✅ Found ${clean.length} job URLs on search page`);
  return clean.slice(0, MAX_JOBS_PER_RUN);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Parse CLI args
  const args = process.argv.slice(2);
  let mode = 'url';
  let target = args.find(a => !a.startsWith('--'));

  if (args.includes('--jobs-file')) {
    mode = 'file';
    target = args[args.indexOf('--jobs-file') + 1];
  } else if (args.includes('--search')) {
    mode = 'search';
    target = args[args.indexOf('--search') + 1];
  }

  if (!target) {
    // Interactive prompt
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    target = await new Promise(res => rl.question('Enter Upwork URL (search or job): ', ans => { rl.close(); res(ans.trim()); }));
    mode = target.includes('/jobs/search') || target.includes('/nx/search') ? 'search-url' : 'url';
  }

  log('🚀 Launching real Chrome browser…');
  const { browser, page } = await connect({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    customConfig: {},
    turnstile: true,
    connectOption: {},
    disableXvfb: false,
    ignoreAllFlags: false,
  });

  // Load cookies
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      await page.setCookie(...cookies);
      log(`🍪 Loaded ${cookies.length} cookies`);
    } catch (e) { warn('Could not load cookies: ' + e.message); }
  }

  let jobUrls = [];

  try {
    if (mode === 'file') {
      jobUrls = fs.readFileSync(target, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
      log(`📋 Loaded ${jobUrls.length} URLs from file`);
    } else if (mode === 'search') {
      const searchUrl = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(target)}`;
      jobUrls = await extractJobUrlsFromSearchPage(page, searchUrl);
    } else if (target.includes('/search/jobs') || target.includes('/nx/search')) {
      jobUrls = await extractJobUrlsFromSearchPage(page, target);
    } else {
      jobUrls = [target];
    }

    log(`\n🎯 Processing ${jobUrls.length} job(s)…\n`);

    const allJobs = [];

    for (let i = 0; i < jobUrls.length; i++) {
      const url = jobUrls[i];
      log(`[${i + 1}/${jobUrls.length}] ${url}`);
      try {
        const job = await scrapeJob(page, url);
        allJobs.push(job);
        log(`  ✓ Merged: company="${job.company?.name || '—'}", uid="${job._uid || '—'}", sources=${job._sources.length}`);
      } catch (e) {
        warn(`  Failed: ${e.message}`);
        allJobs.push({ _jobUrl: url, _error: e.message });
      }

      // Brief pause between jobs to be respectful
      if (i < jobUrls.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    // ── Write output ──────────────────────────────────────────────────────
    const outFile = path.join(OUT_DIR, `capture_${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(allJobs, null, 2));
    log(`\n✅ Done! ${allJobs.length} job(s) → ${outFile}`);

    // Print summary table
    console.log('\n┌──────┬──────────────────────┬─────────────────────────┬──────────┐');
    console.log('│  #   │ Job UID              │ Company                 │ Sources  │');
    console.log('├──────┼──────────────────────┼─────────────────────────┼──────────┤');
    for (let i = 0; i < allJobs.length; i++) {
      const j = allJobs[i];
      const uid  = (j._uid  || '—').slice(0, 20).padEnd(20);
      const co   = (j.company?.name || '—').slice(0, 23).padEnd(23);
      const srcs = String(j._sources?.length || 0).padEnd(8);
      console.log(`│ ${String(i + 1).padEnd(4)} │ ${uid} │ ${co} │ ${srcs} │`);
    }
    console.log('└──────┴──────────────────────┴─────────────────────────┴──────────┘');

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
