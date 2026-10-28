import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(dir, "src/index.ts")],
  outfile: join(dir, "dist/index.js"),
  absWorkingDir: dir,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
