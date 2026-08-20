import * as http from "http";
import type { AddressInfo } from "net";

/**
 * Minimal reverse proxy placed in front of a project's dev server.
 *
 * Why not iframe `http://localhost:<devPort>` directly? A generated app can
 * set `X-Frame-Options` / `Content-Security-Policy: frame-ancestors`, which
 * would stop the preview iframe from rendering. The proxy strips those
 * framing headers on the way back. It also gives us one stable place to sit
 * in front of the dev server later (error overlay, request logging) without
 * touching the app's own code.
 *
 * HMR is a WebSocket, so `upgrade` requests must be forwarded too — otherwise
 * live edits (the whole point of the preview) stop refreshing.
 *
 * ponytail: stdlib http reverse proxy, ~50 lines. Swap in `http-proxy` only if
 * we outgrow this (retries, load balancing, path rewriting).
 */

const STRIP_HEADERS = ["x-frame-options", "content-security-policy"];

export interface DevProxy {
  /** The proxy's own port; iframe `http://localhost:<port>`. */
  port: number;
  close: () => void;
}

export function startProxy(target: { host: string; port: number }): Promise<DevProxy> {
  const server = http.createServer((req, res) => {
    const proxyReq = http.request(
      {
        host: target.host,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        for (const h of STRIP_HEADERS) delete headers[h];
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("proxy error");
    });
    req.pipe(proxyReq);
  });

  // Forward WebSocket upgrades (Next.js HMR) so live edits keep refreshing.
  server.on("upgrade", (req, socket, head) => {
    const proxyReq = http.request({
      host: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      const headerLines = Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\r\n");
      socket.write(statusLine + headerLines + "\r\n\r\n");
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
    });
    proxyReq.on("error", () => socket.destroy());
    if (head && head.length) proxyReq.write(head);
    proxyReq.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

// ponytail self-check: `node dist/proxy.js` — target server behind proxy,
// asserts body passes through and framing headers are stripped.
if (require.main === module) {
  void (async () => {
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      });
      res.end("hello via proxy");
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = (origin.address() as AddressInfo).port;

    const proxy = await startProxy({ host: "127.0.0.1", port: originPort });
    const resp = await fetch(`http://127.0.0.1:${proxy.port}/`);
    const body = await resp.text();

    if (body !== "hello via proxy") throw new Error(`body mismatch: ${body}`);
    if (resp.headers.get("x-frame-options")) throw new Error("x-frame-options not stripped");
    if (resp.headers.get("content-security-policy")) throw new Error("csp not stripped");

    proxy.close();
    origin.close();
    console.log("proxy self-check OK");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
