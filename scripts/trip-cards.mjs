// Printable cards for rentals and outfitters: four to a sheet, one sheet per town. Each QR code opens
// the trip planner with that town chosen. The town sits after the #, so it never reaches a server and
// a scan can't be counted or tied to anyone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import QRCode from 'qrcode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://garrettcountyadventures.com';
const OUTPUT = path.join(ROOT, 'docs', 'trip-cards');

export const cardUrl = stay => `${SITE}/trails/#plan${stay ? `=${stay.id}` : ''}`;
export const cardPlace = stay => (stay ? stay.label : 'Garrett County and nearby');

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function cardHtml(place, qrSvg) {
  return `<section class="card">
    <header><p>Garrett County Adventures</p></header>
    <div class="body">
      <p class="kicker">Trails near</p>
      <h1>${escapeHtml(place)}</h1>
      <p class="lead">Hiking, biking, skiing and riding close to where you're staying.</p>
      <div class="qr">${qrSvg}</div>
      <p class="scan">Point your phone's camera here</p>
      <ul>
        <li>Free, with no sign-up or app store</li>
        <li>Save maps before you lose signal</li>
        <li>Weather and river levels for your stay</li>
      </ul>
    </div>
    <footer>garrettcountyadventures.com/trails<br><span>Check rules and conditions with the land manager before you go.</span></footer>
  </section>`;
}

export function sheetHtml(place, qrSvg) {
  const card = cardHtml(place, qrSvg);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(place)} trail card</title><style>
    @page { size: 8.5in 11in; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body { display: grid; grid-template: repeat(2, 5.5in) / repeat(2, 4.25in); width: 8.5in; height: 11in; color: #203a31; font-family: "Segoe UI", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .card { display: flex; flex-direction: column; border: 0.5pt dashed #9aa79e; overflow: hidden; }
    header { padding: 0.13in 0.28in; background: #203a31; color: #fff; font-size: 10.5pt; font-weight: 700; text-align: center; }
    header p, .body p, footer { margin: 0; }
    .body { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 0.17in 0.28in 0; text-align: center; }
    .kicker { color: #41694e; font-size: 9.5pt; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
    h1 { margin: 0.02in 0 0.05in; font-size: 17pt; line-height: 1.12; }
    .lead { font-size: 10.5pt; line-height: 1.3; }
    .qr { width: 2.2in; height: 2.2in; margin-top: 0.08in; }
    .qr svg { display: block; width: 100%; height: 100%; }
    .scan { font-size: 9.5pt; font-weight: 700; }
    ul { align-self: stretch; margin: 0.09in 0 0; padding: 0.08in 0 0; border-top: 0.75pt solid #d2d9ce; list-style: none; font-size: 9.5pt; line-height: 1.42; }
    footer { padding: 0.07in 0.28in 0.14in; font-size: 9pt; font-weight: 700; line-height: 1.35; text-align: center; }
    footer span { color: #58685d; font-size: 7.5pt; font-weight: 400; }
  </style></head><body>${card.repeat(4)}</body></html>`;
}

async function buildCards() {
  const { stays } = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'trails', 'public', 'data', 'stays.json'), 'utf8'));
  fs.mkdirSync(OUTPUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Error correction M leaves the code big enough to scan, and still readable with a smudge or a crease.
  for (const stay of [null, ...stays]) {
    const qrSvg = await QRCode.toString(cardUrl(stay), { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    await page.setContent(sheetHtml(cardPlace(stay), qrSvg));
    await page.pdf({ path: path.join(OUTPUT, `${stay ? stay.id : 'all-towns'}.pdf`), width: '8.5in', height: '11in', printBackground: true, pageRanges: '1' });
  }
  await browser.close();
  console.log(`Wrote ${stays.length + 1} sheets to ${path.relative(ROOT, OUTPUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildCards();
