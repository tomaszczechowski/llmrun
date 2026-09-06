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

export async function fetchDeployments(): Promise<DeploymentInfo[]> {
    const res = await fetch("/api/deployments", { cache: "no-store" });

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
