import fs from "node:fs";
import path from "node:path";

const root = "C:/Users/More/Desktop/desktop agent/_tmp_openclaw_202613/package/dist";
const target = "@mariozechner/pi-ai/oauth";
const replacement = "@mariozechner/pi-ai/oauth/index.cjs";

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
    const text = fs.readFileSync(full, "utf8");
    if (!text.includes(target)) continue;
    fs.writeFileSync(full, text.split(target).join(replacement), "utf8");
    console.log(`patched ${full}`);
  }
}

walk(root);
