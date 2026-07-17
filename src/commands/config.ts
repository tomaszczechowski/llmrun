import { loadGlobalConfig, saveGlobalConfig, resolveAws, type GlobalConfig } from "../lib/config.js";
import { loadCatalog } from "../lib/catalog.js";
import { globalConfigPath } from "../lib/paths.js";
import type { GlobalFlags } from "../lib/context.js";
import { heading, keyValues, success, dim } from "../lib/ui.js";

export interface ConfigOptions {
    set?: string[];
}

const SETTABLE = ["profile", "region", "base_port", "idle_timeout"] as const;

/** Show or edit the machine-level global config (`~/.llmrun/config.json`). */
export async function configCommand(flags: GlobalFlags, opts: ConfigOptions): Promise<void> {
    const global = loadGlobalConfig();

    if (opts.set && opts.set.length > 0) {
        const next: GlobalConfig = { ...global };
        for (const pair of opts.set) {
            const idx = pair.indexOf("=");

            if (idx === -1) throw new Error(`Invalid --set "${pair}". Use key=value.`);
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();

            if (!SETTABLE.includes(key as (typeof SETTABLE)[number])) {
                throw new Error(`Unknown config key "${key}". Settable: ${SETTABLE.join(", ")}.`);
            }
            if (key === "base_port") next.base_port = Number(value);
            else if (key === "profile") next.profile = value;
            else if (key === "region") next.region = value;
            else if (key === "idle_timeout") next.idle_timeout = value;
        }
        saveGlobalConfig(next);
        success(`Saved ${dim(globalConfigPath())}`);
    }

    const current = loadGlobalConfig();
    let catalogDefaults;
    try {
        catalogDefaults = loadCatalog().catalog.defaults;
    } catch {
        catalogDefaults = undefined;
    }
    const sel = resolveAws(flags, catalogDefaults ? ({ defaults: catalogDefaults } as any) : undefined, current);

    heading("Global config (~/.llmrun/config.json)");
    keyValues([
        ["profile", current.profile ?? dim("(unset)")],
        ["region", current.region ?? dim("(unset)")],
        ["base_port", String(current.base_port ?? dim("(default 8000)"))],
        ["idle_timeout", current.idle_timeout ?? dim("(unset)")],
        ["state_backend", current.state_backend],
    ]);

    heading("Effective AWS selection (flags → env → yaml → global → CLI default)");
    keyValues([
        ["profile", sel.profile ?? dim("(aws default)")],
        ["region", sel.region ?? dim("(aws default)")],
    ]);
}
