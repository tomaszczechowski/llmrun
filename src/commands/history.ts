import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import type { GlobalFlags } from "../lib/context.js";
import { historyFile, globalConfigPath, packageRoot } from "../lib/paths.js";
import { listDeployments } from "../lib/state.js";
import { loadEvents, summarizeLedger } from "../lib/history.js";
import { createZip, type ZipEntry } from "../lib/zip.js";
import { LlmrunError, formatDuration } from "../lib/errors.js";
import { formatUsd } from "../lib/instances.js";
import { heading, table, info, success, dim, formatInt } from "../lib/ui.js";

/**
 * `llmrun history` — the ledger browser: every deployment ever recorded
 * (running + destroyed), with an export escape hatch (single-file zip) and
 * the one sanctioned deletion path (`--clear`).
 */

export interface HistoryOptions {
    clear?: boolean;
}

export async function historyCommand(_flags: GlobalFlags, opts: HistoryOptions): Promise<void> {
    if (opts.clear) {
        const ok = await confirm({
            message: `Delete the entire usage ledger (${historyFile()})? Sessions, tokens, costs, and chat history are gone for good.`,
            default: false,
        });

        if (!ok) {
            info("Aborted. The ledger is untouched.");

            return;
        }
        writeFileSync(historyFile(), "");
        success("Usage ledger cleared.");

        return;
    }

    const events = loadEvents();

    if (events.length === 0) {
        info("No history yet — the ledger fills as you run `llmrun up`.");

        return;
    }

    // Snapshot rates (no network here): `llmrun cost` is the live-priced view.
    const agg = summarizeLedger(events);

    heading("History — every deployment recorded in the ledger");
    table(
        ["NAME", "MODEL", "STATUS", "CREATED", "LAST ACTIVITY", "SESSIONS", "RUNNING", "OUT TOKENS", "COST"],
        agg.deployments.map((d) => [
            d.name,
            d.alias,
            d.destroyed ? "destroyed" : "live",
            d.createdAt.slice(0, 10),
            d.lastTs.slice(0, 10),
            String(d.sessions.length),
            formatDuration(d.runningSeconds),
            formatInt(d.generationTokens),
            formatUsd(d.computeCostUsd + d.storageCostUsd),
        ])
    );

    let size = "";

    if (existsSync(historyFile())) {
        const kb = statSync(historyFile()).size / 1024;
        size = ` (${events.length} events, ${kb.toFixed(1)} KB)`;
    }
    console.log("");
    console.log(dim(`  Ledger: ${historyFile()}${size}`));
    console.log(dim("  `llmrun cost [--since 30d]` for the money view · `llmrun history export <file>` to back up."));
}

/** Export the ledger (+ non-secret deployment metadata) to a single-file zip. */
export async function historyExportCommand(destArg: string): Promise<void> {
    if (!existsSync(historyFile())) {
        throw new LlmrunError("No usage ledger to export yet.", "Run `llmrun up` and use the deployment first.");
    }

    const dest = destArg.toLowerCase().endsWith(".zip") ? destArg : `${destArg}.zip`;
    const entries: ZipEntry[] = [];
    entries.push({ name: "history.jsonl", data: readFileSync(historyFile()) });

    // Deployment metadata only — never the workspace terraform files (tfvars
    // carry the HF token and have no business leaving the deployment dir).
    for (const d of listDeployments()) {
        entries.push({
            name: `deployments/${d.name}/deployment.json`,
            data: JSON.stringify(d, null, 4) + "\n",
        });
    }
    if (existsSync(globalConfigPath())) {
        entries.push({ name: "config.json", data: readFileSync(globalConfigPath()) });
    }

    let version = "unknown";
    try {
        version =
            (JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version?: string })
                .version ?? version;
    } catch {
        // Manifest without a version is still useful.
    }
    entries.push({
        name: "manifest.json",
        data:
            JSON.stringify(
                {
                    tool: "llmrun",
                    version,
                    exportedAt: new Date().toISOString(),
                    entries: entries.map((e) => e.name),
                    restore: "Copy history.jsonl to ~/.llmrun/history.jsonl on the new machine.",
                },
                null,
                4
            ) + "\n",
    });

    const zip = createZip(entries);
    writeFileSync(dest, zip);
    success(`Exported ${entries.length} files (${(zip.length / 1024).toFixed(1)} KB) to ${dest}`);
    info(dim("Restore: unzip and copy history.jsonl back into ~/.llmrun/ on the new machine."));
}
