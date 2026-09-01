import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
const background = await readFile(new URL('../public/background.js', import.meta.url), 'utf8');

const assert = (condition, label) => {
  if (!condition) {
    console.error('FAIL:', label);
    process.exit(1);
  }
};

assert(manifest.manifest_version === 3, 'Manifest V3');
assert(manifest.permissions.includes('unlimitedStorage'), 'large IndexedDB storage permission enabled');
assert(manifest.commands?._execute_action?.suggested_key?.mac === 'Command+Shift+O', 'macOS shortcut uses Command');
assert(background.includes('chrome.tabs.query') && background.includes('chrome.tabs.update'), 'toolbar action reuses an existing Corral tab');

console.log('manifest tests: ALL PASS');
