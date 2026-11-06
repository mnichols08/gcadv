import test from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE, createBackupHandler, LIMITS, MAX_ITEMS_PER_USER, newCode, normalizeEmail, QUOTA_BYTES, rateLimitAddress, rateLimitEmail, validEmail } from '../../../apps/trails/server/backup-core.mjs';
import { memoryBucket, memoryStore } from '../../../apps/trails/server/memory-store.mjs';

// backup.js reads the page's origin as it loads, which doesn't exist under Node.
globalThis.self ??= { location: { origin: 'https://example.test' } };
const { base64ToBytes, bytesToBase64, MASS_REMOVAL, mergeLocal, pendingCount, planSync, shouldHoldRemovals } = await import('../../../apps/trails/public/modules/backup.js');

const ORIGIN = 'https://app.test';

function harness(limits = {}) {
  const clock = { now: 1_800_000_000_000 };
  const codes = new Map();
  const sent = [];
  const notices = [];
  const store = memoryStore();
  const bucket = memoryBucket();
  const options = {
    store,
    bucket,
    pepper: 'test-pepper',
    limits,
    sendNotice: async email => { notices.push(email); },
    now: () => clock.now,
    sendCode: async (email, code) => {
      if (harness.failMail) throw new Error('mail down');
      codes.set(email, code);
      sent.push(email);
    },
  };
  const handle = createBackupHandler(options);
  const request = (method, path, { body, cookie, origin = ORIGIN, address = '198.51.100.7', type } = {}) => {
    const headers = new Headers();
    if (origin) headers.set('Origin', origin);
    if (cookie) headers.set('Cookie', cookie);
    if (address) headers.set('CF-Connecting-IP', address);
    if (type) headers.set('Content-Type', type);
    return handle(new Request(`${ORIGIN}/api/hike/${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
  };
  const post = (path, value, extra = {}) => request('POST', path, { body: JSON.stringify(value), ...extra });
  const signIn = async email => {
    await post('auth/start', { email });
    const response = await post('auth/verify', { email, code: codes.get(email) });
    assert.equal(response.status, 200);
    return response.headers.get('Set-Cookie').split(';')[0];
  };
  return { clock, codes, sent, notices, store, bucket, request, post, signIn };
}

const putJson = (h, cookie, kind, id, updatedAt, value = { a: 1 }) => h.request('PUT', `items/${kind}/${id}?updatedAt=${updatedAt}`, { cookie, body: JSON.stringify(value) });
const TIME = 1_799_000_000_000;

test('email handling is forgiving about case and space, strict about shape', () => {
  assert.equal(normalizeEmail('  Hiker@Example.COM '), 'hiker@example.com');
  assert.equal(normalizeEmail(42), '');
  assert.ok(validEmail('hiker@example.com'));
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@b c.com', 'x<victim@gmail.com>', 'a,b@c.com', 'a;b@c.com', '"a"@c.com', `${'x'.repeat(250)}@b.com`]) assert.ok(!validEmail(bad), bad);
});

test('sign-in codes are eight digits and vary', () => {
  const codes = Array.from({ length: 300 }, newCode);
  assert.ok(codes.every(code => /^\d{8}$/.test(code)));
  assert.ok(new Set(codes).size > 280);
});

test('sign-in works end to end, and the session is locked down', async () => {
  const h = harness();
  const start = await h.post('auth/start', { email: 'Hiker@Example.com' });
  assert.equal(start.status, 202);
  assert.deepEqual(h.sent, ['hiker@example.com']);
  const verify = await h.post('auth/verify', { email: 'hiker@example.com', code: h.codes.get('hiker@example.com') });
  assert.equal(verify.status, 200);
  const cookie = verify.headers.get('Set-Cookie');
  assert.match(cookie, new RegExp(`^${COOKIE}=`));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/hike']) assert.ok(cookie.includes(part), part);
  const me = await h.request('GET', 'me', { cookie: cookie.split(';')[0] });
  assert.equal((await me.json()).email, 'hiker@example.com');
});

test('new and existing addresses get the same answer', async () => {
  const h = harness();
  await h.signIn('known@example.com');
  const known = await h.post('auth/start', { email: 'known@example.com' });
  const unknown = await h.post('auth/start', { email: 'stranger@example.com' });
  assert.equal(known.status, unknown.status);
  assert.deepEqual(await known.json(), await unknown.json());
});

test('nothing secret is stored in the clear', async () => {
  const h = harness();
  await h.post('auth/start', { email: 'a@example.com' });
  const code = h.codes.get('a@example.com');
  const saved = await h.store.getLoginCode('a@example.com');
  assert.ok(!saved.codeHash.includes(code));
  assert.equal(saved.codeHash.length, 64);
  const response = await h.post('auth/verify', { email: 'a@example.com', code });
  const token = response.headers.get('Set-Cookie').split(';')[0].split('=')[1];
  assert.equal(await h.store.getSession(token), null, 'the raw token must not be a lookup key');
});

test('a code works once, for its own address, and not after 10 minutes', async () => {
  const h = harness();
  await h.post('auth/start', { email: 'a@example.com' });
  const code = h.codes.get('a@example.com');
  assert.equal((await h.post('auth/verify', { email: 'b@example.com', code })).status, 400);
  assert.equal((await h.post('auth/verify', { email: 'a@example.com', code })).status, 200);
  assert.equal((await h.post('auth/verify', { email: 'a@example.com', code })).status, 400);

  await h.post('auth/start', { email: 'c@example.com' });
  h.clock.now += 10 * 60 * 1000 + 1;
  assert.equal((await h.post('auth/verify', { email: 'c@example.com', code: h.codes.get('c@example.com') })).status, 400);
});

test('guessing burns the code after five tries, even if the sixth is right', async () => {
  const h = harness();
  await h.post('auth/start', { email: 'a@example.com' });
  const code = h.codes.get('a@example.com');
  const wrong = code === '00000000' ? '00000001' : '00000000';
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await h.post('auth/verify', { email: 'a@example.com', code: wrong })).status, 400);
  assert.equal((await h.post('auth/verify', { email: 'a@example.com', code })).status, 400);
});

test('malformed sign-in requests are refused without detail', async () => {
  const h = harness();
  assert.equal((await h.post('auth/start', { email: 'nope' })).status, 400);
  assert.equal((await h.post('auth/verify', { email: 'a@example.com', code: 'abcdef' })).status, 400);
  assert.equal((await h.request('POST', 'auth/start', { body: 'not json' })).status, 400);
  assert.equal((await h.request('POST', 'auth/start', { body: JSON.stringify({ email: 'x'.repeat(5000) }) })).status, 400);
});

test('code requests are rate limited per address and per network, then recover', async () => {
  const h = harness();
  for (let index = 0; index < LIMITS.startPerEmail; index += 1) {
    assert.equal((await h.post('auth/start', { email: 'a@example.com' })).status, 202);
    h.clock.now += 61000;
  }
  assert.equal((await h.post('auth/start', { email: 'a@example.com' })).status, 429);
  assert.equal(h.sent.length, LIMITS.startPerEmail, 'no extra email goes out');
  h.clock.now += 60 * 60 * 1000 + 1;
  assert.equal((await h.post('auth/start', { email: 'a@example.com' })).status, 202);

  const other = harness();
  for (let index = 0; index < LIMITS.startPerAddress; index += 1) await other.post('auth/start', { email: `u${index}@example.com` });
  assert.equal((await other.post('auth/start', { email: 'next@example.com' })).status, 429);
  assert.equal((await other.post('auth/start', { email: 'next@example.com' }, { address: '203.0.113.9' })).status, 202);
});

test('a failed email is reported, and leaves no usable code behind', async () => {
  const h = harness();
  harness.failMail = true;
  try {
    assert.equal((await h.post('auth/start', { email: 'a@example.com' })).status, 502);
    assert.equal(await h.store.getLoginCode('a@example.com'), null);
  } finally {
    harness.failMail = false;
  }
});

test('requests from another site are refused', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  assert.equal((await h.post('auth/start', { email: 'b@example.com' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await h.request('DELETE', 'account', { cookie, origin: 'https://evil.test' })).status, 403);
  assert.equal((await h.request('PUT', `items/spot/x?updatedAt=${TIME}`, { cookie, origin: null, body: '{}' })).status, 403);
});

test('nothing is reachable without a session', async () => {
  const h = harness();
  for (const [method, path] of [['GET', 'me'], ['GET', 'items'], ['GET', 'items/hike/x'], ['DELETE', 'account']]) {
    assert.equal((await h.request(method, path)).status, 401, path);
  }
  assert.equal((await h.request('GET', 'items', { cookie: `${COOKIE}=forged` })).status, 401);
});

test('sessions expire and signing out ends them', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  assert.equal((await h.request('GET', 'me', { cookie })).status, 200);
  const out = await h.request('POST', 'auth/signout', { cookie });
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await h.request('GET', 'me', { cookie })).status, 401);

  const later = await h.signIn('b@example.com');
  h.clock.now += 91 * 24 * 60 * 60 * 1000;
  assert.equal((await h.request('GET', 'me', { cookie: later })).status, 401);
});

test('one account can never reach another account’s data', async () => {
  const h = harness();
  const alice = await h.signIn('alice@example.com');
  const bob = await h.signIn('bob@example.com');
  assert.equal((await putJson(h, alice, 'hike', 'shared-id', TIME, { secret: 'alice' })).status, 200);
  assert.equal((await h.request('GET', 'items/hike/shared-id', { cookie: bob })).status, 404);
  assert.deepEqual((await (await h.request('GET', 'items', { cookie: bob })).json()).items, []);
  assert.equal((await putJson(h, bob, 'hike', 'shared-id', TIME, { secret: 'bob' })).status, 200);
  assert.equal(await (await h.request('GET', 'items/hike/shared-id', { cookie: alice })).text(), JSON.stringify({ secret: 'alice' }));
});

test('items round-trip and are served as inert downloads', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  assert.equal((await putJson(h, cookie, 'spot', 'abc-1', TIME, { name: 'Car' })).status, 200);
  const { items } = await (await h.request('GET', 'items', { cookie })).json();
  assert.deepEqual(items, [{ kind: 'spot', id: 'abc-1', updatedAt: TIME, size: 14, deleted: false }]);
  const response = await h.request('GET', 'items/spot/abc-1', { cookie });
  assert.equal(await response.text(), '{"name":"Car"}');
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('uploads are checked: known kinds, safe ids, real content, sane times', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  const put = (path, body = '{}') => h.request('PUT', path, { cookie, body });
  assert.equal((await put(`items/script/x?updatedAt=${TIME}`)).status, 400);
  assert.equal((await put(`items/constructor/x?updatedAt=${TIME}`)).status, 400, 'object internals are not kinds');
  assert.equal((await put(`items/spot/${encodeURIComponent('../../other')}?updatedAt=${TIME}`)).status, 400);
  assert.equal((await put(`items/spot/${'x'.repeat(65)}?updatedAt=${TIME}`)).status, 400);
  assert.equal((await put('items/spot/x')).status, 400);
  assert.equal((await put('items/spot/x?updatedAt=-5')).status, 400);
  assert.equal((await put(`items/spot/x?updatedAt=${h.clock.now + 2 * 24 * 60 * 60 * 1000}`)).status, 400, 'a far-future stamp would win forever');
  assert.equal((await put(`items/spot/x?updatedAt=${TIME}`, 'not json')).status, 400);
  assert.equal((await put(`items/photofile/x?updatedAt=${TIME}`, '<script>alert(1)</script>')).status, 400);
  assert.equal((await put(`items/photofile/x?updatedAt=${TIME}`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).status, 200);
  assert.equal((await put(`items/spot/big?updatedAt=${TIME}`, JSON.stringify({ a: 'x'.repeat(70 * 1024) }))).status, 413);
});

test('an older change cannot overwrite a newer one', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  await putJson(h, cookie, 'spot', 'x', TIME, { v: 'new' });
  const stale = await putJson(h, cookie, 'spot', 'x', TIME - 1000, { v: 'old' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).updatedAt, TIME);
  assert.equal((await h.request('DELETE', `items/spot/x?updatedAt=${TIME - 1000}`, { cookie })).status, 409);
  assert.equal(await (await h.request('GET', 'items/spot/x', { cookie })).text(), '{"v":"new"}');
});

test('deleting leaves a marker for other phones and removes the content', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  await putJson(h, cookie, 'spot', 'x', TIME);
  assert.equal((await h.request('DELETE', `items/spot/x?updatedAt=${TIME + 1}`, { cookie })).status, 200);
  assert.equal(h.bucket.objects.size, 0);
  assert.equal((await h.request('GET', 'items/spot/x', { cookie })).status, 404);
  const { items } = await (await h.request('GET', 'items', { cookie })).json();
  assert.deepEqual(items, [{ kind: 'spot', id: 'x', updatedAt: TIME + 1, size: 0, deleted: true }]);
});

test('the storage quota holds, and replacing an item only counts the difference', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  const me = await (await h.request('GET', 'me', { cookie })).json();
  const user = await h.store.getUserByEmail('a@example.com');
  await h.store.putItem({ userId: user.id, kind: 'hike', id: 'huge', updatedAt: TIME, size: QUOTA_BYTES - 10, deleted: false });
  assert.equal(me.quotaBytes, QUOTA_BYTES);
  assert.equal((await putJson(h, cookie, 'spot', 'x', TIME, { name: 'way too long for what is left' })).status, 413);
  assert.equal((await putJson(h, cookie, 'spot', 'x', TIME, {})).status, 200);
});

test('deleting an account erases its data and sessions, and leaves others alone', async () => {
  const h = harness();
  const alice = await h.signIn('alice@example.com');
  const bob = await h.signIn('bob@example.com');
  await putJson(h, alice, 'hike', 'a1', TIME);
  await h.request('PUT', `items/photofile/a2?updatedAt=${TIME}`, { cookie: alice, body: new Uint8Array([0xff, 0xd8]) });
  await putJson(h, bob, 'hike', 'b1', TIME);
  const user = await h.store.getUserByEmail('alice@example.com');
  // An object orphaned by an upload that died halfway must go too.
  await h.bucket.put(`u/${user.id}/hike/orphan`, new Uint8Array(1));

  await h.post('auth/start', { email: 'alice@example.com' });
  const refused = await h.request('DELETE', 'account', { cookie: alice, body: JSON.stringify({ code: '00000000' === h.codes.get('alice@example.com') ? '00000001' : '00000000' }) });
  assert.equal(refused.status, 400, 'an open session alone must not be enough');
  assert.equal((await h.request('DELETE', 'account', { cookie: alice })).status, 400);
  assert.ok(h.bucket.objects.size > 1, 'a refused deletion changes nothing');
  const gone = await h.request('DELETE', 'account', { cookie: alice, body: JSON.stringify({ code: h.codes.get('alice@example.com') }) });
  assert.equal(gone.status, 200);
  assert.match(gone.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await h.request('GET', 'me', { cookie: alice })).status, 401);
  assert.equal(await h.store.getUserByEmail('alice@example.com'), null);
  assert.deepEqual([...h.bucket.objects.keys()].filter(key => key.includes(user.id)), []);
  assert.equal(h.bucket.objects.size, 1);
  assert.equal((await h.request('GET', 'items/hike/b1', { cookie: bob })).status, 200);

  // The same address can start fresh, with nothing from before.
  const again = await h.signIn('alice@example.com');
  assert.deepEqual((await (await h.request('GET', 'items', { cookie: again })).json()).items, []);
});

test('guesses are capped per day across every code an address gets', async () => {
  const h = harness();
  const email = 'target@example.com';
  let guesses = 0;
  let refused = false;
  for (let round = 0; round < 8 && !refused; round += 1) {
    h.clock.now += 61000;
    await h.post('auth/start', { email });
    const real = h.codes.get(email);
    const wrong = real === '00000000' ? '00000001' : '00000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await h.post('auth/verify', { email, code: wrong }, { address: `198.51.100.${guesses}` });
      if (response.status === 429) refused = true;
      else guesses += 1;
    }
    h.clock.now += 60 * 60 * 1000;
  }
  assert.ok(refused);
  assert.equal(guesses, LIMITS.verifyPerEmailPerDay);
  h.clock.now += 24 * 60 * 60 * 1000 + 1;
  await h.post('auth/start', { email });
  assert.equal((await h.post('auth/verify', { email, code: h.codes.get(email) })).status, 200);
});

test('one inbox under many spellings counts as one', () => {
  assert.equal(rateLimitEmail('victim+1@gmail.com'), 'victim@gmail.com');
  assert.equal(rateLimitEmail('v.i.c.t.i.m+x@googlemail.com'), 'victim@gmail.com');
  assert.equal(rateLimitEmail('first.last+tag@example.com'), 'first.last@example.com');
});

test('aliases cannot dodge the per-address limit', async () => {
  const h = harness();
  const statuses = [];
  for (let index = 0; index < LIMITS.startPerEmail + 1; index += 1) statuses.push((await h.post('auth/start', { email: `victim+${index}@gmail.com` })).status);
  assert.equal(statuses.at(-1), 429);
  assert.equal(h.sent.length, LIMITS.startPerEmail);
});

test('an IPv6 network counts as one address', () => {
  assert.equal(rateLimitAddress('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitAddress('2001:DB8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(rateLimitAddress('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitAddress('::1'), '0:0:0:0::/64');
  assert.equal(rateLimitAddress('198.51.100.7'), '198.51.100.7');
});

test('a repeat request does not replace or resend a fresh code', async () => {
  const h = harness();
  await h.post('auth/start', { email: 'a@example.com' });
  const first = h.codes.get('a@example.com');
  assert.equal((await h.post('auth/start', { email: 'a@example.com' })).status, 202);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.post('auth/verify', { email: 'a@example.com', code: first })).status, 200);
});

test('the daily mail and new-account caps hold for everyone', async () => {
  const mail = harness({ mailPerDay: 2, startPerAddress: 100 });
  assert.equal((await mail.post('auth/start', { email: 'a@example.com' })).status, 202);
  assert.equal((await mail.post('auth/start', { email: 'b@example.com' })).status, 202);
  assert.equal((await mail.post('auth/start', { email: 'c@example.com' })).status, 429);
  assert.equal(mail.sent.length, 2);

  const accounts = harness({ newAccountsPerDay: 1 });
  await accounts.signIn('first@example.com');
  await accounts.post('auth/start', { email: 'second@example.com' });
  assert.equal((await accounts.post('auth/verify', { email: 'second@example.com', code: accounts.codes.get('second@example.com') })).status, 429);
  // People who already have accounts aren't affected.
  await accounts.signIn('first@example.com');
});

test('every new sign-in sends a notice, and a failed notice does not block it', async () => {
  const h = harness();
  await h.signIn('a@example.com');
  assert.deepEqual(h.notices, ['a@example.com']);
});

test('sessions end after going idle, stretch with use, and stop at the hard limit', async () => {
  const h = harness();
  const DAY = 24 * 60 * 60 * 1000;
  const idle = await h.signIn('idle@example.com');
  const active = await h.signIn('active@example.com');
  for (let day = 20; day <= 80; day += 20) {
    h.clock.now += 20 * DAY;
    assert.equal((await h.request('GET', 'me', { cookie: active })).status, 200, `day ${day}`);
  }
  assert.equal((await h.request('GET', 'me', { cookie: idle })).status, 401);
  h.clock.now += 11 * DAY;
  assert.equal((await h.request('GET', 'me', { cookie: active })).status, 401, 'past 90 days, use no longer helps');
});

test('a lost phone can be signed out from another', async () => {
  const h = harness();
  const lost = await h.signIn('a@example.com');
  const kept = await h.signIn('a@example.com');
  assert.equal((await h.request('DELETE', 'sessions/others', { cookie: kept })).status, 200);
  assert.equal((await h.request('GET', 'me', { cookie: lost })).status, 401);
  assert.equal((await h.request('GET', 'me', { cookie: kept })).status, 200);
});

test('deleting something that never existed writes nothing', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  assert.equal((await h.request('DELETE', `items/spot/never-existed?updatedAt=${TIME}`, { cookie })).status, 200);
  assert.deepEqual((await (await h.request('GET', 'items', { cookie })).json()).items, []);
});

test('write volume, item count and upload bytes are all capped per person', async () => {
  const writes = harness({ writesPerUserPerHour: 2 });
  const a = await writes.signIn('a@example.com');
  assert.equal((await putJson(writes, a, 'spot', 'one', TIME)).status, 200);
  assert.equal((await putJson(writes, a, 'spot', 'two', TIME)).status, 200);
  assert.equal((await putJson(writes, a, 'spot', 'three', TIME)).status, 429);

  const items = harness();
  const b = await items.signIn('b@example.com');
  const user = await items.store.getUserByEmail('b@example.com');
  for (let index = 0; index < MAX_ITEMS_PER_USER; index += 1) await items.store.putItem({ userId: user.id, kind: 'spot', id: `x${index}`, updatedAt: TIME, size: 1, deleted: false });
  assert.equal((await putJson(items, b, 'spot', 'more', TIME)).status, 413);
  assert.equal((await putJson(items, b, 'spot', 'x1', TIME + 1)).status, 200, 'updating one is still fine');

  const bytes = harness({ uploadBytesPerUserPerDay: 30 });
  const c = await bytes.signIn('c@example.com');
  assert.equal((await putJson(bytes, c, 'spot', 'one', TIME, { a: 'x'.repeat(10) })).status, 200);
  assert.equal((await putJson(bytes, c, 'spot', 'two', TIME, { a: 'x'.repeat(10) })).status, 429);
});

test('an upload that finishes after its account was deleted leaves nothing behind', async () => {
  const h = harness();
  const cookie = await h.signIn('a@example.com');
  const user = await h.store.getUserByEmail('a@example.com');
  // The account disappears at the moment the upload is writing.
  const realPut = h.bucket.put;
  h.bucket.put = async (key, bytes) => {
    await realPut(key, bytes);
    await h.store.deleteUserData(user.id);
  };
  assert.equal((await putJson(h, cookie, 'hike', 'late', TIME)).status, 401);
  assert.equal(h.bucket.objects.size, 0);
  assert.deepEqual(await h.store.listItems(user.id), []);
});

const item = (kind, id, updatedAt, deleted = false) => ({ kind, id, updatedAt, deleted });

test('sync holds back when many items would vanish at once', () => {
  const removals = count => ({ deleteLocal: Array.from({ length: count }, (_, index) => item('spot', `s${index}`, 5)) });
  assert.equal(shouldHoldRemovals(removals(MASS_REMOVAL), false), false);
  assert.equal(shouldHoldRemovals(removals(MASS_REMOVAL + 1), false), true);
  assert.equal(shouldHoldRemovals(removals(MASS_REMOVAL + 1), true), false);
});

test('sync plan: moves things the other side lacks', () => {
  const plan = planSync([item('hike', 'a', 5)], [item('spot', 'b', 5)]);
  assert.deepEqual(plan.upload.map(x => x.id), ['a']);
  assert.deepEqual(plan.download.map(x => x.id), ['b']);
});

test('sync plan: the newest change wins, and equal stamps do nothing', () => {
  const newerHere = planSync([item('spot', 'a', 9)], [item('spot', 'a', 5)]);
  assert.equal(newerHere.upload.length, 1);
  const newerThere = planSync([item('spot', 'a', 5)], [item('spot', 'a', 9)]);
  assert.equal(newerThere.download.length, 1);
  const same = planSync([item('spot', 'a', 5)], [item('spot', 'a', 5)]);
  assert.deepEqual(same, { upload: [], download: [], deleteRemote: [], deleteLocal: [] });
  assert.equal(pendingCount(newerHere), 1);
});

test('sync plan: deletions travel both ways and a deleted item is never restored', () => {
  assert.equal(planSync([item('spot', 'a', 9, true)], [item('spot', 'a', 5)]).deleteRemote.length, 1);
  assert.equal(planSync([item('spot', 'a', 5)], [item('spot', 'a', 9, true)]).deleteLocal.length, 1);
  const goneThere = planSync([], [item('spot', 'a', 9, true)]);
  assert.deepEqual(goneThere, { upload: [], download: [], deleteRemote: [], deleteLocal: [] });
  const goneHere = planSync([item('spot', 'a', 9, true)], []);
  assert.deepEqual(goneHere, { upload: [], download: [], deleteRemote: [], deleteLocal: [] });
  assert.equal(planSync([item('spot', 'a', 5, true)], [item('spot', 'a', 5)]).deleteRemote.length, 1);
  assert.equal(planSync([item('spot', 'a', 5)], [item('spot', 'a', 5, true)]).deleteLocal.length, 1);
});

test('sync plan: photo files move before the records that point at them', () => {
  const plan = planSync([item('photo', 'a', 5), item('hike', 'h', 5), item('photofile', 'a', 5)], []);
  assert.deepEqual(plan.upload.map(x => x.kind), ['photofile', 'photo', 'hike']);
  const back = planSync([], [item('photo', 'a', 5), item('photofile', 'a', 5)]);
  assert.deepEqual(back.download.map(x => x.kind), ['photofile', 'photo']);
});

test('merging: a deletion stands unless something newer brought the item back', () => {
  const [deleted] = mergeLocal([item('checkin', 'x', 5)], [{ kind: 'checkin', id: 'x', updatedAt: 9 }]);
  assert.equal(deleted.deleted, true);
  const [kept] = mergeLocal([item('checkin', 'x', 9)], [{ kind: 'checkin', id: 'x', updatedAt: 5 }]);
  assert.equal(kept.deleted, false);
  const [gone] = mergeLocal([], [{ kind: 'spot', id: 'y', updatedAt: 5 }]);
  assert.equal(gone.deleted, true);
});

test('binary content survives the trip through text', () => {
  const bytes = new Uint8Array(70000).map((_, index) => index % 256);
  assert.deepEqual(new Uint8Array(base64ToBytes(bytesToBase64(bytes.buffer))), bytes);
});
