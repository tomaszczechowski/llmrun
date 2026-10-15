import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveDeployment, loadDeployment, type DeploymentState } from "../lib/state.js";
import { loadEvents } from "../lib/history.js";
import type { InstanceInfo } from "../lib/aws.js";
import {
    abortAllChats,
    handleChat,
    handleConversationTurns,
    handleCreateConversation,
    handleDeleteConversation,
    handleListConversations,
    isChatBusy,
} from "./chat.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>;

let home: string;
let upstream: Server;
let upstreamHandler: Handler;
let upstreamBodies: any[];
let bridge: Server;
let bridgeBase: string;
let liveState: string;
let liveDelayMs = 0;
const prevHome = process.env.LLMRUN_HOME;

function listen(server: Server): Promise<number> {
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    );
}

async function readAll(req: IncomingMessage): Promise<string> {
    let s = "";

    for await (const c of req) s += c;

    return s;
}

const sse = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (content: string) => ({ choices: [{ delta: { content } }] });

function deployment(over: Partial<DeploymentState> = {}): DeploymentState {
    return {
        name: "dep",
        alias: "qwen",
        hf_repo: "Qwen/Qwen3",
        engine: "vllm",
        instanceType: "g5.xlarge",
        mode: "gpu",
        region: "us-east-1",
        localPort: (upstream.address() as AddressInfo).port,
        remotePort: 8000,
        idleTimeout: "30m",
        instanceId: "i-123",
        deploymentId: "dep-id-1",
        createdAt: new Date().toISOString(),
        forwardPid: process.pid, // "alive" port-forward, so no SSM is attempted
        ...over,
    };
}

/** Parse an SSE body into its JSON frames. */
function frames(text: string): any[] {
    return text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)));
}

async function post(body: unknown, name = "dep", signal?: AbortSignal): Promise<Response> {
    return fetch(`${bridgeBase}/chat/${name}`, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal,
    });
}

beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "llmrun-chat-"));
    process.env.LLMRUN_HOME = home;
    liveState = "running";
    liveDelayMs = 0;
    upstreamBodies = [];
    upstreamHandler = (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        sse(res, chunk("Hel"));
        sse(res, chunk("lo"));
        sse(res, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } });
        res.write("data: [DONE]\n\n");
        res.end();
    };
    upstream = createServer((req, res) => {
        void (async () => {
            const raw = await readAll(req);
            let body: any = null;

            try {
                body = raw ? JSON.parse(raw) : null;
            } catch {
                // not JSON (e.g. GET /v1/models)
            }
            if (req.url === "/v1/models") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ data: [{ id: "m" }] }));

                return;
            }
            upstreamBodies.push(body);
            await upstreamHandler(req, res, body);
        })();
    });
    await listen(upstream);

    bridge = createServer((req, res) => {
        void (async () => {
            const raw = await readAll(req);
            const m = req.url!.match(/^\/chat\/(.+)$/);

            await handleChat(m![1]!, raw === "__TOO_BIG__" ? null : raw, res, {} as any, async () => {
                // A cache miss in the real getLive is an AWS DescribeInstances round-trip.
                if (liveDelayMs) await new Promise((r) => setTimeout(r, liveDelayMs));

                return { state: liveState } as InstanceInfo;
            });
        })();
    });
    bridgeBase = `http://127.0.0.1:${await listen(bridge)}`;
    saveDeployment(deployment());
});

afterEach(async () => {
    abortAllChats();
    bridge.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await new Promise((r) => upstream.close(r));
    if (prevHome === undefined) delete process.env.LLMRUN_HOME;
    else process.env.LLMRUN_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
});

describe("handleChat request validation", () => {
    it("404s an unknown deployment", async () => {
        expect((await post({ message: "hi" }, "ghost")).status).toBe(404);
    });

    it("413s when the router reports an oversize body", async () => {
        expect((await post("__TOO_BIG__")).status).toBe(413);
    });

    it.each([
        ["not json", "{nope"],
        ["empty message", { message: "" }],
        ["missing message", {}],
        ["bad role in history", { message: "x", history: [{ role: "tool", content: "x" }] }],
        ["temperature out of range", { message: "x", params: { temperature: 3 } }],
        [
            "too much history",
            { message: "x", history: Array.from({ length: 401 }, () => ({ role: "user", content: "x" })) },
        ],
    ])("400s: %s", async (_label, body) => {
        expect((await post(body)).status).toBe(400);
    });

    it("409s when the deployment has no instance", async () => {
        saveDeployment(deployment({ instanceId: undefined }));
        expect((await post({ message: "hi" })).status).toBe(409);
    });

    it("409s when the instance is not running", async () => {
        liveState = "stopped";
        const r = await post({ message: "hi" });

        expect(r.status).toBe(409);
        expect(((await r.json()) as { error: string }).error).toMatch(/stopped/);
        expect(isChatBusy("dep")).toBe(false);
    });
});

describe("handleChat streaming", () => {
    it("streams deltas + usage, forwards the right payload, and persists the turn", async () => {
        const r = await post({
            conversationId: "conv-1",
            message: "Say hi",
            history: [{ role: "system", content: "be brief" }],
            params: { temperature: 0.5, maxTokens: 64 },
        });
        const f = frames(await r.text());

        expect(r.headers.get("content-type")).toBe("text/event-stream");
        expect(f[0]).toEqual({ type: "meta", conversationId: "conv-1" });
        expect(
            f
                .filter((x) => x.type === "delta")
                .map((x) => x.text)
                .join("")
        ).toBe("Hello");
        expect(f.at(-1)).toMatchObject({ type: "done", usage: { promptTokens: 12, completionTokens: 2 } });

        expect(upstreamBodies[0]).toMatchObject({
            model: "Qwen/Qwen3",
            stream: true,
            stream_options: { include_usage: true },
            temperature: 0.5,
            max_tokens: 64,
            messages: [
                { role: "system", content: "be brief" },
                { role: "user", content: "Say hi" },
            ],
        });

        const chats = loadEvents().filter((e) => e.t === "chat");

        expect(chats).toHaveLength(1);
        expect(chats[0]).toMatchObject({
            id: "dep-id-1",
            conversationId: "conv-1",
            messages: [
                { role: "user", content: "Say hi" },
                { role: "assistant", content: "Hello" },
            ],
            usage: { promptTokens: 12, completionTokens: 2 },
        });
        expect(isChatBusy("dep")).toBe(false);
    });

    it("omits stream_options for ollama", async () => {
        saveDeployment(deployment({ engine: "ollama" }));
        await (await post({ message: "hi" })).text();

        expect(upstreamBodies[0]).not.toHaveProperty("stream_options");
    });

    it("mints a deploymentId for legacy state files so the turn isn't dropped", async () => {
        saveDeployment(deployment({ deploymentId: undefined }));
        await (await post({ message: "hi" })).text();

        const minted = loadDeployment("dep").deploymentId;

        expect(minted).toBeTruthy();
        expect(loadEvents().find((e) => e.t === "chat")?.id).toBe(minted);
    });

    it("handles SSE lines split across network chunks and non-data lines", async () => {
        upstreamHandler = async (_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(": keepalive\n\n");
            const line = `data: ${JSON.stringify(chunk("split"))}\n\n`;

            res.write(line.slice(0, 10));
            await new Promise((r) => setTimeout(r, 30));
            res.write(line.slice(10));
            res.write("data: [DONE]\n\n");
            res.end();
        };
        const f = frames(await (await post({ message: "hi" })).text());

        expect(f.filter((x) => x.type === "delta").map((x) => x.text)).toEqual(["split"]);
    });

    it("accumulates streamed tool calls and persists them", async () => {
        upstreamHandler = (_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            sse(res, {
                choices: [
                    { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_", arguments: '{"a"' } }] } },
                ],
            });
            sse(res, {
                choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: ":1}" } }] } }],
            });
            sse(res, {
                choices: [
                    { delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "other", arguments: "{}" } }] } },
                ],
            });
            res.write("data: [DONE]\n\n");
            res.end();
        };
        await (await post({ message: "weather?" })).text();

        const turn = loadEvents().find((e) => e.t === "chat") as any;

        expect(turn.messages[1].toolCalls).toEqual([
            { id: "c1", name: "get_weather", arguments: '{"a":1}' },
            { id: "c2", name: "other", arguments: "{}" },
        ]);
    });

    it("finishes cleanly when the upstream closes without [DONE]", async () => {
        upstreamHandler = (_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            sse(res, chunk("partial"));
            res.end();
        };
        const f = frames(await (await post({ message: "hi" })).text());

        expect(f.at(-1).type).toBe("done");
        expect((loadEvents().find((e) => e.t === "chat") as any).messages[1].content).toBe("partial");
    });

    it("reports upstream HTTP errors and persists nothing", async () => {
        upstreamHandler = (_req, res) => {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("CUDA out of memory");
        };
        const f = frames(await (await post({ message: "hi" })).text());

        expect(f.at(-1)).toMatchObject({ type: "error" });
        expect(f.at(-1).message).toMatch(/500.*CUDA out of memory/);
        expect(loadEvents().filter((e) => e.t === "chat")).toHaveLength(0);
        expect(isChatBusy("dep")).toBe(false);
    });

    it("reports a dropped tunnel as an error", async () => {
        upstreamHandler = (req) => {
            req.socket.destroy();
        };
        const f = frames(await (await post({ message: "hi" })).text());

        expect(f.at(-1)).toMatchObject({ type: "error" });
        expect(isChatBusy("dep")).toBe(false);
    });

    it("aborts the upstream request and keeps the partial turn when the browser disconnects", async () => {
        let upstreamClosed = false;

        upstreamHandler = (req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            sse(res, chunk("partial"));
            res.on("close", () => (upstreamClosed = true));
            req.on("close", () => (upstreamClosed = true));
            // never finishes on its own
        };
        const ctl = new AbortController();
        const r = await post({ message: "long" }, "dep", ctl.signal);
        const reader = r.body!.getReader();
        let seen = "";

        while (!seen.includes("partial")) seen += new TextDecoder().decode((await reader.read()).value);
        ctl.abort();
        await reader.cancel().catch(() => undefined);

        await expect.poll(() => upstreamClosed, { timeout: 3_000 }).toBe(true);
        await expect.poll(() => isChatBusy("dep"), { timeout: 3_000 }).toBe(false);
        await expect
            .poll(() => (loadEvents().find((e) => e.t === "chat") as any)?.messages[1].content, { timeout: 3_000 })
            .toBe("partial");
    });

    it("rejects a second concurrent stream for the same deployment with 409", async () => {
        liveDelayMs = 100;
        upstreamHandler = async (_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            sse(res, chunk("a"));
            await new Promise((r) => setTimeout(r, 300));
            res.write("data: [DONE]\n\n");
            res.end();
        };
        const [a, b] = await Promise.all([post({ message: "one" }), post({ message: "two" })]);
        const statuses = [a.status, b.status].sort();

        await Promise.all([a.text(), b.text()]);

        expect(statuses).toEqual([200, 409]);
    });

    it("rejects a second stream once the first is clearly in flight", async () => {
        upstreamHandler = async (_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            sse(res, chunk("a"));
            await new Promise((r) => setTimeout(r, 400));
            res.write("data: [DONE]\n\n");
            res.end();
        };
        const first = await post({ message: "one" });

        await expect.poll(() => isChatBusy("dep")).toBe(true);

        const second = await post({ message: "two" });

        expect(second.status).toBe(409);
        await first.text();
        expect(isChatBusy("dep")).toBe(false);
    });
});

describe("conversation handlers", () => {
    function call(fn: (res: ServerResponse) => void): Promise<{ status: number; body: any }> {
        return new Promise((resolve) => {
            const srv = createServer((_req, res) => fn(res));

            srv.listen(0, "127.0.0.1", async () => {
                const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);

                resolve({ status: r.status, body: await r.json() });
                srv.closeAllConnections();
                srv.close();
            });
        });
    }

    it("round-trips list → turns → delete → list", async () => {
        await (await post({ conversationId: "c1", message: "hello there" })).text();

        const list = await call((res) => handleListConversations("dep", res));

        expect(list.body.conversations).toHaveLength(1);
        expect(list.body.conversations[0]).toMatchObject({ conversationId: "c1", title: "hello there", turns: 1 });

        const turns = await call((res) => handleConversationTurns("dep", "c1", res));

        expect(turns.body.turns[0].messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);

        expect((await call((res) => handleDeleteConversation("dep", "c1", res))).body).toEqual({ ok: true });
        expect((await call((res) => handleListConversations("dep", res))).body.conversations).toEqual([]);
    });

    it("404s unknown deployments and mints fresh conversation ids", async () => {
        expect((await call((res) => handleListConversations("ghost", res))).status).toBe(404);
        expect((await call((res) => handleDeleteConversation("ghost", "c", res))).status).toBe(404);

        const a = await call((res) => handleCreateConversation(res));
        const b = await call((res) => handleCreateConversation(res));

        expect(a.body.conversationId).not.toBe(b.body.conversationId);
    });

    it("does not leak one deployment's conversations into another", async () => {
        saveDeployment(deployment({ name: "other", deploymentId: "dep-id-2" }));
        await (await post({ conversationId: "c1", message: "mine" })).text();

        expect((await call((res) => handleListConversations("other", res))).body.conversations).toEqual([]);
        expect((await call((res) => handleConversationTurns("other", "c1", res))).body.turns).toEqual([]);
    });
});
