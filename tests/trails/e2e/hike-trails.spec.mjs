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
    window.__emit = (lat, lon) => window.__gps({
      coords: { latitude: lat, longitude: lon, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    });
  });
  await page.goto(URL_PATH);
});

// Points from the baked Lostland Run line, so the walk really is on the trail.
const LOSTLAND = { lat: 39.37878, lon: -79.2829 };

test('lists hikes by home area, with Gormania honest about what is there', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  const list = page.locator('#finderList');
  await expect(list.getByRole('heading', { name: 'Near Gormania' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Garrett County' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Tucker County' })).toBeVisible();
  await expect(list).toContainText('Lostland Run and Cascade Falls');
  await expect(list).toContainText('Swallow Falls Canyon');
  await expect(list).toContainText('Lindy Point');
  await expect(list).toContainText('Unexploded shells');
  await expect(list).toContainText('No named trail');
  await expect(page.locator('#finderDialog')).toContainText('Snowmobile or motorized route');
});

test('following a hike guides to the trail, then warns on leaving it', async ({ page }) => {
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Lostland Run' }).getByRole('button', { name: 'Follow this hike' }).click();
  await expect(page.locator('#guideName')).toHaveText('Lostland Run and Cascade Falls');
  await expect(page.locator('#guideDistance')).toHaveText('Finding GPS…');

  await page.evaluate(({ lat, lon }) => window.__emit(lat + 0.01, lon), LOSTLAND);
  await expect(page.locator('#guideDistance')).toHaveText(/to (the trail|parking|trailhead)$/);
  // Walking in to the trail for the first time isn't "leaving" it.
  await expect(page.locator('#notice')).toBeHidden();

  await page.evaluate(({ lat, lon }) => window.__emit(lat, lon), LOSTLAND);
  await expect(page.locator('#guideDistance')).toHaveText('On the trail');

  await page.evaluate(({ lat, lon }) => window.__emit(lat + 0.005, lon), LOSTLAND);
  await expect(page.locator('#notice')).toContainText("You've left Lostland Run");
  await expect(page.locator('#guideDistance')).toContainText('to the trail');

  await page.evaluate(({ lat, lon }) => window.__emit(lat, lon), LOSTLAND);
  await expect(page.locator('#notice')).toBeHidden();
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await expect(page.locator('#guide')).toBeHidden();
});

test('a destination with no trail guides by distance alone', async ({ page }) => {
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.evaluate(() => window.__emit(39.2809, -79.3409));
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Fairfax Stone' }).getByRole('button', { name: 'Guide me here' }).click();
  await expect(page.locator('#guideName')).toHaveText('Fairfax Stone');
  await expect(page.locator('#guideDistance')).toHaveText(/^\d+\.\d+ mi SW$/);
});

test('saving a hike offline plans the area around it', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Lindy Point' }).getByRole('button', { name: 'Save offline' }).click();
  await expect(page.getByRole('heading', { name: 'Save map for offline' })).toBeVisible();
  await expect(page.locator('#mapsPlan')).toContainText('Trail and water data');
  await expect(page.locator('#mapsSave')).toBeEnabled();
});

test('saving a hike offline keeps the whole hike, whatever fits on screen', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Lindy Point' }).getByRole('button', { name: 'Save offline' }).click();
  const planned = Number((await page.locator('#mapsPlan').textContent()).match(/([\d,]+) map pieces/)[1].replace(/,/g, ''));
  // Half a mile around a short hike, down to the finest map, is well over a screenful.
  expect(planned).toBeGreaterThan(40);
  await page.getByRole('button', { name: 'Save this area' }).click();
  await expect(page.locator('#mapsResult')).toHaveText(`Saved ${planned} map pieces. This area now works without signal.`, { timeout: 20000 });
  await expect(page.locator('#areaList')).toContainText('map pieces');
});

test('names the nearest trail and marks tracks as unknown access', async ({ page }) => {
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.evaluate(({ lat, lon }) => window.__emit(lat, lon), LOSTLAND);
  await page.getByRole('button', { name: 'Where am I?' }).click();
  await expect(page.locator('#whereTrail')).toContainText('Lostland Run Trail (trail)');
});

test('outside the trail data says so instead of implying no trails', async ({ page }) => {
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.evaluate(() => window.__emit(38.2, -77.0));
  await page.getByRole('button', { name: 'Where am I?' }).click();
  await expect(page.locator('#whereTrail')).toHaveText("Trail data doesn't cover this area yet.");
});

test('all four shortcuts fit a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  for (const name of ['Where am I?', 'Find a trail', 'Checkpoints', 'More']) await expect(page.getByRole('button', { name })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('choosing an activity narrows the finder, says what the marking means, and is remembered', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  const chips = page.locator('#finderActivities');
  await expect(chips.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
  await chips.getByRole('button', { name: 'Snowmobile' }).click();
  await expect(chips.getByRole('button', { name: 'Snowmobile' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#finderNote')).toContainText('land manager');
  await expect(page.locator('#finderList .route-list li').first()).toContainText('snowmobiles');
  await page.locator('#finderDialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#activityChip')).toHaveText('Snowmobile only ✕');
  await page.reload();
  await expect(page.locator('#activityChip')).toHaveText('Snowmobile only ✕');
  await page.locator('#activityChip').click();
  await expect(page.locator('#activityChip')).toBeHidden();
});

test('the county choice narrows the list', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await expect(page.locator('#finderCounty option')).toHaveCount(10);
  await page.locator('#finderCounty').selectOption('Somerset County, PA');
  await expect(page.locator('#finderList .route-list li').first()).toContainText('Somerset County, PA');
  await expect(page.locator('#finderList').getByText('Tucker County, WV')).toHaveCount(0);
});

test('following a listed trail draws it and guides to it', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderActivities').getByRole('button', { name: 'XC ski' }).click();
  await page.locator('#finderList .route-list li').first().getByRole('button', { name: 'Follow this trail' }).click();
  await expect(page.locator('#finderDialog')).toBeHidden();
  await expect(page.locator('#guide')).toBeVisible();
});

test('other activities list their own trails, not the hand-picked hikes', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await expect(page.getByRole('button', { name: 'Follow this hike' }).first()).toBeVisible();
  await page.locator('#finderActivities').getByRole('button', { name: 'XC ski' }).click();
  await expect(page.locator('#finderList .route-list li').first()).toContainText('XC skiing');
  await expect(page.getByRole('button', { name: 'Follow this hike' })).toHaveCount(0);
});

test('the trip planner gives nearby trails for where you are staying, and remembers', async ({ page }) => {
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  await expect(page.locator('#planResults')).toContainText('Pick where you');
  await page.locator('#planStay').selectOption({ label: 'Deep Creek Lake (McHenry), MD' });
  await expect(page.locator('#planResults')).toContainText('Pick one or more');
  await page.locator('#planActivities').getByRole('button', { name: 'Hike' }).click();
  await page.locator('#planActivities').getByRole('button', { name: 'ATV / UTV' }).click();
  await expect(page.locator('#planResults h3', { hasText: 'Hike' })).toBeVisible();
  await expect(page.locator('#planResults .route-list li').first()).toContainText('mi away');
  await expect(page.locator('#planResults')).toContainText('Wolf Den Run State Park');
  await expect(page.locator('#planResults')).toContainText('Local guides');
  await expect(page.locator('#planResults a', { hasText: 'First Time at Deep Creek Lake' })).toHaveAttribute('href', '../first-time-deep-creek.html');
  await page.reload();
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  await expect(page.locator('#planStay')).not.toHaveValue('');
  await expect(page.locator('#planResults')).toContainText('Wolf Den Run State Park');
});

test('following a trail from the planner closes it and starts the guide', async ({ page }) => {
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  await page.locator('#planStay').selectOption({ label: 'Ohiopyle, PA' });
  await page.locator('#planActivities').getByRole('button', { name: 'Bike' }).click();
  await page.locator('#planResults .route-list li').first().getByRole('button', { name: 'Follow this trail' }).click();
  await expect(page.locator('#planDialog')).toBeHidden();
  await expect(page.locator('#guide')).toBeVisible();
});

test('the site can link straight to the planner', async ({ page }) => {
  await page.goto('/trails/#plan');
  await expect(page.locator('#planDialog')).toBeVisible();
});

test('an activity shows what land managers say, including where it is not allowed', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderActivities').getByRole('button', { name: 'ATV / UTV' }).click();
  await expect(page.locator('#finderHelp')).toContainText('From the land managers');
  await expect(page.locator('#finderHelp a').first()).toHaveAttribute('target', '_blank');
});
