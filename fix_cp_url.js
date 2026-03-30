// Fix company-page URL: use companyUid (base32 slug) not raw numeric companyId
// Also add companyUid to GraphQL queries and tighten the title extraction
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

// 1. Add companyUid to both GraphQL queries
const OLD_COMPANY_FIELD = 'company { companyId contractDate isEDCReplicated name profile { industry size } }';
const NEW_COMPANY_FIELD = 'company { companyId companyUid contractDate isEDCReplicated name profile { industry size } }';
let cnt = 0;
while (s.includes(OLD_COMPANY_FIELD)) { s = s.replace(OLD_COMPANY_FIELD, NEW_COMPANY_FIELD); cnt++; }
if (cnt === 0) { console.error('company field not found'); process.exit(1); }
console.log(`Step 1: companyUid added to ${cnt} queries`);

// 2. Pass companyUid through to detectedCompanies in maybeExtractCompany
// The jad response won't have companyUid (it's a REST endpoint), but we'll get it from GraphQL post-processing
// For now, pass companyId and let company-page handler encode it

// 3. Fix the company-page URL: Upwork uses /companies/~{companyUid}/ format
// companyUid looks like "~01abc123" — already has tilde prefix
// If we only have the numeric companyId, encode it via Upwork's base32 scheme
// Simplest: use GraphQL result's companyUid (added above), pass it down
// Update buildLookupQueries to also pass companyUid when available
const OLD_QUERY_PUSH = "    queries.push({ alias: 'company-page', type: 'company-page', companyId });";
const NEW_QUERY_PUSH = "    queries.push({ alias: 'company-page', type: 'company-page', companyId, companyUid: null });  // companyUid filled after jobAuth queries run";
if (s.indexOf(OLD_QUERY_PUSH) === -1) { console.error('query push not found'); process.exit(1); }
s = s.replace(OLD_QUERY_PUSH, NEW_QUERY_PUSH);
console.log('Step 2: query push updated');

// 4. Fix the fetch URL to try companyUid first, then numeric fallback
// Replace the entire company-page handler with a corrected version
const CP_OLD =
  "    if (q.type === 'company-page') {\r\n" +
  "      if (!q.companyId) { results.push({ alias: 'company-page', skipped: true }); continue; }\r\n" +
  "      try {\r\n" +
  "        const cpResp = await fetch('https://www.upwork.com/ab/companies/' + q.companyId + '/', { credentials: 'include' });\r\n";

const CP_NEW =
  "    if (q.type === 'company-page') {\r\n" +
  "      if (!q.companyId) { results.push({ alias: 'company-page', skipped: true }); continue; }\r\n" +
  "      try {\r\n" +
  "        // Get companyUid from the jobAuth-buyer result that ran earlier\r\n" +
  "        const jabForCp = results.find(r => r && r.alias === 'jobAuth-buyer');\r\n" +
  "        const cpUid = jabForCp?.data?.data?.jobAuthDetails?.buyer?.info?.company?.companyUid || null;\r\n" +
  "        // Upwork company page URL: /companies/~{uid}/ or /ab/companies/~{uid}/\r\n" +
  "        const cpUrl = cpUid\r\n" +
  "          ? 'https://www.upwork.com/companies/' + cpUid + '/'\r\n" +
  "          : null;\r\n" +
  "        if (!cpUrl) { results.push({ alias: 'company-page', skipped: true, reason: 'no companyUid from jobAuth-buyer' }); continue; }\r\n" +
  "        const cpResp = await fetch(cpUrl, { credentials: 'include' });\r\n";

if (s.indexOf(CP_OLD) === -1) { console.error('CP_OLD not found'); process.exit(1); }
s = s.replace(CP_OLD, CP_NEW);
console.log('Step 3: company-page URL fixed to use companyUid');

// 5. Also tighten the title extraction — reject 404/error pages
const TITLE_OLD = "        // 1. <title>Company Name | Upwork</title>\r\n" +
  "        const titleM = cpHtml.match(/<title>([^<|]{2,80})\\s*[|\\u2013\\-]/);\r\n" +
  "        if (titleM) cpName = titleM[1].trim();\r\n";

const TITLE_NEW = "        // Only extract from successful response\r\n" +
  "        if (cpResp.status !== 200) { results.push({ alias: 'company-page', status: cpResp.status, companyName: null }); continue; }\r\n" +
  "        // 1. <title>Company Name | Upwork</title>\r\n" +
  "        const titleM = cpHtml.match(/<title>([^<|]{2,80})\\s*[|\\u2013\\-]/);\r\n" +
  "        if (titleM) {\r\n" +
  "          const t = titleM[1].trim();\r\n" +
  "          if (t && !/^(404|403|error|not found|page not found)/i.test(t)) cpName = t;\r\n" +
  "        }\r\n";

if (s.indexOf(TITLE_OLD) === -1) { console.error('TITLE_OLD not found'); process.exit(1); }
s = s.replace(TITLE_OLD, TITLE_NEW);
console.log('Step 4: status check and 404 filter added');

// 6. Update post-processing to also try companyUid from jobAuth-buyer for page-state
const PP_OLD =
  "    const apiName   = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name\r\n" +
  "                   || cpResult?.companyName\r\n" +
  "                   || null;\r\n";
const PP_NEW =
  "    const apiName   = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name\r\n" +
  "                   || cpResult?.companyName\r\n" +
  "                   || null;\r\n" +
  "    // Cache companyUid in detectedCompanies for future use\r\n" +
  "    const apiUid = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.companyUid || null;\r\n" +
  "    if (apiUid && companyId) {\r\n" +
  "      chrome.storage.local.get(['detectedCompanies'], (stored) => {\r\n" +
  "        const dcs = stored.detectedCompanies || [];\r\n" +
  "        const dc = dcs.find(c => c.companyId === companyId);\r\n" +
  "        if (dc && !dc.companyUid) { dc.companyUid = apiUid; chrome.storage.local.set({ detectedCompanies: dcs }); }\r\n" +
  "      });\r\n" +
  "    }\r\n";
if (s.indexOf(PP_OLD) === -1) { console.error('PP_OLD not found'); process.exit(1); }
s = s.replace(PP_OLD, PP_NEW);
console.log('Step 5: companyUid cached from jobAuth-buyer');

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('All done. Syntax OK.');
