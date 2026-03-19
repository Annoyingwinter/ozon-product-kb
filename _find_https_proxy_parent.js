import { execFileSync } from "node:child_process";
import fs from "node:fs";

const pkgPath = "C:/Users/More/Desktop/desktop agent/_tmp_openclaw_202613/package/package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
  try {
    const out = execFileSync(
      "npm",
      ["view", `${name}@${version}`, "dependencies", "--json"],
      { encoding: "utf8" },
    );
    if (out.includes("https-proxy-agent")) {
      console.log(`MATCH ${name}@${version}`);
      console.log(out);
    }
  } catch (error) {
    // ignore
  }
}
