import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES } from './prepare-public-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const privatePath = /(?:^|\/)(?:portfolio(?:.*\.json| JSON)|Uitdraai en huidige portfolio|Transactions\.csv|Volledige geschiedenis\.csv)/i;
const leakedPaths = tracked.filter(file => privatePath.test(file));
assert.deepEqual(leakedPaths, [], `Privébestanden staan onder versiebeheer: ${leakedPaths.join(', ')}`);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localRefs = [...html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^"#]*)?"/g)]
  .map(match => match[1])
  .filter(ref => !/^(?:https?:|data:|#)/.test(ref));
for (const ref of localRefs) {
  assert.ok(fs.existsSync(path.join(root, ref)), `Ontbrekend publiek bestand: ${ref}`);
  assert.ok(PUBLIC_FILES.includes(ref), `HTML verwijst naar bestand buiten de publicatie-allowlist: ${ref}`);
}

assert.equal(new Set(PUBLIC_FILES).size, PUBLIC_FILES.length, 'Publicatie-allowlist bevat duplicaten.');
for (const file of PUBLIC_FILES) {
  const stat = fs.lstatSync(path.join(root, file));
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Publiek pad is geen regulier bestand: ${file}`);
  assert.doesNotMatch(file, privatePath, `Privépad staat in de publicatie-allowlist: ${file}`);
}

const versions = [...html.matchAll(/[?&]v=(\d+)/g)].map(match => match[1]);
assert.ok(versions.length > 1, 'Geen cache-bustingversies gevonden.');
assert.equal(new Set(versions).size, 1, 'index.html gebruikt verschillende cacheversies.');
const version = versions[0];
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
assert.match(serviceWorker, new RegExp(`vermogen-v${version}\\b`), 'Service-worker cacheversie loopt achter.');
assert.doesNotMatch(serviceWorker, new RegExp(`\\?v=(?!${version}\\b)\\d+`), 'Service-worker bevat een afwijkende assetversie.');

const pagesWorkflow = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
assert.match(pagesWorkflow, /run:\s*npm run check\b/, 'Pages valideert de app niet vóór publicatie.');
assert.match(pagesWorkflow, /run:\s*npm run build:public\b/, 'Pages bouwt het publieke allowlist-artifact niet.');
assert.match(pagesWorkflow, /path:\s*dist\s*$/m, 'Pages uploadt niet uitsluitend dist/.');
assert.doesNotMatch(pagesWorkflow, /path:\s*[.\/]\s*$/m, 'Pages mag de repository-root niet uploaden.');

const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
assert.match(ciWorkflow, /^\s{2}test:\s*$/m, 'CI mist de unit-/regressiecheck.');
assert.match(ciWorkflow, /^\s{2}browser-e2e:\s*$/m, 'CI mist de cross-browsercheck.');
assert.match(ciWorkflow, /playwright install --with-deps chromium firefox webkit/, 'CI installeert niet alle ondersteunde browsers.');

console.log(`Publieke build gevalideerd: ${PUBLIC_FILES.length} allowlistbestanden, cache v${version}, geen privépaden.`);
