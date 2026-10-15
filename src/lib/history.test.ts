import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    appendChatTurn,
    appendEvent,
    computeSession,
    conversationTurns,
    deleteConversation,
    listConversations,
    loadEvents,
    stoppedSecondsFor,
    stoppedWindowsFor,
    storageCostFor,
    summarizeDeployment,
    summarizeLedger,
    windowsFor,
    type LedgerEvent,
} from "./history.js";
import { STORAGE_USD_PER_GB_MONTH } from "./pricing.js";

const HOUR = 3_600_000;
const iso = (s: string) => new Date(s).toISOString();

function up(id: string, ts: string, over: Record<string, unknown> = {}): LedgerEvent {
    return {
        t: "up",
        id,
        ts: iso(ts),
        name: `dep-${id}`,
        alias: "qwen",
        hfRepo: "Qwen/Qwen3",
        instanceId: `i-${id}`,
        instanceType: "g5.xlarge",
        engine: "vllm",
        mode: "gpu",
        region: "us-east-1",
        diskGb: 100,
        usdPerHour: 2,
        ...over,
    } as LedgerEvent;
}

const started = (id: string, ts: string): LedgerEvent => ({ t: "instance_started", id, ts: iso(ts), source: "ec2" });
const stopped = (id: string, ts: string, source: "ec2" | "destroy" = "ec2"): LedgerEvent => ({
    t: "instance_stopped",
    id,
    ts: iso(ts),
    source,
});
const down = (id: string, ts: string): LedgerEvent => ({ t: "down", id, ts: iso(ts) });
const snap = (id: string, ts: string, prompt: number, gen: number, active = 0): LedgerEvent => ({
    t: "usage_snapshot",
    id,
    ts: iso(ts),
    srcTs: Math.floor(Date.parse(ts) / 1000),
    runningSeconds: 0,
    activeSeconds: active,
    promptTokens: prompt,
    generationTokens: gen,
    requestSuccess: 0,
    resets: 0,
});

const STORAGE_PER_HOUR = (100 * STORAGE_USD_PER_GB_MONTH) / 730;

/**
 * Deployment "a": a 4h window straddling Jan→Feb, 48h stopped, then a second
 * window open at NOW (2h in).
 */
const NOW = "2026-02-03T04:00:00.000Z";
const ledgerA = (): LedgerEvent[] => [
    up("a", "2026-01-31T21:00:00Z"),
    started("a", "2026-01-31T22:00:00Z"),
    snap("a", "2026-01-31T22:00:00Z", 0, 0),
    snap("a", "2026-02-01T00:00:00Z", 100, 1000, 600),
    snap("a", "2026-02-01T02:00:00Z", 300, 3000, 1800),
    stopped("a", "2026-02-01T02:00:00Z"),
    started("a", "2026-02-03T02:00:00Z"),
];

describe("windowsFor / stoppedWindowsFor", () => {
    it("pairs start/stop and leaves the last window open", () => {
        expect(windowsFor("a", ledgerA())).toEqual([
            { startedTs: iso("2026-01-31T22:00:00Z"), stoppedTs: iso("2026-02-01T02:00:00Z"), source: "ec2" },
            { startedTs: iso("2026-02-03T02:00:00Z"), stoppedTs: null, source: "ec2" },
        ]);
    });

    it("derives the stopped gap between running windows", () => {
        expect(stoppedWindowsFor("a", ledgerA())).toEqual([
            { startedTs: iso("2026-02-01T02:00:00Z"), endedTs: iso("2026-02-03T02:00:00Z") },
        ]);
    });

    it("leaves an open-ended window while still stopped", () => {
        const evs = [
            up("a", "2026-01-01T00:00:00Z"),
            started("a", "2026-01-01T00:00:00Z"),
            stopped("a", "2026-01-01T01:00:00Z"),
        ];

        expect(stoppedWindowsFor("a", evs)).toEqual([{ startedTs: iso("2026-01-01T01:00:00Z"), endedTs: null }]);
    });

    it("accrues no storage after destroy, and caps a stopped window at `down`", () => {
        const destroyed = [
            up("a", "2026-01-01T00:00:00Z"),
            started("a", "2026-01-01T00:00:00Z"),
            stopped("a", "2026-01-01T01:00:00Z", "destroy"),
            down("a", "2026-01-01T01:00:00Z"),
        ];

        expect(stoppedWindowsFor("a", destroyed)).toEqual([]);

        const stoppedThenDown = [
            up("a", "2026-01-01T00:00:00Z"),
            started("a", "2026-01-01T00:00:00Z"),
            stopped("a", "2026-01-01T01:00:00Z"),
            down("a", "2026-01-02T01:00:00Z"),
        ];

        expect(stoppedSecondsFor("a", NOW, stoppedThenDown)).toBe(86400);
    });

    it("ignores events after `down` (a reused id cannot reopen windows)", () => {
        const evs = [
            up("a", "2026-01-01T00:00:00Z"),
            started("a", "2026-01-01T00:00:00Z"),
            stopped("a", "2026-01-01T01:00:00Z"),
            down("a", "2026-01-01T02:00:00Z"),
            started("a", "2026-01-05T00:00:00Z"),
        ];

        expect(windowsFor("a", evs)).toHaveLength(1);
    });
});

describe("storageCostFor", () => {
    it("is diskGb × gp3 rate × stopped hours, using 730h months", () => {
        expect(storageCostFor("a", NOW, ledgerA())).toBeCloseTo(48 * STORAGE_PER_HOUR, 6);
    });

    it("is 0 when the disk size is unknown (no up event)", () => {
        const evs = ledgerA().filter((e) => e.t !== "up");

        expect(storageCostFor("a", NOW, evs)).toBe(0);
    });
});

describe("computeSession / summarizeDeployment", () => {
    it("diffs cumulative counters across the window and prices running time", () => {
        const [w1] = windowsFor("a", ledgerA());
        const t = computeSession("a", w1!, NOW, ledgerA());

        expect(t.runningSeconds).toBe(4 * 3600);
        expect(t.promptTokens).toBe(300);
        expect(t.generationTokens).toBe(3000);
        expect(t.activeSeconds).toBe(1800);
        expect(t.computeCostUsd).toBeCloseTo(8, 6);
    });

    it("lets a live rate override the up-time snapshot", () => {
        const [w1] = windowsFor("a", ledgerA());

        expect(computeSession("a", w1!, NOW, ledgerA(), 3).computeCostUsd).toBeCloseTo(12, 6);
    });

    it("sums sessions and storage; open window is priced up to `nowIso`", () => {
        const s = summarizeDeployment("a", ledgerA(), { nowIso: NOW });

        expect(s.sessions).toBe(2);
        expect(s.runningSeconds).toBe(6 * 3600);
        expect(s.computeCostUsd).toBeCloseTo(12, 6);
        expect(s.stoppedSeconds).toBe(48 * 3600);
        expect(s.storageCostUsd).toBeCloseTo(48 * STORAGE_PER_HOUR, 6);
        expect(s.usdPer1MOutTokens).toBeCloseTo(12 / 0.003, 4);
    });

    it("never goes negative when a counter resets", () => {
        const evs = [
            up("a", "2026-01-01T00:00:00Z"),
            started("a", "2026-01-01T00:00:00Z"),
            snap("a", "2026-01-01T00:00:00Z", 500, 500),
            snap("a", "2026-01-01T01:00:00Z", 10, 10),
            stopped("a", "2026-01-01T01:00:00Z"),
        ];
        const t = computeSession("a", windowsFor("a", evs)[0]!, NOW, evs);

        expect(t.promptTokens).toBe(0);
        expect(t.generationTokens).toBe(0);
    });
});

describe("summarizeLedger", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => vi.useRealTimers());

    it("matches summarizeDeployment (CLI and dashboard cannot disagree)", () => {
        const agg = summarizeLedger(ledgerA());
        const s = summarizeDeployment("a", ledgerA(), { nowIso: NOW });
        const d = agg.deployments[0]!;

        expect(agg.deployments).toHaveLength(1);
        expect(d.computeCostUsd).toBeCloseTo(s.computeCostUsd, 6);
        expect(d.storageCostUsd).toBeCloseTo(s.storageCostUsd, 6);
        expect(d.generationTokens).toBe(s.generationTokens);
        expect(d.runningSeconds).toBe(s.runningSeconds);
        expect(d.stoppedSeconds).toBe(s.stoppedSeconds);
        expect(agg.totals.computeCostUsd).toBeCloseTo(12, 6);
    });

    it("attributes cost AND tokens to the month they happened in", () => {
        const agg = summarizeLedger(ledgerA());
        const jan = agg.monthly.find((m) => m.month === "2026-01")!;
        const feb = agg.monthly.find((m) => m.month === "2026-02")!;

        expect(jan.runningSeconds).toBe(2 * 3600);
        expect(jan.computeCostUsd).toBeCloseTo(4, 6);
        expect(jan.generationTokens).toBe(1000);
        expect(feb.generationTokens).toBe(2000);
        // Monthly buckets telescope back to the totals.
        expect(jan.generationTokens + feb.generationTokens).toBe(agg.totals.generationTokens);
        expect(jan.computeCostUsd + feb.computeCostUsd).toBeCloseTo(agg.totals.computeCostUsd, 6);
        expect(jan.storageCostUsd + feb.storageCostUsd).toBeCloseTo(agg.totals.storageCostUsd, 6);
    });

    it("clips windows (not drops them) for --since", () => {
        const agg = summarizeLedger(ledgerA(), { sinceIso: iso("2026-02-01T00:00:00Z") });
        const d = agg.deployments[0]!;

        expect(d.sessions[d.sessions.length - 1]!.runningSeconds).toBe(2 * 3600);
        expect(d.generationTokens).toBe(2000);
        expect(agg.sinceIso).toBe(iso("2026-02-01T00:00:00Z"));
    });

    it("omits deployments with nothing in range", () => {
        const agg = summarizeLedger(ledgerA(), { sinceIso: iso("2026-02-03T03:59:00Z") });

        // Only the last minute of the open window is in range.
        expect(agg.deployments[0]!.runningSeconds).toBe(60);

        const future = summarizeLedger(
            [
                up("z", "2026-01-01T00:00:00Z"),
                started("z", "2026-01-01T00:00:00Z"),
                stopped("z", "2026-01-01T01:00:00Z"),
                down("z", "2026-01-01T01:00:00Z"),
            ],
            {
                sinceIso: iso("2026-02-01T00:00:00Z"),
            }
        );

        expect(future.deployments).toHaveLength(0);
        expect(future.totals.deployments).toBe(0);
    });

    it("filters by model alias and id", () => {
        const evs = [
            ...ledgerA(),
            up("b", "2026-02-03T00:00:00Z", { alias: "llama" }),
            started("b", "2026-02-03T00:00:00Z"),
        ];

        expect(summarizeLedger(evs, { model: "llama" }).deployments.map((d) => d.id)).toEqual(["b"]);
        expect(summarizeLedger(evs, { id: "a" }).deployments.map((d) => d.id)).toEqual(["a"]);
        expect(summarizeLedger(evs, { model: "nope" }).deployments).toEqual([]);
    });

    it("marks destroyed deployments and stops the clock at `down`", () => {
        const evs = [
            up("d", "2026-01-01T00:00:00Z"),
            started("d", "2026-01-01T00:00:00Z"),
            down("d", "2026-01-01T03:00:00Z"),
        ];
        const d = summarizeLedger(evs).deployments[0]!;

        expect(d.destroyed).toBe(true);
        expect(d.runningSeconds).toBe(3 * 3600);
        expect(d.computeCostUsd).toBeCloseTo(6, 6);
    });

    it("applies the rate resolver to everything", () => {
        const agg = summarizeLedger(ledgerA(), {}, (region, type, snapshot) => {
            expect(region).toBe("us-east-1");
            expect(type).toBe("g5.xlarge");
            expect(snapshot).toBe(2);

            return 10;
        });

        expect(agg.totals.computeCostUsd).toBeCloseTo(60, 6);
        expect(agg.deployments[0]!.usdPerHour).toBe(10);
    });

    it("skips orphan fragments with no `up` event and rolls up per model", () => {
        const evs = [
            ...ledgerA(),
            started("orphan", "2026-02-01T00:00:00Z"),
            up("c", "2026-02-02T00:00:00Z"),
            started("c", "2026-02-02T00:00:00Z"),
            stopped("c", "2026-02-02T01:00:00Z"),
        ];
        const agg = summarizeLedger(evs);

        expect(agg.deployments.map((d) => d.id).sort()).toEqual(["a", "c"]);
        expect(agg.byModel).toHaveLength(1);
        expect(agg.byModel[0]!.deployments).toBe(2);
        expect(agg.byModel[0]!.computeCostUsd).toBeCloseTo(agg.totals.computeCostUsd, 6);
    });

    it("handles an empty ledger", () => {
        const agg = summarizeLedger([]);

        expect(agg.totals.deployments).toBe(0);
        expect(agg.monthly).toEqual([]);
    });

    it("stays fast with many snapshots (binary search, not a scan per lookup)", () => {
        const evs: LedgerEvent[] = [up("p", "2026-01-01T00:00:00Z"), started("p", "2026-01-01T00:00:00Z")];

        for (let i = 0; i < 20_000; i++)
            evs.push(snap("p", new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString(), i, i));

        const t0 = performance.now();
        const agg = summarizeLedger(evs);

        expect(performance.now() - t0).toBeLessThan(2_000);
        expect(agg.deployments[0]!.generationTokens).toBeGreaterThan(0);
    });

    it("doesn't mutate the caller's events", () => {
        const evs = ledgerA();
        const copy = JSON.stringify(evs);

        summarizeLedger(evs);

        expect(JSON.stringify(evs)).toBe(copy);
    });
});

describe("ledger IO and conversations", () => {
    let home: string;
    const prev = process.env.LLMRUN_HOME;

    beforeEach(() => {
        home = mkdtempSync(path.join(tmpdir(), "llmrun-test-"));
        process.env.LLMRUN_HOME = home;
    });
    afterEach(() => {
        if (prev === undefined) delete process.env.LLMRUN_HOME;
        else process.env.LLMRUN_HOME = prev;
        rmSync(home, { recursive: true, force: true });
    });

    it("returns [] when no ledger exists, creating nothing", () => {
        expect(loadEvents()).toEqual([]);
    });

    it("skips corrupted/partial/unknown lines but keeps valid ones", () => {
        appendEvent(up("a", "2026-01-01T00:00:00Z"));
        appendFileSync(path.join(home, "history.jsonl"), "{not json\n");
        appendFileSync(path.join(home, "history.jsonl"), JSON.stringify({ t: "mystery", id: "a" }) + "\n");
        appendFileSync(path.join(home, "history.jsonl"), '{"t":"down","id":"a","ts":"2026-01-01T00:00:00.000Z"\n'); // torn line
        appendEvent(down("a", "2026-01-02T00:00:00Z"));

        expect(loadEvents().map((e) => e.t)).toEqual(["up", "down"]);
    });

    it("a torn tail line doesn't swallow the next appended event", () => {
        appendEvent(up("a", "2026-01-01T00:00:00Z"));
        appendFileSync(path.join(home, "history.jsonl"), '{"t":"down","id":"a","ts":"2026-01-01'); // crash mid-write, no newline
        appendEvent(down("a", "2026-01-02T00:00:00Z"));

        expect(loadEvents().map((e) => e.t)).toEqual(["up", "down"]);
    });

    it("serves repeat reads from cache and invalidates on append and truncate", () => {
        appendEvent(up("a", "2026-01-01T00:00:00Z"));

        const first = loadEvents();

        expect(loadEvents()).toEqual(first);
        // Callers get their own array: mutating it must not corrupt the cache.
        first.pop();
        expect(loadEvents()).toHaveLength(1);

        appendEvent(down("a", "2026-01-02T00:00:00Z"));
        expect(loadEvents()).toHaveLength(2);

        writeFileSync(path.join(home, "history.jsonl"), "");
        expect(loadEvents()).toEqual([]);

        rmSync(path.join(home, "history.jsonl"));
        expect(loadEvents()).toEqual([]);
    });

    it("persists chat turns with tool calls and lists conversations newest first", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
        appendChatTurn(
            "a",
            "c1",
            [
                { role: "user", content: "  What is\n  the weather?  " },
                { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "weather", arguments: '{"q":1}' }] },
            ],
            { promptTokens: 10, completionTokens: 5 }
        );
        vi.setSystemTime(new Date("2026-03-01T10:05:00Z"));
        appendChatTurn(
            "a",
            "c1",
            [
                { role: "user", content: "again" },
                { role: "assistant", content: "ok" },
            ],
            { promptTokens: 7, completionTokens: 3 }
        );
        vi.setSystemTime(new Date("2026-03-01T11:00:00Z"));
        appendChatTurn("a", "c2", [
            { role: "user", content: "x".repeat(200) },
            { role: "assistant", content: "y" },
        ]);
        appendChatTurn("other", "c9", [
            { role: "user", content: "hi" },
            { role: "assistant", content: "yo" },
        ]);
        vi.useRealTimers();

        const convs = listConversations("a");

        expect(convs.map((c) => c.conversationId)).toEqual(["c2", "c1"]);
        expect(convs[1]).toMatchObject({
            title: "What is the weather?",
            turns: 2,
            promptTokens: 17,
            completionTokens: 8,
        });
        expect(convs[0]!.title).toHaveLength(80);

        const turns = conversationTurns("a", "c1");

        expect(turns).toHaveLength(2);
        expect(turns[0]!.messages[1]!.toolCalls?.[0]).toMatchObject({ name: "weather", arguments: '{"q":1}' });
    });

    it("tombstones deleted conversations without touching the file's history", () => {
        appendChatTurn("a", "c1", [
            { role: "user", content: "hi" },
            { role: "assistant", content: "yo" },
        ]);
        deleteConversation("a", "c1");

        expect(listConversations("a")).toEqual([]);
        expect(loadEvents().filter((e) => e.t === "chat")).toHaveLength(1);
    });

    it("tolerates a ledger that was truncated by `history --clear`", () => {
        writeFileSync(path.join(home, "history.jsonl"), "");

        expect(loadEvents()).toEqual([]);
        expect(listConversations("a")).toEqual([]);
    });

    it("creates the home dir on first append", () => {
        const nested = path.join(home, "fresh");

        process.env.LLMRUN_HOME = nested;
        appendEvent(down("a", "2026-01-01T00:00:00Z"));

        expect(loadEvents()).toHaveLength(1);
        mkdirSync(nested, { recursive: true });
    });
});
