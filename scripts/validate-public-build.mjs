import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

const versions = [...html.matchAll(/[?&]v=(\d+)/g)].map(match => match[1]);
assert.ok(versions.length > 1, 'Geen cache-bustingversies gevonden.');
assert.equal(new Set(versions).size, 1, 'index.html gebruikt verschillende cacheversies.');
const version = versions[0];
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
assert.match(serviceWorker, new RegExp(`vermogen-v${version}\\b`), 'Service-worker cacheversie loopt achter.');
assert.doesNotMatch(serviceWorker, new RegExp(`\\?v=(?!${version}\\b)\\d+`), 'Service-worker bevat een afwijkende assetversie.');

console.log(`Publieke build gevalideerd: ${tracked.length} tracked bestanden, cache v${version}, geen privépaden.`);
