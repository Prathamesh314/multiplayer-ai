import test from 'node:test';
import assert from 'node:assert/strict';
import { processTreeRss } from './resources.mjs';

test('RSS includes all web descendants regardless of ps order, excluding other processes', () => {
  const output = '12 11 30\n99 1 500\n10 1 10\n11 10 20\n13 10 40\n';
  assert.equal(processTreeRss(output, 10), 100 * 1024);
  assert.equal(processTreeRss(output, 123), 0);
});
