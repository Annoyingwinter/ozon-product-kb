import { chromium } from "playwright";
import path from "node:path";

const storageState = path.resolve("output", "alphashop-ozon-2026-03-18T07-32-31.229Z.storage-state.json");
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--no-proxy-server"], ignoreDefaultArgs: ["--enable-automation"] }).catch(() => chromium.launch({ headless: true, args: ["--no-proxy-server"], ignoreDefaultArgs: ["--enable-automation"] }));
const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 1200 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await page.goto("https://www.alphashop.cn/select-product/general-agent", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(6000);
const buttonState = async (label) => {
  const send = page.locator('button[class*="sendButton--"]').first();
  return {
    label,
    count: await send.count(),
    disabled: await send.evaluate(el => ({ disabled: el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), className: el.className, text: el.textContent })).catch(() => null)
  };
};
const states = [];
states.push(await buttonState('initial'));
const input = page.locator('div[class*="textInput--"]').last();
await input.click();
await page.keyboard.type('test', { delay: 20 });
await page.waitForTimeout(500);
states.push(await buttonState('after_type_test'));
await page.keyboard.press('Control+A').catch(() => {});
await page.keyboard.press('Backspace').catch(() => {});
await page.waitForTimeout(300);
await input.click();
await input.evaluate((el) => { el.textContent = 'hello world'; el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'hello world' })); });
await page.waitForTimeout(500);
states.push(await buttonState('after_eval_input'));
console.log(JSON.stringify(states, null, 2));
await browser.close();
