import { test, expect } from '@playwright/test';

const URL_PATH = '/trails/';
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');
const GPX = `<?xml version="1.0"?><gpx xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
<wpt lat="39.5005" lon="-79.4"><name>GC12345</name><type>Geocache|Traditional Cache</type><groundspeak:cache><groundspeak:name>Hemlock &amp; Stone</groundspeak:name><groundspeak:container>Small</groundspeak:container><groundspeak:difficulty>2</groundspeak:difficulty><groundspeak:terrain>1.5</groundspeak:terrain><groundspeak:short_description>&lt;b&gt;Old&lt;/b&gt; wall</groundspeak:short_description><groundspeak:encoded_hints>Behind the wall</groundspeak:encoded_hints></groundspeak:cache></wpt>
<wpt lat="39.9" lon="-79.4"><name>GC99999</name><groundspeak:cache><groundspeak:name>&lt;img src=x onerror="window.__hacked=1"&gt;Far Away</groundspeak:name></groundspeak:cache></wpt>
</gpx>`;

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.route('https://basemap.nationalmap.gov/**', route => route.fulfill({ body: TILE, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success) { window.__gps = success; return 1; },
        clearWatch() {},
        getCurrentPosition() {},
      },
    });
    window.__emit = (lat, lon, t = Date.now(), accuracy = 5) => window.__gps({
      coords: { latitude: lat, longitude: lon, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: t,
    });
    // A real JPEG made on demand, since a photo fixture would need a binary in the repo.
    window.__photo = async (name, lastModified) => {
      const canvas = document.createElement('canvas');
      canvas.width = 2000;
      canvas.height = 1000;
      const context = canvas.getContext('2d');
      context.fillStyle = '#2a7';
      context.fillRect(0, 0, 2000, 1000);
      const blob = await new Promise(resolve => { canvas.toBlob(resolve, 'image/jpeg'); });
      return new File([blob], name, { type: 'image/jpeg', lastModified });
    };
    window.__addPhoto = async (name, lastModified) => {
      const transfer = new DataTransfer();
      transfer.items.add(await window.__photo(name, lastModified));
      const input = document.getElementById('photoInput');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
  });
  await page.goto(URL_PATH);
});

const findMe = async (page, lat = 39.5, lon = -79.4) => {
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.evaluate(([a, b]) => window.__emit(a, b), [lat, lon]);
  await expect(page.locator('#gps')).toContainText('GPS ±');
};

const loadCaches = async page => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Geocaches' }).click();
  await page.locator('#cachesInput').setInputFiles({ name: 'my-caches.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(GPX) });
  await expect(page.locator('#cachesResult')).toHaveText('Loaded 2 new.');
};

test('an older install upgrades without losing its hikes', async ({ page }) => {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const removal = indexedDB.deleteDatabase('waymark');
    removal.onsuccess = () => {
      const open = indexedDB.open('waymark', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('hikes', { keyPath: 'id' });
        db.createObjectStore('points', { keyPath: ['hikeId', 'seq'] });
        db.createObjectStore('spots', { keyPath: 'id' });
        db.createObjectStore('areas', { keyPath: 'id' });
      };
      open.onsuccess = () => {
        const put = open.result.transaction('hikes', 'readwrite').objectStore('hikes').put({ id: 'old', name: 'Old Hike', status: 'done', startedAt: 1, endedAt: 60001, pausedSeconds: 0, miles: 2.5, gainFeet: 100 });
        put.onsuccess = () => { open.result.close(); resolve(); };
      };
      open.onerror = () => reject(open.error);
    };
    removal.onblocked = () => reject(new Error('blocked'));
  }));
  await page.reload();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'My hikes' }).click();
  await expect(page.locator('#hikeList')).toContainText('Old Hike');
  await page.getByRole('button', { name: 'Close' }).last().click();
  await loadCaches(page);
});

test('a marked spot averages the readings taken while it is named', async ({ page }) => {
  await findMe(page);
  await page.getByRole('button', { name: 'Mark spot' }).click();
  await expect(page.locator('#markStatus')).toContainText('Averaging 1 GPS reading');
  await page.evaluate(() => { window.__emit(39.50002, -79.4, Date.now() + 1000); window.__emit(39.49998, -79.4, Date.now() + 2000); });
  await expect(page.locator('#markStatus')).toContainText('Averaging 3 GPS readings');
});

test('GPX export keeps more detail than the drawn line needs', async ({ page }) => {
  const base = Date.now();
  await page.getByRole('button', { name: 'Start hike' }).click();
  await page.evaluate(start => {
    for (let index = 0; index < 60; index += 1) window.__emit(39.5 + index * 0.00001, -79.4, start + index * 1000);
  }, base);
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('button', { name: 'Save hike' }).click();
  await expect(page.locator('#hikeList')).toContainText('GPS points');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GPX' }).click();
  const stream = await (await download).createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk;
  expect(text.match(/<trkpt/g).length).toBeGreaterThanOrEqual(55);
});

test('a photo taken now lands on the map and opens from a tap', async ({ page }) => {
  await findMe(page);
  await page.evaluate(() => window.__addPhoto('now.jpg', Date.now()));
  await expect(page.locator('#notice')).toContainText('Photo added');
  const box = await page.locator('#map').boundingBox();
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('heading', { name: 'Photo', exact: true })).toBeVisible();
  await expect(page.locator('#photoFacts')).toContainText('where you were when you added it');
  // The stored copy is downsized, so a phone full of photos stays manageable.
  await expect.poll(() => page.locator('#photoFull').evaluate(image => image.naturalWidth)).toBe(1600);
});

test('an old library photo with no location waits to be placed by hand', async ({ page }) => {
  await findMe(page);
  await page.evaluate(() => window.__addPhoto('old.jpg', Date.now() - 400 * 86400000));
  await expect(page.locator('#notice')).toContainText('had no location');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'My photos' }).click();
  await expect(page.locator('#photoList')).toContainText('needs a location');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guide me here' }).first()).toBeHidden();
  await page.getByRole('button', { name: 'Place at map center' }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'My photos' }).click();
  await expect(page.locator('#photoList')).not.toContainText('needs a location');
});

test('photos survive a reload and can be deleted', async ({ page }) => {
  await findMe(page);
  await page.evaluate(() => window.__addPhoto('keep.jpg', Date.now()));
  await expect(page.locator('#notice')).toContainText('Photo added');
  await page.reload();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'My photos' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'My photos' }).click();
  await expect(page.locator('#photoList')).toContainText('Photos you add appear here');
});

test('geocaches load from a GPX file, nearest first, with the hint held back', async ({ page }) => {
  await findMe(page);
  await loadCaches(page);
  await expect(page.locator('#cacheList li').first()).toContainText('Hemlock & Stone');
  await page.getByRole('button', { name: 'Details' }).first().click();
  await expect(page.locator('#cacheTitle')).toHaveText('Hemlock & Stone (GC12345)');
  await expect(page.locator('#cacheDescription')).toHaveText('Old wall');
  await expect(page.locator('#cacheHint')).toBeHidden();
  await page.getByRole('button', { name: 'Show hint' }).click();
  await expect(page.locator('#cacheHint')).toHaveText('Behind the wall');
  await page.getByRole('button', { name: 'Guide me here' }).last().click();
  await expect(page.locator('#guideName')).toHaveText('Hemlock & Stone');
  await expect(page.locator('#guideDistance')).toHaveText('182 ft N');
});

test('a hostile file cannot run code, and found marks persist', async ({ page }) => {
  await findMe(page);
  await loadCaches(page);
  await expect(page.locator('#cacheList')).toContainText('Far Away');
  expect(await page.evaluate(() => window.__hacked)).toBeUndefined();
  await page.getByRole('button', { name: 'Details' }).first().click();
  await page.getByRole('button', { name: 'Mark found' }).click();
  // The dialog closes once the mark is safely stored.
  await expect(page.locator('#cacheDialog')).toBeHidden();
  await page.reload();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Geocaches' }).click();
  await expect(page.locator('#cacheList li').first()).toContainText('found');
});

test('a file with no waypoints says so', async ({ page }) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Geocaches' }).click();
  await page.locator('#cachesInput').setInputFiles({ name: 'empty.gpx', mimeType: 'text/xml', buffer: Buffer.from('<gpx></gpx>') });
  await expect(page.locator('#cachesResult')).toContainText('No waypoints');
});

test('hikes show their way in and link to driving directions', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  const bearRocks = page.locator('#finderList li', { hasText: 'Bear Rocks Trail' });
  await expect(bearRocks).toContainText('Trailhead');
  await expect(bearRocks.getByRole('link', { name: 'Driving directions' })).toHaveAttribute('href', /google\.com\/maps\/dir\/\?api=1&destination=39\.06/);
});

test('far from a hike, guidance heads for its parking first', async ({ page }) => {
  await findMe(page, 39.15, -79.3);
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Bear Rocks Trail' }).getByRole('button', { name: 'Follow this hike' }).click();
  await expect(page.locator('#guideDistance')).toHaveText(/ to trailhead$/);
});

test('a small phone keeps every action on screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByRole('button', { name: 'Start hike' }).click();
  for (const name of ['Pause', 'Finish', 'Mark spot', 'Photo']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
