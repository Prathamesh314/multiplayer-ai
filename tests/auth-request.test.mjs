import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthRequestError, authRequest, retryAfterSeconds } from '../app/lib/auth/request.ts';
import { isPasswordAuthResponse } from '../app/lib/auth/types.ts';

test('authentication requests distinguish recovery actions without exposing transport errors', async t => {
  const original = globalThis.fetch;
  try {
    await t.test('offline and timeout messages are actionable and never echo raw errors', async () => {
      globalThis.fetch = async () => { throw new TypeError('Failed to fetch: secret detail'); };
      await assert.rejects(authRequest('/api/auth/login', 'POST', {}), error => error instanceof AuthRequestError && error.code === 'network_error' && /internet connection/.test(error.message) && !/secret/.test(error.message));
      globalThis.fetch = async () => { throw new DOMException('secret detail', 'TimeoutError'); };
      await assert.rejects(authRequest('/api/auth/email/resend', 'POST'), error => error.code === 'request_timeout' && /refresh/.test(error.message));
    });
    await t.test('proxy HTML and server errors are not shown to the user', async () => {
      globalThis.fetch = async () => new Response('<html>upstream secret</html>', { status: 502 });
      await assert.rejects(authRequest('/api/auth/login', 'POST'), error => error.status === 502 && /try again/.test(error.message) && !/secret|html/.test(error.message));
      globalThis.fetch = async () => Response.json({ error: 'database password secret' }, { status: 503 });
      await assert.rejects(authRequest('/api/auth/login', 'POST'), error => !/secret|password/.test(error.message));
    });
    await t.test('rate limits preserve the wait and verification recovery code', async () => {
      globalThis.fetch = async () => Response.json({ error: 'Please wait before requesting another code.', code: 'resend_limited' }, { status: 429, headers: { 'retry-after': '60' } });
      await assert.rejects(authRequest('/api/auth/email/resend', 'POST'), error => error.retryAfter === 60 && error.code === 'resend_limited');
      assert.equal(retryAfterSeconds('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:00Z')), 60);
      assert.equal(retryAfterSeconds('invalid'), 0);
      assert.equal(retryAfterSeconds('99999999'), 86400);
    });
    await t.test('an invalid success response cannot redirect as an authenticated user', async () => {
      for (const value of [null, {}, [], { status: 'authenticated' }, { status: 'verification_required', verification: {} }]) {
        globalThis.fetch = async () => Response.json(value);
        await assert.rejects(authRequest('/api/auth/login', 'POST', {}, isPasswordAuthResponse), error => error.code === 'invalid_response');
      }
      const result = { status: 'authenticated', user: { id: 'user', email: 'user@example.test' }, connectCode: null };
      globalThis.fetch = async () => Response.json(result);
      assert.deepEqual(await authRequest('/api/auth/login', 'POST', {}, isPasswordAuthResponse), result);
    });
  } finally { globalThis.fetch = original; }
});
