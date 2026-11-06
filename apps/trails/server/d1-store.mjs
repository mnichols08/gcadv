// The backup store on Cloudflare D1. It matches memory-store.mjs, which tests and local preview use.
const toItem = row => ({ kind: row.kind, id: row.id, updatedAt: row.updated_at, size: row.size, deleted: Boolean(row.deleted) });

export function d1Store(db) {
  const run = (sql, ...values) => db.prepare(sql).bind(...values).run();
  const first = (sql, ...values) => db.prepare(sql).bind(...values).first();
  const toUser = row => (row ? { id: row.id, email: row.email } : null);

  return {
    async getUser(id) {
      return toUser(await first('SELECT id, email FROM users WHERE id = ?', id));
    },
    async getUserByEmail(email) {
      return toUser(await first('SELECT id, email FROM users WHERE email = ?', email));
    },
    // Two phones verifying at once must end up with one account, not an error.
    async createUser({ id, email, createdAt }) {
      await run('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)', id, email, createdAt);
      return toUser(await first('SELECT id, email FROM users WHERE email = ?', email));
    },
    async getLoginCode(email) {
      const row = await first('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?', email);
      return row ? { codeHash: row.code_hash, expiresAt: row.expires_at, attempts: row.attempts } : null;
    },
    async putLoginCode({ email, codeHash, expiresAt, attempts }) {
      await run('INSERT OR REPLACE INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?)', email, codeHash, expiresAt, attempts);
    },
    async addLoginAttempt(email) {
      const row = await first('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? RETURNING attempts', email);
      return row ? row.attempts : Infinity;
    },
    async deleteLoginCode(email) {
      await run('DELETE FROM login_codes WHERE email = ?', email);
    },
    async bumpRate(key, now, windowMs, amount = 1) {
      const row = await first(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?4)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN window_start <= ?2 - ?3 THEN ?4 ELSE count + ?4 END,
           window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
         RETURNING count`,
        key, now, windowMs, amount,
      );
      return row.count;
    },
    async deleteExpired(now) {
      await db.batch([
        db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').bind(now),
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
        db.prepare('DELETE FROM rate_limits WHERE window_start <= ?').bind(now - 2 * 24 * 60 * 60 * 1000),
      ]);
    },
    async putSession({ tokenHash, userId, expiresAt, createdAt }) {
      await run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', tokenHash, userId, expiresAt, createdAt);
    },
    async extendSession(tokenHash, expiresAt) {
      await run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', expiresAt, tokenHash);
    },
    async deleteOtherSessions(userId, keepHash) {
      await run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepHash);
    },
    async getSession(tokenHash) {
      const row = await first('SELECT user_id, expires_at, created_at FROM sessions WHERE token_hash = ?', tokenHash);
      return row ? { userId: row.user_id, expiresAt: row.expires_at, createdAt: row.created_at } : null;
    },
    async deleteSession(tokenHash) {
      await run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    },
    async listItems(userId) {
      const { results } = await db.prepare('SELECT kind, id, updated_at, size, deleted FROM items WHERE user_id = ?').bind(userId).all();
      return results.map(toItem);
    },
    async getItem(userId, kind, id) {
      const row = await first('SELECT kind, id, updated_at, size, deleted FROM items WHERE user_id = ? AND kind = ? AND id = ?', userId, kind, id);
      return row ? toItem(row) : null;
    },
    async putItem({ userId, kind, id, updatedAt, size, deleted }) {
      await run('INSERT OR REPLACE INTO items (user_id, kind, id, updated_at, size, deleted) VALUES (?, ?, ?, ?, ?, ?)', userId, kind, id, updatedAt, size, deleted ? 1 : 0);
    },
    async countItems(userId) {
      const row = await first('SELECT COUNT(*) AS total FROM items WHERE user_id = ?', userId);
      return row.total;
    },
    async totalSize(userId) {
      const row = await first('SELECT COALESCE(SUM(size), 0) AS total FROM items WHERE user_id = ?', userId);
      return row.total;
    },
    async deleteUserData(userId) {
      await db.batch([
        db.prepare('DELETE FROM items WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
      ]);
    },
  };
}

// Cloudflare R2, trimmed to the few operations backup needs.
export function r2Bucket(bucket) {
  return {
    put: (key, bytes) => bucket.put(key, bytes),
    get: key => bucket.get(key),
    delete: key => bucket.delete(key),
    async deletePrefix(prefix) {
      let cursor;
      do {
        const page = await bucket.list({ prefix, cursor });
        if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}
