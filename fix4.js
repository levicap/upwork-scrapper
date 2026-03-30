// Add window.__NUXT__.payload search (the path used by friend's extension)
// to both maybeExtractCompany and the runQueriesInTab page-state block
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

// ─── FIX A: maybeExtractCompany expr — add nuxt.payload before 'return null' ─
const A_OLD =
  '        \'return null;\' +\r\n' +
  '        \'}catch(e){return null;}\' +\r\n' +
  '      \'})()\';\r\n';

const A_NEW =
  '        // 6. window.__NUXT__.payload (friend\'s extension reads this path)\r\n' +
  '        \'if(nuxt&&nuxt.payload){\' +\r\n' +
  '          \'var pjd=nuxt.payload.jobDetails;\' +\r\n' +
  '          \'if(pjd){\' +\r\n' +
  '            \'var pjd2=pjd.jobDetails||pjd;var pb=pjd2.buyer;\' +\r\n' +
  '            \'if(pb&&pb.info&&pb.info.company&&pb.info.company.name)return pb.info.company.name;\' +\r\n' +
  '          \'}\' +\r\n' +
  '          \'var pkeys=Object.keys(nuxt.payload);\' +\r\n' +
  '          \'for(var pi=0;pi<pkeys.length;pi++){\' +\r\n' +
  '            \'var pval=nuxt.payload[pkeys[pi]];\' +\r\n' +
  '            \'if(!pval||typeof pval!=="object")continue;\' +\r\n' +
  '            \'var pvjd=pval.jobDetails?(pval.jobDetails.jobDetails||pval.jobDetails):pval;\' +\r\n' +
  '            \'if(pvjd&&pvjd.buyer&&pvjd.buyer.info&&pvjd.buyer.info.company&&pvjd.buyer.info.company.name)return pvjd.buyer.info.company.name;\' +\r\n' +
  '          \'}\' +\r\n' +
  '        \'}\' +\r\n' +
  '        \'return null;\' +\r\n' +
  '        \'}catch(e){return null;}\' +\r\n' +
  '      \'})()\';\r\n';

const A_IDX = s.indexOf(A_OLD);
if (A_IDX === -1) { console.error('FIX A: return null marker not found'); process.exit(1); }
s = s.slice(0, A_IDX) + A_NEW + s.slice(A_IDX + A_OLD.length);
console.log('FIX A applied');

// ─── FIX B: page-state block in runQueriesInTab — add nuxt.payload ────────────
const B_OLD =
  '      return { error: "company name not found \u2014 open a job then click Run", source: "none" };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const B_NEW =
  '      // window.__NUXT__.payload (Nuxt SSR payload — what friend\'s extension reads)\r\n' +
  '      var nuxt2 = window.__NUXT__;\r\n' +
  '      if (nuxt2 && nuxt2.payload) {\r\n' +
  '        var pjd = nuxt2.payload.jobDetails;\r\n' +
  '        if (pjd) {\r\n' +
  '          var pjd2 = pjd.jobDetails || pjd;\r\n' +
  '          var pb = pjd2.buyer;\r\n' +
  '          if (pb && pb.info && pb.info.company && pb.info.company.name) {\r\n' +
  '            return { companyName: pb.info.company.name, companyUid: pb.info.company.companyUid || null, location: pb.info.location || null, source: "nuxt-payload" };\r\n' +
  '          }\r\n' +
  '        }\r\n' +
  '        // scan all payload keys\r\n' +
  '        var pkeys = Object.keys(nuxt2.payload);\r\n' +
  '        for (var pi = 0; pi < pkeys.length; pi++) {\r\n' +
  '          var pval = nuxt2.payload[pkeys[pi]];\r\n' +
  '          if (!pval || typeof pval !== "object") continue;\r\n' +
  '          var pvjd = pval.jobDetails ? (pval.jobDetails.jobDetails || pval.jobDetails) : pval;\r\n' +
  '          if (pvjd && pvjd.buyer && pvjd.buyer.info && pvjd.buyer.info.company && pvjd.buyer.info.company.name) {\r\n' +
  '            return { companyName: pvjd.buyer.info.company.name, location: pvjd.buyer.info.location || null, source: "nuxt-payload-scan" };\r\n' +
  '          }\r\n' +
  '        }\r\n' +
  '      }\r\n' +
  '\r\n' +
  '      return { error: "company name not found \u2014 open a job then click Run", source: "none" };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const B_IDX = s.indexOf(B_OLD);
if (B_IDX === -1) { console.error('FIX B: page-state fallback not found'); process.exit(1); }
s = s.slice(0, B_IDX) + B_NEW + s.slice(B_IDX + B_OLD.length);
console.log('FIX B applied');

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
