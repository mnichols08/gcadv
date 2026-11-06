// Keeps this phone and the hiker's backup in step. The newest change to each item wins, and a
// deleted item leaves a marker so other phones delete it too rather than restoring it.
const ROOT = new URL('/api/hike/', self.location.origin).href;

// Files before the records that point at them, so an interrupted restore never shows a photo
// that has nothing to open.
const ORDER = { photofile: 0, photo: 1, hike: 2, spot: 3, checkin: 4 };
const byOrder = (a, b) => ORDER[a.kind] - ORDER[b.kind];
const keyOf = ({ kind, id }) => `${kind}/${id}`;

// A deletion only counts if nothing newer has brought that item back, as when a checkpoint
// is reached again after starting over.
export function mergeLocal(items, deletions) {
  const merged = new Map(items.map(item => [keyOf(item), { ...item, deleted: false }]));
  for (const { kind, id, updatedAt } of deletions) {
    const key = keyOf({ kind, id });
    const present = merged.get(key);
    if (!present || present.updatedAt < updatedAt) merged.set(key, { kind, id, updatedAt, deleted: true });
  }
  return [...merged.values()];
}

export function planSync(local, remote) {
  const remoteByKey = new Map(remote.map(item => [keyOf(item), item]));
  const localKeys = new Set(local.map(keyOf));
  const plan = { upload: [], download: [], deleteRemote: [], deleteLocal: [] };
  for (const item of local) {
    const other = remoteByKey.get(keyOf(item));
    if (!other) {
      if (!item.deleted) plan.upload.push(item);
    } else if (item.updatedAt > other.updatedAt) {
      if (item.deleted) plan.deleteRemote.push(item);
      else plan.upload.push(item);
    } else if (item.updatedAt < other.updatedAt) {
      if (other.deleted) plan.deleteLocal.push(other);
      else plan.download.push(other);
    } else if (item.deleted !== other.deleted) {
      // The same moment on both sides, so deleting is the choice that respects the hiker.
      if (item.deleted) plan.deleteRemote.push(item);
      else plan.deleteLocal.push(other);
    }
  }
  for (const item of remote) {
    if (!localKeys.has(keyOf(item)) && !item.deleted) plan.download.push(item);
  }
  plan.upload.sort(byOrder);
  plan.download.sort(byOrder);
  return plan;
}

export const pendingCount = plan => plan.upload.length + plan.deleteRemote.length;

// Many items vanishing at once could be a stolen session rather than the hiker tidying up, and
// this phone may hold the last copy. Keep them until someone says otherwise.
export const MASS_REMOVAL = 6;
export const shouldHoldRemovals = (plan, allowed) => !allowed && plan.deleteLocal.length > MASS_REMOVAL;

export function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}

export function base64ToBytes(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes.buffer;
}

export class BackupError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function call(path, options = {}) {
  let response;
  try {
    response = await fetch(ROOT + path, { credentials: 'same-origin', ...options });
  } catch {
    throw new BackupError('offline', 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // A host without the backup API answers with its ordinary not-found page.
    throw new BackupError(body.error || (response.status === 404 ? 'backup_unavailable' : 'server_error'), response.status);
  }
  return response;
}

const postJson = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const startSignIn = email => postJson('auth/start', { email });
export const finishSignIn = async (email, code) => (await postJson('auth/verify', { email, code })).json();
export const signOut = () => postJson('auth/signout', {});
export const whoAmI = async () => (await call('me')).json();
export const signOutOthers = () => call('sessions/others', { method: 'DELETE' });
export const deleteAccount = code => call('account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });

// Reads and writes the phone's own records as backup items.
function createItems(store) {
  return {
    async list() {
      const hikes = (await store.listHikes()).filter(hike => hike.status === 'done');
      const photos = await store.listPhotos();
      const items = [
        ...hikes.map(hike => ({ kind: 'hike', id: hike.id, updatedAt: hike.updatedAt ?? hike.endedAt })),
        ...(await store.listSpots()).map(spot => ({ kind: 'spot', id: spot.id, updatedAt: spot.updatedAt ?? spot.t })),
        ...(await store.listCheckins()).map(checkin => ({ kind: 'checkin', id: checkin.id, updatedAt: checkin.t })),
        ...photos.map(photo => ({ kind: 'photo', id: photo.id, updatedAt: photo.updatedAt ?? photo.addedAt })),
        // The image itself never changes, even when its pin is moved.
        ...photos.map(photo => ({ kind: 'photofile', id: photo.id, updatedAt: photo.addedAt })),
      ];
      return mergeLocal(items, await store.listDeletions());
    },
    async read({ kind, id }) {
      if (kind === 'photofile') return store.getPhotoFile(id);
      if (kind === 'hike') {
        const hike = (await store.listHikes()).find(item => item.id === id);
        const points = (await store.listPoints(id)).map(({ hikeId, ...point }) => point);
        return JSON.stringify({ hike, points });
      }
      if (kind === 'photo') {
        const photo = (await store.listPhotos()).find(item => item.id === id);
        return JSON.stringify({ ...photo, thumb: bytesToBase64(photo.thumb) });
      }
      const list = kind === 'spot' ? await store.listSpots() : await store.listCheckins();
      return JSON.stringify(list.find(item => item.id === id));
    },
    async write({ kind, id }, response) {
      if (kind === 'photofile') {
        await store.putPhotoFile(id, await response.arrayBuffer());
        return;
      }
      const value = JSON.parse(await response.text());
      if (kind === 'hike') {
        // Points first: a hike record with no track looks finished and would never be fetched again.
        await store.putPoints(id, value.points);
        await store.putHike(value.hike);
      } else if (kind === 'photo') {
        await store.putPhoto({ ...value, thumb: base64ToBytes(value.thumb) });
      } else if (kind === 'spot') {
        await store.putSpot(value);
      } else {
        await store.putCheckin(value);
      }
    },
    remove: ({ kind, id }) => store.removeLocal(kind, id),
  };
}

async function eachLimited(list, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < list.length) {
      const item = list[next];
      next += 1;
      await work(item);
    }
  }));
}

// One failed item never stops the rest: it stays pending and the next run tries again.
export async function runSync(store, onProgress, { allowRemovals = false } = {}) {
  const items = createItems(store);
  const { items: remote } = await (await call('items')).json();
  const plan = planSync(await items.list(), remote);
  const heldRemovals = shouldHoldRemovals(plan, allowRemovals) ? plan.deleteLocal.length : 0;
  if (heldRemovals) plan.deleteLocal = [];
  const total = plan.upload.length + plan.download.length + plan.deleteRemote.length + plan.deleteLocal.length;
  const result = { uploaded: 0, downloaded: 0, removedHere: 0, failed: 0, heldRemovals, total, firstError: null };
  let finished = 0;
  const step = async work => {
    try {
      await work();
    } catch (error) {
      result.failed += 1;
      result.firstError ||= error.code || 'failed';
      if (error.status === 401) throw error;
    }
    finished += 1;
    onProgress?.(finished, total);
  };
  const stamped = item => `items/${item.kind}/${item.id}?updatedAt=${item.updatedAt}`;
  // Uploads go in order, so a photo's image is safe before its record appears on another phone.
  for (const kinds of [['photofile'], ['photo', 'hike', 'spot', 'checkin']]) {
    await eachLimited(plan.upload.filter(item => kinds.includes(item.kind)), 2, item => step(async () => {
      await call(stamped(item), { method: 'PUT', body: await items.read(item) });
      result.uploaded += 1;
    }));
  }
  await eachLimited(plan.deleteRemote, 2, item => step(async () => {
    await call(stamped(item), { method: 'DELETE' });
    result.uploaded += 1;
  }));
  for (const kinds of [['photofile'], ['photo', 'hike', 'spot', 'checkin']]) {
    await eachLimited(plan.download.filter(item => kinds.includes(item.kind)), 2, item => step(async () => {
      await items.write(item, await call(`items/${item.kind}/${item.id}`));
      result.downloaded += 1;
    }));
  }
  await eachLimited(plan.deleteLocal, 2, item => step(async () => {
    await items.remove(item);
    result.removedHere += 1;
  }));
  return result;
}
