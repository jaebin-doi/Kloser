const { chromium } = require('playwright');
const path = require('path');

const PAGE_URL = 'file:///' + path.resolve(__dirname, '..', 'kloser', 'platform', 'newsletter.html').replace(/\\/g, '/');
const OUT = __dirname;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()); });

  console.log('navigating to', PAGE_URL);
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // 1) initial state
  await page.screenshot({ path: path.join(OUT, '01_initial.png'), fullPage: false });
  console.log('shot 1: initial');

  // 2) click "신규 가입 환영 메일" suggested prompt → triggers AI draft
  await page.getByRole('button', { name: '신규 가입 환영 메일' }).click();
  // wait for draft card to appear (typing 1s + appendDraft 600ms)
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(OUT, '02_draft_generated.png'), fullPage: false });
  console.log('shot 2: draft generated');

  // 3) click 발송 button on the draft card
  await page.locator('.send-btn').last().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '03_send_modal.png'), fullPage: false });
  console.log('shot 3: send modal open');

  // 4) select VIP group (radio input is hidden, click the label instead)
  await page.locator('label.recipient-opt:has(input[value="487"])').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '04_modal_vip_selected.png'), fullPage: false });
  console.log('shot 4: VIP selected');

  // 5) select 예약 발송
  await page.locator('label:has(input[name="when"][value="scheduled"])').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '05_modal_scheduled.png'), fullPage: false });
  console.log('shot 5: scheduled mode');

  // 6) back to 지금 발송, then click 발송 to start sending
  await page.locator('label:has(input[name="when"][value="now"])').click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /명에게 발송/ }).click();
  // capture mid-progress (around 50%)
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '06_sending.png'), fullPage: false });
  console.log('shot 6: sending in progress');

  // 7) wait for completion (1.8s total + 380ms transition)
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(OUT, '07_complete.png'), fullPage: false });
  console.log('shot 7: complete');

  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
