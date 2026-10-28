import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromDir = join(root, "extension/libs/tool-contracts");
const toDir = join(root, "cloudflare/libs/tool-contracts");

async function listTs(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTs(full, base)));
    else if (entry.name.endsWith(".ts")) files.push(relative(base, full));
  }
  return files.sort();
}

const expected = await listTs(fromDir);
const actual = await listTs(toDir);
const problems = [];

for (const file of expected) {
  if (!actual.includes(file)) {
    problems.push(`missing in cloudflare: ${file}`);
    continue;
  }
  const [a, b] = await Promise.all([readFile(join(fromDir, file), "utf8"), readFile(join(toDir, file), "utf8")]);
  if (a !== b) problems.push(`differs: ${file}`);
}
for (const file of actual) {
  if (!expected.includes(file)) problems.push(`extra in cloudflare: ${file}`);
}

if (problems.length > 0) {
  console.error("Tool contracts have drifted. Run `npm run sync:contracts` and commit the result.");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.error("tool contracts are in sync");
