import { loadGlobalConfig, resolveAws } from "../lib/config.js";
import type { GlobalFlags } from "../lib/context.js";
import { loadEvents, summarizeLedger, type RateResolver } from "../lib/history.js";
import { getCachedRate, refreshRatesFor } from "../lib/pricing.js";
import { parseSinceIso, formatDuration } from "../lib/errors.js";
import { formatUsd } from "../lib/instances.js";
import { heading, keyValues, table, info, warn, dim, formatInt } from "../lib/ui.js";

/**
 * `llmrun cost` — the money view of the local usage ledger. Same aggregation
 * as the studio History tab (both call `summarizeLedger`), so CLI and
 * dashboard totals always match. Estimates, not AWS billing.
 */

export interface CostOptions {
    since?: string;
    model?: string;
}

/** Run `p` but give up after timeoutMs (live pricing must never block the CLI). */
async function withTimeout(p: Promise<void>, timeoutMs: number): Promise<void> {
    await Promise.race([
        p,
        new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeoutMs);
            t.unref();
        }),
    ]);
}

export async function costCommand(flags: GlobalFlags, opts: CostOptions): Promise<void> {
    const events = loadEvents();

    if (events.length === 0) {
        info("No usage recorded yet — the ledger fills as you run `llmrun up`.");

        return;
    }

    const sinceIso = parseSinceIso(opts.since);
    const sel = resolveAws(flags, undefined, loadGlobalConfig());

    // Best-effort live rates; falls back to the up-time snapshot per deployment.
    const targets = new Map<string, { region: string; instanceType: string }>();

    for (const e of events) {
        if (e.t === "up")
            targets.set(`${e.region}:${e.instanceType}`, { region: e.region, instanceType: e.instanceType });
    }
    await withTimeout(refreshRatesFor(sel, [...targets.values()].slice(0, 25)), 12_000);

    const rateFor: RateResolver = (region, instanceType, snapshot) => getCachedRate(region, instanceType) ?? snapshot;
    const agg = summarizeLedger(events, { sinceIso, model: opts.model }, rateFor);
    const t = agg.totals;

    heading(sinceIso ? `Cost since ${sinceIso.slice(0, 10)}` : "Cost — all time");
    if (opts.model) info(`Filtered to model "${opts.model}".`);
    keyValues([
        ["Compute", `${formatUsd(t.computeCostUsd)}  (${formatDuration(t.runningSeconds)} running)`],
        ["Storage", `${formatUsd(t.storageCostUsd)}  (${formatDuration(t.stoppedSeconds)} stopped — EBS persists)`],
        ["Total", formatUsd(t.computeCostUsd + t.storageCostUsd)],
        [
            "Tokens",
            `${formatInt(t.promptTokens)} in / ${formatInt(t.generationTokens)} out across ${formatInt(t.requestSuccess)} requests`,
        ],
        ["$ / 1M out", t.generationTokens > 0 ? formatUsd(t.usdPer1MOutTokens, 3) : "—"],
        [
            "Utilization",
            t.runningSeconds > 0
                ? `${Math.round((t.activeSeconds / t.runningSeconds) * 100)}% of running time active`
                : "—",
        ],
    ]);

    if (agg.byModel.length > 0) {
        console.log("");
        table(
            ["MODEL", "DEPL.", "RUNNING", "STOPPED", "OUT TOKENS", "COMPUTE", "STORAGE", "$/1M OUT"],
            agg.byModel.map((m) => [
                m.alias,
                String(m.deployments),
                formatDuration(m.runningSeconds),
                formatDuration(m.stoppedSeconds),
                formatInt(m.generationTokens),
                formatUsd(m.computeCostUsd),
                formatUsd(m.storageCostUsd),
                m.generationTokens > 0 ? formatUsd(m.usdPer1MOutTokens, 3) : "—",
            ])
        );
    }

    if (agg.deployments.length > 0) {
        console.log("");
        const shown = agg.deployments.slice(0, 15);
        table(
            ["NAME", "STATUS", "SESSIONS", "RUNNING", "OUT TOKENS", "COMPUTE", "STORAGE"],
            shown.map((d) => [
                d.name,
                d.destroyed ? "destroyed" : "live",
                String(d.sessions.length),
                formatDuration(d.runningSeconds),
                formatInt(d.generationTokens),
                formatUsd(d.computeCostUsd),
                formatUsd(d.storageCostUsd),
            ])
        );
        if (agg.deployments.length > shown.length) {
            console.log(
                dim(`  … and ${agg.deployments.length - shown.length} more (llmrun history for the full list).`)
            );
        }
    }

    if (t.deployments === 0) {
        info("Nothing recorded in this range.");
    }

    // Efficiency nudge: instances that mostly burned money while idle.
    const lazy = agg.deployments.filter((d) => d.efficiency !== null && d.efficiency < 0.3 && d.runningSeconds > 3600);

    for (const d of lazy.slice(0, 3)) {
        console.log("");
        warn(
            `"${d.name}" was active only ${Math.round((d.efficiency ?? 0) * 100)}% of its ${formatDuration(d.runningSeconds)} ` +
                "running time — consider a shorter idle_timeout in llmrun.yaml."
        );
    }

    console.log("");
    console.log(
        dim("  Estimates from ~/.llmrun/history.jsonl (live Pricing-API rates when reachable) — not AWS billing.")
    );
}
