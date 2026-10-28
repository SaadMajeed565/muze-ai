import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionDir = join(root, "extension");
const dist = join(extensionDir, "dist");
const releaseDir = join(root, "release");
const manifestPath = join(dist, "manifest.json");

// Packaging must never ship a stale contract copy: sync and verify first,
// even when this script is run directly instead of via the root package script.
try {
  execFileSync("node", [join(root, "scripts/sync-tool-contracts.mjs")], { stdio: "inherit" });
  execFileSync("node", [join(root, "scripts/check-tool-contracts.mjs")], { stdio: "inherit" });
} catch {
  console.error("tool contracts are not in sync; refusing to package");
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  console.error("extension/dist is missing; run `npm --prefix extension run build` first");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageJson = JSON.parse(await readFile(join(extensionDir, "package.json"), "utf8"));
if (manifest.version !== packageJson.version) {
  console.error(`version mismatch: manifest=${manifest.version} package=${packageJson.version}`);
  process.exit(1);
}
for (const forbidden of ["key", "update_url"]) {
  if (forbidden in manifest) {
    console.error(`refusing to package manifest with forbidden field: ${forbidden}`);
    process.exit(1);
  }
}

await mkdir(releaseDir, { recursive: true });
const output = join(releaseDir, `muze-ai-extension-${manifest.version}.zip`);
await rm(output, { force: true });

try {
  execFileSync("zip", ["-qr", "-X", output, ".", "-x", "*.map"], { cwd: dist, stdio: "inherit" });
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("the `zip` command is required to package the extension");
    process.exit(1);
  }
  throw error;
}

console.log(`packaged ${output}`);
