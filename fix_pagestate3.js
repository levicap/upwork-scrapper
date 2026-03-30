const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

// ── FIX 1: runCompanyLookup — pass cached company info into runQueriesInTab ──
// Find the try block that calls runQueriesInTab and wrap it to look up cached data first
const oldHandler = `      try {
        const results = await runQueriesInTab(upworkTab.id, companyId, jobCiphertext);`;

const newHandler = `      try {
        // Pull cached buyer data from already-captured API response (most reliable source)
        const prefill = await new Promise(resolve => {
          chrome.storage.local.get(['detectedCompanies', 'requests'], (stored) => {
            // First check detectedCompanies (set by maybeExtractCompany on capture)
            const dc = (stored.detectedCompanies || []).find(c => c.companyId === companyId);
            if (dc && (dc.companyName || dc.location)) {
              return resolve({ companyName: dc.companyName || null, location: dc.location || null, jobTitle: dc.jobTitle || null, companyUid: dc.companyId, source: 'captured-response' });
            }
            // Fallback: scan stored request list for auth-job-details response
            const reqs = stored.requests || [];
            for (let i = reqs.length - 1; i >= 0; i--) {
              const r = reqs[i];
              if (!r.url || !r.url.includes('get-auth-job-details')) continue;
              const jad = r.responseBody && r.responseBody.data && r.responseBody.data.jobAuthDetails;
              if (!jad) continue;
              const co = jad.buyer && jad.buyer.info && jad.buyer.info.company;
              if (!co || co.companyId !== companyId) continue;
              return resolve({
                companyName: co.name || null,
                companyUid: co.companyUid || null,
                isEnterprise: !!(jad.buyer && jad.buyer.enterprise),
                isPaymentVerified: !!(jad.buyer && jad.buyer.isPaymentMethodVerified),
                location: jad.buyer.info.location || null,
                stats: jad.buyer.info.stats || null,
                jobTitle: jad.opening && jad.opening.job && jad.opening.job.info ? jad.opening.job.info.title : null,
                source: 'captured-request-log'
              });
            }
            resolve(null);
          });
        });
        const results = await runQueriesInTab(upworkTab.id, companyId, jobCiphertext, prefill);`;

const idx1 = s.indexOf(oldHandler);
if (idx1 === -1) { console.error('FIX 1: oldHandler not found'); process.exit(1); }
s = s.slice(0, idx1) + newHandler + s.slice(idx1 + oldHandler.length);
console.log('FIX 1 applied at', idx1);

// ── FIX 2: runQueriesInTab — accept prefill param ──────────────────────────
const oldSig = 'async function runQueriesInTab(tabId, companyId, jobCiphertext) {';
const newSig = 'async function runQueriesInTab(tabId, companyId, jobCiphertext, prefill) {';
const idx2 = s.indexOf(oldSig);
if (idx2 === -1) { console.error('FIX 2: signature not found'); process.exit(1); }
s = s.slice(0, idx2) + newSig + s.slice(idx2 + oldSig.length);
console.log('FIX 2 applied at', idx2);

// ── FIX 3: Replace the page-state block in the injected expression ───────────
// Find the STEP 1 block and replace with a version that uses prefill + Vue $store
const stepStart = s.indexOf('  // STEP 1: Read Upwork\u2019s Nuxt page state');
const stepEnd   = s.indexOf('\r\n  })();\r\n\r\n  // Token priority');
if (stepStart === -1) { console.error('FIX 3: stepStart not found'); process.exit(1); }
if (stepEnd   === -1) { console.error('FIX 3: stepEnd not found'); process.exit(1); }
const stepEndFull = stepEnd + '\r\n  })();'.length;

const newPageState = `  // STEP 1: Read buyer data — prefill from captured response, then live Vue store\r\n  const pageStateResult = (() => {\r\n    try {\r\n      // Priority 1: prefill passed from background script (from captured API response)\r\n      var pre = ${JSON.stringify('__PREFILL__').replace('"__PREFILL__"', '${JSON.stringify(prefill || null)}' )};\r\n      if (pre && (pre.companyName || pre.location)) return pre;\r\n\r\n      // Priority 2: live Nuxt/Vue $store via DOM root (works even after modal closes)\r\n      var extractBuyer = function(jd, opening, source) {\r\n        if (!jd) return null;\r\n        var buyer = jd.buyer;\r\n        var op    = opening || jd.opening;\r\n        if (!buyer || !buyer.info) return null;\r\n        var co = buyer.info.company;\r\n        return {\r\n          companyName:       co ? (co.name || null) : null,\r\n          companyUid:        co ? (co.companyUid || null) : null,\r\n          companyLegacyId:   co ? (co.id || null) : null,\r\n          isEnterprise:      !!buyer.enterprise,\r\n          isPaymentVerified: !!buyer.isPaymentMethodVerified,\r\n          location:          buyer.info.location || null,\r\n          stats:             buyer.info.stats || null,\r\n          jobTitle:          (op && op.job && op.job.info) ? op.job.info.title : null,\r\n          hiredCount:        jd.hiredApplicantNames ? jd.hiredApplicantNames.length : 0,\r\n          source:            source\r\n        };\r\n      };\r\n\r\n      // Try the Nuxt 2 root element's Vue instance $store (live Vuex)\r\n      var nuxtEl = document.getElementById('__nuxt');\r\n      if (nuxtEl && nuxtEl.__vue__ && nuxtEl.__vue__.$store) {\r\n        var storeState = nuxtEl.__vue__.$store.state;\r\n        if (storeState && storeState.jobDetails) {\r\n          var jdModule = storeState.jobDetails;\r\n          var r = extractBuyer(jdModule.jobDetails || jdModule, null, 'vuex/$store');\r\n          if (r) return r;\r\n        }\r\n      }\r\n\r\n      // Try window.__NUXT__.fetch['ModalJobDetails:0'] (only when modal is open)\r\n      var nuxt = window.__NUXT__;\r\n      if (nuxt && nuxt.fetch) {\r\n        var modalData = nuxt.fetch['ModalJobDetails:0'];\r\n        if (modalData) {\r\n          var jdm = modalData.jobDetails ? (modalData.jobDetails.jobDetails || modalData.jobDetails) : null;\r\n          var rm = extractBuyer(jdm, null, 'nuxt.fetch/ModalJobDetails');\r\n          if (rm) return rm;\r\n        }\r\n        // Try all fetch keys\r\n        var fvals = Object.values(nuxt.fetch);\r\n        for (var fi = 0; fi < fvals.length; fi++) {\r\n          if (!fvals[fi] || typeof fvals[fi] !== 'object') continue;\r\n          var jdf = fvals[fi].jobDetails ? (fvals[fi].jobDetails.jobDetails || fvals[fi].jobDetails) : null;\r\n          var rf = extractBuyer(jdf, null, 'nuxt.fetch[' + fi + ']');\r\n          if (rf) return rf;\r\n        }\r\n      }\r\n\r\n      return { error: 'buyer not found — open a job then click Run', source: 'none' };\r\n    } catch(e) {\r\n      return { error: e.message };\r\n    }\r\n  })();`;

s = s.slice(0, stepStart) + newPageState + s.slice(stepEndFull);
console.log('FIX 3 applied, stepStart=', stepStart, 'stepEndFull=', stepEndFull);

fs.writeFileSync(file, s, 'utf8');
console.log('All fixes written.');
