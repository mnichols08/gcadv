import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const URL_PATH = '/trails/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');

// USGS stays out of the suite, and scripted fixes let a test control the clock GPS reports.
async function prepare(page) {
  await page.route('https://basemap.nationalmap.gov/**', route => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success, failure) { window.__gps = { success, failure }; return 1; },
        clearWatch() { window.__gps = null; },
        getCurrentPosition() {},
      },
    });
    window.__emit = ({ lat, lon, t, accuracy = 5, altitude = null }) => window.__gps.success({
      coords: { latitude: lat, longitude: lon, accuracy, altitude, altitudeAccuracy: altitude === null ? null : 5, heading: null, speed: null },
      timestamp: t,
    });
  });
}

const walk = (page, fixes) => page.evaluate(list => list.forEach(fix => window.__emit(fix)), fixes);
const steps = (count, from = 0, base = Date.now()) => Array.from({ length: count }, (_, index) => ({ lat: 39.5 + (from + index) * 0.001, lon: -79.4, t: base + (from + index) * 60000 }));

test.describe('recording a hike', () => {
  test.use({ serviceWorkers: 'block' });

  test.beforeEach(async ({ page }) => {
    await prepare(page);
    await page.goto(URL_PATH);
  });

  test('records a walk, finishes it, and exports GPX', async ({ page }) => {
    await page.getByRole('button', { name: 'Start hike' }).click();
    await expect(page.locator('#gps')).toHaveText('Finding GPS…');
    await walk(page, steps(6));
    await expect(page.locator('#gps')).toContainText('GPS ±16 ft');
    // Five steps of 0.001 degrees of latitude, about 0.345 miles.
    await expect(page.locator('#statMiles')).toHaveText('0.35 mi');

    await page.getByRole('button', { name: 'Finish' }).click();
    await page.locator('#finishName').fill('Test & Ridge');
    await page.getByRole('button', { name: 'Save hike' }).click();
    await expect(page.getByRole('heading', { name: 'My hikes' })).toBeVisible();
    await expect(page.locator('#hikeList')).toContainText('Test & Ridge');
    await expect(page.locator('#hikeList')).toContainText('0.35 mi');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export GPX' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/test-ridge\.gpx$/);
    const gpx = readFileSync(await file.path(), 'utf8');
    expect(gpx.match(/<trkpt/g)).toHaveLength(6);
    expect(gpx).toContain('Test &amp; Ridge');
  });

  test('a recording survives the browser reloading', async ({ page }) => {
    await page.getByRole('button', { name: 'Start hike' }).click();
    await walk(page, steps(4));
    await expect(page.locator('#statMiles')).toHaveText('0.21 mi');
    // Writes are fire-and-forget, so let them land before the reload.
    await page.waitForFunction(() => new Promise(resolve => {
      const open = indexedDB.open('waymark');
      open.onsuccess = () => {
        const count = open.result.transaction('points').objectStore('points').count();
        count.onsuccess = () => resolve(count.result === 4);
      };
    }));
    await page.reload();
    await expect(page.locator('#notice')).toContainText('restored');
    await expect(page.locator('#statMiles')).toHaveText('0.21 mi');
    await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible();
  });

  test('tells the hiker when the phone stopped reporting', async ({ page }) => {
    const base = Date.now();
    await page.getByRole('button', { name: 'Start hike' }).click();
    await walk(page, [{ lat: 39.5, lon: -79.4, t: base }, { lat: 39.5005, lon: -79.4, t: base + 60000 }]);
    await walk(page, [{ lat: 39.51, lon: -79.4, t: base + 60000 + 900000 }]);
    await expect(page.locator('#notice')).toContainText("isn't in your route");
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.locator('#finishSummary')).toContainText("wasn't tracked");
  });

  test('pausing stops distance from growing', async ({ page }) => {
    const base = Date.now();
    await page.getByRole('button', { name: 'Start hike' }).click();
    await walk(page, steps(3, 0, base));
    await page.getByRole('button', { name: 'Pause' }).click();
    await walk(page, steps(3, 3, base));
    await expect(page.locator('#statMiles')).toHaveText('0.14 mi');
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  test('marks a spot and guides back to it', async ({ page }) => {
    await page.getByRole('button', { name: 'Find me and follow' }).click();
    await walk(page, [{ lat: 39.5, lon: -79.4, t: Date.now() }]);
    await page.getByRole('button', { name: 'Mark spot' }).click();
    await page.getByRole('button', { name: 'Car', exact: true }).click();
    // Walking on before saving must not move the spot.
    await walk(page, [{ lat: 39.5001, lon: -79.4, t: Date.now() + 60000 }]);
    await page.getByRole('button', { name: 'Save spot' }).click();
    await walk(page, [{ lat: 39.51, lon: -79.4, t: Date.now() + 600000 }]);
    await page.getByRole('button', { name: 'Where am I?' }).click();
    await expect(page.locator('#spotList')).toContainText('Car');
    await page.getByRole('button', { name: 'Guide me', exact: true }).click();
    await expect(page.locator('#guideName')).toHaveText('Car');
    await expect(page.locator('#guideDistance')).toHaveText('0.69 mi S');
  });

  test('names the nearest town and water from bundled data', async ({ page }) => {
    await page.getByRole('button', { name: 'Find me and follow' }).click();
    await walk(page, [{ lat: 39.2809, lon: -79.3409, t: Date.now() }]);
    await page.getByRole('button', { name: 'Where am I?' }).click();
    await expect(page.locator('#whereCoords')).toHaveText('39.28090, -79.34090');
    await expect(page.locator('#wherePlace')).toContainText(/ of .+, (WV|MD)./);
    await expect(page.locator('#wherePlace')).not.toContainText('historical');
    await expect(page.locator('#whereWater')).toContainText('North Branch Potomac River');
  });

  test('a blocked location explains itself', async ({ page }) => {
    await page.getByRole('button', { name: 'Find me and follow' }).click();
    await page.evaluate(() => window.__gps.failure({ code: 1, PERMISSION_DENIED: 1 }));
    await expect(page.locator('#gps')).toHaveText('Location blocked');
    await expect(page.locator('#notice')).toContainText('site settings');
  });

  test('offers to save only a reasonable area', async ({ page }) => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Save map' }).click();
    await expect(page.locator('#mapsPlan')).toContainText('too large');
    await expect(page.locator('#mapsSave')).toBeDisabled();
  });

  test('fits a phone screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await expect(page.getByRole('button', { name: 'Start hike' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'More', exact: true })).toBeInViewport();
  });
});

test('the real Geolocation API feeds the map', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright grants geolocation most reliably in Chromium.');
  const context = await browser.newContext({ geolocation: { latitude: 39.5, longitude: -79.4, accuracy: 10 }, permissions: ['geolocation'], serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('https://basemap.nationalmap.gov/**', route => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await page.goto(URL_PATH);
  await page.getByRole('button', { name: 'Start hike' }).click();
  await expect(page.locator('#gps')).toContainText('GPS ±33 ft');
  await context.close();
});

test('reopens and keeps recording with no connection', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Offline service worker reload is checked in Chromium.');
  const context = await browser.newContext();
  const page = await context.newPage();
  await prepare(page);
  await page.goto(URL_PATH);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Start hike' }).click();
  await walk(page, steps(3));
  await expect(page.locator('#statMiles')).toHaveText('0.14 mi');
  await context.close();
});

async function controlledPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await prepare(page);
  await page.goto(URL_PATH);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  return { context, page };
}

test('a returning phone runs one whole release, not a mix of old and new files', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Service worker storage is checked in Chromium.');
  const { context, page } = await controlledPage(browser);
  const marked = await page.evaluate(async () => {
    const name = (await caches.keys()).find(key => key.startsWith('hike-shell'));
    const cache = await caches.open(name);
    const url = new URL('modules/geo.js', location.href).href;
    const text = await (await cache.match(url)).text();
    await cache.put(url, new Response(text + '\n// from the stored release', { headers: { 'content-type': 'text/javascript' } }));
    return (await (await fetch('modules/geo.js')).text()).includes('from the stored release');
  });
  expect(marked).toBe(true);
  await context.close();
});

test('a new release restarts an idle app, but never a hike under way', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Service worker updates are checked in Chromium.');
  const { context, page } = await controlledPage(browser);
  const takeOver = () => page.evaluate(() => {
    window.__sameLoad = true;
    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
  });
  await Promise.all([page.waitForEvent('load', { timeout: 5000 }), takeOver()]);
  expect(await page.evaluate(() => window.__sameLoad)).toBeUndefined();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.getByRole('button', { name: 'Start hike' }).click();
  await takeOver();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__sameLoad)).toBe(true);
  await context.close();
});

test('the built app names its release', async ({ request }) => {
  const worker = await (await request.get('/trails/sw.js')).text();
  expect(worker).toMatch(/SHELL_CACHE = 'hike-shell-[0-9a-f]{16}'/);
});
