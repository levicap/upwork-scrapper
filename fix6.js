// Fix: don't return pre early if companyName is null — search the page, then merge
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

// Fix 1: change early return so it only skips page read when we already have a name
const OLD1 =
  '  var pageStateResult = (function() {\r\n' +
  '    try {\r\n' +
  '      if (pre && (pre.companyName || pre.location)) return pre;\r\n' +
  '\r\n' +
  '      // Live Vue $store (works when job page/modal currently open)\r\n';

const NEW1 =
  '  var pageStateResult = (function() {\r\n' +
  '    try {\r\n' +
  '      // Only skip page read if we already have the name from cache\r\n' +
  '      if (pre && pre.companyName) return pre;\r\n' +
  '\r\n' +
  '      // Live Vue $store (works when job page/modal currently open)\r\n';

const I1 = s.indexOf(OLD1);
if (I1 === -1) { console.error('Fix1 target not found'); process.exit(1); }
s = s.slice(0, I1) + NEW1 + s.slice(I1 + OLD1.length);
console.log('Fix 1 applied (early-return condition)');

// Fix 2: when we find a name on the page, merge pre's location/jobTitle into the result
// Replace each "return { companyName: ..." inside pageStateResult to merge pre data
// Strategy: replace the diagnostic final return to also include merged pre data
const OLD2 =
  '      return { error: "company name not found", source: "none", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, storeJobDetailsKeys: storeJobDetailsKeys };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const NEW2 =
  '      // Merge cached location/jobTitle from detection time if we have it\r\n' +
  '      if (pre) return Object.assign({}, pre, { source: (pre.source||"cached") + "+no-name-on-page", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys });\r\n' +
  '      return { error: "company name not found", source: "none", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, storeJobDetailsKeys: storeJobDetailsKeys };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const I2 = s.indexOf(OLD2);
if (I2 === -1) { console.error('Fix2 target not found'); process.exit(1); }
s = s.slice(0, I2) + NEW2 + s.slice(I2 + OLD2.length);
console.log('Fix 2 applied (merge pre on fallback)');

// Fix 3: all the "return { companyName: ... }" hits inside the closure should also merge pre
// Patch each: vuex-live, nuxt-fetch, nuxt-payload, nuxt-payload-scan
const patches = [
  {
    old: 'return { companyName: b.info.company.name || null, companyUid: b.info.company.companyUid || null, location: b.info.location || null, stats: b.info.stats || null, source: "vuex-live" };',
    new: 'return Object.assign({}, pre||{}, { companyName: b.info.company.name || null, companyUid: b.info.company.companyUid || null, location: b.info.location || (pre&&pre.location) || null, stats: b.info.stats || null, source: "vuex-live" });'
  },
  {
    old: 'return { companyName: fb.info.company.name, companyUid: fb.info.company.companyUid || null, location: fb.info.location || null, stats: fb.info.stats || null, source: "nuxt-fetch" };',
    new: 'return Object.assign({}, pre||{}, { companyName: fb.info.company.name, companyUid: fb.info.company.companyUid || null, location: fb.info.location || (pre&&pre.location) || null, stats: fb.info.stats || null, source: "nuxt-fetch" });'
  },
  {
    old: 'return { companyName: pb.info.company.name, companyUid: pb.info.company.companyUid || null, location: pb.info.location || null, source: "nuxt-payload" };',
    new: 'return Object.assign({}, pre||{}, { companyName: pb.info.company.name, companyUid: pb.info.company.companyUid || null, location: pb.info.location || (pre&&pre.location) || null, source: "nuxt-payload" });'
  },
  {
    old: 'return { companyName: pvjd.buyer.info.company.name, location: pvjd.buyer.info.location || null, source: "nuxt-payload-scan" };',
    new: 'return Object.assign({}, pre||{}, { companyName: pvjd.buyer.info.company.name, location: pvjd.buyer.info.location || (pre&&pre.location) || null, source: "nuxt-payload-scan" });'
  }
];

for (const p of patches) {
  const idx = s.indexOf(p.old);
  if (idx === -1) { console.warn('Warning: patch target not found:', p.old.slice(0,60)); continue; }
  s = s.slice(0, idx) + p.new + s.slice(idx + p.old.length);
  console.log('Patched:', p.old.slice(0, 50));
}

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
