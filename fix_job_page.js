/**
 * fix_job_page.js  — replaces the company-page handler with job-page __NUXT_DATA__ approach
 */
const fs = require('fs');
const path = require('path');
const bgFile = path.join(__dirname, 'chrome-extension', 'background.js');
let src = fs.readFileSync(bgFile, 'utf8');

// ─── Find the company-page handler block ─────────────────────────────────────
const START_MARKER = "    if (q.type === 'company-page') {";
const END_MARKER   = "    // useJobToken=true: try each token, first WITH tenantId then WITHOUT (if tenant error)";

const si = src.indexOf(START_MARKER);
const ei = src.indexOf(END_MARKER);
if (si === -1 || ei === -1) {
  console.error('Could not find company-page handler boundaries!');
  console.error('si:', si, 'ei:', ei);
  process.exit(1);
}

// The new handler (CRLF line endings to match the file)
const CRLF = '\r\n';
const newHandler = [
  "    if (q.type === 'company-page') {",
  "      if (!q.companyId) { results.push({ alias: 'company-page', skipped: true }); continue; }",
  "      try {",
  "        let cpName = null;",
  "        let cpSource = null;",
  "",
  "        // ── Approach 1: Company profile page (if companyUid already known) ───────",
  "        const cpUid = pageStateResult?.companyUid || pre?.companyUid || null;",
  "        if (cpUid) {",
  "          try {",
  "            const cpUrl = 'https://www.upwork.com/companies/' + cpUid + '/';",
  "            const cpResp = await fetch(cpUrl, { credentials: 'include' });",
  "            if (cpResp.ok) {",
  "              const cpHtml = await cpResp.text();",
  "              const tM = cpHtml.match(/<title>([^<|]{2,80})\\s*[|\\u2013\\-]/);",
  "              if (tM) { const t = tM[1].trim(); if (t && !/^(404|403|error|not found)/i.test(t)) { cpName = t; cpSource = 'company-profile'; } }",
  "              if (!cpName) { const lM = cpHtml.match(/\"@type\"\\s*:\\s*\"Organization\"[^}]{0,300}\"name\"\\s*:\\s*\"([^\"]{2,100})\"/); if (lM) { cpName = lM[1]; cpSource = 'company-profile-jsonld'; } }",
  "              if (!cpName) { const oM = cpHtml.match(/property=\"og:title\"[^>]*content=\"([^\"\\|]{2,100})/); if (oM) { cpName = oM[1].split('|')[0].split('\\u2013')[0].trim(); cpSource = 'company-profile-og'; } }",
  "            }",
  "          } catch(_) {}",
  "        }",
  "",
  "        // ── Approach 2: Fetch job page HTML, parse __NUXT_DATA__ (Nuxt 3) ─────────",
  "        // Mirrors server.js: SSR flat-array has buyer.company fields not in modal API.",
  "        if (!cpName && q.jobCiphertext) {",
  "          try {",
  "            const jpUrl = 'https://www.upwork.com/jobs/_' + q.jobCiphertext + '/';",
  "            const jpResp = await fetch(jpUrl, { credentials: 'include', redirect: 'follow' });",
  "            if (jpResp.ok) {",
  "              const jpHtml = await jpResp.text();",
  "              // Parse <script id=\"__NUXT_DATA__\"> — Nuxt 3 flat-array format",
  "              const ndM = jpHtml.match(/<script[^>]*id=\"__NUXT_DATA__\"[^>]*>([\\s\\S]*?)<\\/script>/);",
  "              if (ndM) {",
  "                const nuxtData = JSON.parse(ndM[1]);",
  "                // rr: resolve integer indices into nuxtData (resolveRef)",
  "                const rr = (val, d) => {",
  "                  if (!d) d = 0;",
  "                  if (d > 8 || typeof val !== 'number' || val < 0 || val >= nuxtData.length) return val;",
  "                  const rv = nuxtData[val];",
  "                  if (Array.isArray(rv) && rv[0] === 'Reactive' && rv.length > 1) return rr(rv[1], d+1);",
  "                  return rr(rv, d+1);",
  "                };",
  "                let jpName = null, jpUid = null;",
  "                const seen = new WeakSet();",
  "                const ds = (obj, d) => {",
  "                  if (!d) d = 0;",
  "                  if (d > 15 || !obj || typeof obj !== 'object' || seen.has(obj)) return;",
  "                  seen.add(obj);",
  "                  if (Array.isArray(obj)) {",
  "                    for (let i = 0; i < Math.min(obj.length, 2000); i++) {",
  "                      if (jpName && jpUid) break;",
  "                      ds(typeof obj[i] === 'number' ? rr(obj[i]) : obj[i], d+1);",
  "                    }",
  "                  } else {",
  "                    for (const k of Object.keys(obj)) {",
  "                      const v = typeof obj[k] === 'number' ? rr(obj[k]) : obj[k];",
  "                      if ((k === 'companyUid' || k === 'organizationUid') && typeof v === 'string' && v && !jpUid) jpUid = v;",
  "                      if (k === 'name' && typeof v === 'string' && v && obj.companyId !== undefined && !jpName) jpName = v;",
  "                      ds(v, d+1);",
  "                    }",
  "                  }",
  "                };",
  "                ds(nuxtData);",
  "                if (jpName) { cpName = jpName; cpSource = 'job-page-nuxt-data'; }",
  "                // If we found companyUid but no name, try the company profile page",
  "                if (!cpName && jpUid) {",
  "                  try {",
  "                    const jpCpUrl = 'https://www.upwork.com/companies/' + jpUid + '/';",
  "                    const jpCpResp = await fetch(jpCpUrl, { credentials: 'include' });",
  "                    if (jpCpResp.ok) {",
  "                      const jpCpHtml = await jpCpResp.text();",
  "                      const tM2 = jpCpHtml.match(/<title>([^<|]{2,80})\\s*[|\\u2013\\-]/);",
  "                      if (tM2) { const t2 = tM2[1].trim(); if (t2 && !/^(404|403|error|not found)/i.test(t2)) { cpName = t2; cpSource = 'company-via-job-page'; } }",
  "                    }",
  "                  } catch(_) {}",
  "                }",
  "              }",
  "              // Also try window.__NUXT__ (Nuxt 2 SSR, older Upwork pages)",
  "              if (!cpName) {",
  "                const n2M = jpHtml.match(/window\\.__NUXT__\\s*=\\s*(\\{[\\s\\S]{0,80000}?\\})\\s*;/);",
  "                if (n2M) {",
  "                  try {",
  "                    const n2 = JSON.parse(n2M[1]);",
  "                    const sc2 = (o, d) => {",
  "                      if (!d) d = 0;",
  "                      if (d > 10 || !o || typeof o !== 'object') return null;",
  "                      if (o.company && typeof o.company === 'object' && o.company.name) return o.company.name;",
  "                      for (const k of Object.keys(o)) { const r = sc2(o[k], d+1); if (r) return r; }",
  "                      return null;",
  "                    };",
  "                    const n2name = sc2(n2);",
  "                    if (n2name) { cpName = n2name; cpSource = 'job-page-nuxt2'; }",
  "                  } catch(_) {}",
  "                }",
  "              }",
  "            }",
  "          } catch(jpErr) { cpSource = 'job-page-error:' + jpErr.message; }",
  "        }",
  "",
  "        results.push({ alias: 'company-page', companyName: cpName, source: cpSource });",
  "      } catch(cpErr) {",
  "        results.push({ alias: 'company-page', error: cpErr.message });",
  "      }",
  "      continue;",
  "    }",
  "",
  "    "   // the END_MARKER follows
].join(CRLF);

// Splice: replace from si to ei (keep END_MARKER line onwards)
const before = src.slice(0, si);
const after   = src.slice(ei);
src = before + newHandler + after;

fs.writeFileSync(bgFile, src, 'utf8');
console.log('Done. Lines in file:', src.split('\n').length);

// Quick syntax check
const { execSync } = require('child_process');
try {
  execSync('node --check "' + bgFile + '"', { stdio: 'pipe' });
  console.log('Syntax OK');
} catch(e) {
  console.error('SYNTAX ERROR:', e.stderr.toString());
}
