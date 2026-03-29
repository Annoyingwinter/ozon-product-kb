const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
async function main() {
  const r = await fetch("https://en.yiwugo.com/product/list.html?keyword=storage+box&cpage=1", {
    headers: { "User-Agent": UA },
  });
  const html = await r.text();

  // Find a full product card - from product_inf div to the next one
  const cards = html.split("product_inf");
  console.log("=== Card count:", cards.length - 1);
  if (cards.length > 1) {
    // Show first card structure
    const card = cards[1].slice(0, 1200).replace(/\s+/g, " ");
    console.log("\n=== First card HTML ===");
    console.log(card);
  }

  // Try to find product names - look for class patterns
  const nameRe = /class="[^"]*(?:proname|pro_name|product.name|pro-tit|tit)[^"]*"[^>]*>([^<]+)/gi;
  const names = [...html.matchAll(nameRe)];
  console.log("\n=== Product names by class (" + names.length + ") ===");
  for (const m of names.slice(0, 5)) console.log("  " + m[1].trim().slice(0, 60));

  // Try alt text on images
  const altRe = /alt="([^"]{10,120})"/g;
  const alts = [...html.matchAll(altRe)];
  console.log("\n=== Image alts (" + alts.length + ") ===");
  for (const m of alts.slice(0, 5)) console.log("  " + m[1].slice(0, 60));

  // Find <img> with product images
  const imgRe = /src="(https?:\/\/img[^"]+)"/g;
  const imgs = [...html.matchAll(imgRe)];
  console.log("\n=== Image srcs (" + imgs.length + ") ===");
  for (const m of imgs.slice(0, 3)) console.log("  " + m[1].slice(0, 80));

  // Find productid attribute
  const pidRe = /productid="(\d+)"/g;
  const pids = [...html.matchAll(pidRe)];
  console.log("\n=== productid attrs (" + pids.length + ") ===");
  console.log(pids.slice(0, 5).map(m => m[1]));
}
main();
