import {
    appendFileSync,
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { historyFile, homeDir } from "./paths.js";
import type { AwsSelection } from "./config.js";
import { updateDeployment, type DeploymentState } from "./state.js";
import { describeInstance, runSsmCommand, type InstanceInfo } from "./aws.js";
import { estimateCost } from "./instances.js";
import { STORAGE_USD_PER_GB_MONTH } from "./pricing.js";

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

/** One tool call made by the assistant within a chat turn. */
const toolCallSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
});

const chatMessageSchema = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCalls: z.array(toolCallSchema).optional(),
});

/** Chat turn (phase 2): exactly one user message and its assistant reply. */
const chatEventSchema = z.object({
    t: z.literal("chat"),
    id: uuid,
    ts: isoTs,
    conversationId: z.string(),
    messages: z.array(chatMessageSchema),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
});

/** Tombstone: a conversation was deleted in the UI (the ledger stays append-only). */
const chatDeleteSchema = z.object({
    t: z.literal("chat_delete"),
    id: uuid,
    ts: isoTs,
    conversationId: z.string(),
});

export const ledgerEventSchema = z.discriminatedUnion("t", [
    upEventSchema,
    instanceStartedSchema,
    instanceStoppedSchema,
    usageSnapshotSchema,
    sessionEndSchema,
    downEventSchema,
    chatEventSchema,
    chatDeleteSchema,
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

/** True when the file is non-empty and doesn't end in a newline (a torn write). */
function endsMidLine(file: string): boolean {
    if (!existsSync(file)) return false;

    const fd = openSync(file, "r");

    try {
        const { size } = fstatSync(fd);

        if (size === 0) return false;

        const last = Buffer.alloc(1);

        readSync(fd, last, 0, 1, size - 1);

        return last[0] !== 0x0a;
    } finally {
        closeSync(fd);
    }
}

export function appendEvent(event: LedgerEvent): void {
    mkdirSync(homeDir(), { recursive: true });

    // A crash mid-append leaves a partial last line; starting a fresh line keeps
    // that fragment from swallowing this (valid) event.
    const prefix = endsMidLine(historyFile()) ? "\n" : "";

    appendFileSync(historyFile(), prefix + JSON.stringify(event) + "\n");
}

// Parsed-ledger cache keyed on file identity. The studio polls every 5 s and
// chat turns make the file large; re-reading and zod-validating all of it per
// poll would grow with total chat volume. Any append/truncate changes size or mtime.
let ledgerCache: { file: string; mtimeMs: number; size: number; events: LedgerEvent[] } | null = null;

/** Read the whole ledger, skipping malformed lines (tolerate partial writes). */
export function loadEvents(): LedgerEvent[] {
    const file = historyFile();

    if (!existsSync(file)) {
        ledgerCache = null;

        return [];
    }

    const st = statSync(file);

    if (
        ledgerCache &&
        ledgerCache.file === file &&
        ledgerCache.mtimeMs === st.mtimeMs &&
        ledgerCache.size === st.size
    ) {
        return ledgerCache.events.slice();
    }

    const out: LedgerEvent[] = [];

    for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) continue;
        try {
            out.push(ledgerEventSchema.parse(JSON.parse(trimmed)));
        } catch {
            // Skip rather than fail a read on a corrupted line.
        }
    }
    ledgerCache = { file, mtimeMs: st.mtimeMs, size: st.size, events: out };

    return out.slice();
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

type UsageSnapshotEvent = Extract<LedgerEvent, { t: "usage_snapshot" }>;

/** A deployment's usage snapshots, ascending by ts — the table `usageAt` searches. */
function snapshotsFor(evs: LedgerEvent[]): UsageSnapshotEvent[] {
    return evs
        .filter((e): e is UsageSnapshotEvent => e.t === "usage_snapshot")
        .sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Cumulative counters as of `asOfIso` — the newest snapshot at or before it.
 * Binary search, because the aggregation samples this at every window *and*
 * month boundary; a scan per lookup makes the whole summary quadratic in
 * snapshot count.
 */
function usageAt(snapshots: UsageSnapshotEvent[], asOfIso: string): Cumulatives {
    let lo = 0;
    let hi = snapshots.length - 1;
    let found = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;

        if (snapshots[mid]!.ts <= asOfIso) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const e = found >= 0 ? snapshots[found]! : undefined;

    if (!e) {
        return { runningSeconds: 0, activeSeconds: 0, promptTokens: 0, generationTokens: 0, requestSuccess: 0 };
    }

    return {
        runningSeconds: e.runningSeconds,
        activeSeconds: e.activeSeconds,
        promptTokens: e.promptTokens,
        generationTokens: e.generationTokens,
        requestSuccess: e.requestSuccess,
    };
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

export interface StoppedWindow {
    startedTs: string;
    /** null = still stopped right now (accruing storage). */
    endedTs: string | null;
}

/** AWS billing convention: 730 hours per month. */
const HOURS_PER_MONTH = 730;

function storageUsdPerSecond(diskGb: number): number {
    return (diskGb * STORAGE_USD_PER_GB_MONTH) / (HOURS_PER_MONTH * 3600);
}

/** Disk size recorded on the `up` event (0 when unknown — legacy deployments). */
function diskGbFor(id: string, events?: LedgerEvent[]): number {
    const evs = events ?? eventsFor(id);

    return evs.find((e) => e.t === "up")?.diskGb ?? 0;
}

/**
 * All stopped windows for a deployment id: the gaps between running windows.
 * Storage (EBS + model cache) keeps billing while an instance is stopped, so
 * these windows are cost-bearing. A `down` event caps the last window (the
 * disk is gone); a still-stopped live deployment has an open-ended window.
 * `instance_stopped` with source `destroy` marks destruction (not stopping) —
 * no storage accrues after it.
 */
export function stoppedWindowsFor(id: string, events?: LedgerEvent[]): StoppedWindow[] {
    const evs = (events ?? eventsFor(id)).slice().sort((a, b) => a.ts.localeCompare(b.ts));
    const windows: StoppedWindow[] = [];
    let stoppedAt: string | null = null;

    for (const e of evs) {
        if (e.t === "instance_stopped" && !stoppedAt) {
            if (e.source === "destroy") continue; // destroyed — the disk is gone with it
            stoppedAt = e.ts;
        } else if (e.t === "instance_started" && stoppedAt) {
            windows.push({ startedTs: stoppedAt, endedTs: e.ts });
            stoppedAt = null;
        } else if (e.t === "down") {
            if (stoppedAt) windows.push({ startedTs: stoppedAt, endedTs: e.ts });

            return windows;
        }
    }
    if (stoppedAt) windows.push({ startedTs: stoppedAt, endedTs: null });

    return windows;
}

/** Total seconds spent stopped (capped at `nowIso` for the open window). */
export function stoppedSecondsFor(id: string, nowIso = new Date().toISOString(), events?: LedgerEvent[]): number {
    let total = 0;

    for (const w of stoppedWindowsFor(id, events)) {
        const end = w.endedTs ?? nowIso;
        total += Math.max(0, (Date.parse(end) - Date.parse(w.startedTs)) / 1000);
    }

    return Math.round(total);
}

/** Storage cost accrued while stopped: diskGb × gp3 rate × stopped time. */
export function storageCostFor(id: string, nowIso = new Date().toISOString(), events?: LedgerEvent[]): number {
    const evs = events ?? eventsFor(id);

    return stoppedSecondsFor(id, nowIso, evs) * storageUsdPerSecond(diskGbFor(id, evs));
}

/**
 * Compute totals for one running window. Tokens/active-seconds come from usage
 * snapshot diffs (cumulative counters, so a reset-safe baseline); running time
 * and cost come from the window timestamps × the rate (the `up`-time snapshot,
 * optionally overridden with a live Pricing-API-refreshed rate).
 *
 * `storageCostUsd` stays 0 on sessions: storage accrues in *stopped* windows,
 * which `summarizeDeployment`/`summarizeLedger` account for separately.
 */
export function computeSession(
    id: string,
    window: RunningWindow,
    nowIso = new Date().toISOString(),
    events?: LedgerEvent[],
    rateUsdPerHour?: number
): SessionTotals {
    const evs = events ?? eventsFor(id);
    const endTs = window.stoppedTs ?? nowIso;
    const snapshots = snapshotsFor(evs);
    const base = usageAt(snapshots, window.startedTs);
    const end = usageAt(snapshots, endTs);

    const runningSeconds = Math.max(0, Math.round((Date.parse(endTs) - Date.parse(window.startedTs)) / 1000));
    const activeSeconds = Math.max(0, end.activeSeconds - base.activeSeconds);
    const promptTokens = Math.max(0, end.promptTokens - base.promptTokens);
    const generationTokens = Math.max(0, end.generationTokens - base.generationTokens);
    const requestSuccess = Math.max(0, end.requestSuccess - base.requestSuccess);
    const rate = rateUsdPerHour ?? usdPerHourFor(id, evs);
    const computeCostUsd = (runningSeconds / 3600) * rate;
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
export function summarizeDeployment(
    id: string,
    events?: LedgerEvent[],
    opts?: { nowIso?: string; rateUsdPerHour?: number }
): {
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
} {
    const evs = events ?? eventsFor(id);
    const nowIso = opts?.nowIso ?? new Date().toISOString();
    const windows = windowsFor(id, evs);
    const sum = windows.reduce(
        (acc, w) => {
            const t = computeSession(id, w, nowIso, evs, opts?.rateUsdPerHour);
            acc.runningSeconds += t.runningSeconds;
            acc.activeSeconds += t.activeSeconds;
            acc.promptTokens += t.promptTokens;
            acc.generationTokens += t.generationTokens;
            acc.requestSuccess += t.requestSuccess;
            acc.computeCostUsd += t.computeCostUsd;

            return acc;
        },
        {
            sessions: windows.length,
            runningSeconds: 0,
            activeSeconds: 0,
            promptTokens: 0,
            generationTokens: 0,
            requestSuccess: 0,
            computeCostUsd: 0,
        }
    );
    const millionOut = sum.generationTokens / 1e6;

    return {
        ...sum,
        stoppedSeconds: stoppedSecondsFor(id, nowIso, evs),
        storageCostUsd: storageCostFor(id, nowIso, evs),
        usdPer1MOutTokens: millionOut > 0 ? sum.computeCostUsd / millionOut : 0,
    };
}

/** All sessions (running windows, open included) with computed totals. */
export function listSessions(id: string, events?: LedgerEvent[], rateUsdPerHour?: number): SessionTotals[] {
    const evs = events ?? eventsFor(id);

    return windowsFor(id, evs).map((w) => computeSession(id, w, undefined, evs, rateUsdPerHour));
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
export async function reconcileLifecycle(
    sel: AwsSelection,
    state: DeploymentState,
    info?: InstanceInfo
): Promise<void> {
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
    'sudo bash -c \'f=/var/lib/llmrun/usage.jsonl; [ -s "$f" ] || exit 0; n=$(wc -l < "$f"); c=$(( n < ' +
    USAGE_CHUNK +
    " ? n : " +
    USAGE_CHUNK +
    ' )); head -n "$c" "$f"\'';

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
    const seen = new Set(existing.filter((e) => e.t === "usage_snapshot").map((e) => (e as { srcTs: number }).srcTs));
    let ingested = 0;

    for (let chunk = 0; chunk < 500; chunk++) {
        const out = await runSsmCommand(sel, instanceId, [usageReadCommand]);

        if (!out) break; // unreachable, timed out, or buffer empty

        const lines = out
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

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

// --- Cross-ledger aggregation (phase 2: /api/history + `llmrun cost`) --------

/** Optional rate override: live Pricing-API rate beats the `up`-time snapshot. */
export type RateResolver = (region: string, instanceType: string, snapshotUsdPerHour: number) => number;

const defaultRate: RateResolver = (_region, _instanceType, snapshot) => snapshot;

export interface LedgerFilter {
    /** Only count time at/after this instant (windows are clipped, not dropped whole). */
    sinceIso?: string;
    /** Exact model alias filter. */
    model?: string;
    /** Exact deployment id filter. */
    id?: string;
}

export interface SessionAggregate {
    startedTs: string;
    /** null = still running. */
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
    /** activeSeconds / runningSeconds, null when never running in range. */
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
    /** "YYYY-MM" (UTC). */
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

type UpEvent = Extract<LedgerEvent, { t: "up" }>;

/** Split [startMs, endMs) into UTC calendar-month buckets of seconds. */
function monthBuckets(
    startMs: number,
    endMs: number
): { month: string; startMs: number; endMs: number; seconds: number }[] {
    const out: { month: string; startMs: number; endMs: number; seconds: number }[] = [];
    let cur = startMs;

    while (cur < endMs) {
        const d = new Date(cur);
        const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        const segEnd = Math.min(endMs, next);
        out.push({
            month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
            startMs: cur,
            endMs: segEnd,
            seconds: (segEnd - cur) / 1000,
        });
        cur = segEnd;
    }

    return out;
}

function zeroTotals(): LedgerTotals {
    return {
        deployments: 0,
        destroyed: 0,
        sessions: 0,
        runningSeconds: 0,
        stoppedSeconds: 0,
        activeSeconds: 0,
        promptTokens: 0,
        generationTokens: 0,
        requestSuccess: 0,
        computeCostUsd: 0,
        storageCostUsd: 0,
        usdPer1MOutTokens: 0,
    };
}

/**
 * Aggregate the whole ledger into per-deployment, per-model, and per-month
 * views, clipped to an optional time range. This single implementation backs
 * both `GET /api/history` and `llmrun cost`, so the CLI and the dashboard can
 * never disagree. Pass a `rateFor` resolver backed by the live pricing cache to
 * price everything at current rates.
 */
export function summarizeLedger(
    events: LedgerEvent[],
    filter: LedgerFilter = {},
    rateFor: RateResolver = defaultRate
): LedgerAggregate {
    const nowMs = Date.now();
    const sinceMs = filter.sinceIso ? Date.parse(filter.sinceIso) : undefined;

    const byId = new Map<string, LedgerEvent[]>();

    for (const e of events) {
        const list = byId.get(e.id);

        if (list) list.push(e);
        else byId.set(e.id, [e]);
    }

    const deployments: DeploymentAggregate[] = [];
    const monthly = new Map<string, MonthAggregate>();

    const monthAt = (month: string): MonthAggregate => {
        let m = monthly.get(month);

        if (!m) {
            m = {
                month,
                runningSeconds: 0,
                stoppedSeconds: 0,
                promptTokens: 0,
                generationTokens: 0,
                computeCostUsd: 0,
                storageCostUsd: 0,
            };
            monthly.set(month, m);
        }

        return m;
    };

    for (const [id, evs] of byId) {
        const up = evs.find((e): e is UpEvent => e.t === "up");

        if (!up) continue; // orphan fragments (shouldn't happen) — skip

        if (filter.id && id !== filter.id) continue;
        if (filter.model && up.alias !== filter.model) continue;

        const down = evs.find((e) => e.t === "down");
        const destroyed = down !== undefined;
        const endCapMs = down ? Date.parse(down.ts) : nowMs;
        const rate = rateFor(up.region, up.instanceType, up.usdPerHour);
        const storageRate = storageUsdPerSecond(up.diskGb);

        const snapshots = snapshotsFor(evs);
        const sessions: SessionAggregate[] = [];
        let runningSeconds = 0;
        let activeSeconds = 0;
        let promptTokens = 0;
        let generationTokens = 0;
        let requestSuccess = 0;
        let computeCostUsd = 0;
        let storageCostUsd = 0;
        let stoppedSeconds = 0;

        for (const w of windowsFor(id, evs)) {
            const startMs = Math.max(Date.parse(w.startedTs), sinceMs ?? -Infinity);
            const rawEndMs = w.stoppedTs ? Date.parse(w.stoppedTs) : endCapMs;
            const endMs = Math.min(rawEndMs, endCapMs);

            if (endMs <= startMs) continue;

            const startIso = new Date(startMs).toISOString();
            const endIso = new Date(endMs).toISOString();
            const base = usageAt(snapshots, startIso);
            const end = usageAt(snapshots, endIso);
            const s: SessionAggregate = {
                startedTs: w.startedTs,
                endedTs: w.stoppedTs,
                runningSeconds: Math.round((endMs - startMs) / 1000),
                activeSeconds: Math.max(0, end.activeSeconds - base.activeSeconds),
                promptTokens: Math.max(0, end.promptTokens - base.promptTokens),
                generationTokens: Math.max(0, end.generationTokens - base.generationTokens),
                requestSuccess: Math.max(0, end.requestSuccess - base.requestSuccess),
                computeCostUsd: ((endMs - startMs) / 3_600_000) * rate,
            };
            sessions.push(s);
            runningSeconds += s.runningSeconds;
            activeSeconds += s.activeSeconds;
            promptTokens += s.promptTokens;
            generationTokens += s.generationTokens;
            requestSuccess += s.requestSuccess;
            computeCostUsd += s.computeCostUsd;

            for (const b of monthBuckets(startMs, endMs)) {
                const m = monthAt(b.month);
                m.runningSeconds += b.seconds;
                m.computeCostUsd += (b.seconds / 3600) * rate;

                // Tokens belong to the month they were generated in, not to the
                // window's first month — a window open across a month boundary
                // would otherwise credit February's tokens to January. Sampling
                // the counters at both bucket edges telescopes back to exactly
                // the session totals computed above.
                const from = usageAt(snapshots, new Date(b.startMs).toISOString());
                const to = usageAt(snapshots, new Date(b.endMs).toISOString());
                m.promptTokens += Math.max(0, to.promptTokens - from.promptTokens);
                m.generationTokens += Math.max(0, to.generationTokens - from.generationTokens);
            }
        }

        for (const w of stoppedWindowsFor(id, evs)) {
            const startMs = Math.max(Date.parse(w.startedTs), sinceMs ?? -Infinity);
            const endMs = Math.min(w.endedTs ? Date.parse(w.endedTs) : endCapMs, endCapMs);

            if (endMs <= startMs) continue;

            const secs = (endMs - startMs) / 1000;
            stoppedSeconds += secs;
            storageCostUsd += secs * storageRate;

            for (const b of monthBuckets(startMs, endMs)) {
                const m = monthAt(b.month);
                m.stoppedSeconds += b.seconds;
                m.storageCostUsd += b.seconds * storageRate;
            }
        }

        if (sessions.length === 0 && stoppedSeconds === 0) continue; // nothing in range

        let lastTs = "";

        for (const e of evs) if (e.ts > lastTs) lastTs = e.ts;

        const millionOut = generationTokens / 1e6;

        deployments.push({
            id,
            name: up.name,
            alias: up.alias,
            hfRepo: up.hfRepo,
            instanceId: up.instanceId,
            instanceType: up.instanceType,
            engine: up.engine,
            mode: up.mode,
            region: up.region,
            diskGb: up.diskGb,
            usdPerHour: rate,
            destroyed,
            createdAt: up.ts,
            lastTs,
            sessions: sessions.sort((a, b) => b.startedTs.localeCompare(a.startedTs)),
            runningSeconds: Math.round(runningSeconds),
            stoppedSeconds: Math.round(stoppedSeconds),
            activeSeconds: Math.round(activeSeconds),
            promptTokens,
            generationTokens,
            requestSuccess,
            computeCostUsd,
            storageCostUsd,
            usdPer1MOutTokens: millionOut > 0 ? computeCostUsd / millionOut : 0,
            efficiency: runningSeconds > 0 ? activeSeconds / runningSeconds : null,
        });
    }

    deployments.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    // Per-model rollup.
    const byAlias = new Map<string, ModelAggregate>();

    for (const d of deployments) {
        let m = byAlias.get(d.alias);

        if (!m) {
            m = {
                alias: d.alias,
                deployments: 0,
                destroyed: 0,
                runningSeconds: 0,
                stoppedSeconds: 0,
                promptTokens: 0,
                generationTokens: 0,
                computeCostUsd: 0,
                storageCostUsd: 0,
                usdPer1MOutTokens: 0,
            };
            byAlias.set(d.alias, m);
        }
        m.deployments += 1;
        if (d.destroyed) m.destroyed += 1;
        m.runningSeconds += d.runningSeconds;
        m.stoppedSeconds += d.stoppedSeconds;
        m.promptTokens += d.promptTokens;
        m.generationTokens += d.generationTokens;
        m.computeCostUsd += d.computeCostUsd;
        m.storageCostUsd += d.storageCostUsd;
    }
    for (const m of byAlias.values()) {
        const millionOut = m.generationTokens / 1e6;
        m.usdPer1MOutTokens = millionOut > 0 ? m.computeCostUsd / millionOut : 0;
    }

    const totals = zeroTotals();

    for (const d of deployments) {
        totals.deployments += 1;
        if (d.destroyed) totals.destroyed += 1;
        totals.sessions += d.sessions.length;
        totals.runningSeconds += d.runningSeconds;
        totals.stoppedSeconds += d.stoppedSeconds;
        totals.activeSeconds += d.activeSeconds;
        totals.promptTokens += d.promptTokens;
        totals.generationTokens += d.generationTokens;
        totals.requestSuccess += d.requestSuccess;
        totals.computeCostUsd += d.computeCostUsd;
        totals.storageCostUsd += d.storageCostUsd;
    }
    {
        const millionOut = totals.generationTokens / 1e6;
        totals.usdPer1MOutTokens = millionOut > 0 ? totals.computeCostUsd / millionOut : 0;
    }

    return {
        generatedAt: new Date(nowMs).toISOString(),
        sinceIso: filter.sinceIso ?? null,
        model: filter.model ?? null,
        totals,
        deployments,
        byModel: [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
        monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    };
}

// --- Conversations (phase 2 chat persistence) ---------------------------------

export interface ConversationSummary {
    conversationId: string;
    title: string;
    turns: number;
    promptTokens: number;
    completionTokens: number;
    firstTs: string;
    lastTs: string;
}

type ChatEvent = Extract<LedgerEvent, { t: "chat" }>;
export type ChatMessage = ChatEvent["messages"][number];

/** All non-deleted conversations for a deployment, most recently active first. */
export function listConversations(id: string, events?: LedgerEvent[]): ConversationSummary[] {
    const evs = events ?? eventsFor(id);
    const deleted = new Set(
        evs.filter((e) => e.t === "chat_delete").map((e) => (e as { conversationId: string }).conversationId)
    );
    const chats = evs
        .filter((e): e is ChatEvent => e.t === "chat" && !deleted.has(e.conversationId))
        .sort((a, b) => a.ts.localeCompare(b.ts));

    const byConv = new Map<string, ChatEvent[]>();

    for (const c of chats) {
        const list = byConv.get(c.conversationId);

        if (list) list.push(c);
        else byConv.set(c.conversationId, [c]);
    }

    const out: ConversationSummary[] = [];

    for (const [cid, turns] of byConv) {
        const first = turns[0]!;
        const last = turns[turns.length - 1]!;
        const firstUser = first.messages.find((m) => m.role === "user")?.content ?? "";
        const title = firstUser.replace(/\s+/g, " ").trim().slice(0, 80);
        let promptTokens = 0;
        let completionTokens = 0;

        for (const t of turns) {
            promptTokens += t.usage?.promptTokens ?? 0;
            completionTokens += t.usage?.completionTokens ?? 0;
        }
        out.push({
            conversationId: cid,
            title: title || "(untitled)",
            turns: turns.length,
            promptTokens,
            completionTokens,
            firstTs: first.ts,
            lastTs: last.ts,
        });
    }

    return out.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

/** All chat turns of one conversation in chronological order. */
export function conversationTurns(id: string, conversationId: string, events?: LedgerEvent[]): ChatEvent[] {
    const evs = events ?? eventsFor(id);

    return evs
        .filter((e): e is ChatEvent => e.t === "chat" && e.conversationId === conversationId)
        .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Persist one completed (or aborted) chat turn. */
export function appendChatTurn(
    id: string,
    conversationId: string,
    messages: ChatMessage[],
    usage?: { promptTokens: number; completionTokens: number }
): void {
    appendEvent({
        t: "chat",
        id,
        ts: new Date().toISOString(),
        conversationId,
        messages,
        usage,
    });
}

/** Tombstone a conversation (append-only: the turns stay in the file, hidden from views). */
export function deleteConversation(id: string, conversationId: string): void {
    appendEvent({ t: "chat_delete", id, ts: new Date().toISOString(), conversationId });
}
