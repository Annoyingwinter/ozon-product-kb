import { chromium } from "playwright";
import path from "node:path";

const storageState = path.resolve(
  "output",
  "alphashop-ozon-2026-03-18T07-32-31.229Z.storage-state.json",
);

const prompt = [
  "你是Ozon Russia的跨境选品运营，请严格按 Ozon 的经营逻辑进行筛选。",
  "任务目标：筛选适合 Ozon 俄罗斯站的轻小件、高复购潜力、低售后、可跨境履约的商品。",
  "重点类目：家居、车品、收纳、宠物、小工具、季节型轻小件",
  "目标人群：俄罗斯本地家庭用户、车主、宠物主人、礼品消费人群",
  "硬性约束：售价区间 1000-4000 RUB，单件重量 <= 1.2 kg，最长边 <= 45 cm，低售后，低破损，低认证风险。",
  "运营判断优先级：价格带适配 > 履约与物流友好 > 毛利空间 > 竞争度 > 退货风险 > 内容传播性。",
  "请优先选择：轻小件、标准化、非强品牌依赖、图片容易表达、俄语卖点容易本地化、适合平台推荐分发的商品。",
  "请谨慎或剔除：易碎大件、复杂电子类、强认证/清关风险、尺码复杂、高退货、高售后产品。",
  "输出 8-12 个候选商品，并给出 Go/No-Go 判断。",
  "必须只输出 JSON，不要 Markdown，不要解释，不要多余文字。",
  'JSON 结构如下：{"selection_brief":{"platform":"Ozon","price_band_rub":"1000-4000","core_strategy":["..."],"warnings":["..."]},"products":[{"name":"","category":"","target_price_rub":0,"supply_price_cny":0,"est_weight_kg":0,"package_long_edge_cm":0,"fragility":"low|medium|high","certification_risk":"low|medium|high","return_risk":"low|medium|high","competition_level":"low|medium|high","content_potential":"low|medium|high","seasonality":"stable|seasonal","why_it_can_sell":"","risk_notes":["..."],"go_or_no_go":"Go|Watch|No-Go"}],"recommended_actions":["..."]}',
].join("\n");

async function main() {
  const browser = await chromium
    .launch({
      headless: false,
      channel: "msedge",
      args: ["--no-proxy-server"],
      ignoreDefaultArgs: ["--enable-automation"],
    })
    .catch(() =>
      chromium.launch({
        headless: false,
        args: ["--no-proxy-server"],
        ignoreDefaultArgs: ["--enable-automation"],
      }),
    );

  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 1200 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  await page.goto("https://www.alphashop.cn/select-product/general-agent", {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(6000);

  const input = page.locator('div[class*="textInput--"]').last();
  await input.click();
  await page.keyboard.insertText(prompt);

  await page.waitForTimeout(800);

  const sendButton = page.locator('button[class*="sendButton--"]').first();
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  const enabled = await sendButton.evaluate((element) => !element.disabled);
  if (!enabled) {
    throw new Error("Send button is still disabled after typing prompt.");
  }
  await sendButton.click();

  console.log('Clicked send button via selector: button[class*="sendButton--"]');
  console.log("Keeping browser open for inspection.");

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
