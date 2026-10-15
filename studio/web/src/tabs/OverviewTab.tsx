import { useState } from "react";
import type { DeploymentInfo } from "../api";
import { fmtCountdown, fmtDuration, fmtInt, fmtUsd, stateBadgeClass } from "../util";

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
                <KV k="Rate" v={fmtUsd(d.usdPerHour) + "/hr" + (d.rateLive ? " · live" : "")} />
                <KV k="Uptime" v={fmtDuration(d.uptimeSeconds)} />
            </div>

            {d.state === "running" && <IdleCountdown d={d} />}

            <div className="flex items-center gap-2 text-sm">
                <code className="truncate rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{d.endpoint}</code>
                <button
                    onClick={() => void copyEndpoint()}
                    className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
                >
                    {copied ? "copied" : "copy"}
                </button>
                {d.connected && (
                    <span className="shrink-0 text-xs text-emerald-400">forward active (port {d.localPort})</span>
                )}
            </div>

            {d.session && (
                <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                            Current session
                        </span>
                        <EfficiencyHint d={d} />
                    </div>
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
                Lifetime ({d.totals.sessions} session{d.totals.sessions === 1 ? "" : "s"}):{" "}
                {fmtDuration(d.totals.runningSeconds)} · {fmtUsd(d.totals.computeCostUsd)} ·{" "}
                {fmtInt(d.totals.promptTokens)} in / {fmtInt(d.totals.generationTokens)} out
                {d.totals.stoppedSeconds > 0 && (
                    <>
                        {" "}
                        · stopped {fmtDuration(d.totals.stoppedSeconds)} ({fmtUsd(d.totals.storageCostUsd)} storage)
                    </>
                )}
            </div>
        </div>
    );
}

/** Live auto-stop countdown, computed from the instance's last activity. */
function IdleCountdown({ d }: { d: DeploymentInfo }) {
    let secondsLeft = d.idle?.secondsLeft ?? null;

    if (secondsLeft === null && d.idle?.lastActiveAt && d.idle.timeoutSeconds) {
        secondsLeft = d.idle.timeoutSeconds - (Date.now() / 1000 - Date.parse(d.idle.lastActiveAt) / 1000);
    }

    if (secondsLeft === null) {
        return (
            <div className="text-xs text-zinc-500">
                Auto-stop after <span className="text-zinc-300">{d.idleTimeout}</span> idle — reading the instance…
            </div>
        );
    }
    secondsLeft = Math.max(0, Math.round(secondsLeft));

    return (
        <div
            className={`text-xs ${
                secondsLeft <= 60 ? "text-red-400" : secondsLeft <= 300 ? "text-amber-400" : "text-zinc-500"
            }`}
        >
            {secondsLeft <= 60 ? "Idle auto-stop imminent — " : "Idle auto-stop in "}
            <span className="font-medium">{fmtCountdown(secondsLeft)}</span>
            <span className="text-zinc-500"> (any request, incl. studio chat, resets the timer)</span>
        </div>
    );
}

/** Efficiency nudge: sessions that mostly burned money while idle. */
function EfficiencyHint({ d }: { d: DeploymentInfo }) {
    const s = d.session;

    if (!s || s.runningSeconds < 1800) return null;
    const eff = s.runningSeconds > 0 ? s.activeSeconds / s.runningSeconds : 0;

    if (eff >= 0.3) {
        return <span className="text-[11px] text-emerald-400">{Math.round(eff * 100)}% active</span>;
    }

    return (
        <span
            className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400"
            title="Mostly idle — a shorter idle_timeout (llmrun.yaml) would cut the waste."
        >
            {Math.round(eff * 100)}% active — mostly idle; consider idle_timeout &lt; {d.idleTimeout}
        </span>
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
