import fs from "node:fs";
import path from "node:path";

const root = "C:/Users/More/Desktop/desktop agent/_tmp_openclaw_202613/package";
const globalNodeModules = "C:/Users/More/AppData/Roaming/npm/node_modules/openclaw/node_modules";

function loadDeps(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.entries(json.dependencies ?? {});
}

function exists(modName) {
  if (modName.startsWith("@")) {
    const [scope, name] = modName.split("/");
    return fs.existsSync(path.join(globalNodeModules, scope, name));
  }
  return fs.existsSync(path.join(globalNodeModules, modName));
}

const files = [
  path.join(root, "package.json"),
  path.join(root, "extensions/feishu/package.json"),
  path.join(root, "extensions/zalo/package.json"),
];

for (const file of files) {
  console.log(`FILE ${file}`);
  for (const [name, version] of loadDeps(file)) {
    if (!exists(name)) {
      console.log(`  MISSING ${name}@${version}`);
    }
  }
}
