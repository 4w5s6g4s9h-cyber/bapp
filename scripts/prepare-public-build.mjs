import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist');
export const PUBLIC_FILES = Object.freeze([
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'sw.js',
  'css/style.css',
  'js/data.js',
  'js/ml.js',
  'js/charts.js',
  'js/quant.js',
  'js/backtest.js',
  'js/catalog.js',
  'js/dca.js',
  'js/importer.js',
  'js/alerts.js',
  'js/app.js',
]);

async function listFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

export async function preparePublicBuild() {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const file of PUBLIC_FILES) {
    const source = path.join(root, file);
    const sourceStat = await fs.lstat(source);
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink(), `Publiek pad is geen regulier bestand: ${file}`);
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  await fs.writeFile(path.join(destination, '.nojekyll'), '');

  const actualFiles = (await listFiles(destination)).sort();
  const expectedFiles = [...PUBLIC_FILES, '.nojekyll'].sort();
  assert.deepEqual(actualFiles, expectedFiles, 'Publiek artifact bevat een onverwacht bestand.');
  console.log(`Publieke artifactmap opgebouwd: ${PUBLIC_FILES.length} expliciet goedgekeurde runtimebestanden in dist/.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await preparePublicBuild();
