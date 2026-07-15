// Build: bundles the worker (with postal-mime) and the CLI into dist/.
// The CLI reads dist/worker.js at runtime to upload it during `setup`.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

await build({
  entryPoints: ["src/worker/index.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  define: { NPCMAIL_VERSION: JSON.stringify(pkg.version) },
  legalComments: "none",
  minify: false,
});

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  define: { NPCMAIL_VERSION: JSON.stringify(pkg.version) },
  legalComments: "none",
  minify: false,
});

console.log("built dist/worker.js and dist/cli.js");
