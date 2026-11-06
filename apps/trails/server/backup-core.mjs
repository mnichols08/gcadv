// Accounts and backup for the trail app. Storage and email are passed in, so the same code runs on
// Cloudflare, in the local preview and in tests. Tracks are location history: every item is
// reachable only through its owner's session, and is never served as anything a browser runs.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CODE_LIFETIME = 10 * MINUTE;
const CODE_ATTEMPTS = 5;
const SESSION_LIFETIME = 90 * DAY; // The hard limit, however often it's used.
const SESSION_IDLE = 30 * DAY;
const CODE_RESEND_WAIT = MINUTE; // A repeat request can't keep replacing someone's pending code.
const MB = 1024 * 1024;
export const QUOTA_BYTES = 2048 * MB;
export const COOKIE = 'hike_session';

export const LIMITS = {
  startPerEmail: 5,
  startPerAddress: 20,
  verifyPerAddress: 30,
  // With 8 digits this makes guessing one person's code hopeless, even over years.
  verifyPerEmailPerDay: 20,
  // Keeps an abuser from spending the mail allowance or filling storage for everyone.
  mailPerDay: 90,
  newAccountsPerDay: 100,
  writesPerUserPerHour: 5000,
  uploadBytesPerUserPerDay: 4096 * MB,
};
export const MAX_ITEMS_PER_USER = 20000;

const KINDS = {
  hike: { maxBytes: 20 * MB, format: 'json' },
  spot: { maxBytes: 64 * 1024, format: 'json' },
  checkin: { maxBytes: 64 * 1024, format: 'json' },
  photo: { maxBytes: 256 * 1024, format: 'json' },
  photofile: { maxBytes: 6 * MB, format: 'jpeg' },
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Also refuses the characters that let one string name a second mailbox to a mail provider.
const EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const encoder = new TextEncoder();

const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

async function keyedHash(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

// Eight digits, drawn without the small bias a plain remainder would add.
export function newCode() {
  const span = 100000000;
  const limit = Math.floor(0xffffffff / span) * span;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return String(value[0] % span).padStart(8, '0');
}

// One inbox can answer to many spellings, so count them together. The real address is still
// what gets emailed and what the account is keyed on.
export function rateLimitEmail(email) {
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1);
  let local = email.slice(0, at).split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return `${local}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}

// One IPv6 customer controls a whole /64, so that's the unit worth limiting.
export function rateLimitAddress(address) {
  if (!address.includes(':')) return address;
  const [head, tail = ''] = address.toLowerCase().split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after] : before;
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});

const refuse = (error, status) => json({ error }, status);

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

export const normalizeEmail = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');
export const validEmail = email => email.length <= 254 && EMAIL.test(email);
const itemKey = (userId, kind, id) => `u/${userId}/${kind}/${id}`;

async function readJson(request) {
  try {
    if (Number(request.headers.get('Content-Length') || 0) > 4096) return null;
    const text = await request.text();
    if (text.length > 4096) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function acceptableBody(format, bytes) {
  if (format === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

export function createBackupHandler({ store, bucket, sendCode, sendNotice, pepper, cookieSecure = true, limits: limitOverrides = {}, now = () => Date.now(), newId = () => crypto.randomUUID() }) {
  const limits = { ...LIMITS, ...limitOverrides };
  const sessionCookie = (token, maxAgeSeconds) => {
    const secure = cookieSecure ? ' Secure;' : '';
    return `${COOKIE}=${token}; HttpOnly;${secure} SameSite=Strict; Path=/api/hike; Max-Age=${maxAgeSeconds}`;
  };

  async function allow(key, limit, windowMs = HOUR, amount = 1) {
    const count = await store.bumpRate(await sha256(`${pepper}|${key}`), now(), windowMs, amount);
    return count <= limit;
  }

  const clientAddress = request => rateLimitAddress(request.headers.get('CF-Connecting-IP') || 'unknown');

  async function currentUser(request) {
    const token = readCookie(request, COOKIE);
    if (!token) return null;
    const tokenHash = await sha256(token);
    const session = await store.getSession(tokenHash);
    if (!session || session.expiresAt <= now()) return null;
    // Stay signed in with use, but never past the hard limit, and write only now and then.
    if (session.expiresAt - now() < SESSION_IDLE / 2) {
      await store.extendSession(tokenHash, Math.min(session.createdAt + SESSION_LIFETIME, now() + SESSION_IDLE));
    }
    return store.getUser(session.userId);
  }

  async function startSignIn(request) {
    const body = await readJson(request);
    const email = normalizeEmail(body?.email);
    if (!validEmail(email)) return refuse('bad_email', 400);
    if (!(await allow(`start-ip|${clientAddress(request)}`, limits.startPerAddress)) || !(await allow(`start-email|${rateLimitEmail(email)}`, limits.startPerEmail))) return refuse('too_many', 429);
    await store.deleteExpired(now());
    const pending = await store.getLoginCode(email);
    if (pending && pending.expiresAt - CODE_LIFETIME + CODE_RESEND_WAIT > now()) return json({ ok: true }, 202);
    if (!(await allow('mail-all', limits.mailPerDay, DAY))) return refuse('too_many', 429);
    const code = newCode();
    await store.putLoginCode({ email, codeHash: await keyedHash(pepper, `${email}|${code}`), expiresAt: now() + CODE_LIFETIME, attempts: 0 });
    try {
      await sendCode(email, code);
    } catch {
      await store.deleteLoginCode(email);
      return refuse('mail_failed', 502);
    }
    // The same answer for every address, so this can't be used to discover who has an account.
    return json({ ok: true }, 202);
  }

  // Checks a code and uses it up. Returns an error code, or null on success.
  async function consumeCode(request, email, code) {
    if (!validEmail(email) || !/^\d{8}$/.test(code)) return 'bad_code';
    if (!(await allow(`verify-ip|${clientAddress(request)}`, limits.verifyPerAddress))) return 'too_many';
    // Across every code this address gets, so asking for fresh codes doesn't earn fresh guesses.
    if (!(await allow(`verify-email|${rateLimitEmail(email)}`, limits.verifyPerEmailPerDay, DAY))) return 'too_many';
    const saved = await store.getLoginCode(email);
    if (!saved || saved.expiresAt <= now()) return 'bad_code';
    // Count the try before checking it, so parallel guesses can't share one attempt.
    const attempts = await store.addLoginAttempt(email);
    if (attempts > CODE_ATTEMPTS) {
      await store.deleteLoginCode(email);
      return 'bad_code';
    }
    if (!sameText(saved.codeHash, await keyedHash(pepper, `${email}|${code}`))) return 'bad_code';
    await store.deleteLoginCode(email);
    return null;
  }

  const statusFor = error => (error === 'too_many' ? 429 : 400);

  async function finishSignIn(request) {
    const body = await readJson(request);
    const email = normalizeEmail(body?.email);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const problem = await consumeCode(request, email, code);
    if (problem) return refuse(problem, statusFor(problem));
    let user = await store.getUserByEmail(email);
    if (!user) {
      if (!(await allow('new-accounts', limits.newAccountsPerDay, DAY))) return refuse('too_many', 429);
      user = await store.createUser({ id: newId(), email, createdAt: now() });
    }
    const token = randomToken();
    await store.putSession({ tokenHash: await sha256(token), userId: user.id, expiresAt: now() + SESSION_IDLE, createdAt: now() });
    // Lets someone notice a sign-in that wasn't them. It must not block a real one.
    try {
      await sendNotice?.(email);
    } catch { /* The sign-in itself succeeded. */ }
    return json({ email: user.email }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_LIFETIME / 1000) });
  }

  async function signOutOthers(request, user) {
    await store.deleteOtherSessions(user.id, await sha256(readCookie(request, COOKIE)));
    return json({ ok: true });
  }

  async function signOut(request) {
    const token = readCookie(request, COOKIE);
    if (token) await store.deleteSession(await sha256(token));
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  async function putItem(request, user, kind, id, updatedAt) {
    const rule = KINDS[kind];
    if (Number(request.headers.get('Content-Length') || 0) > rule.maxBytes) return refuse('too_large', 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > rule.maxBytes) return refuse('too_large', 413);
    if (!acceptableBody(rule.format, bytes)) return refuse('bad_body', 400);
    const existing = await store.getItem(user.id, kind, id);
    if (existing && existing.updatedAt > updatedAt) return json({ error: 'newer_exists', updatedAt: existing.updatedAt }, 409);
    if (!existing && (await store.countItems(user.id)) >= MAX_ITEMS_PER_USER) return refuse('over_quota', 413);
    const others = (await store.totalSize(user.id)) - (existing?.size || 0);
    if (others + bytes.length > QUOTA_BYTES) return refuse('over_quota', 413);
    // Parallel uploads can all pass the check above, so this is what bounds any overshoot.
    if (!(await allow(`upload-bytes|${user.id}`, limits.uploadBytesPerUserPerDay, DAY, bytes.length))) return refuse('too_many', 429);
    await bucket.put(itemKey(user.id, kind, id), bytes);
    await store.putItem({ userId: user.id, kind, id, updatedAt, size: bytes.length, deleted: false });
    // If the account was deleted during this upload, this write must not outlive it.
    if (!(await store.getUser(user.id))) {
      await bucket.deletePrefix(`u/${user.id}/`);
      await store.deleteUserData(user.id);
      return refuse('signed_out', 401);
    }
    return json({ ok: true });
  }

  async function deleteItem(user, kind, id, updatedAt) {
    const existing = await store.getItem(user.id, kind, id);
    // Nothing to delete means nothing to record, or anyone could fill the index with markers.
    if (!existing) return json({ ok: true });
    if (existing.updatedAt > updatedAt) return json({ error: 'newer_exists', updatedAt: existing.updatedAt }, 409);
    await bucket.delete(itemKey(user.id, kind, id));
    await store.putItem({ userId: user.id, kind, id, updatedAt, size: 0, deleted: true });
    return json({ ok: true });
  }

  async function getItem(user, kind, id) {
    const existing = await store.getItem(user.id, kind, id);
    if (!existing || existing.deleted) return refuse('not_found', 404);
    const object = await bucket.get(itemKey(user.id, kind, id));
    if (!object) return refuse('not_found', 404);
    // A fixed, inert type: stored bytes must never run as a page on this origin.
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Updated-At': String(existing.updatedAt),
      },
    });
  }

  // Needs a fresh code, so a stolen phone's open session can't erase someone's whole history.
  async function deleteAccount(request, user) {
    const body = await readJson(request);
    const problem = await consumeCode(request, user.email, typeof body?.code === 'string' ? body.code.trim() : '');
    if (problem) return refuse(problem, statusFor(problem));
    // In bulk, by prefix: one call per item could hit the platform's limit for a large backup.
    await bucket.deletePrefix(`u/${user.id}/`);
    await store.deleteUserData(user.id);
    await store.deleteLoginCode(user.email);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/hike\//, '').split('/').filter(Boolean);
    const { method } = request;

    // A strict cookie already stops other sites, and this refuses anything that slips past it.
    if (method !== 'GET' && request.headers.get('Origin') !== url.origin) return refuse('bad_origin', 403);

    try {
      if (path[0] === 'auth') {
        if (method !== 'POST') return refuse('method', 405);
        if (path[1] === 'start') return await startSignIn(request);
        if (path[1] === 'verify') return await finishSignIn(request);
        if (path[1] === 'signout') return await signOut(request);
        return refuse('not_found', 404);
      }

      const user = await currentUser(request);
      if (!user) return refuse('signed_out', 401);

      if (path[0] === 'sessions' && path[1] === 'others' && method === 'DELETE') return await signOutOthers(request, user);
      if (path[0] === 'me' && method === 'GET') return json({ email: user.email, usedBytes: await store.totalSize(user.id), quotaBytes: QUOTA_BYTES });
      if (path[0] === 'account' && method === 'DELETE') return await deleteAccount(request, user);
      if (path[0] !== 'items') return refuse('not_found', 404);
      if (path.length === 1) {
        if (method !== 'GET') return refuse('method', 405);
        return json({ items: await store.listItems(user.id) });
      }

      const [, kind, id] = path;
      if (path.length !== 3 || !Object.hasOwn(KINDS, kind) || !ID.test(id)) return refuse('bad_item', 400);
      if (method === 'GET') return await getItem(user, kind, id);
      const updatedAt = Number(url.searchParams.get('updatedAt'));
      // A little grace for a phone's clock, but a far-future stamp would win every later sync.
      if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0 || updatedAt > now() + DAY) return refuse('bad_time', 400);
      if (!(await allow(`writes|${user.id}`, limits.writesPerUserPerHour))) return refuse('too_many', 429);
      if (method === 'PUT') return await putItem(request, user, kind, id, updatedAt);
      if (method === 'DELETE') return await deleteItem(user, kind, id, updatedAt);
      return refuse('method', 405);
    } catch {
      return refuse('server_error', 500);
    }
  };
}
