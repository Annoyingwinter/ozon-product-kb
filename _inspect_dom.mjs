import { chromium } from "playwright";
import path from "node:path";

const storageState = path.resolve("output", "alphashop-ozon-2026-03-18T07-32-31.229Z.storage-state.json");
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--no-proxy-server"], ignoreDefaultArgs: ["--enable-automation"] }).catch(() => chromium.launch({ headless: true, args: ["--no-proxy-server"], ignoreDefaultArgs: ["--enable-automation"] }));
const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 1200 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await page.goto("https://www.alphashop.cn/select-product/general-agent", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(6000);
const result = await page.evaluate(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const cssPath = (el) => {
    if (!(el instanceof Element)) return "";
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let sel = el.nodeName.toLowerCase();
      if (el.id) {
        sel += `#${el.id}`;
        parts.unshift(sel);
        break;
      }
      if (el.classList.length) sel += "." + [...el.classList].slice(0,4).join(".");
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.nodeName === el.nodeName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el)+1})`;
      }
      parts.unshift(sel);
      el = parent;
    }
    return parts.join(" > ");
  };

  const inputs = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].filter(isVisible).map(el => ({
    tag: el.tagName,
    cls: el.className,
    text: text(el).slice(0,120),
    placeholder: el.getAttribute("placeholder") || "",
    rect: el.getBoundingClientRect().toJSON(),
    path: cssPath(el),
  }));

  const all = [...document.querySelectorAll('button, [role="button"], div, span')].filter(isVisible);
  const candidates = all.map(el => ({
    tag: el.tagName,
    cls: el.className || "",
    text: text(el).slice(0,80),
    title: el.getAttribute("title") || "",
    aria: el.getAttribute("aria-label") || "",
    rect: el.getBoundingClientRect().toJSON(),
    hasSvg: !!el.querySelector('svg, img, i'),
    path: cssPath(el),
  })).filter(x => x.hasSvg || x.text || x.aria || x.title);

  const bottomRight = candidates
    .filter(x => x.rect.width >= 20 && x.rect.width <= 90 && x.rect.height >= 20 && x.rect.height <= 90)
    .sort((a,b) => (b.rect.top + b.rect.left) - (a.rect.top + a.rect.left))
    .slice(0, 25);

  return { url: location.href, inputs, bottomRight };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
