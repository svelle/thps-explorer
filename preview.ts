import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "dist");

function parsePort(): number {
  const i = process.argv.indexOf("--port");
  if (i !== -1 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = process.env.PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 8080;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".map")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

if (!existsSync(ROOT)) {
  console.error(`Missing ${ROOT}. Run bun run build first.`);
  process.exit(1);
}

const PORT = parsePort();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\0")) {
      return new Response("Bad Request", { status: 400 });
    }

    const rel = pathname === "/" || pathname === "" ? "index.html" : pathname.slice(1).replace(/^\/+/, "");
    const filePath = resolve(ROOT, rel);
    const relToRoot = relative(ROOT, filePath);
    if (relToRoot.startsWith("..")) {
      return new Response("Not Found", { status: 404 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(file, {
      headers: { "Content-Type": contentType(filePath) },
    });
  },
});

console.log(`Serving ${ROOT}`);
console.log(`Open: http://127.0.0.1:${PORT}/`);
console.log("Ctrl+C to stop");
