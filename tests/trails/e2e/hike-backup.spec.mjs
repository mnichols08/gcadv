import { test, expect } from '@playwright/test';

const URL_PATH = '/trails/';
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');
const LINDY = { lat: 39.10019, lon: -79.53158 };

async function prepare(page) {
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
    window.__emit = (lat, lon, t = Date.now()) => window.__gps({
      coords: { latitude: lat, longitude: lon, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: t,
    });
    window.__addPhoto = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const context = canvas.getContext('2d');
      context.fillStyle = '#2a7';
      context.fillRect(0, 0, 800, 600);
      const blob = await new Promise(resolve => { canvas.toBlob(resolve, 'image/jpeg'); });
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
      const input = document.getElementById('photoInput');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
  });
}

// Each simulated phone is its own browser profile, so nothing is shared but the account.
async function newPhone(browser, baseURL) {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block', viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  await prepare(page);
  await page.goto(URL_PATH);
  return { context, page };
}

const more = (page, name) => page.getByRole('button', { name: 'More', exact: true }).click().then(() => page.getByRole('button', { name }).click());
const closeDialog = (page, id) => page.locator(`#${id}`).getByRole('button', { name: 'Close' }).click();
let counter = 0;
const uniqueEmail = browserName => `hiker${Date.now()}${counter++}${browserName}@example.test`;

async function signIn(page, email) {
  await more(page, 'Backup');
  await page.locator('#backupEmail').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.locator('#backupMessage')).toContainText('We sent a code');
  const code = await (await page.request.get(`/__local/last-code?email=${encodeURIComponent(email)}`)).text();
  await page.locator('#backupCode').fill(code);
  await page.getByRole('button', { name: 'Turn on backup' }).click();
  await expect(page.locator('#backupAccount')).toHaveText(`Backing up to ${email}.`);
}

const backedUp = page => expect(page.locator('#backupStatus')).toContainText(/saved|brought to this phone|Everything is backed up/, { timeout: 20000 });

async function recordHike(page, name) {
  const base = Date.now() - 600000;
  await page.getByRole('button', { name: 'Start hike' }).click();
  await page.evaluate(([lat, lon, start]) => {
    for (let index = 0; index < 5; index += 1) window.__emit(lat + index * 0.001, lon, start + index * 60000);
  }, [LINDY.lat + 0.02, LINDY.lon, base]);
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.locator('#finishName').fill(name);
  await page.getByRole('button', { name: 'Save hike' }).click();
  await expect(page.locator('#hikeList')).toContainText(name);
  await closeDialog(page, 'hikesDialog');
}

test('it stays optional, and says plainly what leaves the phone', async ({ browser, baseURL }) => {
  const { context, page } = await newPhone(browser, baseURL);
  await expect(page.locator('.credit')).toContainText('stays on this phone');
  await more(page, 'Backup');
  await expect(page.locator('#backupOut')).toContainText('optional');
  await expect(page.locator('#backupOut')).toContainText("aren't end-to-end encrypted");
  await context.close();
});

test('a lost phone: everything comes back on a new one', async ({ browser, baseURL, browserName }) => {
  const email = uniqueEmail(browserName);
  const old = await newPhone(browser, baseURL);
  await recordHike(old.page, 'Lindy Walk');
  await old.page.getByRole('button', { name: 'Find me and follow' }).click();
  await old.page.evaluate(({ lat, lon }) => window.__emit(lat, lon), LINDY);
  await old.page.locator('#arrival').click();
  await expect(old.page.locator('#notice')).toContainText('Checked in');
  await old.page.getByRole('button', { name: 'Mark spot' }).click();
  await old.page.getByRole('button', { name: 'Car', exact: true }).click();
  await old.page.getByRole('button', { name: 'Save spot' }).click();
  await old.page.evaluate(() => window.__addPhoto());
  await expect(old.page.locator('#notice')).toContainText('Photo added');
  await signIn(old.page, email);
  await backedUp(old.page);
  await expect(old.page.locator('#backupStatus')).toContainText('saved');
  await old.context.close();

  const fresh = await newPhone(browser, baseURL);
  await signIn(fresh.page, email);
  await expect(fresh.page.locator('#backupStatus')).toContainText('brought to this phone', { timeout: 20000 });
  await closeDialog(fresh.page, 'backupDialog');

  await more(fresh.page, 'My hikes');
  await expect(fresh.page.locator('#hikeList')).toContainText('Lindy Walk');
  const download = fresh.page.waitForEvent('download');
  await fresh.page.getByRole('button', { name: 'Export GPX' }).click();
  let gpx = '';
  for await (const chunk of await (await download).createReadStream()) gpx += chunk;
  expect(gpx.match(/<trkpt/g).length).toBeGreaterThanOrEqual(5);
  await closeDialog(fresh.page, 'hikesDialog');

  await fresh.page.getByRole('button', { name: 'Checkpoints' }).click();
  await expect(fresh.page.locator('#checkpointProgress')).toHaveText('1 of 10 reached.');
  await closeDialog(fresh.page, 'checkpointsDialog');

  await fresh.page.getByRole('button', { name: 'Where am I?' }).click();
  await expect(fresh.page.locator('#spotList')).toContainText('Car');
  await closeDialog(fresh.page, 'whereDialog');

  await more(fresh.page, 'My photos');
  await fresh.page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => fresh.page.locator('#photoFull').evaluate(image => image.naturalWidth)).toBe(800);
  await fresh.context.close();
});

test('a deletion on one phone reaches the other, and does not come back', async ({ browser, baseURL, browserName }) => {
  const email = uniqueEmail(browserName);
  const first = await newPhone(browser, baseURL);
  await recordHike(first.page, 'Doomed Hike');
  await signIn(first.page, email);
  await expect(first.page.locator('#backupStatus')).toContainText('saved', { timeout: 20000 });
  await closeDialog(first.page, 'backupDialog');

  const second = await newPhone(browser, baseURL);
  await signIn(second.page, email);
  await expect(second.page.locator('#backupStatus')).toContainText('brought to this phone', { timeout: 20000 });
  await closeDialog(second.page, 'backupDialog');

  await more(first.page, 'My hikes');
  first.page.once('dialog', dialog => dialog.accept());
  await first.page.getByRole('button', { name: 'Delete' }).first().click();
  await expect(first.page.locator('#hikeList')).not.toContainText('Doomed Hike');
  await closeDialog(first.page, 'hikesDialog');
  await more(first.page, 'Backup');
  await first.page.getByRole('button', { name: 'Back up now' }).click();
  await expect(first.page.locator('#backupStatus')).toContainText('saved', { timeout: 20000 });

  await more(second.page, 'Backup');
  await second.page.getByRole('button', { name: 'Back up now' }).click();
  await expect(second.page.locator('#backupStatus')).toContainText('removed here', { timeout: 20000 });
  await closeDialog(second.page, 'backupDialog');
  await more(second.page, 'My hikes');
  await expect(second.page.locator('#hikeList')).not.toContainText('Doomed Hike');
  await first.context.close();
  await second.context.close();
});

test('a wrong code is refused with a clear message', async ({ browser, baseURL, browserName }) => {
  const { context, page } = await newPhone(browser, baseURL);
  const email = uniqueEmail(browserName);
  await more(page, 'Backup');
  await page.locator('#backupEmail').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.locator('#backupMessage')).toContainText('We sent a code');
  const real = await (await page.request.get(`/__local/last-code?email=${encodeURIComponent(email)}`)).text();
  await page.locator('#backupCode').fill(real === '00000000' ? '00000001' : '00000000');
  await page.getByRole('button', { name: 'Turn on backup' }).click();
  await expect(page.locator('#backupMessage')).toContainText("didn't work");
  await expect(page.locator('#backupIn')).toBeHidden();
  await context.close();
});

test('signing out keeps everything on the phone and stops backing up', async ({ browser, baseURL, browserName }) => {
  const { context, page } = await newPhone(browser, baseURL);
  await recordHike(page, 'Kept Hike');
  await signIn(page, uniqueEmail(browserName));
  await backedUp(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#backupMessage')).toContainText('Everything is still on this phone');
  await expect(page.locator('#backupOut')).toBeVisible();
  await closeDialog(page, 'backupDialog');
  await more(page, 'My hikes');
  await expect(page.locator('#hikeList')).toContainText('Kept Hike');
  await context.close();
});

test('deleting the account erases the backup but not this phone', async ({ browser, baseURL, browserName }) => {
  const email = uniqueEmail(browserName);
  const { context, page } = await newPhone(browser, baseURL);
  await recordHike(page, 'Local Copy');
  await signIn(page, email);
  await expect(page.locator('#backupStatus')).toContainText('saved', { timeout: 20000 });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete my backup and account' }).click();
  await expect(page.locator('#backupStatus')).toContainText('Enter it to confirm');
  // A wrong code must leave everything in place.
  const real = await (await page.request.get(`/__local/last-code?email=${encodeURIComponent(email)}`)).text();
  await page.locator('#backupDeleteCode').fill(real === '00000000' ? '00000001' : '00000000');
  await page.getByRole('button', { name: 'Delete everything' }).click();
  await expect(page.locator('#backupStatus')).toContainText("didn't work");
  await page.locator('#backupDeleteCode').fill(real);
  await page.getByRole('button', { name: 'Delete everything' }).click();
  await expect(page.locator('#backupMessage')).toContainText('Your account and backup are deleted');
  await closeDialog(page, 'backupDialog');
  await more(page, 'My hikes');
  await expect(page.locator('#hikeList')).toContainText('Local Copy');
  await context.close();

  const fresh = await newPhone(browser, baseURL);
  await signIn(fresh.page, email);
  await expect(fresh.page.locator('#backupStatus')).toContainText('Everything is backed up', { timeout: 20000 });
  await closeDialog(fresh.page, 'backupDialog');
  await more(fresh.page, 'My hikes');
  await expect(fresh.page.locator('#hikeList')).not.toContainText('Local Copy');
  await fresh.context.close();
});

test('signing in as someone else asks first, and refusing copies nothing', async ({ browser, baseURL, browserName }) => {
  const { context, page } = await newPhone(browser, baseURL);
  await recordHike(page, 'My Private Hike');
  await signIn(page, uniqueEmail(browserName));
  await expect(page.locator('#backupStatus')).toContainText('saved', { timeout: 20000 });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#backupOut')).toBeVisible();

  const friend = uniqueEmail(browserName);
  await page.locator('#backupEmail').fill(friend);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.locator('#backupMessage')).toContainText('We sent a code');
  const code = await (await page.request.get(`/__local/last-code?email=${encodeURIComponent(friend)}`)).text();
  await page.locator('#backupCode').fill(code);
  let warning = '';
  page.once('dialog', dialog => { warning = dialog.message(); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Turn on backup' }).click();
  await expect(page.locator('#backupMessage')).toHaveText('Not signed in. Nothing was copied.');
  expect(warning).toContain(friend);
  await context.close();

  const friendsPhone = await newPhone(browser, baseURL);
  await signIn(friendsPhone.page, friend);
  await expect(friendsPhone.page.locator('#backupStatus')).toContainText('Everything is backed up', { timeout: 20000 });
  await closeDialog(friendsPhone.page, 'backupDialog');
  await more(friendsPhone.page, 'My hikes');
  await expect(friendsPhone.page.locator('#hikeList')).not.toContainText('My Private Hike');
  await friendsPhone.context.close();
});

test('a phone keeps its copies when many items vanish from the backup at once', async ({ browser, baseURL, browserName }) => {
  const email = uniqueEmail(browserName);
  const first = await newPhone(browser, baseURL);
  await first.page.getByRole('button', { name: 'Find me and follow' }).click();
  await first.page.evaluate(({ lat, lon }) => window.__emit(lat + 0.03, lon), LINDY);
  for (let index = 0; index < 8; index += 1) {
    await first.page.getByRole('button', { name: 'Mark spot' }).click();
    await first.page.locator('#markName').fill(`Spot ${index}`);
    await first.page.getByRole('button', { name: 'Save spot' }).click();
    await expect(first.page.locator('#markDialog')).toBeHidden();
  }
  await signIn(first.page, email);
  await expect(first.page.locator('#backupStatus')).toContainText('8 saved', { timeout: 20000 });
  await closeDialog(first.page, 'backupDialog');

  const second = await newPhone(browser, baseURL);
  await signIn(second.page, email);
  await expect(second.page.locator('#backupStatus')).toContainText('brought to this phone', { timeout: 20000 });

  // The other phone, or a thief using it, removes them all from the backup.
  await first.page.evaluate(async () => {
    const { items } = await (await fetch('/api/hike/items')).json();
    await Promise.all(items.map(item => fetch(`/api/hike/items/${item.kind}/${item.id}?updatedAt=${Date.now()}`, { method: 'DELETE' })));
  });

  await second.page.getByRole('button', { name: 'Back up now' }).click();
  await expect(second.page.locator('#backupStatus')).toContainText("They're still on this phone", { timeout: 20000 });
  await closeDialog(second.page, 'backupDialog');
  await second.page.getByRole('button', { name: 'Where am I?' }).click();
  await expect(second.page.locator('#spotList')).toContainText('Spot 7');
  await closeDialog(second.page, 'whereDialog');

  await more(second.page, 'Backup');
  await second.page.getByRole('button', { name: 'Back up now' }).click();
  await expect(second.page.locator('#backupKeepRemoving')).toBeVisible({ timeout: 20000 });
  second.page.once('dialog', dialog => dialog.accept());
  await second.page.locator('#backupKeepRemoving').click();
  await expect(second.page.locator('#backupStatus')).toContainText('8 removed here', { timeout: 20000 });
  await first.context.close();
  await second.context.close();
});

test('another phone can be signed out from here', async ({ browser, baseURL, browserName }) => {
  const email = uniqueEmail(browserName);
  const lost = await newPhone(browser, baseURL);
  await signIn(lost.page, email);
  await backedUp(lost.page);
  const kept = await newPhone(browser, baseURL);
  await signIn(kept.page, email);
  await backedUp(kept.page);
  await kept.page.getByRole('button', { name: 'Sign out other phones' }).click();
  await expect(kept.page.locator('#backupStatus')).toContainText('Every other phone is signed out');

  await lost.page.getByRole('button', { name: 'Back up now' }).click();
  await expect(lost.page.locator('#backupMessage')).toContainText('Your sign-in ended');
  await kept.page.getByRole('button', { name: 'Back up now' }).click();
  await backedUp(kept.page);
  await lost.context.close();
  await kept.context.close();
});

test('with no backend configured, the app explains and keeps working', async ({ browser, baseURL }) => {
  const { context, page } = await newPhone(browser, baseURL);
  await page.route('**/api/hike/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"backup_unavailable"}' }));
  await more(page, 'Backup');
  await expect(page.locator('#backupMessage')).toContainText("isn't set up");
  await expect(page.locator('#backupOut')).toBeHidden();
  await closeDialog(page, 'backupDialog');
  await recordHike(page, 'Still Works');
  await context.close();
});

test('losing signal during a hike never gets in the way', async ({ browser, baseURL, browserName }) => {
  const { context, page } = await newPhone(browser, baseURL);
  await signIn(page, uniqueEmail(browserName));
  await backedUp(page);
  await closeDialog(page, 'backupDialog');
  await page.route('**/api/hike/**', route => route.abort());
  await recordHike(page, 'No Signal Hike');
  await more(page, 'Backup');
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.locator('#backupStatus')).toContainText('No signal');
  await context.close();
});
