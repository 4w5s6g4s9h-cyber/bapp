import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");
const tracker = await readFile(new URL("../js/tracker.js", import.meta.url), "utf8");

assert.match(index, /<link rel="stylesheet" href="css\/styles\.css">/);
assert.match(index, /<script src="js\/tracker\.js" defer><\/script>/);
assert.doesNotMatch(index, /<style>|<script>\s*const STORAGE_KEY/);
assert.doesNotMatch(index, /portfolio-import-data\.js/);
assert.match(index, /accept="\.json,application\/json"/);

const tabletMedia = css.match(/@media \(max-width: 1040px\) \{[\s\S]*?@media \(max-width: 720px\)/)?.[0] || "";
assert.match(tabletMedia, /aside\s*\{[\s\S]*height:\s*auto;/);
assert.match(tabletMedia, /nav\s*\{[\s\S]*overflow-x:\s*auto;/);

assert.match(css, /body\.modal-open\s*\{[\s\S]*overflow:\s*hidden;/);
assert.match(tracker, /function openDialog\(/);
assert.match(tracker, /function handleModalKeydown\(/);
assert.match(tracker, /function drawEmptyCanvasMessage\(/);

console.log("browser smoke static checks passed");
