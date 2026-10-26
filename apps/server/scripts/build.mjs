// Bundles the server (and the workspace core package) into dist/ with esbuild.
// npm dependencies stay external and are resolved from node_modules at runtime.
import { cpSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@automation-studio/"));

rmSync(join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: {
    main: join(root, "src/main.ts"),
    worker: join(root, "src/worker.ts"),
    migrate: join(root, "src/cli/migrate.ts"),
    seed: join(root, "src/cli/seed.ts"),
    "mcp-stdio": join(root, "src/cli/mcp-stdio.ts"),
    "rotate-key": join(root, "src/cli/rotate-key.ts"),
  },
  outdir: join(root, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: [...external, ...external.map((e) => `${e}/*`)],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
cpSync(join(root, "src/db/migrations"), join(root, "dist/migrations"), { recursive: true });
console.log("server built to dist/");
