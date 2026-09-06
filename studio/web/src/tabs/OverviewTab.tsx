import { useState } from "react";
import type { DeploymentInfo } from "../api";
import { fmtDuration, fmtInt, fmtUsd, stateBadgeClass } from "../util";

interface Props {
    deployments: DeploymentInfo[];
    busy: string | null;
    onAction: (name: string, action: string) => void;
}

function actionsFor(d: DeploymentInfo): { label: string; action: string; danger?: boolean }[] {
    const out: { label: string; action: string; danger?: boolean }[] = [];
    if (d.state === "running") {
        out.push(d.connected ? { label: "Disconnect", action: "disconnect" } : { label: "Connect", action: "connect" });
        out.push({ label: "Stop", action: "stop", danger: true });
    } else if (d.state === "stopped") {
        out.push({ label: "Start", action: "start" });
    }
    return out;
}

function Card({ d, busy, onAction }: { d: DeploymentInfo; busy: string | null; onAction: Props["onAction"] }) {
    const [copied, setCopied] = useState(false);

    const copyEndpoint = async () => {
        try {
            await navigator.clipboard.writeText(d.endpoint);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
        } catch {
            // Clipboard unavailable (focus/permissions) — ignore.
        }
    };

    return (
        <div className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-base font-semibold">{d.name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateBadgeClass(d.state)}`}>
                            {d.state}
                        </span>
                    </div>
                    <div className="mt-1 truncate text-sm text-zinc-400">
                        {d.alias} · {d.hfRepo}
                    </div>
                </div>
                <div className="flex shrink-0 gap-2">
                    {actionsFor(d).map((a) => (
                        <button
                            key={a.action}
                            disabled={busy !== null}
                            onClick={() => onAction(d.name, a.action)}
                            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                                a.danger
                                    ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                                    : "bg-sky-500/10 text-sky-400 hover:bg-sky-500/20"
                            }`}
                        >
                            {busy === `${d.name}:${a.action}` ? "Working…" : a.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <KV k="Instance" v={`${d.instanceType} (${d.mode})`} />
                <KV k="Region" v={d.region} />
                <KV k="Rate" v={fmtUsd(d.usdPerHour) + "/hr"} />
                <KV k="Uptime" v={fmtDuration(d.uptimeSeconds)} />
            </div>

            <div className="flex items-center gap-2 text-sm">
                <code className="truncate rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{d.endpoint}</code>
                <button onClick={() => void copyEndpoint()} className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200">
                    {copied ? "copied" : "copy"}
                </button>
                {d.connected && (
                    <span className="shrink-0 text-xs text-emerald-400">forward active (port {d.localPort})</span>
                )}
            </div>

            {d.session && (
                <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
                    <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Current session</div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
                        <KV k="Running" v={fmtDuration(d.session.runningSeconds)} />
                        <KV k="Cost so far" v={fmtUsd(d.session.computeCostUsd)} />
                        <KV k="$ / 1M out" v={fmtUsd(d.session.usdPer1MOutTokens, 3)} />
                        <KV k="Tokens in" v={fmtInt(d.session.promptTokens)} />
                        <KV k="Tokens out" v={fmtInt(d.session.generationTokens)} />
                        <KV k="Requests" v={fmtInt(d.session.requestSuccess)} />
                    </div>
                </div>
            )}

            <div className="text-xs text-zinc-500">
                Lifetime ({d.totals.sessions} session{d.totals.sessions === 1 ? "" : "s"}): {fmtDuration(d.totals.runningSeconds)}
                · {fmtUsd(d.totals.computeCostUsd)} · {fmtInt(d.totals.promptTokens)} in / {fmtInt(d.totals.generationTokens)} out
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

export default function OverviewTab({ deployments, busy, onAction }: Props) {
    if (deployments.length === 0) {
        return (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-10 text-center text-zinc-400">
                No deployments. Create one with <code className="text-zinc-200">llmrun up</code>.
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {deployments.map((d) => (
                <Card key={d.name} d={d} busy={busy} onAction={onAction} />
            ))}
        </div>
    );
}
