import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { ROOT } from './helpers/runtime.mjs';

test('alle JavaScript-bestanden zijn syntactisch geldig', () => {
  for (const name of fs.readdirSync(path.join(ROOT, 'js')).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(ROOT, 'js', name), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }));
  }
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), { filename: 'sw.js' }));
});

test('publieke shell heeft CSP, geen externe fonts en consistente cacheversie', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.doesNotMatch(html + sw, /\?v=11/);
  assert.match(sw, /res\.ok && res\.type === 'basic'/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'js/importer.js'), 'utf8'), /corsproxy|allorigins|codetabs/i);
});
