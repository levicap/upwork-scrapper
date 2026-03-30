// Dump the actual content of window.__NUXT__.fetch["ModalJobDetails:0"]
// so we can see its structure and find the real path to company name
const fs = require('fs');
const file = './chrome-extension/background.js';
let s = fs.readFileSync(file, 'utf8');

const OLD =
  '      return { error: "company name not found", source: "none", nuxtKeys: nuxtKeys, payloadKeys: payloadKeys, fetchKeys: fetchKeys, storeJobDetailsKeys: storeJobDetailsKeys };\r\n' +
  '    } catch(e) { return { error: e.message }; }\r\n' +
  '  }());';

const NEW =
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

const idx = s.indexOf(OLD);
if (idx === -1) { console.error('Target not found'); process.exit(1); }
s = s.slice(0, idx) + NEW + s.slice(idx + OLD.length);

fs.writeFileSync(file, s, 'utf8');
require('child_process').execSync('node --check ' + file, { stdio: 'inherit' });
console.log('Done. Syntax OK.');
