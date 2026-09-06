import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { historyFile, homeDir } from "./paths.js";
import type { AwsSelection } from "./config.js";
import { updateDeployment, type DeploymentState } from "./state.js";
import { describeInstance, runSsmCommand, type InstanceInfo } from "./aws.js";
import { estimateCost } from "./instances.js";

/**
 * Durable usage ledger: append-only `~/.llmrun/history.jsonl`.
 *
 * One JSON event per line, written by CLI lifecycle commands and aggregated in
 * memory on read. The file lives outside the deployment workspaces, so
 * `llmrun down`'s `rm -rf` can never destroy it — the only deletion path is an
 * explicit clear by the user.
 *
 * The instance-side `/var/lib/llmrun/usage.jsonl` is a transient transport
 * buffer (it dies with the instance), not storage. It is pulled into this
 * ledger via SSM by `flushInstanceUsage`, deduped by the instance timestamp.
 */

const uuid = z.string().min(1);
const isoTs = z.string().datetime();

/** Deployment created (`llmrun up`). `usdPerHour` snapshots the rate table. */
const upEventSchema = z.object({
    t: z.literal("up"),
    id: uuid,
    ts: isoTs,
    name: z.string(),
    alias: z.string(),
    hfRepo: z.string(),
    instanceId: z.string(),
    instanceType: z.string(),
    engine: z.enum(["vllm", "ollama"]),
    mode: z.enum(["gpu", "cpu"]),
    region: z.string(),
    diskGb: z.number(),
    contextLength: z.number().optional(),
    quantization: z.string().optional(),
    toolCallParser: z.string().optional(),
    usdPerHour: z.number(),
});

/** A running window opened (reconciled from EC2 `StartTime`). */
const instanceStartedSchema = z.object({
    t: z.literal("instance_started"),
    id: uuid,
    ts: isoTs,
    source: z.enum(["ec2", "cli"]).default("ec2"),
});

/** A running window closed. `destroy` = ended by `llmrun down` (no EC2 stop state). */
const instanceStoppedSchema = z.object({
    t: z.literal("instance_stopped"),
    id: uuid,
    ts: isoTs,
    source: z.enum(["ec2", "destroy"]),
});

/**
 * Ingested instance usage buffer line. All counters are *cumulative* on the
 * instance's root disk (they survive stop/start) and monotone within it (the
 * instance monitor handles vLLM container-restart counter resets).
 */
const usageSnapshotSchema = z.object({
    t: z.literal("usage_snapshot"),
    id: uuid,
    ts: isoTs,
    /** Instance-side epoch seconds; the dedupe key for re-ingestion. */
    srcTs: z.number().int().nonnegative(),
    runningSeconds: z.number().int().nonnegative(),
    activeSeconds: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    generationTokens: z.number().int().nonnegative(),
    requestSuccess: z.number().int().nonnegative(),
    /** Cumulative counter resets observed (vLLM container restarts). */
    resets: z.number().int().nonnegative(),
});

/** Computed totals for one closed (or open) running window. */
const sessionEndSchema = z.object({
    t: z.literal("session_end"),
    id: uuid,
    ts: isoTs,
    startedTs: isoTs,
    runningSeconds: z.number().int().nonnegative(),
    activeSeconds: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    generationTokens: z.number().int().nonnegative(),
    requestSuccess: z.number().int().nonnegative(),
    computeCostUsd: z.number(),
    storageCostUsd: z.number(),
    usdPer1MOutTokens: z.number(),
});

/** Deployment destroyed (`llmrun down`). */
const downEventSchema = z.object({
    t: z.literal("down"),
    id: uuid,
    ts: isoTs,
});

/** Chat turn (phase 2). */
const chatEventSchema = z.object({
    t: z.literal("chat"),
    id: uuid,
    ts: isoTs,
    conversationId: z.string(),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() })),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
});

export const ledgerEventSchema = z.discriminatedUnion("t", [
    upEventSchema,
    instanceStartedSchema,
    instanceStoppedSchema,
    usageSnapshotSchema,
    sessionEndSchema,
    downEventSchema,
    chatEventSchema,
]);

export type LedgerEvent = z.infer<typeof ledgerEventSchema>;

/** Line format of the instance-side `/var/lib/llmrun/usage.jsonl` buffer. */
export const usageLineSchema = z.object({
    ts: z.number().int().nonnegative(),
    run: z.number().int().nonnegative(),
    act: z.number().int().nonnegative(),
    p: z.number().int().nonnegative(),
    g: z.number().int().nonnegative(),
    r: z.number().int().nonnegative(),
    rst: z.number().int().nonnegative(),
});

export function appendEvent(event: LedgerEvent): void {
    mkdirSync(homeDir(), { recursive: true });
    appendFileSync(historyFile(), JSON.stringify(event) + "\n");
}

/** Read the whole ledger, skipping malformed lines (tolerate partial writes). */
export function loadEvents(): LedgerEvent[] {
    if (!existsSync(historyFile())) return [];

    const out: LedgerEvent[] = [];
    for (const line of readFileSync(historyFile(), "utf8").split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) continue;
        try {
            out.push(ledgerEventSchema.parse(JSON.parse(trimmed)));
        } catch {
            // Skip rather than fail a read on a corrupted line.
        }
    }
    return out;
}

export function eventsFor(id: string): LedgerEvent[] {
    return loadEvents().filter((e) => e.id === id);
}

/** The `usdPerHour` rate recorded at `up` (0 if unknown). */
export function usdPerHourFor(id: string, events?: LedgerEvent[]): number {
    const evs = events ?? eventsFor(id);

    return evs.find((e) => e.t === "up")?.usdPerHour ?? 0;
}

export interface RunningWindow {
    startedTs: string;
    /** null = the window is still open (instance running). */
    stoppedTs: string | null;
    source: "ec2" | "destroy";
}

/** All running windows for a deployment id, in start order. */
export function windowsFor(id: string, events?: LedgerEvent[]): RunningWindow[] {
    const evs = (events ?? eventsFor(id)).slice().sort((a, b) => a.ts.localeCompare(b.ts));
    const windows: RunningWindow[] = [];
    let open: { startedTs: string } | null = null;

    for (const e of evs) {
        if (e.t === "down") break;
        if (e.t === "instance_started" && !open) open = { startedTs: e.ts };
        else if (e.t === "instance_stopped" && open) {
            windows.push({ startedTs: open.startedTs, stoppedTs: e.ts, source: e.source });
            open = null;
        }
    }
    if (open) windows.push({ startedTs: open.startedTs, stoppedTs: null, source: "ec2" });

    return windows;
}

interface Cumulatives {
    runningSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
}

function cumulativeUsage(id: string, asOfIso: string, events?: LedgerEvent[]): Cumulatives {
    const zero: Cumulatives = { runningSeconds: 0, activeSeconds: 0, promptTokens: 0, generationTokens: 0, requestSuccess: 0 };
    const evs = events ?? eventsFor(id);
    let best: Cumulatives = zero;

    for (const e of evs) {
        if (e.t === "usage_snapshot" && e.ts <= asOfIso) {
            best = {
                runningSeconds: e.runningSeconds,
                activeSeconds: e.activeSeconds,
                promptTokens: e.promptTokens,
                generationTokens: e.generationTokens,
                requestSuccess: e.requestSuccess,
            };
        }
    }
    return best;
}

export interface SessionTotals {
    startedTs: string;
    runningSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    storageCostUsd: number;
    usdPer1MOutTokens: number;
}

/**
 * Compute totals for one running window. Tokens/active-seconds come from usage
 * snapshot diffs (cumulative counters, so a reset-safe baseline); running time
 * and cost come from the window timestamps × the `up`-time rate (phase 1 is
 * compute-only — storage-while-stopped lands in phase 2).
 */
export function computeSession(id: string, window: RunningWindow, nowIso = new Date().toISOString(), events?: LedgerEvent[]): SessionTotals {
    const evs = events ?? eventsFor(id);
    const endTs = window.stoppedTs ?? nowIso;
    const base = cumulativeUsage(id, window.startedTs, evs);
    const end = cumulativeUsage(id, endTs, evs);

    const runningSeconds = Math.max(0, Math.round((Date.parse(endTs) - Date.parse(window.startedTs)) / 1000));
    const activeSeconds = Math.max(0, end.activeSeconds - base.activeSeconds);
    const promptTokens = Math.max(0, end.promptTokens - base.promptTokens);
    const generationTokens = Math.max(0, end.generationTokens - base.generationTokens);
    const requestSuccess = Math.max(0, end.requestSuccess - base.requestSuccess);
    const computeCostUsd = (runningSeconds / 3600) * usdPerHourFor(id, evs);
    const millionOut = generationTokens / 1e6;

    return {
        startedTs: window.startedTs,
        runningSeconds,
        activeSeconds,
        promptTokens,
        generationTokens,
        requestSuccess,
        computeCostUsd,
        storageCostUsd: 0,
        usdPer1MOutTokens: millionOut > 0 ? computeCostUsd / millionOut : 0,
    };
}

/** Aggregate all windows (open + closed) for a deployment id. */
export function summarizeDeployment(id: string, events?: LedgerEvent[]): {
    sessions: number;
    runningSeconds: number;
    activeSeconds: number;
    promptTokens: number;
    generationTokens: number;
    requestSuccess: number;
    computeCostUsd: number;
    usdPer1MOutTokens: number;
} {
    const evs = events ?? eventsFor(id);
    const windows = windowsFor(id, evs);
    const sum = windows.reduce(
        (acc, w) => {
            const t = computeSession(id, w, undefined, evs);
            acc.runningSeconds += t.runningSeconds;
            acc.activeSeconds += t.activeSeconds;
            acc.promptTokens += t.promptTokens;
            acc.generationTokens += t.generationTokens;
            acc.requestSuccess += t.requestSuccess;
            acc.computeCostUsd += t.computeCostUsd;
            return acc;
        },
        { sessions: windows.length, runningSeconds: 0, activeSeconds: 0, promptTokens: 0, generationTokens: 0, requestSuccess: 0, computeCostUsd: 0 }
    );
    const millionOut = sum.generationTokens / 1e6;

    return { ...sum, usdPer1MOutTokens: millionOut > 0 ? sum.computeCostUsd / millionOut : 0 };
}

/**
 * Close the open running window (if any) for a deployment id: append
 * `instance_stopped` and the computed `session_end`. Returns true if a window
 * was closed.
 */
export function closeOpenWindow(id: string, stoppedTs: string, source: "ec2" | "destroy"): boolean {
    const events = eventsFor(id);
    const windows = windowsFor(id, events);
    const open = windows[windows.length - 1];

    if (!open || open.stoppedTs !== null) return false;

    appendEvent({ t: "instance_stopped", id, ts: stoppedTs, source });
    const totals = computeSession(id, { startedTs: open.startedTs, stoppedTs, source }, stoppedTs, events);
    appendEvent({
        t: "session_end",
        id,
        ts: stoppedTs,
        startedTs: open.startedTs,
        runningSeconds: totals.runningSeconds,
        activeSeconds: totals.activeSeconds,
        promptTokens: totals.promptTokens,
        generationTokens: totals.generationTokens,
        requestSuccess: totals.requestSuccess,
        computeCostUsd: totals.computeCostUsd,
        storageCostUsd: totals.storageCostUsd,
        usdPer1MOutTokens: totals.usdPer1MOutTokens,
    });
    return true;
}

/**
 * Reconcile the ledger with EC2 ground truth for a deployment. Appends the
 * missing `instance_started` / `instance_stopped` events so running hours are
 * exact even when the laptop was off across stop/start cycles. Idempotent: the
 * EC2 `StartTime` identifies the current running window.
 */
export async function reconcileLifecycle(sel: AwsSelection, state: DeploymentState, info?: InstanceInfo): Promise<void> {
    const instanceId = state.instanceId;

    if (!instanceId) return;

    // Mint identity for deployments created before the ledger existed.
    let id = state.deploymentId;
    if (!id) {
        id = randomUUID();
        updateDeployment(state.name, { deploymentId: id });
        appendEvent({
            t: "up",
            id,
            ts: state.createdAt,
            name: state.name,
            alias: state.alias,
            hfRepo: state.hf_repo,
            instanceId,
            instanceType: state.instanceType,
            engine: state.engine,
            mode: state.mode,
            region: state.region,
            diskGb: 0,
            usdPerHour: estimateCost(state.instanceType)?.usdPerHour ?? 0,
        });
    }

    if (eventsFor(id).some((e) => e.t === "down")) return;

    const live = info ?? (await describeInstance(sel, instanceId).catch(() => undefined));

    if (!live) return; // destroyed — the `down` command owns that event

    const events = eventsFor(id);
    const windows = windowsFor(id, events);
    const open = windows[windows.length - 1];
    const startedAt = live.startTime;

    if (live.state === "running") {
        if (!open) {
            appendEvent({ t: "instance_started", id, ts: startedAt ?? new Date().toISOString(), source: "ec2" });
        } else if (startedAt && open.startedTs !== startedAt) {
            // A stop/start cycle happened while unreconciled: close the stale
            // window at the new start, open the current one. (Without an EC2
            // stop time, the gap is attributed to the old window — bounded overcount.)
            closeOpenWindow(id, startedAt, "ec2");
            appendEvent({ t: "instance_started", id, ts: startedAt, source: "ec2" });
        }
    } else if (live.state === "stopped") {
        if (!open) {
            // A full window was missed; EC2 StartTime marks its start.
            if (startedAt) {
                appendEvent({ t: "instance_started", id, ts: startedAt, source: "ec2" });
                closeOpenWindow(id, new Date().toISOString(), "ec2");
            }
        } else if (startedAt && open.startedTs !== startedAt) {
            closeOpenWindow(id, startedAt, "ec2");
            appendEvent({ t: "instance_started", id, ts: startedAt, source: "ec2" });
            closeOpenWindow(id, new Date().toISOString(), "ec2");
        }
    }
    // pending/stopping/shutting-down are transient — the next pass settles them.
}

/** How many lines to read per SSM transfer (stays under the 4 KB output cap). */
const USAGE_CHUNK = 20;

const usageReadCommand =
    "sudo bash -c 'f=/var/lib/llmrun/usage.jsonl; [ -s \"$f\" ] || exit 0; n=$(wc -l < \"$f\"); c=$(( n < " +
    USAGE_CHUNK +
    " ? n : " +
    USAGE_CHUNK +
    " )); head -n \"$c\" \"$f\"'";

function usageTruncateCommand(removed: number): string {
    return (
        "sudo bash -c 'f=/var/lib/llmrun/usage.jsonl; t=/var/lib/llmrun/usage.jsonl.tmp; " +
        `tail -n +$(( ${removed} + 1 )) "$f" > "$t" 2>/dev/null || true; ` +
        'cat "$t" > "$f" 2>/dev/null || : > "$f"; rm -f "$t"'
    );
}

/**
 * Pull the instance's transient usage buffer into the ledger in small chunks
 * (SSM command output is capped at 4 KB), then trim the buffer on the instance
 * after each successful transfer. At-least-once safe: lines are deduped by the
 * instance timestamp, so a crash between transfer and trim just re-reads.
 *
 * Returns the number of new lines ingested. Stops quietly if the instance is
 * unreachable (e.g. already stopped) — the buffer lives on the instance's disk
 * until `down`.
 */
export async function flushInstanceUsage(sel: AwsSelection, instanceId: string, id: string): Promise<number> {
    const existing = eventsFor(id);
    const seen = new Set(
        existing.filter((e) => e.t === "usage_snapshot").map((e) => (e as { srcTs: number }).srcTs)
    );
    let ingested = 0;

    for (let chunk = 0; chunk < 500; chunk++) {
        const out = await runSsmCommand(sel, instanceId, [usageReadCommand]);

        if (!out) break; // unreachable, timed out, or buffer empty

        const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);

        if (lines.length === 0) break;

        for (const line of lines) {
            try {
                const parsed = usageLineSchema.parse(JSON.parse(line));

                if (seen.has(parsed.ts)) continue;
                seen.add(parsed.ts);
                appendEvent({
                    t: "usage_snapshot",
                    id,
                    ts: new Date(parsed.ts * 1000).toISOString(),
                    srcTs: parsed.ts,
                    runningSeconds: parsed.run,
                    activeSeconds: parsed.act,
                    promptTokens: parsed.p,
                    generationTokens: parsed.g,
                    requestSuccess: parsed.r,
                    resets: parsed.rst,
                });
                ingested++;
            } catch {
                // Torn line (output truncation or corruption) — drop it; the
                // chunk is removed from the buffer below either way.
            }
        }

        const trimmed = await runSsmCommand(sel, instanceId, [usageTruncateCommand(lines.length)]);

        if (!trimmed) break; // instance vanished mid-flush
    }
    return ingested;
}
