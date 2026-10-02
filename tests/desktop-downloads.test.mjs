import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopDownloadUrl } from '../app/lib/desktop-downloads.ts';

test('missing, unsafe, and old placeholder downloads cannot become live buttons', () => {
  for (const value of [undefined, '', '  ', 'not a URL', '/download/app.dmg',
    'http://downloads.test/app.exe', 'javascript:alert(1)', 'file:///app.dmg',
    'https://user:password@downloads.test/app.dmg', 'https://example.com/downloads/app.dmg',
    'https://files.example.org/app.exe', 'https://example.net/app.AppImage']) {
    assert.equal(desktopDownloadUrl(value), null, String(value));
  }
});

test('versioned public download URLs retain filenames and query credentials for external hosts', () => {
  for (const value of [
    'https://downloads.test/preview-abc/Multiplayer-AI-mac-arm64-preview.dmg',
    'https://storage.test/app.exe?signature=temporary-token',
    'https://downloads.test/preview-abc/SHA256SUMS.txt',
  ]) assert.equal(desktopDownloadUrl(value), value);
});
