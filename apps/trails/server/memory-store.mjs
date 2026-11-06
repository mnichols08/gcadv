// In-memory stand-ins for D1 and R2, for tests and the local preview. Nothing here persists.
export function memoryStore() {
  const users = new Map();
  const codes = new Map();
  const sessions = new Map();
  const rates = new Map();
  const items = new Map();
  const itemKey = (userId, kind, id) => `${userId}|${kind}|${id}`;
  const itemsOf = userId => [...items.values()].filter(item => item.userId === userId);
  const publicItem = ({ kind, id, updatedAt, size, deleted }) => ({ kind, id, updatedAt, size, deleted });

  return {
    async getUser(id) {
      return users.get(id) || null;
    },
    async getUserByEmail(email) {
      return [...users.values()].find(user => user.email === email) || null;
    },
    async createUser({ id, email }) {
      const existing = [...users.values()].find(user => user.email === email);
      if (existing) return existing;
      const user = { id, email };
      users.set(id, user);
      return user;
    },
    async getLoginCode(email) {
      return codes.get(email) || null;
    },
    async putLoginCode(code) {
      codes.set(code.email, { ...code });
    },
    async addLoginAttempt(email) {
      const code = codes.get(email);
      if (!code) return Infinity;
      code.attempts += 1;
      return code.attempts;
    },
    async deleteLoginCode(email) {
      codes.delete(email);
    },
    async bumpRate(key, now, windowMs, amount = 1) {
      const rate = rates.get(key);
      if (!rate || rate.windowStart <= now - windowMs) {
        rates.set(key, { windowStart: now, count: amount });
        return amount;
      }
      rate.count += amount;
      return rate.count;
    },
    async deleteExpired(now) {
      for (const [email, code] of codes) if (code.expiresAt <= now) codes.delete(email);
      for (const [hash, session] of sessions) if (session.expiresAt <= now) sessions.delete(hash);
    },
    async putSession(session) {
      sessions.set(session.tokenHash, { ...session });
    },
    async extendSession(tokenHash, expiresAt) {
      sessions.get(tokenHash).expiresAt = expiresAt;
    },
    async deleteOtherSessions(userId, keepHash) {
      for (const [hash, session] of sessions) if (session.userId === userId && hash !== keepHash) sessions.delete(hash);
    },
    async getSession(tokenHash) {
      return sessions.get(tokenHash) || null;
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async listItems(userId) {
      return itemsOf(userId).map(publicItem);
    },
    async getItem(userId, kind, id) {
      const item = items.get(itemKey(userId, kind, id));
      return item ? publicItem(item) : null;
    },
    async putItem(item) {
      items.set(itemKey(item.userId, item.kind, item.id), { ...item });
    },
    async countItems(userId) {
      return itemsOf(userId).length;
    },
    async totalSize(userId) {
      return itemsOf(userId).reduce((total, item) => total + item.size, 0);
    },
    async deleteUserData(userId) {
      for (const item of itemsOf(userId)) items.delete(itemKey(userId, item.kind, item.id));
      for (const [hash, session] of sessions) if (session.userId === userId) sessions.delete(hash);
      users.delete(userId);
    },
  };
}

export function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async get(key) {
      return objects.has(key) ? { body: objects.get(key) } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
    },
  };
}
