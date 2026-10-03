import assert from 'node:assert/strict';
import test from 'node:test';
import { safeReturnPath, loginHref } from '../app/lib/auth/return-path.ts';

test('login retains the selected organisation, project and invitation paths', () => {
  for (const path of ['/workspace?org=second-team&connections=project-id', '/invite/abc123', '/s/my-room#changes']) {
    assert.equal(safeReturnPath(path), path);
    assert.equal(new URL(loginHref(path), 'https://app.test').searchParams.get('next'), path);
  }
});

test('post-login targets cannot navigate to an external origin through URL normalization', () => {
  for (const path of [undefined, '', 'https://evil.test', '//evil.test', '/\\evil.test', '/%5cevil.test', '/%2fevil.test', '/\t/evil.test', '/%0a/evil.test', '/.//evil.test', '/%2e//evil.test', '/foo/..//evil.test', '/.%2e//evil.test', '/foo/../%2fevil.test', 'javascript:alert(1)', '/bad%escape', '/'+ 'x'.repeat(4096)]) {
    assert.equal(safeReturnPath(path), '/workspace', JSON.stringify(path));
  }
});
