import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const URL_PATH = '/trails/';
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');
const LINDY = { lat: 39.10019, lon: -79.53158 };

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
    window.__emit = (lat, lon, accuracy = 5) => window.__gps({
      coords: { latitude: lat, longitude: lon, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    });
  });
  await page.goto(URL_PATH);
  await page.getByRole('button', { name: 'Find me and follow' }).click();
});

const standAt = (page, lat, lon, accuracy = 5) => page.evaluate(([a, b, c]) => window.__emit(a, b, c), [lat, lon, accuracy]);
const checkIn = page => page.locator('#arrival');

test('lists all ten checkpoints by home area', async ({ page }) => {
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  await expect(page.locator('#checkpointProgress')).toHaveText('0 of 10 reached.');
  for (const name of ['Near Gormania', 'Garrett County', 'Tucker County']) await expect(page.locator('#checkpointList').getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('#checkpointList li')).toHaveCount(10);
  await expect(page.locator('#checkpointList')).toContainText('Lindy Point Overlook');
  await expect(page.locator('#checkpointsReset')).toBeHidden();
});

test('no check-in from far away or on weak GPS', async ({ page }) => {
  await standAt(page, LINDY.lat + 0.01, LINDY.lon);
  await expect(page.locator('#gps')).toContainText('GPS ±');
  await expect(checkIn(page)).toBeHidden();
  await standAt(page, LINDY.lat, LINDY.lon, 200);
  await expect(page.locator('#gps')).toContainText('Weak GPS');
  await expect(checkIn(page)).toBeHidden();
});

test('arriving offers a check-in, which sticks through a reload', async ({ page }) => {
  await standAt(page, LINDY.lat, LINDY.lon);
  await expect(checkIn(page)).toHaveText("You've reached Lindy Point Overlook. Check in");
  await checkIn(page).click();
  await expect(page.locator('#notice')).toHaveText('Checked in at Lindy Point Overlook. 1 of 10 reached.');
  await expect(checkIn(page)).toBeHidden();

  await page.reload();
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await standAt(page, LINDY.lat, LINDY.lon);
  await expect(page.locator('#gps')).toContainText('GPS ±');
  // Already reached, so standing here doesn't offer it twice.
  await expect(checkIn(page)).toBeHidden();
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  await expect(page.locator('#checkpointProgress')).toHaveText('1 of 10 reached.');
  await expect(page.locator('#checkpointList')).toContainText('✓ Lindy Point Overlook');
});

test('details show the warning where it matters, and follow the hike', async ({ page }) => {
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  await page.locator('#checkpointList li', { hasText: 'Bear Rocks Trailhead' }).getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('#checkpointTitle')).toHaveText('Bear Rocks Trailhead');
  await expect(page.locator('#checkpointNote')).toContainText('Unexploded shells');
  await page.getByRole('button', { name: 'Follow this hike' }).click();
  await expect(page.locator('#guideName')).toHaveText('Bear Rocks Trail');
});

test('a straight-line guide can head to a checkpoint directly', async ({ page }) => {
  await standAt(page, 39.2809, -79.3409);
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  await page.locator('#checkpointList li', { hasText: 'Fairfax Stone' }).getByRole('button', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Straight-line guide' }).click();
  await expect(page.locator('#guideName')).toHaveText('Fairfax Stone');
  await expect(page.locator('#guideDistance')).toHaveText(/^\d+\.\d+ mi SW$/);
});

test('tapping a checkpoint on the map opens it', async ({ page }) => {
  await standAt(page, LINDY.lat + 0.0006, LINDY.lon);
  await expect(checkIn(page)).toBeHidden();
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  await page.getByRole('button', { name: 'Close' }).first().evaluate(() => document.getElementById('checkpointsDialog').close());
  const point = await page.evaluate(({ lat, lon }) => {
    const box = document.getElementById('map').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, lat, lon };
  }, LINDY);
  // The marker sits about 220 ft south of center, so offset the tap by the map's own scale.
  const scale = await page.locator('#scaleBar').evaluate(element => element.getBoundingClientRect().width);
  const label = await page.locator('#scaleLabel').textContent();
  const feet = Number(label.replace(/[^\d]/g, ''));
  await page.mouse.click(point.x, point.y + (0.0006 * 69.09 * 5280 / feet) * scale);
  await expect(page.locator('#checkpointTitle')).toHaveText('Lindy Point Overlook');
});

test('starting over clears progress after confirming', async ({ page }) => {
  await standAt(page, LINDY.lat, LINDY.lon);
  await checkIn(page).click();
  await expect(checkIn(page)).toBeHidden();
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.locator('#checkpointProgress')).toHaveText('0 of 10 reached.');
  await page.getByRole('button', { name: 'Close' }).first().evaluate(() => document.getElementById('checkpointsDialog').close());
  await expect(checkIn(page)).toBeVisible();
});

test('a check-in during a hike lands in its GPX', async ({ page }) => {
  const base = Date.now();
  await page.getByRole('button', { name: 'Start hike' }).click();
  await page.evaluate(([lat, lon, start]) => {
    for (let index = 0; index < 3; index += 1) {
      window.__gps({ coords: { latitude: lat + index * 0.0001, longitude: lon, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: start + index * 30000 });
    }
  }, [LINDY.lat, LINDY.lon, base]);
  await checkIn(page).click();
  await expect(page.locator('#notice')).toContainText('Checked in');
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('button', { name: 'Save hike' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GPX' }).click();
  let text = '';
  for await (const chunk of await (await download).createReadStream()) text += chunk;
  expect(text).toContain('Checkpoint: Lindy Point Overlook');
});

test('the check-in button fits a small phone alongside everything else', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await standAt(page, LINDY.lat, LINDY.lon);
  await expect(checkIn(page)).toBeInViewport();
  for (const name of ['Where am I?', 'Find a trail', 'Checkpoints', 'More']) await expect(page.getByRole('button', { name })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('shipped data matches the place the tests stand at', () => {
  const { checkpoints } = JSON.parse(readFileSync(new URL('../../../apps/trails/public/data/checkpoints.json', import.meta.url), 'utf8'));
  const lindy = checkpoints.find(item => item.id === 'lindy-point');
  expect(lindy.lat).toBeCloseTo(LINDY.lat, 4);
  expect(lindy.lon).toBeCloseTo(LINDY.lon, 4);
});
