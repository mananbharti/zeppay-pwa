import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4179, URL = process.env.TARGET_URL || `http://localhost:${PORT}/`;
const srv = process.env.TARGET_URL ? { kill(){} } : spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const SHOTS = process.env.SHOTS === '1';
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], headless: 'new' });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fresh(opts = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (opts.dark) await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  p.on('pageerror', (e) => { fail++; console.log('  FAIL pageerror ' + e.message); });
  await p.goto(URL); await wait(300);
  return p;
}
const clickText = (p, re, sel = 'button') => p.evaluate((src, sel) => { const r = new RegExp(src, 'i'); const el = [...document.querySelectorAll(sel)].find((e) => r.test(e.textContent) || r.test(e.getAttribute('aria-label') || '')); if (el) el.click(); return !!el; }, re.source, sel);
const has = (p, re) => p.evaluate((src) => new RegExp(src, 'i').test(document.body.innerText), re.source);
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `docs/screenshots/${name}.png` }); };
const retype = async (p, sel, text) => { await p.focus(sel); await p.$eval(sel, (e) => e.select()); await p.keyboard.press('Backspace'); await p.type(sel, text); };
const type = async (p, sel, text) => { await p.click(sel); await p.type(sel, text); };
const pin = async (p, digits) => { for (const d of digits) { await clickText(p, new RegExp('^' + d + '$')); await wait(30); } };
async function toHome(p) { await clickText(p, /^Skip$/); await wait(300); }

console.log('Onboarding');
let p = await fresh();
ok(await has(p, /Pay with zero data/), 'first slide shown');
await shot(p, '01-welcome');
await clickText(p, /^Next/); await wait(200);
ok(await has(p, /Scan\. Confirm\. Zep\./), 'second slide');
await clickText(p, /^Next/); await clickText(p, /Get started/); await wait(300);
ok(await has(p, /Pay anyone with a UPI ID/), 'lands on home');
ok(await p.evaluate(() => localStorage.getItem('zep.onboarded') === 'true'), 'onboarded persisted');
await p.reload(); await wait(300);
ok(await has(p, /People & places/), 'skips onboarding after reload');
await shot(p, '02-home');

console.log('Pay flow (demo success)');
await clickText(p, /Pay Aarav/); await wait(300);
ok(await p.$eval('[data-testid=payee-vpa]', (e) => e.textContent) === 'aarav.sharma@okaxis', 'payee prefilled');
ok(await p.$eval('.sheet-foot .btn', (e) => e.disabled), 'Pay disabled initially');
await type(p, 'input[aria-label=Amount]', '5001'); await wait(100);
ok(await has(p, /up to ₹5,000/), 'over-limit error');
await retype(p, 'input[aria-label=Amount]', '250');
ok(await p.$eval('.sheet-foot .btn', (e) => e.disabled), 'still disabled until payee confirmed');
await p.click('.check input'); await wait(100);
await shot(p, '03-pay');
ok(!(await p.$eval('.sheet-foot .btn', (e) => e.disabled)), 'Pay enabled after confirm');
await p.click('.sheet-foot .btn'); await wait(2400);
ok(await has(p, /Enter UPI PIN/), 'PIN prompt after simulated steps');
await shot(p, '04-pin');
await pin(p, '12345'); ok((await p.$$eval('.pins i.f', (e) => e.length)) === 5, 'pin dots fill');
await pin(p, '6'); await wait(2200);
ok(await has(p, /Payment successful/), 'success outcome');
await shot(p, '05-success');
await clickText(p, /View receipt/); await wait(300);
ok(await has(p, /₹250/) && await has(p, /Demo simulation/), 'receipt shows amount + mode');
await shot(p, '06-receipt');
await clickText(p, /^Close$/); await wait(200);
ok(await p.$eval('[data-testid=balance]', (e) => e.textContent) === '₹12,230.50', 'demo balance debited');
await clickText(p, /^History$/); await wait(300);
ok(await has(p, /Aarav Sharma/) && await has(p, /Today/), 'history entry');
await shot(p, '07-history');
await p.reload(); await wait(300); await clickText(p, /^History$/); await wait(200);
ok(await has(p, /Aarav Sharma/), 'history persists');

console.log('Failure path');
await clickText(p, /^Home$/); await wait(200); await clickText(p, /Pay Priya/); await wait(300);
await type(p, 'input[aria-label=Amount]', '40'); await p.click('.check input');
await p.click('.sheet-foot .btn'); await wait(2400); await pin(p, '000000'); await wait(2200);
ok(await has(p, /Payment failed/) && await has(p, /Incorrect UPI PIN/), 'wrong PIN fails');
ok(await p.evaluate(() => JSON.parse(localStorage.getItem('zep.demoBalance')) === 12230.5), 'failed payment does not debit');
await shot(p, '08-failed');
await clickText(p, /Try again/); await wait(300);
ok(await has(p, /Priya Singh/), 'try again returns to pay form');
await clickText(p, /^Back$/); await wait(200);

console.log('Balance check');
await clickText(p, /^Balance$/); await wait(2400); await pin(p, '123456'); await wait(2400);
ok(await has(p, /₹12,230\.50/), 'balance shown');
await clickText(p, /^Done$/);

console.log('UPI ID entry');
await clickText(p, /To UPI ID/); await wait(200);
await type(p, 'input[aria-label="UPI ID"]', 'bad'); ok(await has(p, /name@bank/), 'invalid shows hint');
await retype(p, 'input[aria-label="UPI ID"]', 'test.user@okaxis');
await p.keyboard.press('Enter'); await wait(300);
ok(await p.$eval('[data-testid=payee-vpa]', (e) => e.textContent) === 'test.user@okaxis', 'manual UPI ID opens pay form');
await clickText(p, /^Back$/);

console.log('Scan via QR image upload');
const link = 'upi://pay?pa=chaiwala@paytm&pn=Sharma%20Tea%20Stall&am=35&tn=chai';
await QRCode.toFile('/tmp/zep-qr.png', link, { width: 500, margin: 2 });
await clickText(p, /Scan any QR/); await wait(500);
await shot(p, '09-scan');
const inp = await p.$('[data-testid=qr-file]'); await inp.uploadFile('/tmp/zep-qr.png'); await wait(900);
ok(await p.$eval('[data-testid=payee-vpa]', (e) => e.textContent) === 'chaiwala@paytm', 'QR decoded to payee');
ok(await has(p, /Sharma Tea Stall/), 'payee name from QR');
ok(await p.$eval('input[aria-label=Amount]', (e) => e.value) === '35', 'amount from QR');
await clickText(p, /^Back$/);
await clickText(p, /Scan any QR/); await wait(300);
await type(p, 'input[aria-label="Paste UPI ID or link"]', 'https://evil.example'); await p.keyboard.press('Enter'); await wait(300);
ok(await has(p, /Not a UPI QR/), 'non-UPI text rejected');
await clickText(p, /^Close$/);

console.log('My QR');
await clickText(p, /^My QR$/); await wait(500);
ok(await p.$eval('.qrcard img', (e) => e.src.startsWith('data:image/png')), 'QR rendered');
await shot(p, '10-myqr');
await clickText(p, /^Close$/);

console.log('Settings: theme, carrier, live mode');
await clickText(p, /^Settings$/); await wait(300);
await shot(p, '11-settings');
await clickText(p, /^Dark$/); await wait(200);
ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark theme applied');
await clickText(p, /^Light$/); ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'light', 'light theme applied');
await clickText(p, /^Live/); await clickText(p, /^Jio$/); await wait(200);
ok(await has(p, /doesn't support \*99#/), 'Jio warning in settings');
await clickText(p, /^Home$/); await wait(200);
ok(await has(p, /Jio doesn't support/), 'Jio warning on home');
await clickText(p, /Pay Aarav/); await wait(300);
await type(p, 'input[aria-label=Amount]', '100'); await p.click('.check input');
ok(await has(p, /Your carrier is set to Jio/), 'live+Jio blocks payment');
ok(await p.$eval('.sheet-foot .btn', (e) => e.disabled), 'Pay disabled on Jio live');
await clickText(p, /^Back$/);
await clickText(p, /^Settings$/); await clickText(p, /^Airtel$/); await wait(200);
await clickText(p, /^Home$/); await wait(200); await clickText(p, /Pay Aarav/); await wait(300);
await type(p, 'input[aria-label=Amount]', '100'); await p.click('.check input');
await p.click('.sheet-foot .btn'); await wait(500);
ok(await has(p, /Continue in your dialer/), 'live mode shows dialer handoff');
await shot(p, '12-live');
ok(await has(p, /\*99\*1\*3#/), 'shows *99*1*3# code');
await p.close();

console.log('Dark mode / auto');
p = await fresh({ dark: true });
ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'auto follows system dark');
await toHome(p); await shot(p, '13-home-dark'); await p.close();

console.log('PWA assets');
const man = await (await fetch(URL + 'manifest.webmanifest')).json();
ok(man.display === 'standalone' && man.icons.length >= 3, 'manifest valid');
for (const i of man.icons) ok((await fetch(URL + i.src)).ok, 'icon ' + i.src);
ok((await fetch(URL + 'sw.js')).ok, 'service worker served');
p = await fresh(); await wait(1200);
ok(await p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), 'service worker registered');
await p.setOfflineMode(true); await p.reload(); await wait(600);
ok(await has(p, /Pay with zero data|People & places/), 'app loads fully offline');
await p.close();

await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
