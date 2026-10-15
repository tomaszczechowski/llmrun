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
    stoppedSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    storageCostUsd: number;
    usdPer1MOutTokens: number;
}

export interface IdleInfo {
    lastActiveAt: string | null;
    secondsLeft: number | null;
    timeoutSeconds: number | null;
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
    rateLive: boolean;
    idleTimeout: string;
    idle: IdleInfo | null;
    chatBusy: boolean;
    session: SessionInfo | null;
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

// --- History aggregates ---------------------------------------------------

export interface SessionAggregate {
    startedTs: string;
    endedTs: string | null;
    runningSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
}

export interface DeploymentAggregate {
    id: string;
    name: string;
    alias: string;
    hfRepo: string;
    instanceId: string;
    instanceType: string;
    engine: "vllm" | "ollama";
    mode: "gpu" | "cpu";
    region: string;
    diskGb: number;
    usdPerHour: number;
    destroyed: boolean;
    createdAt: string;
    lastTs: string;
    sessions: SessionAggregate[];
    runningSeconds: number;
    stoppedSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    storageCostUsd: number;
    usdPer1MOutTokens: number;
    efficiency: number | null;
}

export interface ModelAggregate {
    alias: string;
    deployments: number;
    destroyed: number;
    runningSeconds: number;
    stoppedSeconds: number;
    promptTokens: number;
    generationTokens: number;
    computeCostUsd: number;
    storageCostUsd: number;
    usdPer1MOutTokens: number;
}

export interface MonthAggregate {
    month: string;
    runningSeconds: number;
    stoppedSeconds: number;
    promptTokens: number;
    generationTokens: number;
    computeCostUsd: number;
    storageCostUsd: number;
}

export interface LedgerTotals {
    deployments: number;
    destroyed: number;
    sessions: number;
    runningSeconds: number;
    stoppedSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    storageCostUsd: number;
    usdPer1MOutTokens: number;
}

export interface LedgerAggregate {
    generatedAt: string;
    sinceIso: string | null;
    model: string | null;
    totals: LedgerTotals;
    deployments: DeploymentAggregate[];
    byModel: ModelAggregate[];
    monthly: MonthAggregate[];
}

// --- Conversations ----------------------------------------------------------

export interface ToolCallPart {
    id?: string;
    name?: string;
    arguments?: string;
}

export interface ChatMessagePart {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCalls?: ToolCallPart[];
}

export interface ConversationSummary {
    conversationId: string;
    title: string;
    turns: number;
    promptTokens: number;
    completionTokens: number;
    firstTs: string;
    lastTs: string;
}

export interface ConversationTurn {
    ts: string;
    messages: ChatMessagePart[];
    usage: { promptTokens: number; completionTokens: number } | null;
}

// --- Calls --------------------------------------------------------------------

export async function fetchDeployments(): Promise<DeploymentInfo[]> {
    const res = await fetch("/api/deployments", { cache: "no-store" });

    if (!res.ok) throw new Error(`API error: ${res.status}`);

    return res.json();
}

export async function fetchHistory(params: { since?: string; model?: string }): Promise<LedgerAggregate> {
    const q = new URLSearchParams();

    if (params.since) q.set("since", params.since);
    if (params.model) q.set("model", params.model);
    const res = await fetch(`/api/history?${q.toString()}`, { cache: "no-store" });

    if (!res.ok) throw new Error(`API error: ${res.status}`);

    return res.json();
}

export async function sendAction(name: string, action: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/deployments/${encodeURIComponent(name)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
    });

    return res.json();
}

export async function fetchConversations(name: string): Promise<ConversationSummary[]> {
    const res = await fetch(`/api/deployments/${encodeURIComponent(name)}/conversations`, { cache: "no-store" });

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const body = (await res.json()) as { conversations: ConversationSummary[] };

    return body.conversations;
}

export async function fetchConversation(name: string, conversationId: string): Promise<ConversationTurn[]> {
    const res = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/conversations/${encodeURIComponent(conversationId)}`,
        { cache: "no-store" }
    );

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const body = (await res.json()) as { turns: ConversationTurn[] };

    return body.turns;
}

export async function createConversation(name: string): Promise<string> {
    const res = await fetch(`/api/deployments/${encodeURIComponent(name)}/conversations`, { method: "POST" });

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const body = (await res.json()) as { conversationId: string };

    return body.conversationId;
}

export async function deleteConversation(
    name: string,
    conversationId: string
): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: "DELETE" }
    );

    return res.json();
}

export async function fetchServedModels(name: string): Promise<string[]> {
    const res = await fetch(`/api/deployments/${encodeURIComponent(name)}/models`, { cache: "no-store" });

    if (!res.ok) return [];
    const body = (await res.json()) as { models?: string[] };

    return body.models ?? [];
}

type MetricsHandler = {
    onInit: (samples: MetricSample[]) => void;
    onSample: (sample: MetricSample) => void;
    onStatus: (text: string) => void;
};

export function metricsStream(name: string, handlers: MetricsHandler): () => void {
    const es = new EventSource(`/api/deployments/${encodeURIComponent(name)}/metrics`);
    es.onmessage = (ev) => {
        let msg: any;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (msg.type === "init") {
            handlers.onInit(msg.samples);
        } else if (msg.type === "sample") {
            handlers.onSample(msg.data);
        } else if (msg.type === "status") {
            handlers.onStatus(msg.text);
        }
    };

    return () => es.close();
}

type LogsHandler = {
    onLine: (line: string) => void;
    onEnd: (info: string) => void;
};

export function logsStream(name: string, handlers: LogsHandler): () => void {
    const es = new EventSource(`/api/deployments/${encodeURIComponent(name)}/logs`);
    es.onmessage = (ev) => {
        let msg: any;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (msg.type === "line") {
            handlers.onLine(msg.line);
        } else if (msg.type === "end") {
            handlers.onEnd(msg.info);
        }
    };

    return () => es.close();
}

// --- Chat ---------------------------------------------------------------------

export interface ChatParams {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface ChatRequestBody {
    conversationId?: string;
    message: string;
    history: { role: "system" | "user" | "assistant"; content: string }[];
    params?: ChatParams;
}

export interface ChatToolCall {
    id?: string;
    name?: string;
    arguments: string;
}

export interface ChatUsage {
    promptTokens: number;
    completionTokens: number;
}

export interface ChatStreamHandlers {
    onMeta?: (conversationId: string) => void;
    onStatus?: (text: string) => void;
    onDelta?: (text: string) => void;
    onToolCalls?: (toolCalls: ChatToolCall[]) => void;
    onUsage?: (usage: ChatUsage) => void;
    onDone?: (info: { elapsedMs: number; usage: ChatUsage | null }) => void;
    onAborted?: (info: { elapsedMs: number; usage: ChatUsage | null }) => void;
    onError?: (message: string) => void;
}

export interface ChatStream {
    abort(): void;
}

/**
 * POST the chat request and consume the bridge's SSE response with fetch
 * (EventSource can't POST). The returned handle aborts the stream — the
 * bridge then cancels generation on the instance.
 */
export function streamChat(name: string, body: ChatRequestBody, handlers: ChatStreamHandlers): ChatStream {
    const controller = new AbortController();

    void (async () => {
        let res: Response;
        try {
            res = await fetch(`/api/deployments/${encodeURIComponent(name)}/chat`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch {
            if (!controller.signal.aborted) handlers.onError?.("Could not reach the studio bridge.");

            return;
        }

        if (!res.ok || !res.body) {
            let message = `Chat request failed (${res.status}).`;
            try {
                const body = (await res.json()) as { error?: string };

                if (body.error) message = body.error;
            } catch {
                // Non-JSON error body — the status line is the message.
            }
            handlers.onError?.(message);

            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        const handleLine = (line: string) => {
            const trimmed = line.replace(/\r$/, "");

            if (!trimmed.startsWith("data:")) return;
            let msg: any;
            try {
                msg = JSON.parse(trimmed.slice(5).trim());
            } catch {
                return;
            }
            switch (msg.type) {
                case "meta":
                    handlers.onMeta?.(msg.conversationId);
                    break;
                case "status":
                    handlers.onStatus?.(msg.text);
                    break;
                case "delta":
                    handlers.onDelta?.(msg.text);
                    break;
                case "tool":
                    handlers.onToolCalls?.(msg.toolCalls);
                    break;
                case "usage":
                    handlers.onUsage?.(msg.usage);
                    break;
                case "done":
                    handlers.onDone?.({ elapsedMs: msg.elapsedMs, usage: msg.usage });
                    break;
                case "aborted":
                    handlers.onAborted?.({ elapsedMs: msg.elapsedMs, usage: msg.usage });
                    break;
                case "error":
                    handlers.onError?.(msg.message ?? "The chat stream failed.");
                    break;
            }
        };

        try {
            for (;;) {
                const { done, value } = await reader.read();

                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx: number;

                while ((idx = buf.indexOf("\n")) >= 0) {
                    handleLine(buf.slice(0, idx));
                    buf = buf.slice(idx + 1);
                }
            }
            buf += decoder.decode();
            for (const line of buf.split("\n")) handleLine(line);
        } catch {
            if (!controller.signal.aborted) handlers.onError?.("The chat stream broke.");
        }
    })();

    return { abort: () => controller.abort() };
}
