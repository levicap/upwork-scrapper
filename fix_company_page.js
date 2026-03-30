// Add company-page scrape: fetch https://www.upwork.com/ab/companies/{companyId}/
// extract name from <title> or JSON-LD or __NUXT__ SSR
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

// ─── 1. buildLookupQueries: add company-page query ───────────────────────────
const BLQ_OLD =
  '  // ── org-context is intentionally excluded ────────────────────────────────\r\n' +
  '  // It only returns the logged-in freelancer\'s own org data (confirmed), not\r\n' +
  '  // the client\'s — so it provides no value for company lookup.\r\n' +
  '\r\n' +
  '  return queries;\r\n' +
  '}';

const BLQ_NEW =
  '  // ── company-page: scrape the Upwork company profile page ─────────────────\r\n' +
  '  // The public company page has the company name in <title> even when the\r\n' +
  '  // GraphQL API returns null for company.name.\r\n' +
  '  if (companyId) {\r\n' +
  '    queries.push({ alias: \'company-page\', type: \'company-page\', companyId });\r\n' +
  '  }\r\n' +
  '\r\n' +
  '  // ── org-context is intentionally excluded ────────────────────────────────\r\n' +
  '  // It only returns the logged-in freelancer\'s own org data (confirmed), not\r\n' +
  '  // the client\'s — so it provides no value for company lookup.\r\n' +
  '\r\n' +
  '  return queries;\r\n' +
  '}';

if (s.indexOf(BLQ_OLD) === -1) { console.error('BLQ target not found'); process.exit(1); }
s = s.replace(BLQ_OLD, BLQ_NEW);
console.log('Step 1 done: company-page query added to buildLookupQueries');

// ─── 2. runQueriesInTab expression: handle company-page type ─────────────────
const HANDLER_OLD =
  '    if (q.type === \'page-state\') {\r\n' +
  '      results.push({ alias: \'page-state\', type: \'page-state\', data: pageStateResult });\r\n' +
  '      continue;\r\n' +
  '    }';

const HANDLER_NEW =
  '    if (q.type === \'page-state\') {\r\n' +
  '      results.push({ alias: \'page-state\', type: \'page-state\', data: pageStateResult });\r\n' +
  '      continue;\r\n' +
  '    }\r\n' +
  '\r\n' +
  '    if (q.type === \'company-page\') {\r\n' +
  '      if (!q.companyId) { results.push({ alias: \'company-page\', skipped: true }); continue; }\r\n' +
  '      try {\r\n' +
  '        const cpResp = await fetch(\'https://www.upwork.com/ab/companies/\' + q.companyId + \'/\', { credentials: \'include\' });\r\n' +
  '        const cpHtml = await cpResp.text();\r\n' +
  '        let cpName = null;\r\n' +
  '        // 1. <title>Company Name | Upwork</title>\r\n' +
  '        const titleM = cpHtml.match(/<title>([^<|]{2,80})\\s*[|\\u2013\\-]/);\r\n' +
  '        if (titleM) cpName = titleM[1].trim();\r\n' +
  '        // 2. JSON-LD "@type":"Organization"\r\n' +
  '        if (!cpName) {\r\n' +
  '          const ldM = cpHtml.match(/"@type"\\s*:\\s*"Organization"[^}]{0,300}"name"\\s*:\\s*"([^"]{2,100})"/);\r\n' +
  '          if (ldM) cpName = ldM[1];\r\n' +
  '        }\r\n' +
  '        // 3. og:title fallback\r\n' +
  '        if (!cpName) {\r\n' +
  '          const ogM = cpHtml.match(/property="og:title"[^>]*content="([^"|]{2,100})/);\r\n' +
  '          if (ogM) cpName = ogM[1].split(\'|\')[0].split(\'\\u2013\')[0].trim();\r\n' +
  '        }\r\n' +
  '        // 4. window.__NUXT__ SSR payload in the HTML\r\n' +
  '        if (!cpName) {\r\n' +
  '          const nuxtM = cpHtml.match(/window\\.__NUXT__\\s*=\\s*(\\{[\\s\\S]{0,50000}?\\})\\s*;\\s*</);\r\n' +
  '          if (nuxtM) {\r\n' +
  '            try {\r\n' +
  '              const nd = JSON.parse(nuxtM[1]);\r\n' +
  '              cpName = nd?.state?.org?.orgDetails?.name\r\n' +
  '                || nd?.state?.company?.name\r\n' +
  '                || null;\r\n' +
  '            } catch(_) {}\r\n' +
  '          }\r\n' +
  '        }\r\n' +
  '        results.push({ alias: \'company-page\', status: cpResp.status, companyName: cpName });\r\n' +
  '      } catch(cpErr) {\r\n' +
  '        results.push({ alias: \'company-page\', error: cpErr.message });\r\n' +
  '      }\r\n' +
  '      continue;\r\n' +
  '    }';

if (s.indexOf(HANDLER_OLD) === -1) { console.error('HANDLER target not found'); process.exit(1); }
s = s.replace(HANDLER_OLD, HANDLER_NEW);
console.log('Step 2 done: company-page handler added to expression');

// ─── 3. Post-processing: use company-page name as fallback ───────────────────
const PP_OLD =
  '    const psResult = parsed.find(r => r.alias === \'page-state\');\r\n' +
  '    const jabResult = parsed.find(r => r.alias === \'jobAuth-buyer\');\r\n' +
  '    const apiName = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name || null;\r\n' +
  '    if (psResult && !psResult.data?.companyName && apiName) {';

const PP_NEW =
  '    const psResult = parsed.find(r => r.alias === \'page-state\');\r\n' +
  '    const jabResult = parsed.find(r => r.alias === \'jobAuth-buyer\');\r\n' +
  '    const cpResult  = parsed.find(r => r.alias === \'company-page\');\r\n' +
  '    const apiName   = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name\r\n' +
  '                   || cpResult?.companyName\r\n' +
  '                   || null;\r\n' +
  '    if (psResult && !psResult.data?.companyName && apiName) {';

if (s.indexOf(PP_OLD) === -1) { console.error('PP target not found'); process.exit(1); }
s = s.replace(PP_OLD, PP_NEW);
console.log('Step 3 done: post-processing uses company-page fallback');

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('All done. Syntax OK.');
