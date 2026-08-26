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

/**
 * Click-to-select bridge, injected into every previewed HTML page (see below).
 * Runs inside the cross-origin dev-server iframe; talks to the host only over
 * `postMessage`. M1: arm/disarm on `mc:set-mode`, post hover/select with a
 * rect + tag.class label, and swallow clicks while armed so links/buttons
 * don't navigate. Source resolution + chat wiring land in later milestones.
 */
const BRIDGE_JS = `(() => {
  let enabled = false, last = null, selectedEl = null;
  // Act when the toolbar armed us, or on Alt-held for a quick one-off pick.
  const armed = (e) => enabled || e.altKey;
  const post = (m) => parent.postMessage(m, "*");
  const classesOf = (el) =>
    (typeof el.className === "string" ? el.className.trim().split(/\\s+/) : []).filter(Boolean);
  const label = (el) => {
    const c = classesOf(el).slice(0, 3);
    return el.tagName.toLowerCase() + (c.length ? "." + c.join(".") : "");
  };
  // The element's OWN text (direct text nodes) — not textContent, which
  // concatenates every descendant. A wrapper's textContent starts with its
  // children's text, so it anchors the codegen to the wrong (nested) element.
  const ownText = (el) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join("")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 160);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  // Our Babel plugin (dev only) stamps every host element with
  // data-mc-loc="path:line:col". Walk up to the nearest stamped node = the
  // element the user meant. (Next's SWC does not populate fiber _debugSource,
  // so a build-time attribute is the reliable source-of-truth.)
  const inspect = (el) => {
    const node = el.closest && el.closest("[data-mc-loc]");
    if (node) {
      const m = /^(.*):(\\d+):(\\d+)$/.exec(node.getAttribute("data-mc-loc") || "");
      if (m) return { source: { path: m[1], line: +m[2], column: +m[3] } };
    }
    return {};
  };
  addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.type === "mc:set-mode") {
      enabled = !!d.enabled;
      last = null;
      if (!enabled) post({ type: "mc:leave" });
    }
  });
  addEventListener("pointermove", (e) => {
    if (!armed(e)) return;
    const el = e.target;
    if (!(el instanceof Element) || el === last) return;
    last = el;
    post({ type: "mc:hover", rect: rect(el), label: label(el) });
  }, true);
  addEventListener("pointerout", (e) => {
    if (enabled && !e.relatedTarget) post({ type: "mc:leave" });
  }, true);
  addEventListener("click", (e) => {
    if (!armed(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!(el instanceof Element)) return;
    selectedEl = el;
    const info = inspect(el);
    post({
      type: "mc:select",
      rect: rect(el),
      label: label(el),
      source: info.source,
      component: info.component,
      dom: { tag: el.tagName.toLowerCase(), classes: classesOf(el), text: ownText(el) },
    });
  }, true);
  // Escape clears the current selection (works while focus is inside the app).
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") { selectedEl = null; post({ type: "mc:clear" }); }
  }, true);
  // Keep the locked highlight glued to its element as the page scrolls/resizes.
  const track = () => {
    if (selectedEl && selectedEl.isConnected) post({ type: "mc:rect", rect: rect(selectedEl) });
  };
  addEventListener("scroll", track, true);
  addEventListener("resize", track);
})();`;

const BRIDGE_PATH = "/__mc/bridge.js";
const BRIDGE_TAG = `<script src="${BRIDGE_PATH}"></script>`;

export interface DevProxy {
  /** The proxy's own port; iframe `http://localhost:<port>`. */
  port: number;
  close: () => void;
}

export function startProxy(target: { host: string; port: number }): Promise<DevProxy> {
  const server = http.createServer((req, res) => {
    if (req.url === BRIDGE_PATH) {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(BRIDGE_JS);
      return;
    }
    // Force identity encoding so we can buffer + string-inject the bridge into
    // HTML without gunzip/brotli round-trips. Localhost dev server, no bandwidth
    // cost. Non-HTML responses are still streamed straight through untouched.
    const headers = { ...req.headers, "accept-encoding": "identity" };
    const proxyReq = http.request(
      {
        host: target.host,
        port: target.port,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        for (const h of STRIP_HEADERS) delete headers[h];

        const isHtml = (proxyRes.headers["content-type"] ?? "").includes("text/html");
        if (isHtml) {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (c) => chunks.push(c));
          proxyRes.on("end", () => {
            let body = Buffer.concat(chunks).toString("utf8");
            body = body.includes("</head>")
              ? body.replace("</head>", `${BRIDGE_TAG}</head>`)
              : `${BRIDGE_TAG}${body}`;
            const buf = Buffer.from(body, "utf8");
            delete headers["transfer-encoding"]; // we buffered it; send with a fresh length
            headers["content-length"] = String(buf.length);
            res.writeHead(proxyRes.statusCode ?? 502, headers);
            res.end(buf);
          });
          return;
        }

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
    const origin = http.createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>x</title></head><body>hi</body></html>");
        return;
      }
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

    // HTML gets the bridge tag injected before </head>.
    const html = await (await fetch(`http://127.0.0.1:${proxy.port}/page`)).text();
    if (!html.includes(`${BRIDGE_TAG}</head>`)) throw new Error("bridge not injected");
    // Reserved path serves the bridge script.
    const js = await fetch(`http://127.0.0.1:${proxy.port}${BRIDGE_PATH}`);
    if (!(js.headers.get("content-type") ?? "").includes("javascript"))
      throw new Error("bridge not served as js");
    if (!(await js.text()).includes("mc:set-mode")) throw new Error("bridge body wrong");

    proxy.close();
    origin.close();
    console.log("proxy self-check OK");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
