const fs = require('fs');
const file = './chrome-extension/background.js';
const eol = '\r\n';
const DIAG_START = (() => {
  const s = fs.readFileSync(file, 'utf8');
  return s.indexOf('      var nuxtKeys = window.__NUXT__');
})();
const fullS = fs.readFileSync(file, 'utf8');
const DIAG_END = fullS.indexOf('  }());', DIAG_START) + '  }());'.length;
if (DIAG_START === -1) { console.error('Diag start not found'); process.exit(1); }
const CLEAN =
  '      if (pre) return Object.assign({}, pre, { source: \'cached-detection\' });' + eol +
  '      return { error: \'company name not found\', source: \'none\' };' + eol +
  '    } catch(e) { return { error: e.message }; }' + eol +
  '  }());';
const result = fullS.slice(0, DIAG_START) + CLEAN + fullS.slice(DIAG_END);
fs.writeFileSync(file, result, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
let s = fs.readFileSync(file, 'utf8');

// Remove nuxtKeys/payloadKeys/fetchKeys/storeJobDetailsKeys/modalDump diagnostic lines
// and replace the whole end-of-closure block with a clean version

const OLD =
  '      // Nothing found — return diagnostic info to help debug\r\n' +
  '      var nuxtKeys = window.__NUXT__ ? Object.keys(window.__NUXT__) : [];\r\n' +
  '      var payloadKeys = (window.__NUXT__ && window.__NUXT__.payload) ? Object.keys(window.__NUXT__.payload) : [];\r\n' +
  '      var fetchKeys = (window.__NUXT__ && window.__NUXT__.fetch) ? Object.keys(window.__NUXT__.fetch) : [];\r\n' +
  '      var storeJobDetailsKeys = (window.__NUXT__ && window.__NUXT__.state && window.__NUXT__.state.jobDetails) ? Object.keys(window.__NUXT__.state.jobDetails) : [];\r\n' +
  '      return { error: "company name not found", source: "none", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, storeJobDetailsKeys: storeJobDetailsKeys };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

if (s.indexOf(OLD) === -1) { console.error('OLD block not found'); process.exit(1); }

const OLD2 =
  '      // Dump ModalJobDetails:0 content for diagnosis\r\n' +
  '      var modalEntry = (window.__NUXT__ && window.__NUXT__.fetch && window.__NUXT__.fetch["ModalJobDetails:0"]) || null;\r\n' +
  '      var modalDump = null;\r\n' +
  '      if (modalEntry && typeof modalEntry === "object" && !Array.isArray(modalEntry)) {\r\n' +
  '        // Serialize up to 2 levels deep without any circular refs\r\n' +
  '        try { modalDump = JSON.parse(JSON.stringify(modalEntry)); } catch(e2) { modalDump = { serializeError: e2.message }; }\r\n' +
  '      } else {\r\n' +
  '        modalDump = { type: Array.isArray(modalEntry) ? "array" : typeof modalEntry, length: modalEntry && modalEntry.length };\r\n' +
  '      }\r\n' +
  '      if (pre) return Object.assign({}, pre, { source: (pre.source||"cached") + "+no-name-on-page", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, modalDump: modalDump });\r\n' +
  '      return { error: "company name not found", source: "none", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, storeJobDetailsKeys: storeJobDetailsKeys, modalDump: modalDump };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const NEW_CLEAN =
  '      if (pre) return Object.assign({}, pre, { source: (pre.source||"cached") + "+no-company-name" });\r\n' +
  '      return { error: "company name not found — client has no registered company on Upwork", source: "none" };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

// Try the full dump block first, then fall back to the shorter OLD block
if (s.indexOf(OLD2) !== -1) {
  s = s.replace(OLD2, NEW_CLEAN);
  console.log('Replaced full dump block');
} else {
  s = s.replace(OLD, NEW_CLEAN);
  console.log('Replaced short block');
}

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
