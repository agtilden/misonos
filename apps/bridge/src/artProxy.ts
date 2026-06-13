import type http from "node:http";
import { Readable } from "node:stream";

const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const RESPONSE_HEADERS_PASSTHROUGH = new Set([
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "last-modified"
]);

// Fetch album art (typically hosted on a Sonos speaker's LAN address) and pipe
// it back through the bridge so any client that can reach the bridge can load
// it — without needing direct LAN access to the speaker.
export async function proxyArt(target: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return fail(response, 400, "Invalid art url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(response, 400, "Unsupported art url");
  }

  const isHead = request.method === "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: isHead ? "HEAD" : "GET",
      headers: { accept: "image/*,*/*", "user-agent": BROWSER_USER_AGENT },
      redirect: "follow"
    });
  } catch (error) {
    return fail(response, 502, error instanceof Error ? error.message : "Art fetch failed");
  }

  const downstreamHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=86400"
  };
  for (const [key, value] of upstream.headers.entries()) {
    if (RESPONSE_HEADERS_PASSTHROUGH.has(key.toLowerCase())) downstreamHeaders[normalizeHeader(key)] = value;
  }

  response.writeHead(upstream.status, downstreamHeaders);
  if (isHead || !upstream.body) {
    response.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.on("error", () => {
    if (!response.writableEnded) response.end();
  });
  const cleanup = () => {
    if (!nodeStream.destroyed) nodeStream.destroy();
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
  nodeStream.pipe(response);
}

function fail(response: http.ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  const body = JSON.stringify({ error: message });
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function normalizeHeader(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");
}
