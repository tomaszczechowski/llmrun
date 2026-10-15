import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { guardRequest } from "./http.js";

let server: Server;
let port: number;

beforeEach(async () => {
    server = createServer((req, res) => {
        if (!guardRequest(req, res)) return;
        res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
});

/** Raw request so we can set Host/Origin freely (fetch forbids overriding Host). */
function send(opts: { method?: string; path?: string; headers?: Record<string, string> }): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: "127.0.0.1",
                port,
                method: opts.method ?? "GET",
                path: opts.path ?? "/api/deployments",
                headers: opts.headers,
            },
            (res) => {
                res.resume();
                resolve(res.statusCode!);
            }
        );

        req.on("error", reject);
        req.end(opts.method === "POST" ? "{}" : undefined);
    });
}

const JSON_CT = { "content-type": "application/json" };

describe("guardRequest", () => {
    it.each(["127.0.0.1", "127.0.0.1:4173", "localhost:4173", "LOCALHOST", "[::1]:4173"])(
        "allows Host %s",
        async (host) => {
            expect(await send({ headers: { host } })).toBe(200);
        }
    );

    it.each([
        "evil.example",
        "evil.example:4173",
        "127.0.0.1.evil.example",
        "localhost.evil.example:80",
        "10.0.0.5:4173",
    ])("rejects a rebinding Host %s", async (host) => {
        expect(await send({ headers: { host } })).toBe(403);
    });

    it("allows loopback Origins on any port (Vite dev proxy) and no Origin", async () => {
        expect(await send({ headers: { host: "localhost:5173", origin: "http://localhost:5173" } })).toBe(200);
        expect(await send({ headers: { host: "127.0.0.1", origin: "http://127.0.0.1:4173" } })).toBe(200);
        expect(await send({ headers: { host: "127.0.0.1", origin: "http://[::1]:4173" } })).toBe(200);
    });

    it.each(["https://evil.example", "http://127.0.0.1.evil.example", "null", "not a url"])(
        "rejects cross-site Origin %s",
        async (origin) => {
            expect(
                await send({
                    method: "POST",
                    path: "/api/deployments/x/chat",
                    headers: { host: "127.0.0.1", origin, ...JSON_CT },
                })
            ).toBe(403);
            expect(
                await send({
                    method: "DELETE",
                    path: "/api/deployments/x/conversations/c",
                    headers: { host: "127.0.0.1", origin },
                })
            ).toBe(403);
        }
    );

    it("requires application/json for chat and actions (no preflight-free text/plain)", async () => {
        const h = { host: "127.0.0.1" };

        expect(
            await send({
                method: "POST",
                path: "/api/deployments/x/chat",
                headers: { ...h, "content-type": "text/plain" },
            })
        ).toBe(415);
        expect(await send({ method: "POST", path: "/api/deployments/x/actions", headers: h })).toBe(415);
        expect(
            await send({
                method: "POST",
                path: "/api/deployments/x/chat?y=1",
                headers: { ...h, "content-type": "text/plain" },
            })
        ).toBe(415);
        expect(
            await send({
                method: "POST",
                path: "/api/deployments/x/chat",
                headers: { ...h, "content-type": "application/json; charset=utf-8" },
            })
        ).toBe(200);
        expect(await send({ method: "POST", path: "/api/deployments/x/actions", headers: { ...h, ...JSON_CT } })).toBe(
            200
        );
    });

    it("doesn't demand JSON for body-less POSTs like creating a conversation", async () => {
        expect(
            await send({ method: "POST", path: "/api/deployments/x/conversations", headers: { host: "127.0.0.1" } })
        ).toBe(200);
    });
});
