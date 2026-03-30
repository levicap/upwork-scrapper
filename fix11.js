// Remove invalid tagLine/title fields from CompanyProfile in both queries
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

const OLD_PROFILE = 'profile { industry size title tagLine }';
const NEW_PROFILE = 'profile { industry size }';
let count = 0;
while (s.includes(OLD_PROFILE)) { s = s.replace(OLD_PROFILE, NEW_PROFILE); count++; }
if (count === 0) { console.error('profile field not found'); process.exit(1); }
console.log(`Reverted profile fields in ${count} queries`);

// Also revert apiCompanyName in maybeExtractCompany - tagLine/title don't exist
const O1 = "  const apiCompanyName = jad?.buyer?.info?.company?.name\r\n" +
           "    || jad?.buyer?.info?.company?.profile?.tagLine\r\n" +
           "    || jad?.buyer?.info?.company?.profile?.title\r\n" +
           "    || null;\r\n";
const N1 = "  const apiCompanyName = jad?.buyer?.info?.company?.name || null;\r\n";
if (s.indexOf(O1) !== -1) { s = s.replace(O1, N1); console.log('Reverted apiCompanyName'); }

// Also revert post-processing fallback line
const O3 = "    const company = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company;\r\n" +
           "    const apiName = company?.name || company?.profile?.tagLine || company?.profile?.title || null;\r\n";
const N3 = "    const apiName = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name || null;\r\n";
if (s.indexOf(O3) !== -1) { s = s.replace(O3, N3); console.log('Reverted post-processing apiName'); }

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
