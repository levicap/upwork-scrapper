// Remove the stale (no modalDump) no-name-on-page line left from fix6
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

const STALE =
  '      // Merge cached location/jobTitle from detection time if we have it\r\n' +
  '      if (pre) return Object.assign({}, pre, { source: (pre.source||"cached") + "+no-name-on-page", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys });\r\n';

const idx = s.indexOf(STALE);
if (idx === -1) { console.error('Stale line not found'); process.exit(1); }
s = s.slice(0, idx) + s.slice(idx + STALE.length);

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK. Stale line removed.');
