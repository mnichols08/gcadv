import { test, expect } from '@playwright/test';

const URL_PATH = '/trails/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.route('https://basemap.nationalmap.gov/**', route => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success) { window.__gps = success; return 1; },
        clearWatch() {},
        getCurrentPosition() {},
      },
    });
    window.__emit = (lat, lon, t = Date.now()) => window.__gps({
      coords: { latitude: lat, longitude: lon, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: t,
    });
  });
  await page.goto(URL_PATH);
});

const toggle = page => page.getByRole('button', { name: '3D terrain view' });
const distinctPixels = async page => {
  const shot = await page.locator('#terrain').screenshot();
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const seen = new Set();
    for (let index = 0; index < data.length; index += 400) seen.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    return seen.size;
  }, shot.toString('base64'));
};

test('switches to 3D and back, with the controls following along', async ({ page }) => {
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#terrain')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Face north' })).toBeVisible();
  await expect(page.locator('#heightNote')).toBeVisible();
  await expect(page.locator('#scale')).toBeHidden();
  await expect(page.locator('#notice')).toBeHidden({ timeout: 15000 });

  await toggle(page).click();
  await expect(page.locator('#terrain')).toBeHidden();
  await expect(page.locator('#heightNote')).toBeHidden();
  await expect(page.locator('#scale')).toBeVisible();
});

test('draws lit terrain, not a blank canvas', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Software WebGL in Chromium is the reliable headless target.');
  await toggle(page).click();
  await expect(page.locator('#notice')).toBeHidden({ timeout: 15000 });
  await expect.poll(() => distinctPixels(page), { timeout: 15000 }).toBeGreaterThan(20);
});

test('keeps recording while in 3D', async ({ page }) => {
  const base = Date.now();
  await page.getByRole('button', { name: 'Start hike' }).click();
  await toggle(page).click();
  await page.evaluate(start => {
    for (let index = 0; index < 4; index += 1) window.__emit(39.28 + index * 0.001, -79.34, start + index * 60000);
  }, base);
  await expect(page.locator('#statMiles')).toHaveText('0.21 mi');
  await toggle(page).click();
  await expect(page.locator('#statMiles')).toHaveText('0.21 mi');
});

test('says so when the map is outside the terrain data', async ({ page }) => {
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.evaluate(() => window.__emit(38.2, -77.0));
  await toggle(page).click();
  await expect(page.locator('#notice')).toContainText('only the counties this app maps');
  await expect(page.locator('#terrain')).toBeHidden();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('a phone without 3D support keeps working on the map', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      return type === 'webgl2' ? null : original.call(this, type, ...rest);
    };
  });
  await page.reload();
  await toggle(page).click();
  await expect(page.locator('#notice')).toContainText("can't draw 3D");
  await expect(page.locator('#terrain')).toBeHidden();
  await expect(page.locator('#map')).toBeVisible();
});

test('every rail button stays on screen on a small phone, even with the guide open', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await toggle(page).click();
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Fairfax Stone' }).getByRole('button', { name: 'Guide me here' }).click();
  await expect(page.locator('#guide')).toBeVisible();
  const sheetTop = await page.locator('.sheet').evaluate(element => element.getBoundingClientRect().top);
  for (const name of ['Zoom in', 'Zoom out', '3D terrain view', 'Face north', 'Find me and follow', 'Show trails', 'Highlight streams']) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeInViewport();
    const box = await button.boundingBox();
    expect(box.y + box.height, name).toBeLessThanOrEqual(sheetTop + 1);
  }
});
