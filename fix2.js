// Fix maybeExtractCompany: add 400ms delay + DOM search + broader __NUXT__ scan
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

const F1_START = s.indexOf('function maybeExtractCompany');
const F1_END   = s.indexOf('\r\nfunction extractJobCiphertext');
if (F1_START === -1) { console.error('maybeExtractCompany start not found'); process.exit(1); }
if (F1_END   === -1) { console.error('extractJobCiphertext end marker not found'); process.exit(1); }

const newMaybe =
'function maybeExtractCompany(entry) {\r\n' +
'  if (!entry.url || !entry.url.includes(\'get-auth-job-details\')) return;\r\n' +
'  const jad = entry.responseBody?.data?.jobAuthDetails;\r\n' +
'  if (!jad) return;\r\n' +
'\r\n' +
'  const companyId = jad?.buyer?.info?.company?.companyId;\r\n' +
'  if (!companyId) return;\r\n' +
'\r\n' +
'  const apiCompanyName = jad?.buyer?.info?.company?.name || null;\r\n' +
'  const jobTitle = (jad?.opening?.job?.info?.title || \'Unknown\').replace(/\\s+/g, \' \').trim();\r\n' +
'  const location = jad?.buyer?.info?.location || null;\r\n' +
'  const jobCiphertext = extractJobCiphertext(entry.requestBody);\r\n' +
'  const tabId = entry.tabId;\r\n' +
'\r\n' +
'  const persist = (companyName) => {\r\n' +
'    chrome.storage.local.get([\'detectedCompanies\'], (result) => {\r\n' +
'      const companies = result.detectedCompanies || [];\r\n' +
'      const existing = companies.find(c => c.companyId === companyId);\r\n' +
'      if (existing) {\r\n' +
'        if (!existing.companyName && companyName) {\r\n' +
'          existing.companyName = companyName;\r\n' +
'          chrome.storage.local.set({ detectedCompanies: companies });\r\n' +
'        }\r\n' +
'        return;\r\n' +
'      }\r\n' +
'      companies.push({ companyId, companyName, jobCiphertext, jobTitle, location, detectedAt: new Date().toISOString() });\r\n' +
'      chrome.storage.local.set({ detectedCompanies: companies });\r\n' +
'    });\r\n' +
'  };\r\n' +
'\r\n' +
'  // If API already returned the name, persist immediately\r\n' +
'  if (apiCompanyName) { persist(apiCompanyName); return; }\r\n' +
'\r\n' +
'  // API returns null — wait 400 ms for Vue\'s async fetch to populate the store,\r\n' +
'  // then read the company name from DOM + Vuex + __NUXT__\r\n' +
'  if (tabId && attachedTabs.has(tabId)) {\r\n' +
'    setTimeout(() => {\r\n' +
'      if (!attachedTabs.has(tabId)) { persist(null); return; }\r\n' +
'      const expr = \'(function(){\' +\r\n' +
'        \'try{\' +\r\n' +
'        // 1. DOM: company name link inside the modal (most reliable)\r\n' +
'        \'var links=document.querySelectorAll(\\\'[href*="/companies/"]\\\');\' +\r\n' +
'        \'for(var li=0;li<links.length;li++){\' +\r\n' +
'          \'var t=links[li].textContent.trim();\' +\r\n' +
'          \'if(t&&t.length>1)return t;\' +\r\n' +
'        \'}\' +\r\n' +
'        // 2. Vuex live store via __vue__ root\r\n' +
'        \'var el=document.getElementById("__nuxt");\' +\r\n' +
'        \'var store=el&&el.__vue__&&el.__vue__.$store;\' +\r\n' +
'        \'if(store&&store.state){\' +\r\n' +
'          // jobDetails module (registered by ModalJobDetails)\r\n' +
'          \'var jdm=store.state.jobDetails;\' +\r\n' +
'          \'if(jdm){\' +\r\n' +
'            \'var jd=jdm.jobDetails||jdm;\' +\r\n' +
'            \'var b=jd.buyer;\' +\r\n' +
'            \'if(b&&b.info&&b.info.company&&b.info.company.name)return b.info.company.name;\' +\r\n' +
'          \'}\' +\r\n' +
'          // Any other module with buyer.info.company.name\r\n' +
'          \'var mkeys=Object.keys(store.state);\' +\r\n' +
'          \'for(var mi=0;mi<mkeys.length;mi++){\' +\r\n' +
'            \'var mod=store.state[mkeys[mi]];\' +\r\n' +
'            \'if(!mod||typeof mod!=="object")continue;\' +\r\n' +
'            \'var mjd=mod.jobDetails||mod;\' +\r\n' +
'            \'var mb=mjd&&mjd.buyer;\' +\r\n' +
'            \'if(mb&&mb.info&&mb.info.company&&mb.info.company.name)return mb.info.company.name;\' +\r\n' +
'          \'}\' +\r\n' +
'        \'}\' +\r\n' +
'        // 3. window.__NUXT__.fetch (populated after fetch() completes)\r\n' +
'        \'var nuxt=window.__NUXT__;\' +\r\n' +
'        \'if(nuxt&&nuxt.fetch){\' +\r\n' +
'          \'var fvals=Object.values(nuxt.fetch);\' +\r\n' +
'          \'for(var fi=0;fi<fvals.length;fi++){\' +\r\n' +
'            \'if(!fvals[fi]||typeof fvals[fi]!=="object")continue;\' +\r\n' +
'            \'var fjd=fvals[fi].jobDetails?(fvals[fi].jobDetails.jobDetails||fvals[fi].jobDetails):fvals[fi];\' +\r\n' +
'            \'if(fjd&&fjd.buyer&&fjd.buyer.info&&fjd.buyer.info.company&&fjd.buyer.info.company.name)return fjd.buyer.info.company.name;\' +\r\n' +
'          \'}\' +\r\n' +
'        \'}\' +\r\n' +
'        // 4. window.__NUXT__.state (Vuex initial SSR state)\r\n' +
'        \'if(nuxt&&nuxt.state&&nuxt.state.jobDetails){\' +\r\n' +
'          \'var sjd=nuxt.state.jobDetails.jobDetails||nuxt.state.jobDetails;\' +\r\n' +
'          \'var sb=sjd&&sjd.buyer;\' +\r\n' +
'          \'if(sb&&sb.info&&sb.info.company&&sb.info.company.name)return sb.info.company.name;\' +\r\n' +
'        \'}\' +\r\n' +
'        // 5. window.__NUXT__.data (asyncData results array)\r\n' +
'        \'if(nuxt&&Array.isArray(nuxt.data)){\' +\r\n' +
'          \'for(var di=0;di<nuxt.data.length;di++){\' +\r\n' +
'            \'var dp=nuxt.data[di];\' +\r\n' +
'            \'if(!dp)continue;\' +\r\n' +
'            \'var djd=dp.jobDetails?(dp.jobDetails.jobDetails||dp.jobDetails):dp;\' +\r\n' +
'            \'if(djd&&djd.buyer&&djd.buyer.info&&djd.buyer.info.company&&djd.buyer.info.company.name)return djd.buyer.info.company.name;\' +\r\n' +
'          \'}\' +\r\n' +
'        \'}\' +\r\n' +
'        \'return null;\' +\r\n' +
'        \'}catch(e){return null;}\' +\r\n' +
'      \'})()\';\r\n' +
'      chrome.debugger.sendCommand({ tabId }, \'Runtime.evaluate\', { expression: expr, returnByValue: true }, (res) => {\r\n' +
'        const liveCompanyName = (res && res.result && typeof res.result.value === \'string\' && res.result.value) ? res.result.value : null;\r\n' +
'        persist(liveCompanyName);\r\n' +
'      });\r\n' +
'    }, 400);\r\n' +
'  } else {\r\n' +
'    persist(null);\r\n' +
'  }\r\n' +
'}';

s = s.slice(0, F1_START) + newMaybe + s.slice(F1_END);

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
