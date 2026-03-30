// Comprehensive fix: read Vue $store at detection time, pass cached data to lookup
// Uses byte-position splicing to avoid CRLF string-match failures
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');
const eol = '\r\n';

// Apply fixes from HIGHEST byte position to lowest so earlier positions stay valid

// ─── FIX 4: page-state block in injected expression (highest position) ────────
const F4_START = s.indexOf('  // STEP 1: Read Upwork\u2019s Nuxt page state');
const F4_END_MARKER = s.indexOf('\r\n  })();\r\n\r\n  // Token priority', F4_START);
if (F4_START === -1) { console.error('FIX4: STEP 1 marker not found'); process.exit(1); }
if (F4_END_MARKER === -1) { console.error('FIX4: closing })() marker not found'); process.exit(1); }
const F4_END = F4_END_MARKER + '\r\n  })();'.length;

const newPageState =
'  // STEP 1: Resolve company name\r\n' +
'  // Priority: prefill captured at detection time > live Vue $store > window.__NUXT__\r\n' +
'  var pre = ${JSON.stringify(prefill || null)};\r\n' +
'  var pageStateResult = (function() {\r\n' +
'    try {\r\n' +
'      if (pre && (pre.companyName || pre.location)) return pre;\r\n' +
'\r\n' +
'      // Live Vue $store (works when job page/modal currently open)\r\n' +
'      var el = document.getElementById("__nuxt");\r\n' +
'      var store = el && el.__vue__ && el.__vue__.$store;\r\n' +
'      if (store && store.state && store.state.jobDetails) {\r\n' +
'        var jd = store.state.jobDetails;\r\n' +
'        var b = (jd.jobDetails || jd).buyer;\r\n' +
'        if (b && b.info && b.info.company) {\r\n' +
'          return { companyName: b.info.company.name || null, companyUid: b.info.company.companyUid || null, location: b.info.location || null, stats: b.info.stats || null, source: "vuex-live" };\r\n' +
'        }\r\n' +
'      }\r\n' +
'\r\n' +
'      // window.__NUXT__.fetch (only populated while modal is open)\r\n' +
'      var nuxt = window.__NUXT__;\r\n' +
'      if (nuxt && nuxt.fetch) {\r\n' +
'        var fvals = Object.values(nuxt.fetch);\r\n' +
'        for (var fi = 0; fi < fvals.length; fi++) {\r\n' +
'          if (!fvals[fi]) continue;\r\n' +
'          var fjd = fvals[fi].jobDetails ? (fvals[fi].jobDetails.jobDetails || fvals[fi].jobDetails) : fvals[fi];\r\n' +
'          if (!fjd) continue;\r\n' +
'          var fb = fjd.buyer;\r\n' +
'          if (fb && fb.info && fb.info.company && fb.info.company.name) {\r\n' +
'            return { companyName: fb.info.company.name, companyUid: fb.info.company.companyUid || null, location: fb.info.location || null, stats: fb.info.stats || null, source: "nuxt-fetch" };\r\n' +
'          }\r\n' +
'        }\r\n' +
'      }\r\n' +
'\r\n' +
'      return { error: "company name not found — open a job then click Run", source: "none" };\r\n' +
'    } catch(e) { return { error: e.message }; }\r\n' +
'  }());';

s = s.slice(0, F4_START) + newPageState + s.slice(F4_END);
console.log('FIX 4 applied (page-state block replaced, bytes', F4_START, '-', F4_END, ')');

// ─── FIX 3: runQueriesInTab signature (add prefill param) ────────────────────
const F3_OLD = 'async function runQueriesInTab(tabId, companyId, jobCiphertext) {';
const F3_NEW = 'async function runQueriesInTab(tabId, companyId, jobCiphertext, prefill) {';
const F3_IDX = s.indexOf(F3_OLD);
if (F3_IDX === -1) { console.error('FIX3: signature not found'); process.exit(1); }
s = s.slice(0, F3_IDX) + F3_NEW + s.slice(F3_IDX + F3_OLD.length);
console.log('FIX 3 applied (runQueriesInTab signature at', F3_IDX, ')');

// ─── FIX 1: maybeExtractCompany (byte-position splice) ───────────────────────
const F1_START = s.indexOf('function maybeExtractCompany');
const F1_END   = s.indexOf('\r\nfunction extractJobCiphertext');
if (F1_START === -1) { console.error('FIX1: maybeExtractCompany start not found'); process.exit(1); }
if (F1_END   === -1) { console.error('FIX1: extractJobCiphertext end marker not found'); process.exit(1); }

const newMaybe =
'function maybeExtractCompany(entry) {\r\n' +
'  if (!entry.url || !entry.url.includes(\'get-auth-job-details\')) return;\r\n' +
'  const jad = entry.responseBody?.data?.jobAuthDetails;\r\n' +
'  if (!jad) return;\r\n' +
'\r\n' +
'  const companyId = jad?.buyer?.info?.company?.companyId;\r\n' +
'  if (!companyId) return;\r\n' +
'\r\n' +
'  const apiCompanyName = jad?.buyer?.info?.company?.name || null;\r\n' +
'  const jobTitle = (jad?.opening?.job?.info?.title || \'Unknown\').replace(/\\s+/g, \' \').trim();\r\n' +
'  const location = jad?.buyer?.info?.location || null;\r\n' +
'  const jobCiphertext = extractJobCiphertext(entry.requestBody);\r\n' +
'  const tabId = entry.tabId;\r\n' +
'\r\n' +
'  const persist = (companyName) => {\r\n' +
'    chrome.storage.local.get([\'detectedCompanies\'], (result) => {\r\n' +
'      const companies = result.detectedCompanies || [];\r\n' +
'      const existing = companies.find(c => c.companyId === companyId);\r\n' +
'      if (existing) {\r\n' +
'        if (!existing.companyName && companyName) {\r\n' +
'          existing.companyName = companyName;\r\n' +
'          chrome.storage.local.set({ detectedCompanies: companies });\r\n' +
'        }\r\n' +
'        return;\r\n' +
'      }\r\n' +
'      companies.push({ companyId, companyName, jobCiphertext, jobTitle, location, detectedAt: new Date().toISOString() });\r\n' +
'      chrome.storage.local.set({ detectedCompanies: companies });\r\n' +
'    });\r\n' +
'  };\r\n' +
'\r\n' +
'  // If API already returned the name, persist immediately\r\n' +
'  if (apiCompanyName) { persist(apiCompanyName); return; }\r\n' +
'\r\n' +
'  // API returns null for company name — read from Vue $store NOW while modal is open\r\n' +
'  if (tabId && attachedTabs.has(tabId)) {\r\n' +
'    const expr = \'(function(){\' +\r\n' +
'      \'try{\' +\r\n' +
'      \'var el=document.getElementById("__nuxt");\' +\r\n' +
'      \'var store=el&&el.__vue__&&el.__vue__.$store;\' +\r\n' +
'      \'if(store&&store.state&&store.state.jobDetails){\' +\r\n' +
'        \'var jd=store.state.jobDetails;\' +\r\n' +
'        \'var b=(jd.jobDetails||jd).buyer;\' +\r\n' +
'        \'if(b&&b.info&&b.info.company&&b.info.company.name)return b.info.company.name;\' +\r\n' +
'      \'}\' +\r\n' +
'      \'var nuxt=window.__NUXT__;\' +\r\n' +
'      \'if(nuxt&&nuxt.fetch){\' +\r\n' +
'        \'var vals=Object.values(nuxt.fetch);\' +\r\n' +
'        \'for(var i=0;i<vals.length;i++){\' +\r\n' +
'          \'if(!vals[i])continue;\' +\r\n' +
'          \'var jd2=vals[i].jobDetails?(vals[i].jobDetails.jobDetails||vals[i].jobDetails):vals[i];\' +\r\n' +
'          \'if(jd2&&jd2.buyer&&jd2.buyer.info&&jd2.buyer.info.company&&jd2.buyer.info.company.name)\' +\r\n' +
'          \'  return jd2.buyer.info.company.name;\' +\r\n' +
'        \'}\' +\r\n' +
'      \'}\' +\r\n' +
'      \'return null;\' +\r\n' +
'      \'}catch(e){return null;}\' +\r\n' +
'    \'})()\';\r\n' +
'    chrome.debugger.sendCommand({ tabId }, \'Runtime.evaluate\', { expression: expr, returnByValue: true }, (res) => {\r\n' +
'      const liveCompanyName = (res && res.result && typeof res.result.value === \'string\') ? res.result.value : null;\r\n' +
'      persist(liveCompanyName);\r\n' +
'    });\r\n' +
'  } else {\r\n' +
'    persist(null);\r\n' +
'  }\r\n' +
'}';

s = s.slice(0, F1_START) + newMaybe + s.slice(F1_END);
console.log('FIX 1 applied (maybeExtractCompany bytes', F1_START, '-', F1_END, ')');

// ─── FIX 2: runCompanyLookup — pass prefill from cache ───────────────────────
const F2_OLD = '        const results = await runQueriesInTab(upworkTab.id, companyId, jobCiphertext);';
const F2_NEW =
'        // Read company name cached from Vue $store at detection time\r\n' +
'        const prefill = await new Promise(resolve => {\r\n' +
'          chrome.storage.local.get([\'detectedCompanies\'], (stored) => {\r\n' +
'            const dc = (stored.detectedCompanies || []).find(c => c.companyId === companyId);\r\n' +
'            resolve(dc ? { companyName: dc.companyName || null, location: dc.location || null, jobTitle: dc.jobTitle || null, source: \'cached-detection\' } : null);\r\n' +
'          });\r\n' +
'        });\r\n' +
'        const results = await runQueriesInTab(upworkTab.id, companyId, jobCiphertext, prefill);';

const F2_IDX = s.indexOf(F2_OLD);
if (F2_IDX === -1) { console.error('FIX2: runQueriesInTab call not found'); process.exit(1); }
s = s.slice(0, F2_IDX) + F2_NEW + s.slice(F2_IDX + F2_OLD.length);
console.log('FIX 2 applied (runCompanyLookup prefill at', F2_IDX, ')');

// ─── Write and validate ───────────────────────────────────────────────────────
fs.writeFileSync(file, s, 'utf8');
console.log('\nAll 4 fixes applied. File written.');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Syntax OK.')