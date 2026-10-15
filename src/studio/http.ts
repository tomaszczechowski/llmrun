import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Response conventions shared by every studio bridge endpoint. These live here
 * rather than in server.ts so the JSON shape and the SSE framing (headers, the
 * `: connected` preamble, swallow-on-dropped-client writes) have exactly one
 * definition — the metrics/logs handlers and the chat handler must not drift.
 */

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}

/** Write one SSE frame, ignoring a client that has already gone away. */
export function safeWriteSse(res: ServerResponse, obj: unknown): void {
    if (res.writableEnded) return;
    try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
        // Client went away mid-write.
    }
}

/**
 * Open an SSE stream. `x-accel-buffering: no` and `no-transform` keep proxies
 * from buffering the stream, which would stall token-by-token chat output.
 */
export function initSse(res: ServerResponse): void {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(hostHeader: string): string {
    // "host:port" | "[::1]:port" | "host"
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase());

    return m ? m[1]! : "";
}

/**
 * Guard against browser-driven attacks on the localhost bridge. Binding to
 * 127.0.0.1 is not enough: any web page can fire requests at it, and DNS
 * rebinding makes a hostile origin resolve to 127.0.0.1.
 *
 * - `Host` must be a loopback name (rebinding arrives with the attacker's host).
 * - A present `Origin` must be a loopback origin (blocks cross-site POST/DELETE;
 *   any port, so the Vite dev server proxying to the bridge keeps working).
 * - Requests with a body (`/actions`, `/chat`) must be `application/json`, which
 *   forces a CORS preflight the bridge never approves.
 *
 * Writes the rejection and returns false when the request must not proceed.
 */
export function guardRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const host = req.headers.host;

    if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host))) {
        sendJson(res, 403, { ok: false, error: "Forbidden: unexpected Host header." });

        return false;
    }

    const origin = req.headers.origin;

    if (origin !== undefined) {
        let originHost = "";

        try {
            originHost = new URL(origin).hostname.toLowerCase();
        } catch {
            // Malformed (or the literal "null") — rejected below.
        }
        if (!LOOPBACK_HOSTS.has(originHost) && !LOOPBACK_HOSTS.has(`[${originHost}]`)) {
            sendJson(res, 403, { ok: false, error: "Forbidden: cross-origin request." });

            return false;
        }
    }

    const needsJson = req.method === "POST" && /\/(actions|chat)$/.test((req.url ?? "").split("?")[0]!);

    if (needsJson && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        sendJson(res, 415, { ok: false, error: "Content-Type must be application/json." });

        return false;
    }

    return true;
}
