import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");
const tracker = await readFile(new URL("../js/tracker.js", import.meta.url), "utf8");

assert.match(index, /<link rel="stylesheet" href="css\/styles\.css(\?v=\d+)?">/);
assert.match(index, /<script src="js\/portfolioMath\.js(\?v=\d+)?" defer><\/script>\s*<script src="js\/tracker\.js(\?v=\d+)?" defer><\/script>/);
assert.match(index, /<meta http-equiv="Content-Security-Policy"/);
assert.doesNotMatch(index, /<style>|<script>\s*const STORAGE_KEY/);
assert.doesNotMatch(index, /portfolio-import-data\.js/);
assert.match(index, /accept="\.json,application\/json"/);

// Inline handlers zijn vervangen door data-action + één gedelegeerde listener (CSP-proof).
assert.doesNotMatch(index, /onclick=/);
assert.doesNotMatch(tracker, /onclick=/);
assert.match(tracker, /const UI_ACTIONS = \{/);

// Legacy snapshot-/demo-reconciliatie mag niet terugkomen: die kon echte data wissen.
assert.doesNotMatch(tracker, /fixDegiroSnapshot|fixCryptoSnapshot|isDemoEquityState|DEFAULT_IMPORT_STATE|CRYPTO_SNAPSHOT_QUANTITIES/);

const tabletMedia = css.match(/@media \(max-width: 1040px\) \{[\s\S]*?@media \(max-width: 720px\)/)?.[0] || "";
assert.match(tabletMedia, /aside\s*\{[\s\S]*height:\s*auto;/);
assert.match(tabletMedia, /nav\s*\{[\s\S]*overflow-x:\s*auto;/);

assert.match(css, /body\.modal-open\s*\{[\s\S]*overflow:\s*hidden;/);
assert.match(tracker, /function openDialog\(/);
assert.match(tracker, /function handleModalKeydown\(/);
assert.match(tracker, /function drawEmptyCanvasMessage\(/);

console.log("browser smoke static checks passed");
