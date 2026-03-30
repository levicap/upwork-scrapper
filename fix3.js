// Add company name fallback post-processing in runQueriesInTab
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

const OLD = '  const parsed = JSON.parse(evalResult.result.value);\r\n  if (parsed && parsed.fatalError) throw new Error(parsed.fatalError);\r\n  return parsed;\r\n}';

const NEW =
'  const parsed = JSON.parse(evalResult.result.value);\r\n' +
'  if (parsed && parsed.fatalError) throw new Error(parsed.fatalError);\r\n' +
'\r\n' +
'  // Post-processing: if page-state has no companyName, pull it from jobAuth-buyer\r\n' +
'  if (Array.isArray(parsed)) {\r\n' +
'    const psResult = parsed.find(r => r.alias === \'page-state\');\r\n' +
'    const jabResult = parsed.find(r => r.alias === \'jobAuth-buyer\');\r\n' +
'    const apiName = jabResult?.data?.data?.jobAuthDetails?.buyer?.info?.company?.name || null;\r\n' +
'    if (psResult && !psResult.data?.companyName && apiName) {\r\n' +
'      if (psResult.data && typeof psResult.data === \'object\') {\r\n' +
'        psResult.data.companyName = apiName;\r\n' +
'        psResult.data.source = (psResult.data.source || \'none\') + \'+api-fallback\';\r\n' +
'      } else {\r\n' +
'        psResult.data = { companyName: apiName, source: \'api-fallback\' };\r\n' +
'      }\r\n' +
'      // Cache it for future lookups\r\n' +
'      if (companyId) {\r\n' +
'        chrome.storage.local.get([\'detectedCompanies\'], (stored) => {\r\n' +
'          const companies = stored.detectedCompanies || [];\r\n' +
'          const existing = companies.find(c => c.companyId === companyId);\r\n' +
'          if (existing && !existing.companyName) {\r\n' +
'            existing.companyName = apiName;\r\n' +
'            chrome.storage.local.set({ detectedCompanies: companies });\r\n' +
'          }\r\n' +
'        });\r\n' +
'      }\r\n' +
'    }\r\n' +
'  }\r\n' +
'\r\n' +
'  return parsed;\r\n' +
'}';

const idx = s.indexOf(OLD);
if (idx === -1) { console.error('Target string not found'); process.exit(1); }
s = s.slice(0, idx) + NEW + s.slice(idx + OLD.length);

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
