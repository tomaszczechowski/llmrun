import { loadGlobalConfig, resolveAws } from "../lib/config.js";
import { loadCatalog } from "../lib/catalog.js";
import { checkTooling, checkAws, type CheckResult } from "../lib/doctor.js";
import type { GlobalFlags } from "../lib/context.js";
import { LlmrunError } from "../lib/errors.js";
import { heading, symbols, dim } from "../lib/ui.js";

function printResults(results: CheckResult[]): void {
    for (const r of results) {
        const icon = r.status === "ok" ? symbols.ok : r.status === "warn" ? symbols.warn : symbols.err;
        const detail = r.detail ? dim(` — ${r.detail}`) : "";
        console.log(`  ${icon} ${r.name}${detail}`);
        if (r.hint && r.status !== "ok") {
            for (const line of r.hint.split("\n")) {
                console.log(`      ${dim(line)}`);
            }
        }
    }
}

/** Run the full preflight and print a report. */
export async function doctorCommand(flags: GlobalFlags): Promise<void> {
    const global = loadGlobalConfig();
    // Catalog is optional for doctor — resolve AWS with whatever we can find.
    let catalog;
    try {
        catalog = loadCatalog().catalog;
    } catch {
        catalog = undefined;
    }
    const sel = resolveAws(flags, catalog, global);

    heading("Tooling");
    const tooling = await checkTooling();
    printResults(tooling);

    heading("AWS");
    const aws = await checkAws(sel);
    printResults(aws);

    const all = [...tooling, ...aws];
    const failed = all.filter((r) => r.status === "fail").length;
    const warned = all.filter((r) => r.status === "warn").length;

    console.log("");
    if (failed > 0) {
        console.log(`${symbols.err} ${failed} check(s) failed. Resolve the above before running \`llmrun up\`.`);
        process.exitCode = 1;
    } else if (warned > 0) {
        console.log(`${symbols.warn} All required checks passed (${warned} warning(s)).`);
    } else {
        console.log(`${symbols.ok} All checks passed. You're ready to \`llmrun up\`.`);
    }
}

/**
 * Preflight used automatically by `up`/`start`. Runs tooling + AWS checks and
 * throws if any hard prerequisite is missing, printing the failing checks.
 */
export async function assertPreflight(sel: { region?: string; profile?: string }): Promise<void> {
    const results = [...(await checkTooling()), ...(await checkAws(sel))];
    const failures = results.filter((r) => r.status === "fail");

    if (failures.length > 0) {
        heading("Preflight failed");
        printResults(failures);
        console.log("");
        throw new LlmrunError("Preflight checks failed.", "Run `llmrun doctor` for the full report.");
    }
}
