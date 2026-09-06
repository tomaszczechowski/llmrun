import { useEffect, useState } from "react";
import { metricsStream, type DeploymentInfo, type MetricSample } from "../api";
import TimeSeriesChart from "../components/TimeSeriesChart";
import { fmtDuration, fmtInt, fmtNum, fmtUsd } from "../util";

interface Props {
    deployment: DeploymentInfo | null;
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
    return (
        <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-0.5 text-lg font-semibold text-zinc-100">
                {value}
                {unit ? <span className="ml-1 text-xs font-normal text-zinc-500">{unit}</span> : null}
            </div>
        </div>
    );
}

export default function MetricsTab({ deployment }: Props) {
    const name = deployment?.name;
    const engine = deployment?.engine;
    const [samples, setSamples] = useState<MetricSample[]>([]);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (!name || !engine) return;
        setSamples([]);
        setStatus(null);
        const close = metricsStream(name, {
            onInit: (init) => setSamples(init),
            onSample: (s) => setSamples((prev) => (prev.length >= 600 ? [...prev.slice(1), s] : [...prev, s])),
            onStatus: (text) => setStatus(text),
        });
        return close;
    }, [name, engine]);

    if (!deployment) {
        return <div className="text-zinc-400">Select a deployment to see metrics.</div>;
    }

    if (deployment.engine !== "vllm") {
        return (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-10 text-center text-zinc-400">
                Live metrics are unavailable for CPU (Ollama) deployments. {" "}
                Token and cost usage is still tracked in the ledger via the Overview tab.
            </div>
        );
    }

    if (deployment.state !== "running") {
        return (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-10 text-center text-zinc-400">
                The instance is <span className="text-amber-400">{deployment.state}</span> — start it to see live
                metrics.
            </div>
        );
    }

    const last = samples[samples.length - 1] ?? null;
    const times = samples.map((s) => Date.parse(s.t));
    const series = [
        { label: "tokens/s (engine)", values: samples.map((s) => s.values.tokensPerSecond ?? 0) },
        { label: "prompt tokens/s", values: samples.map((s) => s.values.promptTokenRate ?? 0) },
        { label: "generation tokens/s", values: samples.map((s) => s.values.generationTokenRate ?? 0) },
    ];

    return (
        <div className="flex flex-col gap-4">
            {status && <div className="text-sm text-amber-400">{status}</div>}
            {last && !last.connected && (
                <div className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-300">
                    Not connected — no SSM port-forward to the instance. Use Connect in Overview first.
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                <Stat label="Tokens/s" value={fmtNum(last?.values.tokensPerSecond, 0)} />
                <Stat label="In /s" value={fmtNum(last?.values.promptTokenRate, 0)} />
                <Stat label="Out /s" value={fmtNum(last?.values.generationTokenRate, 0)} />
                <Stat label="Running" value={fmtInt(last?.values.requestsRunning)} />
                <Stat label="Waiting" value={fmtInt(last?.values.requestsWaiting)} />
                <Stat label="KV cache" value={fmtNum(last?.values.kvCachePct, 0)} unit="%" />
                <Stat label="TTFT" value={fmtNum(last?.values.ttftMs, 0)} unit="ms" />
                <Stat label="E2E latency" value={fmtNum(last?.values.e2eLatencyMs, 0)} unit="ms" />
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-2 text-sm font-medium text-zinc-300">Throughput (last ~50 min)</div>
                {times.length > 1 ? (
                    <TimeSeriesChart times={times} series={series} height={280} />
                ) : (
                    <div className="flex h-[280px] items-center justify-center text-sm text-zinc-500">
                        Collecting samples (one every 5 s)…
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Cumulative (since counters started)</div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                        <KV k="Prompt tokens" v={fmtInt(last?.values.promptTokensTotal)} />
                        <KV k="Generation tokens" v={fmtInt(last?.values.generationTokensTotal)} />
                        <KV k="Successful requests" v={fmtInt(last?.values.requestSuccessTotal)} />
                        <KV k="TPOT (avg)" v={fmtNum(last?.values.tpotMs, 1) + " ms"} />
                    </div>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Session cost</div>
                    {deployment.session ? (
                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                            <KV k="Session running" v={fmtDuration(deployment.session.runningSeconds)} />
                            <KV k="Active (requesting)" v={fmtDuration(deployment.session.activeSeconds)} />
                            <KV k="Cost so far" v={fmtUsd(deployment.session.computeCostUsd)} />
                            <KV k="$ per 1M out tokens" v={fmtUsd(deployment.session.usdPer1MOutTokens, 3)} />
                            {deployment.session.runningSeconds > 0 && (
                                <KV
                                    k="Efficiency"
                                    v={
                                        Math.round((deployment.session.activeSeconds / deployment.session.runningSeconds) * 100) +
                                        " % active"
                                    }
                                />
                            )}
                        </div>
                    ) : (
                        <div className="text-sm text-zinc-500">No open session recorded yet.</div>
                    )}
                </div>
            </div>
        </div>
    );
}

function KV({ k, v }: { k: string; v: string }) {
    return (
        <div className="min-w-0">
            <div className="text-xs text-zinc-500">{k}</div>
            <div className="truncate text-zinc-200">{v}</div>
        </div>
    );
}
