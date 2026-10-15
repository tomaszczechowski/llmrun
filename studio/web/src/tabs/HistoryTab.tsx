import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchHistory, type DeploymentAggregate, type LedgerAggregate } from "../api";
import TimeSeriesChart from "../components/TimeSeriesChart";
import { fmtDate, fmtDuration, fmtInt, fmtUsd } from "../util";

/**
 * Cross-ledger history: every deployment ever recorded (running + destroyed),
 * per-model aggregates, monthly totals and the cost trend — the same numbers
 * `llmrun cost` / `llmrun history` print.
 */

const RANGES = [
    { label: "24h", value: "1d" },
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
    { label: "All", value: "" },
];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-0.5 text-lg font-semibold text-zinc-100">{value}</div>
            {sub && <div className="text-[11px] text-zinc-500">{sub}</div>}
        </div>
    );
}

export default function HistoryTab() {
    const [since, setSince] = useState("30d");
    const [model, setModel] = useState("");
    const [data, setData] = useState<LedgerAggregate | null>(null);
    const [allModels, setAllModels] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const agg = await fetchHistory({ since: since || undefined, model: model || undefined });

                if (cancelled) return;
                setData(agg);
                setError(null);
            } catch (e) {
                if (!cancelled) setError((e as Error).message);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [since, model]);

    // Discover model aliases once (unfiltered) for the filter dropdown.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const agg = await fetchHistory({});

                if (!cancelled) setAllModels(agg.byModel.map((m) => m.alias));
            } catch {
                // The main fetch surfaces errors.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    const trend = useMemo(() => {
        if (!data || data.monthly.length === 0) return null;
        const times = data.monthly.map((m) => Date.parse(`${m.month}-01T00:00:00Z`));

        return {
            times,
            series: [
                { label: "compute $", values: data.monthly.map((m) => round2(m.computeCostUsd)) },
                { label: "storage $", values: data.monthly.map((m) => round2(m.storageCostUsd)) },
            ],
        };
    }, [data]);

    if (error) {
        return <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-300">{error}</div>;
    }
    if (!data) {
        return <div className="p-6 text-sm text-zinc-500">Loading history…</div>;
    }

    const t = data.totals;

    if (t.deployments === 0) {
        return (
            <div className="flex flex-col gap-4">
                <Filters since={since} setSince={setSince} model={model} setModel={setModel} models={allModels} />
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-10 text-center text-zinc-400">
                    Nothing recorded in this range. The ledger fills as deployments run.
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <Filters since={since} setSince={setSince} model={model} setModel={setModel} models={allModels} />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label="Total cost" value={fmtUsd(t.computeCostUsd + t.storageCostUsd)} sub="compute + storage" />
                <Stat
                    label="Compute"
                    value={fmtUsd(t.computeCostUsd)}
                    sub={`${fmtDuration(t.runningSeconds)} running`}
                />
                <Stat
                    label="Storage"
                    value={fmtUsd(t.storageCostUsd)}
                    sub={`${fmtDuration(t.stoppedSeconds)} stopped`}
                />
                <Stat
                    label="$ / 1M out tokens"
                    value={fmtUsd(t.usdPer1MOutTokens, 3)}
                    sub="pay for infra, not tokens"
                />
                <Stat label="Tokens" value={`${fmtInt(t.generationTokens)}`} sub={`${fmtInt(t.promptTokens)} in`} />
                <Stat label="Requests" value={fmtInt(t.requestSuccess)} sub={`${fmtInt(t.sessions)} sessions`} />
                <Stat
                    label="Deployments"
                    value={String(t.deployments)}
                    sub={`${t.destroyed} destroyed · ${t.deployments - t.destroyed} live`}
                />
            </div>

            {trend && trend.times.length > 1 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Cost trend (by month, UTC)</div>
                    <TimeSeriesChart times={trend.times} series={trend.series} height={240} timeMode="date" />
                </div>
            )}

            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-2 text-sm font-medium text-zinc-300">By model</div>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                            <Th>Model</Th>
                            <Th right>Deploys</Th>
                            <Th right>Running</Th>
                            <Th right>Stopped</Th>
                            <Th right>Tokens in</Th>
                            <Th right>Tokens out</Th>
                            <Th right>Compute</Th>
                            <Th right>Storage</Th>
                            <Th right>$/1M out</Th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.byModel.map((m) => (
                            <tr key={m.alias} className="border-t border-zinc-800/70">
                                <Td className="font-medium text-zinc-200">{m.alias}</Td>
                                <Td right>
                                    {m.deployments}
                                    {m.destroyed > 0 ? <span className="text-zinc-500"> ({m.destroyed}⌫)</span> : null}
                                </Td>
                                <Td right>{fmtDuration(m.runningSeconds)}</Td>
                                <Td right>{fmtDuration(m.stoppedSeconds)}</Td>
                                <Td right>{fmtInt(m.promptTokens)}</Td>
                                <Td right>{fmtInt(m.generationTokens)}</Td>
                                <Td right>{fmtUsd(m.computeCostUsd)}</Td>
                                <Td right>{fmtUsd(m.storageCostUsd)}</Td>
                                <Td right>{m.generationTokens > 0 ? fmtUsd(m.usdPer1MOutTokens, 3) : "—"}</Td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-2 text-sm font-medium text-zinc-300">
                    By deployment (click a row for its sessions)
                </div>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                            <Th>Name</Th>
                            <Th>Status</Th>
                            <Th>Instance</Th>
                            <Th>Created</Th>
                            <Th right>Sessions</Th>
                            <Th right>Running</Th>
                            <Th right>Active</Th>
                            <Th right>Tokens out</Th>
                            <Th right>Compute</Th>
                            <Th right>Storage</Th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.deployments.map((d) => (
                            <DeploymentRow
                                key={d.id}
                                d={d}
                                expanded={expanded === d.id}
                                onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
                            />
                        ))}
                    </tbody>
                </table>
            </div>

            {data.monthly.length > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="mb-2 text-sm font-medium text-zinc-300">Monthly totals</div>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                                <Th>Month</Th>
                                <Th right>Running</Th>
                                <Th right>Stopped</Th>
                                <Th right>Tokens out</Th>
                                <Th right>Compute</Th>
                                <Th right>Storage</Th>
                                <Th right>Total</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...data.monthly].reverse().map((m) => (
                                <tr key={m.month} className="border-t border-zinc-800/70">
                                    <Td className="font-medium text-zinc-200">{m.month}</Td>
                                    <Td right>{fmtDuration(m.runningSeconds)}</Td>
                                    <Td right>{fmtDuration(m.stoppedSeconds)}</Td>
                                    <Td right>{fmtInt(m.generationTokens)}</Td>
                                    <Td right>{fmtUsd(m.computeCostUsd)}</Td>
                                    <Td right>{fmtUsd(m.storageCostUsd)}</Td>
                                    <Td right className="font-medium">
                                        {fmtUsd(m.computeCostUsd + m.storageCostUsd)}
                                    </Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="text-[11px] text-zinc-500">
                Estimates from the local ledger (live Pricing-API rates when reachable). Same data as{" "}
                <code>llmrun cost{since ? ` --since ${since}` : ""}</code>.
            </div>
        </div>
    );
}

function Filters({
    since,
    setSince,
    model,
    setModel,
    models,
}: {
    since: string;
    setSince: (v: string) => void;
    model: string;
    setModel: (v: string) => void;
    models: string[];
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-zinc-700">
                {RANGES.map((r) => (
                    <button
                        key={r.label}
                        onClick={() => setSince(r.value)}
                        className={`px-3 py-1.5 text-sm ${
                            since === r.value
                                ? "bg-sky-500/20 text-sky-300"
                                : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                        }`}
                    >
                        {r.label}
                    </button>
                ))}
            </div>
            <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
            >
                <option value="">All models</option>
                {models.map((m) => (
                    <option key={m} value={m}>
                        {m}
                    </option>
                ))}
            </select>
        </div>
    );
}

function DeploymentRow({ d, expanded, onToggle }: { d: DeploymentAggregate; expanded: boolean; onToggle: () => void }) {
    const efficiency = d.efficiency !== null ? `${Math.round(d.efficiency * 100)}%` : "—";

    return (
        <>
            <tr className="cursor-pointer border-t border-zinc-800/70 hover:bg-zinc-800/40" onClick={onToggle}>
                <Td className="font-medium text-zinc-200">
                    {expanded ? "▾ " : "▸ "}
                    {d.name}
                </Td>
                <Td>
                    <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                            d.destroyed ? "bg-zinc-500/15 text-zinc-400" : "bg-emerald-500/15 text-emerald-400"
                        }`}
                    >
                        {d.destroyed ? "destroyed" : "live"}
                    </span>
                </Td>
                <Td className="text-zinc-400">{d.instanceType}</Td>
                <Td className="text-zinc-400">{fmtDate(d.createdAt)}</Td>
                <Td right>{d.sessions.length}</Td>
                <Td right>{fmtDuration(d.runningSeconds)}</Td>
                <Td right title="Active share of running time">
                    {efficiency}
                </Td>
                <Td right>{fmtInt(d.generationTokens)}</Td>
                <Td right>{fmtUsd(d.computeCostUsd)}</Td>
                <Td right>{fmtUsd(d.storageCostUsd)}</Td>
            </tr>
            {expanded && (
                <tr className="border-t border-zinc-800/40 bg-zinc-950/60">
                    <td colSpan={10} className="px-4 py-3">
                        <div className="mb-1 text-xs text-zinc-500">
                            {d.alias} · {d.hfRepo} · {d.region}
                            {d.efficiency !== null && d.efficiency < 0.3 && d.runningSeconds > 3600
                                ? " — mostly idle; consider a shorter idle_timeout"
                                : ""}
                        </div>
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-left uppercase tracking-wide text-zinc-500">
                                    <Th>Session start (UTC)</Th>
                                    <Th>End</Th>
                                    <Th right>Running</Th>
                                    <Th right>Active</Th>
                                    <Th right>Tokens in</Th>
                                    <Th right>Tokens out</Th>
                                    <Th right>Requests</Th>
                                    <Th right>Compute</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {d.sessions.map((s) => (
                                    <tr key={s.startedTs} className="border-t border-zinc-800/40">
                                        <Td>{s.startedTs.replace("T", " ").slice(0, 19)}</Td>
                                        <Td>{s.endedTs ? s.endedTs.replace("T", " ").slice(0, 19) : "running"}</Td>
                                        <Td right>{fmtDuration(s.runningSeconds)}</Td>
                                        <Td right>{fmtDuration(s.activeSeconds)}</Td>
                                        <Td right>{fmtInt(s.promptTokens)}</Td>
                                        <Td right>{fmtInt(s.generationTokens)}</Td>
                                        <Td right>{fmtInt(s.requestSuccess)}</Td>
                                        <Td right>{fmtUsd(s.computeCostUsd)}</Td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </td>
                </tr>
            )}
        </>
    );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
    return <th className={`px-2 py-1.5 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

function Td({
    children,
    right,
    className = "",
    title,
}: {
    children: ReactNode;
    right?: boolean;
    className?: string;
    title?: string;
}) {
    return (
        <td className={`px-2 py-1.5 ${right ? "text-right" : ""} ${className}`} title={title}>
            {children}
        </td>
    );
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
