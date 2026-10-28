import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromDir = join(root, "extension/libs/tool-contracts");
const toDir = join(root, "cloudflare/libs/tool-contracts");

async function listTs(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTs(full, base)));
    else if (entry.name.endsWith(".ts")) out.push(relative(base, full));
  }
  return out;
}

async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.name.endsWith(".ts")) await cp(from, to);
  }
}

await copyTree(fromDir, toDir);
// Delete stale files: a file removed from the extension copy must not linger
// in the Cloudflare copy, or the two sides would silently diverge. This was
// previously only reported by check-tool-contracts, never fixed by sync.
const sourceFiles = new Set(await listTs(fromDir));
for (const rel of await listTs(toDir)) {
  if (!sourceFiles.has(rel)) {
    await rm(join(toDir, rel), { force: true });
    console.error(`removed stale ${rel} from cloudflare/libs/tool-contracts`);
  }
}
console.error("synced extension/libs/tool-contracts -> cloudflare/libs/tool-contracts");
