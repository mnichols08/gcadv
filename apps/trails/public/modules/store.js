// Everything a hiker records stays in this browser's IndexedDB. Nothing is uploaded.
const NAME = 'waymark';
const VERSION = 4;
let opened;

function open() {
  opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const stores = { hikes: 'id', points: ['hikeId', 'seq'], spots: 'id', areas: 'id', photos: 'id', photoFiles: 'id', geocaches: 'id', checkins: 'id', deletions: 'key' };
      for (const [name, keyPath] of Object.entries(stores)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    request.onsuccess = () => {
      // Another tab holding an older version open would otherwise block its upgrade.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  return opened;
}

const done = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function run(store, mode, work) {
  const db = await open();
  const transaction = db.transaction(store, mode);
  const result = await work(transaction.objectStore(store));
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    if (mode === 'readonly') resolve();
  });
  return result;
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const putHike = hike => run('hikes', 'readwrite', store => done(store.put(hike)));
export const listHikes = async () => (await run('hikes', 'readonly', store => done(store.getAll()))).sort((a, b) => b.startedAt - a.startedAt);
export const addPoint = (hikeId, point) => run('points', 'readwrite', store => done(store.put({ ...point, hikeId })));
export const listPoints = hikeId => run('points', 'readonly', store => done(store.getAll(IDBKeyRange.bound([hikeId, 0], [hikeId, Infinity]))));
export const putSpot = spot => run('spots', 'readwrite', store => done(store.put(spot)));
export async function deleteSpot(id) {
  await run('spots', 'readwrite', store => done(store.delete(id)));
  await recordDeletion('spot', id);
}
export const listSpots = () => run('spots', 'readonly', store => done(store.getAll()));
export const putArea = area => run('areas', 'readwrite', store => done(store.put(area)));
export const listAreas = () => run('areas', 'readonly', store => done(store.getAll()));
export const clearAreas = () => run('areas', 'readwrite', store => done(store.clear()));

// The list holds thumbnails only, so opening the gallery doesn't load every full photo.
// Images are kept as plain bytes: some WebKit builds refuse to store a Blob in IndexedDB.
export const listPhotos = () => run('photos', 'readonly', store => done(store.getAll()));
export const putPhoto = photo => run('photos', 'readwrite', store => done(store.put(photo)));
export const putPhotoFile = (id, bytes) => run('photoFiles', 'readwrite', store => done(store.put({ id, bytes })));
export const getPhotoFile = async id => (await run('photoFiles', 'readonly', store => done(store.get(id))))?.bytes || null;
export async function deletePhoto(id) {
  await run('photos', 'readwrite', store => done(store.delete(id)));
  await run('photoFiles', 'readwrite', store => done(store.delete(id)));
  await recordDeletion('photo', id);
  await recordDeletion('photofile', id);
}

export const listCheckins = () => run('checkins', 'readonly', store => done(store.getAll()));
export const putCheckin = checkin => run('checkins', 'readwrite', store => done(store.put(checkin)));
export async function clearCheckins() {
  const checkins = await listCheckins();
  await run('checkins', 'readwrite', store => done(store.clear()));
  for (const { id } of checkins) await recordDeletion('checkin', id);
}

export const listGeocaches = () => run('geocaches', 'readonly', store => done(store.getAll()));
export const putGeocache = cache => run('geocaches', 'readwrite', store => done(store.put(cache)));
export const clearGeocaches = () => run('geocaches', 'readwrite', store => done(store.clear()));
export const putGeocaches = caches => run('geocaches', 'readwrite', store => {
  for (const cache of caches) store.put(cache);
  return Promise.resolve();
});

// Markers that tell backup, and through it other phones, that something was deleted on purpose.
export const recordDeletion = (kind, id) => run('deletions', 'readwrite', store => done(store.put({ key: `${kind}/${id}`, kind, id, updatedAt: Date.now() })));
export const listDeletions = () => run('deletions', 'readonly', store => done(store.getAll()));
export const clearDeletions = () => run('deletions', 'readwrite', store => done(store.clear()));

export const putPoints = (hikeId, points) => run('points', 'readwrite', store => {
  for (const point of points) store.put({ ...point, hikeId });
  return Promise.resolve();
});

// Applies a deletion made on another phone, so it isn't recorded as a new one here.
export async function removeLocal(kind, id) {
  if (kind === 'hike') {
    await run('hikes', 'readwrite', store => done(store.delete(id)));
    await run('points', 'readwrite', store => done(store.delete(IDBKeyRange.bound([id, 0], [id, Infinity]))));
  } else {
    const stores = { spot: 'spots', checkin: 'checkins', photo: 'photos', photofile: 'photoFiles' };
    await run(stores[kind], 'readwrite', store => done(store.delete(id)));
  }
  await run('deletions', 'readwrite', store => done(store.delete(`${kind}/${id}`)));
}

export async function deleteHike(hikeId) {
  await run('hikes', 'readwrite', store => done(store.delete(hikeId)));
  await run('points', 'readwrite', store => done(store.delete(IDBKeyRange.bound([hikeId, 0], [hikeId, Infinity]))));
  await recordDeletion('hike', hikeId);
  for (const spot of await listSpots()) {
    if (spot.hikeId === hikeId) await deleteSpot(spot.id);
  }
}
