import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class MemoryStorage {
  constructor(initial = {}) { this.data = new Map(Object.entries(initial)); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.has(String(key)) ? this.data.get(String(key)) : null; }
  setItem(key, value) { this.data.set(String(key), String(value)); }
  removeItem(key) { this.data.delete(String(key)); }
  clear() { this.data.clear(); }
  snapshot() { return Object.fromEntries(this.data); }
}

export function createRuntime(files, { storage = new MemoryStorage(), fetchImpl } = {}) {
  let fetchCalls = 0;
  const context = vm.createContext({
    console,
    localStorage: storage,
    location: { reload() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Blob,
    URL,
    performance: { now: () => Date.now() },
    requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    fetch: async (...args) => {
      fetchCalls++;
      if (fetchImpl) return fetchImpl(...args);
      throw new Error('Onverwachte netwerkcall in test');
    },
  });
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return {
    context,
    storage,
    evaluate: expression => vm.runInContext(expression, context),
    fetchCalls: () => fetchCalls,
  };
}
