import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const dir = dirname(fileURLToPath(import.meta.url));
const dist = join(dir, "dist");
const watch = process.argv.includes("--watch");
const gatewayUrl = process.env.MUZE_GATEWAY_URL?.trim() ?? "";

const common = {
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
  absWorkingDir: dir,
  jsx: "automatic",
  jsxImportSource: "preact",
  define: {
    __MUZE_GATEWAY_URL__: JSON.stringify(gatewayUrl),
  },
};

const bundles = [
  { entryPoints: [join(dir, "src/service-worker.ts")], outfile: join(dist, "service-worker.js") },
  { entryPoints: [join(dir, "dashboard/main.tsx")], outfile: join(dist, "dashboard.js") },
  { entryPoints: [join(dir, "src/offscreen.ts")], outfile: join(dist, "offscreen.js") },
  // The page observer is injected as a classic script into the page's MAIN
  // world, so it must not be a module.
  { format: "iife", entryPoints: [join(dir, "src/content/observer.ts")], outfile: join(dist, "observer.js") },
  { format: "iife", entryPoints: [join(dir, "src/content/page-agent.ts")], outfile: join(dist, "page-agent.js") },
];

const staticFiles = [
  ["manifest.json", "manifest.json"],
  ["dashboard/index.html", "index.html"],
  ["offscreen.html", "offscreen.html"],
  ["dashboard/styles.css", "styles.css"],
  ["icons/icon16.png", "icons/icon16.png"],
  ["icons/icon32.png", "icons/icon32.png"],
  ["icons/icon48.png", "icons/icon48.png"],
  ["icons/icon128.png", "icons/icon128.png"],
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  // --watch actually watches: each bundle gets an esbuild context that
  // rebuilds on source change. (Previously this flag only printed "rebuild
  // by re-running build.mjs" and built once.) Static files are copied once
  // at startup; editing manifest.json, index.html or styles.css still needs
  // a re-run, because esbuild does not watch non-bundled copies.
  const contexts = [];
  for (const bundle of bundles) {
    const ctx = await context({ ...common, ...bundle });
    await ctx.watch();
    contexts.push(ctx);
  }
  for (const [from, to] of staticFiles) {
    await cp(join(dir, from), join(dist, to));
  }
  console.log("extension: watching for changes (bundles rebuild on save; static files need a re-run)");
  // Keep the process alive until interrupted; esbuild watchers run on the
  // event loop, but an explicit wait makes the intent (and Ctrl-C exit) clear.
  await new Promise(() => {});
} else {
  for (const bundle of bundles) {
    await build({ ...common, ...bundle });
  }
  for (const [from, to] of staticFiles) {
    await cp(join(dir, from), join(dist, to));
  }
}
