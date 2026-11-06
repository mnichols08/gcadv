import { test, expect } from '@playwright/test';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');
const CORS = { 'access-control-allow-origin': '*' };
const recent = () => new Date(Date.now() - 600000).toISOString();

async function stubServices(page, { failing = false, alert = false } = {}) {
  const answer = (route, json) => (failing ? route.abort() : route.fulfill({ json, headers: CORS }));
  await page.route('https://api.weather.gov/alerts/**', route => answer(route, { features: alert ? [{ properties: { event: 'Winter Storm Warning', headline: 'Winter Storm Warning until 6 PM' } }] : [] }));
  await page.route('https://api.weather.gov/points/**', route => answer(route, { properties: { forecast: 'https://api.weather.gov/gridpoints/LWX/11,84/forecast' } }));
  await page.route('https://api.weather.gov/gridpoints/**', route => answer(route, { properties: { periods: [{ name: 'Tonight', temperature: 28, temperatureUnit: 'F', shortForecast: 'Light Snow', windSpeed: '5 mph', windDirection: 'W' }] } }));
  await page.route('https://mapservices.weather.noaa.gov/**', route => answer(route, { results: [{ attributes: { 'Service Pixel Value': '0.25' } }] }));
  await page.route('https://api.waterdata.usgs.gov/**', route => answer(route, { features: [{ properties: { monitoring_location_id: 'USGS-03076100', parameter_code: '00060', value: '339', time: recent() } }] }));
}

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.route('https://basemap.nationalmap.gov/**', route => route.fulfill({ body: PNG, contentType: 'image/png', headers: CORS }));
  await page.goto('/trails/');
});

const openFromMore = async page => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Conditions here' }).click();
  await expect(page.locator('#conditionsDialog')).toBeVisible();
};

test('conditions show weather, snow, rivers and where to check closures, without a security block', async ({ page }) => {
  const blocked = [];
  page.on('console', message => { if (/content security policy/i.test(message.text())) blocked.push(message.text()); });
  await stubServices(page, { alert: true });
  await openFromMore(page);
  const list = page.locator('#conditionsList');
  await expect(list).toContainText('Winter Storm Warning until 6 PM');
  await expect(list).toContainText('Tonight: 28°F');
  await expect(list).toContainText('About 10 inches estimated');
  await expect(list).toContainText('Youghiogheny River near McHenry, MD');
  await expect(list).toContainText('339 cubic feet per second');
  await expect(list).toContainText('check the land manager');
  await expect(list.locator('a').first()).toHaveAttribute('target', '_blank');
  expect(blocked).toEqual([]);
});

test('with no connection and nothing saved, it says so plainly', async ({ page }) => {
  await stubServices(page, { failing: true });
  await openFromMore(page);
  await expect(page.locator('#conditionsList')).toContainText('Not available right now.');
  await expect(page.locator('#conditionsList')).toContainText('check the land manager');
});

test('readings stay available without a connection, and say how old they are', async ({ page }) => {
  await stubServices(page);
  await openFromMore(page);
  await expect(page.locator('#conditionsList')).toContainText('Tonight: 28°F');
  await page.locator('#conditionsDialog').getByRole('button', { name: 'Close' }).click();
  // Older than the fresh window, then lose the connection.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(item => item.startsWith('trail-conditions:'))) {
      const saved = JSON.parse(localStorage.getItem(key));
      saved.fetchedAt -= 3600000;
      localStorage.setItem(key, JSON.stringify(saved));
    }
  });
  await page.unroute('https://api.weather.gov/gridpoints/**');
  await page.unroute('https://api.weather.gov/points/**');
  await page.route('https://api.weather.gov/points/**', route => route.abort());
  await openFromMore(page);
  await expect(page.locator('#conditionsList')).toContainText('Tonight: 28°F');
  await expect(page.locator('#conditionsList')).toContainText('No connection, so this is from');
});

test('a listed trail has conditions and its details', async ({ page }) => {
  await stubServices(page);
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderCounty').selectOption('Tucker County, WV');
  const row = page.locator('#finderList .route-list li').first();
  await expect(row).toContainText(/climbing|Nearly flat/);
  await row.getByRole('button', { name: 'Conditions' }).click();
  await expect(page.locator('#conditionsTitle')).toContainText('Conditions near');
  await expect(page.locator('#conditionsList')).toContainText('Tonight: 28°F');
});

test('a hand-picked hike shows its climb, effort and profile', async ({ page }) => {
  await page.getByRole('button', { name: 'Find a trail' }).click();
  const row = page.locator('#finderList li', { hasText: 'Big Stonecoal' });
  await expect(row).toContainText('of climbing');
  await expect(row).toContainText('Estimated effort');
  await expect(row.locator('svg.profile')).toHaveAttribute('aria-label', /Elevation over/);
  await stubServices(page);
  await row.getByRole('button', { name: 'Conditions' }).click();
  await expect(page.locator('#conditionsTitle')).toContainText('Big Stonecoal');
});

test('the planner links to conditions for where you are staying', async ({ page }) => {
  await stubServices(page);
  await page.getByRole('button', { name: 'Plan a trip' }).click();
  await page.locator('#planStay').selectOption({ label: 'Ohiopyle, PA' });
  await page.locator('#planActivities').getByRole('button', { name: 'Bike' }).click();
  await page.getByRole('button', { name: 'Conditions near Ohiopyle, PA' }).click();
  await expect(page.locator('#conditionsTitle')).toHaveText('Conditions near Ohiopyle, PA');
  await expect(page.locator('#conditionsList')).toContainText('Tonight: 28°F');
});

test('on a host with no backup API, backup says it is not set up', async ({ page }) => {
  await page.route('**/api/hike/**', route => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html>Not found' }));
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Backup' }).click();
  await expect(page.locator('#backupMessage')).toContainText("isn't set up");
});
