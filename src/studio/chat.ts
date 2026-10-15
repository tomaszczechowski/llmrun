import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AwsSelection } from "../lib/config.js";
import type { GlobalFlags } from "../lib/context.js";
import { selectionForDeployment } from "../lib/context.js";
import { loadDeployment, updateDeployment, type DeploymentState } from "../lib/state.js";
import { waitForSsmOnline, type InstanceInfo } from "../lib/aws.js";
import { establishPortForward, isProcessAlive } from "../lib/ssm.js";
import {
    appendChatTurn,
    conversationTurns,
    deleteConversation,
    listConversations,
    eventsFor,
    type ChatMessage,
} from "../lib/history.js";
import { LlmrunError } from "../lib/errors.js";
import { initSse, safeWriteSse, sendJson } from "./http.js";

/**
 * Chat proxy: streams `POST /api/deployments/:name/chat` through to the
 * instance's OpenAI-compatible `/v1/chat/completions` over the existing SSM
 * port-forward, normalizes the upstream SSE chunks into small UI events, and
 * persists every completed turn as a ledger `chat` event (so conversations
 * survive `down`).
 *
 * - `stream_options: { include_usage: true }` (vLLM) is what makes per-message
 *   token accounting exact; without it usage degrades to null.
 * - Aborting the browser fetch aborts the upstream request, which cancels
 *   generation on the instance.
 * - One active stream per deployment; extras are rejected with 409.
 */

const CONNECT_WAIT_MS = 120_000;

/** Max chat request body (message + history); read by the router in server.ts. */
export const MAX_CHAT_BODY_BYTES = 2 * 1024 * 1024;

const chatRequestSchema = z.object({
    conversationId: z.string().min(1).optional(),
    message: z.string().min(1).max(64_000),
    history: z
        .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(1_000_000) }))
        .max(400)
        .default([]),
    params: z
        .object({
            model: z.string().min(1).max(400).optional(),
            temperature: z.number().min(0).max(2).optional(),
            maxTokens: z.number().int().min(1).max(10_000_000).optional(),
        })
        .optional(),
});

type ChatRequest = z.infer<typeof chatRequestSchema>;

interface ToolCall {
    id?: string;
    name?: string;
    arguments: string;
}

interface ActiveChat {
    controller: AbortController;
    res: ServerResponse;
}

const activeChats = new Map<string, ActiveChat>();

export function isChatBusy(name: string): boolean {
    return activeChats.has(name);
}

/** Abort every in-flight chat stream (bridge shutdown). */
export function abortAllChats(): void {
    for (const chat of activeChats.values()) {
        try {
            chat.controller.abort();
        } catch {
            // Already finished.
        }
    }
    activeChats.clear();
}

/**
 * The deployment's ledger identity, minted on the spot for state files that
 * predate the ledger. Every persistence path needs one, so this must never be
 * conditional — a missing id silently drops the data it was meant to key.
 */
function ensureDeploymentId(d: DeploymentState): string {
    if (d.deploymentId) return d.deploymentId;

    const id = randomUUID();
    updateDeployment(d.name, { deploymentId: id });
    d.deploymentId = id;

    return id;
}

/** Ensure a live port-forward exists, establishing one lazily on first use. */
async function ensureConnected(d: DeploymentState, sel: AwsSelection, res: ServerResponse): Promise<void> {
    if (isProcessAlive(d.forwardPid)) return;

    safeWriteSse(res, { type: "status", text: "Establishing the SSM port-forward…" });
    const online = await waitForSsmOnline(sel, d.instanceId!, 90_000, 3_000);

    if (!online) {
        throw new LlmrunError("The SSM agent is not reachable — is the instance still running?");
    }
    const pid = await establishPortForward(sel, d);
    updateDeployment(d.name, { forwardPid: pid });
}

/** Wait for the served model to answer /v1/models (it may still be loading). */
async function waitForModel(localPort: number, res: ServerResponse, deadline: number): Promise<boolean> {
    let announced = false;

    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${localPort}/v1/models`, { signal: AbortSignal.timeout(4_000) });

            if (r.ok) return true;
        } catch {
            // Not up yet.
        }
        if (!announced) {
            safeWriteSse(res, { type: "status", text: "Waiting for the model to become ready…" });
            announced = true;
        }
        await new Promise((r) => setTimeout(r, 3_000));
    }

    return false;
}

function mergeToolCalls(acc: Map<number, ToolCall>, deltas: any[]): void {
    for (const delta of deltas ?? []) {
        const idx = typeof delta.index === "number" ? delta.index : acc.size;
        const cur = acc.get(idx) ?? { arguments: "" };

        if (delta.id) cur.id = delta.id;
        if (delta.function?.name) cur.name = (cur.name ?? "") + delta.function.name;
        if (typeof delta.function?.arguments === "string") cur.arguments += delta.function.arguments;
        acc.set(idx, cur);
    }
}

export async function handleChat(
    name: string,
    raw: string | null,
    res: ServerResponse,
    flags: GlobalFlags,
    getLive: (d: DeploymentState, flags: GlobalFlags) => Promise<InstanceInfo | undefined>
): Promise<void> {
    let d: DeploymentState;
    try {
        d = loadDeployment(name);
    } catch {
        sendJson(res, 404, { ok: false, error: `No deployment named "${name}".` });

        return;
    }

    if (raw === null) {
        sendJson(res, 413, { ok: false, error: "Request body too large." });

        return;
    }

    let parsed: ChatRequest;
    try {
        parsed = chatRequestSchema.parse(JSON.parse(raw));
    } catch (err) {
        sendJson(res, 400, { ok: false, error: `Invalid chat request: ${(err as Error).message}` });

        return;
    }

    if (!d.instanceId) {
        sendJson(res, 409, { ok: false, error: "Deployment has no instance." });

        return;
    }
    if (activeChats.has(name)) {
        sendJson(res, 409, { ok: false, error: "Another chat stream is already running for this deployment." });

        return;
    }

    // Claim the slot before the first `await`: the busy check above and this
    // claim must be one synchronous step, or two near-simultaneous requests both
    // pass the check while `getLive` is in flight.
    const controller = new AbortController();
    activeChats.set(name, { controller, res });

    const release = (): void => {
        // Only drop our own claim — a newer stream may own the slot by now.
        if (activeChats.get(name)?.controller === controller) activeChats.delete(name);
    };

    const sel = selectionForDeployment(d, flags);
    let live: InstanceInfo | undefined;

    try {
        live = await getLive(d, flags);
    } catch {
        live = undefined; // unknown state — let the connection attempt decide
    }

    if (live && live.state !== "running") {
        release();
        sendJson(res, 409, { ok: false, error: `The instance is ${live.state} — start it from Overview first.` });

        return;
    }

    const conversationId = parsed.conversationId?.trim() || randomUUID();
    const deploymentId = ensureDeploymentId(d);

    initSse(res);
    safeWriteSse(res, { type: "meta", conversationId });

    const startedAt = Date.now();
    let assistantText = "";
    let assistantTools: ToolCall[] = [];
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    let aborted = false;
    let settled = false;

    const finish = (kind: "done" | "error" | "aborted", extra?: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        release();

        // Persist the turn when the model produced anything worth keeping.
        let persistError: string | undefined;

        if (assistantText.trim() || assistantTools.length > 0) {
            const messages: ChatMessage[] = [{ role: "user", content: parsed.message }];
            const asst: ChatMessage = { role: "assistant", content: assistantText };

            if (assistantTools.length > 0) {
                asst.toolCalls = assistantTools.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }));
            }
            messages.push(asst);
            try {
                appendChatTurn(deploymentId, conversationId, messages, usage);
            } catch (err) {
                // A ledger write failure must not break the stream, but the
                // client has to know this turn won't be there on reload.
                persistError = (err as Error).message;
            }
        }
        safeWriteSse(res, {
            type: kind,
            elapsedMs: Date.now() - startedAt,
            usage: usage ?? null,
            ...(persistError ? { persistError } : {}),
            ...extra,
        });
        res.end();
    };

    res.on("close", () => {
        if (settled) return;
        aborted = true;
        controller.abort();
        // Give the reader loop a moment to unwind and persist the partial turn.
        setTimeout(() => finish("aborted"), 50);
    });

    // The client may have left while `getLive` was in flight, before the listener existed.
    if (res.destroyed) {
        aborted = true;
        controller.abort();
        finish("aborted");

        return;
    }

    try {
        await ensureConnected(d, sel, res);
    } catch (err) {
        finish("error", { message: (err as Error).message });

        return;
    }

    const ready = await waitForModel(d.localPort, res, Date.now() + CONNECT_WAIT_MS);

    if (!ready) {
        finish("error", { message: "The model did not become ready in time (check the Logs tab)." });

        return;
    }

    const messages = [...parsed.history, { role: "user" as const, content: parsed.message }];
    const payload: Record<string, unknown> = {
        model: parsed.params?.model || d.hf_repo,
        messages,
        stream: true,
    };

    // Ollama's OpenAI-compat layer predates stream_options; only vLLM gets it.
    if (d.engine === "vllm") {
        payload.stream_options = { include_usage: true };
    }
    if (parsed.params?.temperature !== undefined) payload.temperature = parsed.params.temperature;
    if (parsed.params?.maxTokens !== undefined) payload.max_tokens = parsed.params.maxTokens;

    let upstream: Response;
    try {
        upstream = await fetch(`http://127.0.0.1:${d.localPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } catch {
        if (aborted) {
            finish("aborted");
        } else {
            finish("error", { message: "Could not reach the model endpoint (the tunnel may have dropped)." });
        }

        return;
    }

    if (!upstream.ok || !upstream.body) {
        let detail = "";
        try {
            detail = (await upstream.text()).slice(0, 800);
        } catch {
            // Body unreadable — the status code alone will do.
        }
        finish("error", { message: `Model endpoint returned ${upstream.status}: ${detail || upstream.statusText}` });

        return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const toolAcc = new Map<number, ToolCall>();

    const processLine = (line: string): boolean => {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) return false; // comments/keepalives
        const data = trimmed.slice(5).trim();

        if (data === "[DONE]") return true;
        let json: any;
        try {
            json = JSON.parse(data);
        } catch {
            return false; // torn line — skip
        }
        if (json.usage?.prompt_tokens !== undefined || json.usage?.completion_tokens !== undefined) {
            usage = {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
            };
            safeWriteSse(res, { type: "usage", usage });
        }
        const delta = json.choices?.[0]?.delta;

        if (typeof delta?.content === "string" && delta.content.length > 0) {
            assistantText += delta.content;
            safeWriteSse(res, { type: "delta", text: delta.content });
        }
        if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            mergeToolCalls(toolAcc, delta.tool_calls);
            assistantTools = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
            safeWriteSse(res, { type: "tool", toolCalls: assistantTools });
        }

        return false;
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;

            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);

                if (processLine(line)) {
                    finish("done");
                    await reader.cancel().catch(() => undefined);

                    return;
                }
            }
        }
        // Stream closed without [DONE] (e.g. upstream restart) — emit what we have.
        buf += decoder.decode();

        for (const line of buf.split("\n")) {
            if (processLine(line)) break;
        }
        finish("done");
    } catch {
        if (aborted) finish("aborted");
        else finish("error", { message: "The upstream stream broke mid-generation." });
    }
}

/** GET /api/deployments/:name/models — the served model ids (for the picker). */
export async function handleModels(name: string, res: ServerResponse): Promise<void> {
    let d: DeploymentState;
    try {
        d = loadDeployment(name);
    } catch {
        sendJson(res, 404, { ok: false, error: `No deployment named "${name}".` });

        return;
    }
    if (!isProcessAlive(d.forwardPid)) {
        sendJson(res, 409, { ok: false, error: "Not connected — establish the port-forward first." });

        return;
    }
    try {
        const r = await fetch(`http://127.0.0.1:${d.localPort}/v1/models`, { signal: AbortSignal.timeout(6_000) });

        if (!r.ok) {
            sendJson(res, 502, { ok: false, error: `Model endpoint returned ${r.status}.` });

            return;
        }
        const body = (await r.json()) as { data?: { id?: string }[] };
        sendJson(res, 200, { models: (body.data ?? []).map((m) => m.id).filter((x): x is string => !!x) });
    } catch {
        sendJson(res, 502, { ok: false, error: "Could not reach the model endpoint (still loading?)." });
    }
}

// --- Conversations ---------------------------------------------------------------

function requireDeploymentId(name: string, res: ServerResponse): { d: DeploymentState; id: string } | null {
    let d: DeploymentState;
    try {
        d = loadDeployment(name);
    } catch {
        sendJson(res, 404, { ok: false, error: `No deployment named "${name}".` });

        return null;
    }
    return { d, id: ensureDeploymentId(d) };
}

export function handleListConversations(name: string, res: ServerResponse): void {
    const target = requireDeploymentId(name, res);

    if (!target) return;
    sendJson(res, 200, { conversations: listConversations(target.id, eventsFor(target.id)) });
}

export function handleCreateConversation(res: ServerResponse): void {
    sendJson(res, 200, { conversationId: randomUUID() });
}

export function handleConversationTurns(name: string, conversationId: string, res: ServerResponse): void {
    const target = requireDeploymentId(name, res);

    if (!target) return;
    const turns = conversationTurns(target.id, conversationId, eventsFor(target.id));
    sendJson(res, 200, {
        conversationId,
        turns: turns.map((t) => ({ ts: t.ts, messages: t.messages, usage: t.usage ?? null })),
    });
}

export function handleDeleteConversation(name: string, conversationId: string, res: ServerResponse): void {
    const target = requireDeploymentId(name, res);

    if (!target) return;
    deleteConversation(target.id, conversationId);
    sendJson(res, 200, { ok: true });
}
