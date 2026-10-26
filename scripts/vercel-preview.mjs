// Serves .vercel/output locally the way Vercel routes it: config.json routes
// (headers, the function, filesystem, SPA fallback) and the bundled function.
// For testing the exact deployment artifact without an account:
//   npm run build:vercel && DATABASE_URL=postgres://... node scripts/vercel-preview.mjs
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel/output");
const port = Number(process.env.PORT ?? 3100);
const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8"));

// What Vercel provides at runtime.
process.env.VERCEL ??= "1";
process.env.VERCEL_ENV ??= "production";
process.env.PUBLIC_URL ??= `http://127.0.0.1:${port}`;
const { default: fn } = await import(pathToFileURL(join(out, "functions/api.func/index.mjs")).href);

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
function staticFile(path) {
  const file = normalize(join(out, "static", decodeURIComponent(path)));
  if (!file.startsWith(join(out, "static")) || !existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}
function sendFile(res, file) {
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  // Vercel's edge sets the client address.
  req.headers["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
  req.headers["x-forwarded-proto"] = "http";
  for (const route of config.routes) {
    if (route.handle === "filesystem") {
      const file = path !== "/" && staticFile(path);
      if (file) return sendFile(res, file);
      continue;
    }
    if (!new RegExp(route.src).test(path)) continue;
    for (const [k, v] of Object.entries(route.headers ?? {})) res.setHeader(k, v);
    if (route.dest === "/api") return void fn(req, res);
    if (route.dest) return sendFile(res, staticFile(route.dest));
    if (!route.continue) break;
  }
  res.statusCode = 404;
  res.end("not found");
}).listen(port, "127.0.0.1", () => console.log(`Vercel output preview on http://127.0.0.1:${port}`));
