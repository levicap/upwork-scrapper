// Replace the final error return in page-state block with a diagnostic dump
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

const OLD =
  '      return { error: "company name not found \u2014 open a job then click Run", source: "none" };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const NEW =
  '      // Nothing found — return diagnostic info to help debug\r\n' +
  '      var nuxtKeys = window.__NUXT__ ? Object.keys(window.__NUXT__) : [];\r\n' +
  '      var payloadKeys = (window.__NUXT__ && window.__NUXT__.payload) ? Object.keys(window.__NUXT__.payload) : [];\r\n' +
  '      var fetchKeys = (window.__NUXT__ && window.__NUXT__.fetch) ? Object.keys(window.__NUXT__.fetch) : [];\r\n' +
  '      var storeJobDetailsKeys = (window.__NUXT__ && window.__NUXT__.state && window.__NUXT__.state.jobDetails) ? Object.keys(window.__NUXT__.state.jobDetails) : [];\r\n' +
  '      return { error: "company name not found", source: "none", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, storeJobDetailsKeys: storeJobDetailsKeys };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const idx = s.indexOf(OLD);
if (idx === -1) { console.error('FIX: error return not found'); process.exit(1); }
s = s.slice(0, idx) + NEW + s.slice(idx + OLD.length);

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
