const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadBackground(context, core) {
  vm.createContext(context);
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file === 'shared/core.js') {
        context.RoundtableCore = core;
        continue;
      }
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(source, context, { filename: file });
    }
  };
  const entry = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(entry, context, { filename: 'background.js' });
}

module.exports = { loadBackground };
