const fs = require('fs');
const src = fs.readFileSync('c:/upwork-scrapper/chrome-extension/background.js', 'utf8');

const startMarker = 'const gqlExpr = `';
const endMarker = '`;\r\n\r\n        const gqlEval';
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker, start + 100);
const inner = src.slice(start + startMarker.length, end);

// Simulate outer template literal evaluation
let evaluated = inner
  .replace(/\\\\/g, '\x00BKSL\x00')
  .replace(/\\`/g, '`')
  .replace(/\\\$/g, '$')
  .replace(/\x00BKSL\x00/g, '\\')
  .replace(/\$\{JSON\.stringify\([^)]+\)\}/g, 'null');

const os = require('os'), path = require('path');
const tmp = path.join(os.tmpdir(), 'gql_eval_test.js');
fs.writeFileSync(tmp, evaluated, 'utf8');

const { execSync } = require('child_process');
try {
  const result = execSync(`node --check "${tmp}" 2>&1`).toString();
  console.log('node --check: OK');
} catch(e) {
  const out = (e.stderr || e.stdout || Buffer.from('')).toString();
  console.log('node --check ERROR:', out);
  const lineMatch = out.match(/:(\d+)/);
  if (lineMatch) {
    const lineNum = parseInt(lineMatch[1]);
    const lines = evaluated.split('\n');
    for (let i = Math.max(0, lineNum-4); i < Math.min(lines.length, lineNum+2); i++) {
      console.log(`  L${i+1}: ${lines[i]}`);
    }
  }
}

// Check for double-slash comment risk
const doubleSlash = evaluated.indexOf('//');
if (doubleSlash !== -1) {
  // Check it's not inside a string or template literal
  const before = evaluated.slice(Math.max(0, doubleSlash-50), doubleSlash+20);
  console.log('First // found at', doubleSlash, ':', JSON.stringify(before));
}

fs.unlinkSync(tmp);

