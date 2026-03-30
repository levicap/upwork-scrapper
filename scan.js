const fs = require('fs'), path = require('path');
const dir = './data/api_logs';
const files = fs.readdirSync(dir);
console.log('total files:', files.length);

const urlSet = new Set();
const companyHits = [];

files.forEach(f => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const url = d.url || '';
    const clean = url.replace(/\?.*/, '').replace(/~[A-Za-z0-9_]+/g, '~ID');
    urlSet.add(clean);

    // Search for company name in data
    const s = JSON.stringify(d.data || {});
    if (s.includes('company') || s.includes('Company')) {
      const m = s.match(/"name":"([^"]{3,80})"/);
      companyHits.push({ file: f, url: clean, name: m ? m[1] : '?' });
    }
  } catch (e) {}
});

console.log('\n=== Unique URLs ===');
[...urlSet].sort().forEach(u => console.log(u));

console.log('\n=== Company-related responses ===');
companyHits.forEach(h => console.log(h.file, h.url, '->', h.name));
