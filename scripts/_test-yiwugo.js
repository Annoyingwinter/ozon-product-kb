const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main() {
  const r = await fetch("https://en.yiwugo.com/product/list.html?keyword=storage+box&cpage=1", {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  const html = await r.text();

  // Find product card structure
  const detailIdx = html.indexOf("product/detail/");
  if (detailIdx > 0) {
    console.log("=== Card HTML (800 chars before first product link) ===");
    console.log(html.slice(Math.max(0, detailIdx - 800), detailIdx + 300).replace(/\s+/g, " ").slice(0, 600));
  }

  // Find product titles in <a> tags linking to detail pages
  const re = /<a[^>]*href="[^"]*product\/detail\/(\d+)\.html"[^>]*title="([^"]+)"/g;
  const matches = [...html.matchAll(re)];
  console.log("\n=== Title+ID from <a title> (" + matches.length + " found) ===");
  for (const m of matches.slice(0, 5)) {
    console.log("  id=" + m[1] + " title=" + m[2].slice(0, 60));
  }

  // Alternative: find titles in text content of <a>
  const re2 = /<a[^>]*href="[^"]*product\/detail\/(\d+)\.html"[^>]*>\s*([^<]{8,120})\s*<\/a>/g;
  const matches2 = [...html.matchAll(re2)];
  console.log("\n=== Title from <a> text (" + matches2.length + " found) ===");
  for (const m of matches2.slice(0, 5)) {
    console.log("  id=" + m[1] + " text=" + m[2].trim().slice(0, 60));
  }

  // Price patterns
  const priceRe = /CN[\u00a5¥]\s*([\d,.]+)/g;
  const priceMatches = [...html.matchAll(priceRe)];
  console.log("\n=== Prices (" + priceMatches.length + ") ===");
  console.log(priceMatches.slice(0, 6).map(m => m[0]));

  // Image patterns
  const imgRe = /data-original="([^"]+)"/g;
  const imgMatches = [...html.matchAll(imgRe)];
  console.log("\n=== Lazy images (" + imgMatches.length + ") ===");
  console.log(imgMatches.slice(0, 3).map(m => m[1].slice(0, 80)));
}
main();
