import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sameOrigin, destroySession} from '../lib/auth.ts';
import {POST as setup} from '../app/api/auth/admin-setup/route.ts';

test('public origin works behind a proxy while cross-site requests remain blocked', async t => {
  const previous = process.env.APP_ORIGIN;
  t.after(() => {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  });
  process.env.APP_ORIGIN = 'https://app.ptraam.test/';
  const request = (origin, extra = {}) => new Request('http://127.0.0.1:3000/api/auth/admin-setup', {
    method: 'POST', headers: {...(origin === undefined ? {} : {origin}), ...extra},
  });
  assert.equal(sameOrigin(request('https://app.ptraam.test')), true);
  assert.match(await destroySession(request('https://app.ptraam.test')), /; Secure$/);
  for (const origin of ['https://evil.test', 'null', '', 'http://app.ptraam.test', 'https://app.ptraam.test:444', 'http://127.0.0.1:3000']) {
    assert.equal(sameOrigin(request(origin)), false, origin);
  }
  assert.equal(sameOrigin(request('https://evil.test', {'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https'})), false);
  assert.equal((await setup(request('https://evil.test'))).status, 403);
  assert.equal(sameOrigin(request(undefined)), true);
  for (const value of ['not-a-url', 'null', 'https://app.ptraam.test/path', 'https://user:pass@app.ptraam.test']) {
    process.env.APP_ORIGIN = value;
    assert.equal(sameOrigin(request('https://app.ptraam.test')), false);
  }
  delete process.env.APP_ORIGIN;
  assert.equal(sameOrigin(request('http://127.0.0.1:3000')), true);
  assert.equal(sameOrigin(request('https://evil.test')), false);
  assert.doesNotMatch(await destroySession(request(undefined)), /; Secure/);
});

test('loopback origin uses the actual Host after NextURL normalizes the URL', t => {
  const previous = process.env.APP_ORIGIN;
  t.after(() => {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  });
  delete process.env.APP_ORIGIN;
  const request = (host, origin) => new Request('http://localhost:3000/api/auth/admin-setup', {
    method: 'POST', headers: {host, origin},
  });
  for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
    assert.equal(sameOrigin(request(host, `http://${host}`)), true);
    assert.equal(sameOrigin(request(host, 'https://evil.test')), false);
    assert.equal(sameOrigin(request(host, `https://${host}`)), false);
  }
  assert.equal(sameOrigin(request('127.0.0.1:3000', 'http://localhost:3000')), false);
  assert.equal(sameOrigin(request('127.0.0.1:4000', 'http://127.0.0.1:4000')), false);
  assert.equal(sameOrigin(request('evil.test:3000', 'http://evil.test:3000')), false);
  process.env.APP_ORIGIN = 'https://app.ptraam.test';
  assert.equal(sameOrigin(request('127.0.0.1:3000', 'http://127.0.0.1:3000')), false);
  assert.equal(sameOrigin(request('127.0.0.1:3000', 'https://app.ptraam.test')), true);
});
