// Add tagLine/title fallback and /agencies/ DOM search
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

// 1. maybeExtractCompany: try tagLine/title as fallback
const O1 = "  const apiCompanyName = jad?.buyer?.info?.company?.name || null;\r\n";
const N1 = "  const apiCompanyName = jad?.buyer?.info?.company?.name\r\n" +
           "    || jad?.buyer?.info?.company?.profile?.tagLine\r\n" +
           "    || jad?.buyer?.info?.company?.profile?.title\r\n" +
           "    || null;\r\n";
if (s.indexOf(O1) === -1) { console.error('Fix1 not found'); process.exit(1); }
s = s.replace(O1, N1);
console.log('Fix 1 applied (apiCompanyName fallbacks)');

// 2. GraphQL queries: add tagLine title to profile in both jobAuth-buyer and jobAuth-full
// Both queries have the same profile field string
const OLD_PROFILE = 'profile { industry size }';
const NEW_PROFILE = 'profile { industry size title tagLine }';
let count = 0;
while (s.includes(OLD_PROFILE)) { s = s.replace(OLD_PROFILE, NEW_PROFILE); count++; }
if (count === 0) { console.error('Fix2: profile field not found'); process.exit(1); }
console.log(`Fix 2 applied (profile fields expanded in ${count} queries)`);

// 3. Post-processing in runQueriesInTab: try tagLine/title from jobAuth-buyer
const O3 = "    const apiName = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name || null;\r\n";
const N3 = "    const company = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company;\r\n" +
           "    const apiName = company?.name || company?.profile?.tagLine || company?.profile?.title || null;\r\n";
if (s.indexOf(O3) === -1) { console.error('Fix3 not found'); process.exit(1); }
s = s.replace(O3, N3);
console.log('Fix 3 applied (post-processing tagLine fallback)');

// 4. DOM search in 400ms eval: add /agencies/ selector
const O4 = "'var links=document.querySelectorAll(\\'[href*=\"/companies/\"]\\');' +\r\n";
const N4 = "'var links=document.querySelectorAll(\\'[href*=\"/companies/\"],[href*=\"/agencies/\"],[href*=\"/org/\"]\\'  );' +\r\n";
if (s.indexOf(O4) === -1) { console.error('Fix4 not found'); process.exit(1); }
s = s.replace(O4, N4);
console.log('Fix 4 applied (/agencies/ added to DOM search)');

// 5. Also in page-state block: add tagLine/title from nuxt paths
// After extracting b.info.company, also check tagLine/title
const O5 = "return Object.assign({}, pre||{}, { companyName: b.info.company.name || null, companyUid: b.info.company.companyUid || null, location: b.info.location || (pre&&pre.location) || null, stats: b.info.stats || null, source: \"vuex-live\" });";
const N5 = "return Object.assign({}, pre||{}, { companyName: b.info.company.name || b.info.company.profile&&b.info.company.profile.tagLine || b.info.company.profile&&b.info.company.profile.title || null, companyUid: b.info.company.companyUid || null, location: b.info.location || (pre&&pre.location) || null, stats: b.info.stats || null, source: \"vuex-live\" });";
if (s.indexOf(O5) !== -1) { s = s.replace(O5, N5); console.log('Fix 5 applied (vuex-live tagLine)'); }
else { console.warn('Fix5: vuex-live return not found (ok if already patched)'); }

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
