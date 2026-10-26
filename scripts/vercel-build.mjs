// Produces a Vercel Build Output (v3) in .vercel/output from the regular build:
//   static/              the web app (served from Vercel's CDN)
//   functions/api.func/  one Node.js function for /api, /hooks, /mcp, /metrics
//   config.json          routes, security headers and the daily cron
// Run after `npm run build` (see `npm run build:vercel`). Vercel uses this
// output as-is, so what you test locally is exactly what gets deployed.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// esbuild is a dependency of the server workspace.
const { build } = await import(pathToFileURL(createRequire(join(root, "apps/server/package.json")).resolve("esbuild")).href);
const out = join(root, ".vercel/output");
const fn = join(out, "functions/api.func");
const webDist = join(root, "apps/web/dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error("apps/web/dist is missing: run `npm run build` first.");

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// 1. Static web app.
cpSync(webDist, join(out, "static"), { recursive: true });

// 2. The function: one self-contained ESM bundle (no node_modules needed at runtime).
await build({
  entryPoints: [join(root, "apps/server/src/vercel.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  minifySyntax: true,
  legalComments: "none",
  // Optional native/runtime-specific modules that are never used on Vercel. PGlite
  // (the embedded local database) is excluded: production requires DATABASE_URL.
  external: ["pg-native", "cloudflare:sockets", "bufferutil", "utf-8-validate", "@electric-sql/pglite"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
cpSync(join(root, "apps/server/src/db/migrations"), join(fn, "migrations"), { recursive: true });
writeFileSync(
  join(fn, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      // Keep request bodies untouched: webhook signatures are verified against the raw bytes.
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 60,
      memory: 1024,
    },
    null,
    2,
  ),
);

// 3. Routing, headers and cron.
const csp = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};
const config = {
  version: 3,
  routes: [
    { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
    { src: "^/(.*)$", headers: securityHeaders, continue: true },
    // Server-owned paths go to the function (it sets its own headers and CSP).
    { src: "^/(api|hooks|mcp|metrics)(/.*)?$", dest: "/api" },
    { handle: "filesystem" },
    // Single-page app fallback (including public forms at /f/:slug).
    { src: "^/(.*)$", dest: "/index.html", headers: { "content-security-policy": csp, "cache-control": "no-cache" } },
  ],
  // Hobby plans allow one cron run per day; the scheduled GitHub Action
  // (.github/workflows/queue-tick.yml) calls the same endpoint every 5 minutes.
  crons: [{ path: "/api/internal/tick", schedule: "0 3 * * *" }],
};
writeFileSync(join(out, "config.json"), JSON.stringify(config, null, 2));
console.log("Vercel build output written to .vercel/output");
