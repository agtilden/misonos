import http from "node:http";
import { PhishApi } from "./api.js";
import { PhishBrowser } from "./browse.js";
import { encodeId } from "./ids.js";
import type { PhishConfig } from "./config.js";

export function createServer(config: PhishConfig): http.Server {
  const api = new PhishApi(config);
  const browser = new PhishBrowser(api);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "phish-in",
          name: config.serviceName,
          description: "Phish concert recordings from phish.in",
          rootId: encodeId({ kind: "root" })
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const id = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        try {
          return sendJson(response, 200, await browser.browse(id));
        } catch (error) {
          return sendJson(response, 400, { error: errorMessage(error) });
        }
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        try {
          return sendJson(response, 200, await browser.track(id));
        } catch (error) {
          return sendJson(response, 502, { error: errorMessage(error) });
        }
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, { error: errorMessage(error) });
    }
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Internal error";
}
