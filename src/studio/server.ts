import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { packageRoot } from "../lib/paths.js";
import { listDeployments, loadDeployment, updateDeployment, type DeploymentState } from "../lib/state.js";
import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import {
    describeInstance,
    startInstance,
    stopInstance,
    waitForInstanceState,
    waitForSsmOnline,
    type InstanceInfo,
} from "../lib/aws.js";
import { establishPortForward, isProcessAlive, spawnCommandStream, stopPortForward } from "../lib/ssm.js";
import {
    computeSession,
    eventsFor,
    flushInstanceUsage,
    reconcileLifecycle,
    summarizeDeployment,
    usdPerHourFor,
    windowsFor,
} from "../lib/history.js";
import { estimateCost } from "../lib/instances.js";
import { LlmrunError } from "../lib/errors.js";
import { extractVllmMetrics, parsePrometheus } from "./metrics.js";

/**
 * The studio bridge: a tiny 127.0.0.1-only HTTP server that lets the local
 * browser SPA see what the CLI can see. It serves the built SPA from
 * `dist/studio/assets` and exposes JSON/SSE endpoints backed directly by the
 * same library functions the CLI commands use (state, EC2, SSM, ledger).
 *
 * Trust boundary = localhost: no auth, and the deployment workspace dir (which
 * holds tfvars with the HF token) is never read by any endpoint.
 */

const LIVE_TTL_MS = 15_000;
const METRIC_INTERVAL_MS = 5_000;
const MAX_SAMPLES = 600;
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]|${ESC}\\[?\\(?[0-9;]*m`, "g");

// --- API shapes ---------------------------------------------------------------

export interface SessionInfo {
    startedTs: string;
    runningSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    usdPer1MOutTokens: number;
}

export interface TotalsInfo {
    sessions: number;
    runningSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    usdPer1MOutTokens: number;
}

export interface DeploymentInfo {
    name: string;
    alias: string;
    hfRepo: string;
    engine: "vllm" | "ollama";
    mode: "gpu" | "cpu";
    instanceType: string;
    region: string;
    instanceId: string | null;
    localPort: number;
    endpoint: string;
    connected: boolean;
    state: string;
    uptimeSeconds: number | null;
    usdPerHour: number;
    /** The open running window (null when the instance is not running). */
    session: SessionInfo | null;
    /** All windows, open included. */
    totals: TotalsInfo;
}

export interface MetricValues {
    tokensPerSecond: number | null;
    promptTokenRate: number | null;
    generationTokenRate: number | null;
    promptTokensTotal: number | null;
    generationTokensTotal: number | null;
    requestsRunning: number;
    requestsWaiting: number;
    kvCachePct: number | null;
    requestSuccessTotal: number;
    e2eLatencyMs: number | null;
    ttftMs: number | null;
    tpotMs: number | null;
}

export interface MetricSample {
    t: string;
    connected: boolean;
    values: MetricValues;
}

// --- Module state (per bridge process) ----------------------------------------

const liveCache = new Map<string, { info: InstanceInfo | undefined; at: number }>();
const spawnedChildren = new Set<ChildProcess>();

interface MetricState {
    samples: MetricSample[];
    timer: NodeJS.Timeout | null;
    clients: Set<ServerResponse>;
}
const metricStates = new Map<string, MetricState>();

const ASSETS_DIR = path.join(packageRoot(), "dist", "studio", "assets");
const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".map": "application/json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

// --- Helpers --------------------------------------------------------------------

function sendJson(res: ServerResponse, code: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}

function safeWriteSse(res: ServerResponse, obj: unknown): void {
    if (res.writableEnded) return;
    try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
        // Client went away mid-write.
    }
}

function initSse(res: ServerResponse): void {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            data += chunk;
            if (data.length > 10_000) {
                reject(new Error("Request body too large."));
                req.destroy();
            }
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

async function liveInfo(d: DeploymentState, flags: GlobalFlags): Promise<InstanceInfo | undefined> {
    if (!d.instanceId) return undefined;
    const cached = liveCache.get(d.instanceId);

    if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.info;

    const info = await describeInstance(selectionForDeployment(d, flags), d.instanceId).catch(() => undefined);
    liveCache.set(d.instanceId, { info, at: Date.now() });
    return info;
}

function buildDeploymentInfo(d: DeploymentState, live: InstanceInfo | undefined): DeploymentInfo {
    const id = d.deploymentId ?? null;
    let session: SessionInfo | null = null;
    let totals: TotalsInfo = {
        sessions: 0,
        runningSeconds: 0,
        activeSeconds: 0,
        promptTokens: 0,
        generationTokens: 0,
        requestSuccess: 0,
        computeCostUsd: 0,
        usdPer1MOutTokens: 0,
    };

    if (id) {
        const events = eventsFor(id);
        const windows = windowsFor(id, events);
        const last = windows[windows.length - 1];

        if (last && last.stoppedTs === null) {
            const t = computeSession(id, last, undefined, events);
            session = {
                startedTs: t.startedTs,
                runningSeconds: t.runningSeconds,
                activeSeconds: t.activeSeconds,
                promptTokens: t.promptTokens,
                generationTokens: t.generationTokens,
                requestSuccess: t.requestSuccess,
                computeCostUsd: t.computeCostUsd,
                usdPer1MOutTokens: t.usdPer1MOutTokens,
            };
        }
        totals = summarizeDeployment(id, events);
    }

    const state = !d.instanceId ? (d.provisioningAt ? "provisioning" : "no-instance") : (live?.state ?? "unknown");
    const uptimeSeconds =
        d.instanceId && live?.state === "running" && live.startTime
            ? Math.max(0, Math.round((Date.now() - Date.parse(live.startTime)) / 1000))
            : null;
    const upRate = id ? usdPerHourFor(id) : 0;

    return {
        name: d.name,
        alias: d.alias,
        hfRepo: d.hf_repo,
        engine: d.engine,
        mode: d.mode,
        instanceType: d.instanceType,
        region: d.region,
        instanceId: d.instanceId ?? null,
        localPort: d.localPort,
        endpoint: `http://localhost:${d.localPort}/v1`,
        connected: isProcessAlive(d.forwardPid),
        state,
        uptimeSeconds,
        usdPerHour: upRate > 0 ? upRate : (estimateCost(d.instanceType)?.usdPerHour ?? 0),
        session,
        totals,
    };
}

// --- /api/deployments -----------------------------------------------------------

async function handleListDeployments(res: ServerResponse, flags: GlobalFlags): Promise<void> {
    const deployments = listDeployments();
    const infos = await Promise.all(deployments.map((d) => liveInfo(d, flags)));
    sendJson(res, 200, deployments.map((d, i) => buildDeploymentInfo(d, infos[i]!)));
}

// --- /api/deployments/:name/metrics (SSE) ---------------------------------------

async function metricsPoll(name: string, st: MetricState): Promise<void> {
    let d: DeploymentState;
    try {
        d = loadDeployment(name);
    } catch {
        for (const c of [...st.clients]) safeWriteSse(c, { type: "status", text: "Deployment no longer exists." });
        stopMetricsPoller(name, st);
        return;
    }

    const connected = isProcessAlive(d.forwardPid);
    const values: MetricValues = {
        tokensPerSecond: null,
        promptTokenRate: null,
        generationTokenRate: null,
        promptTokensTotal: null,
        generationTokensTotal: null,
        requestsRunning: 0,
        requestsWaiting: 0,
        kvCachePct: null,
        requestSuccessTotal: 0,
        e2eLatencyMs: null,
        ttftMs: null,
        tpotMs: null,
    };

    if (connected && d.engine === "vllm") {
        try {
            const r = await fetch(`http://127.0.0.1:${d.localPort}/metrics`, { signal: AbortSignal.timeout(3_000) });

            if (r.ok) {
                const snap = extractVllmMetrics(parsePrometheus(await r.text()));
                const prev = st.samples[st.samples.length - 1];
                const dt = prev ? (Date.now() - Date.parse(prev.t)) / 1000 : 0;
                const rate = (cur: number | null, prevVal: number | null): number | null =>
                    cur !== null && prevVal !== null && dt > 1 && cur >= prevVal ? (cur - prevVal) / dt : null;

                values.tokensPerSecond = snap.tokensPerSecond;
                values.promptTokenRate = rate(snap.promptTokens, prev?.values.promptTokensTotal ?? null);
                values.generationTokenRate = rate(snap.generationTokens, prev?.values.generationTokensTotal ?? null);
                values.promptTokensTotal = snap.promptTokens;
                values.generationTokensTotal = snap.generationTokens;
                values.requestsRunning = snap.requestsRunning;
                values.requestsWaiting = snap.requestsWaiting;
                values.kvCachePct = snap.kvCachePct;
                values.requestSuccessTotal = snap.requestSuccessTotal;
                values.e2eLatencyMs = snap.e2eLatencyMs;
                values.ttftMs = snap.ttftMs;
                values.tpotMs = snap.tpotMs;
            }
        } catch {
            // Forward is dead or the server is down — report the state below.
        }
    }

    const sample: MetricSample = { t: new Date().toISOString(), connected, values };
    st.samples.push(sample);
    if (st.samples.length > MAX_SAMPLES) st.samples.shift();
    for (const c of st.clients) safeWriteSse(c, { type: "sample", data: sample });
}

function stopMetricsPoller(name: string, st: MetricState): void {
    if (st.timer) {
        clearInterval(st.timer);
        st.timer = null;
    }
    metricStates.delete(name);
}

function metricsSubscribe(name: string, res: ServerResponse): void {
    let st = metricStates.get(name);
    if (!st) {
        st = { samples: [], timer: null, clients: new Set() };
        metricStates.set(name, st);
    }
    st.clients.add(res);
    initSse(res);
    safeWriteSse(res, { type: "init", samples: st.samples });

    if (!st.timer) {
        st.timer = setInterval(() => {
            void metricsPoll(name, st);
        }, METRIC_INTERVAL_MS);
        void metricsPoll(name, st);
    }

    res.on("close", () => {
        st.clients.delete(res);
        if (st.clients.size === 0) stopMetricsPoller(name, st);
    });
}

// --- /api/deployments/:name/logs (SSE) ------------------------------------------

function streamLogs(name: string, res: ServerResponse, flags: GlobalFlags): void {
    let d: DeploymentState;
    try {
        d = loadDeployment(name);
    } catch {
        sendJson(res, 404, { ok: false, error: `No deployment named "${name}".` });
        return;
    }
    if (!d.instanceId) {
        sendJson(res, 409, { ok: false, error: "Deployment has no instance." });
        return;
    }

    initSse(res);
    const child = spawnCommandStream(
        selectionForDeployment(d, flags),
        d.instanceId,
        "sudo journalctl -u llmrun-server -f -n 500"
    );
    spawnedChildren.add(child);

    let buf = "";
    const pump = (chunk: Buffer | string) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            const clean = line.replace(ANSI_RE, "").trim();

            if (clean) safeWriteSse(res, { type: "line", line: clean });
        }
    };

    child.stdout?.on("data", (c: Buffer) => pump(c));
    child.stderr?.on("data", (c: Buffer) => pump(c));
    child.on("exit", () => {
        spawnedChildren.delete(child);
        safeWriteSse(res, { type: "end", info: "Log stream ended (instance stopped or SSM session closed)." });
        res.end();
    });
    child.on("error", (err: Error) => {
        safeWriteSse(res, { type: "end", info: `Could not start the log stream: ${err.message}` });
        res.end();
    });
    res.on("close", () => {
        try {
            child.kill("SIGTERM");
        } catch {
            // Already gone.
        }
    });
}

// --- /api/deployments/:name/actions ----------------------------------------------

async function handleAction(name: string, body: string, flags: GlobalFlags, res: ServerResponse): Promise<void> {
    let d: DeploymentState;
    try {
        d = loadDeployment(name);
    } catch {
        sendJson(res, 404, { ok: false, error: `No deployment named "${name}".` });
        return;
    }

    let action = "";
    try {
        action = (JSON.parse(body) as { action?: string }).action ?? "";
    } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
        return;
    }

    const sel = selectionForDeployment(d, flags);

    try {
        switch (action) {
            case "connect": {
                if (!d.instanceId) throw new LlmrunError("Deployment has no instance.");
                if (isProcessAlive(d.forwardPid)) stopPortForward(d.forwardPid);
                const pid = await establishPortForward(sel, d);
                updateDeployment(d.name, { forwardPid: pid });
                sendJson(res, 200, { ok: true });
                return;
            }
            case "disconnect": {
                stopPortForward(d.forwardPid);
                updateDeployment(d.name, { forwardPid: undefined });
                sendJson(res, 200, { ok: true });
                return;
            }
            case "stop": {
                if (!d.instanceId) throw new LlmrunError("Deployment has no instance.");
                stopPortForward(d.forwardPid);
                updateDeployment(d.name, { forwardPid: undefined });
                if (d.deploymentId) {
                    try {
                        await flushInstanceUsage(sel, d.instanceId, d.deploymentId);
                        updateDeployment(d.name, { lastFlushAt: new Date().toISOString() });
                    } catch {
                        // SSM blip — the buffer persists until `down`.
                    }
                }
                await stopInstance(sel, d.instanceId);
                // The EC2-side stop is async; `llmrun ls`/`stop` reconciles the
                // window closure with the real stop time.
                sendJson(res, 200, { ok: true, note: "Stop issued; the instance stops asynchronously." });
                return;
            }
            case "start": {
                if (!d.instanceId) throw new LlmrunError("Deployment has no instance.");
                await startInstance(sel, d.instanceId);
                await waitForInstanceState(sel, d.instanceId, ["running"]);
                await reconcileAfterStart(sel, d.name);
                sendJson(res, 200, { ok: true, note: "Instance running; the model may still be loading." });
                return;
            }
            default:
                sendJson(res, 400, { ok: false, error: `Unknown action "${action}".` });
        }
    } catch (err) {
        sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
}

async function reconcileAfterStart(sel: { region?: string; profile?: string }, name: string): Promise<void> {
    const state = loadDeployment(name);
    await reconcileLifecycle(sel, state).catch(() => {
        // Best-effort — `llmrun ls` reconciles.
    });
    if (!isProcessAlive(state.forwardPid)) {
        const online = await waitForSsmOnline(sel, state.instanceId!);

        if (!online) throw new LlmrunError("The SSM agent did not come online after start.");
        const pid = await establishPortForward(sel, state);
        updateDeployment(name, { forwardPid: pid });
    }
}

// --- Static SPA ------------------------------------------------------------------

function serveStatic(res: ServerResponse, urlPath: string): void {
    if (urlPath.includes("..")) {
        res.writeHead(404).end("Not found");
        return;
    }

    const index = path.join(ASSETS_DIR, "index.html");

    if (!existsSync(index)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
            "<!doctype html><meta charset=utf-8><title>llmrun studio</title>" +
                "<body style='font-family:system-ui;margin:3rem'>" +
                "<h1>llmrun studio</h1>" +
                "<p>The dashboard assets are not built. Run <code>pnpm studio:build</code> and reload this page.</p>"
        );
        return;
    }

    const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
    const file = path.normalize(path.join(ASSETS_DIR, rel));

    if (!file.startsWith(ASSETS_DIR + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        // SPA fallback: any unknown GET serves the app shell.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        res.end(readFileSync(index));
        return;
    }

    res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
    });
    res.end(readFileSync(file));
}

// --- Request routing ---------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse, flags: GlobalFlags): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;

    try {
        if (p === "/api/deployments" && req.method === "GET") {
            await handleListDeployments(res, flags);
            return;
        }

        const m = p.match(/^\/api\/deployments\/([^/]+)\/(metrics|logs|actions)$/);

        if (m) {
            const name = decodeURIComponent(m[1]!);
            const kind = m[2]!;

            if (kind === "metrics" && req.method === "GET") {
                try {
                    loadDeployment(name);
                } catch {
                    sendJson(res, 404, { ok: false, error: `No deployment named "${name}".` });
                    return;
                }
                metricsSubscribe(name, res);
                return;
            }

            if (kind === "logs" && req.method === "GET") {
                streamLogs(name, res, flags);
                return;
            }

            if (kind === "actions" && req.method === "POST") {
                const body = await readBody(req);
                await handleAction(name, body, flags, res);
                return;
            }
        }

        if (req.method === "GET" || req.method === "HEAD") {
            serveStatic(res, p);
            return;
        }

        res.writeHead(405, { "allow": "GET, POST" }).end();
    } catch (err) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
}

// --- Lifecycle ----------------------------------------------------------------------

export interface StudioHandle {
    port: number;
    close(): Promise<void>;
}

export interface StudioServerOptions {
    port: number;
    flags: GlobalFlags;
}

/** Start the bridge on 127.0.0.1 (never any other interface). */
export async function startStudioServer(opts: StudioServerOptions): Promise<StudioHandle> {
    const server = createServer((req, res) => {
        void handleRequest(req, res, opts.flags);
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", (err) => {
            const code = (err as NodeJS.ErrnoException).code;

            if (code === "EADDRINUSE") {
                reject(
                    new LlmrunError(
                        `Studio port ${opts.port} is already in use.`,
                        "Pick another with `llmrun config --set studio_port=<port>`, or pass --port."
                    )
                );
            } else {
                reject(err);
            }
        });
        server.listen(opts.port, "127.0.0.1", () => resolve());
    });

    return {
        port: opts.port,
        close(): Promise<void> {
            return new Promise((resolve) => {
                for (const c of spawnedChildren) {
                    try {
                        c.kill("SIGTERM");
                    } catch {
                        // Already gone.
                    }
                }
                spawnedChildren.clear();
                for (const st of metricStates.values()) {
                    if (st.timer) clearInterval(st.timer);
                    for (const c of st.clients) {
                        try {
                            c.end();
                        } catch {
                            // Already gone.
                        }
                    }
                }
                metricStates.clear();
                server.close(() => resolve());
                server.closeAllConnections();
                const t = setTimeout(() => resolve(), 1_000);
                t.unref();
            });
        },
    };
}
