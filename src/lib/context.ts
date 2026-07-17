import { loadCatalog, type LoadedCatalog } from "./catalog.js";
import { loadGlobalConfig, resolveAws, type AwsSelection, type GlobalConfig } from "./config.js";
import type { DeploymentState } from "./state.js";

/** Global flags available on every command. */
export interface GlobalFlags {
    profile?: string;
    region?: string;
}

export interface CatalogContext extends LoadedCatalog {
    global: GlobalConfig;
    sel: AwsSelection;
}

/** Load catalog + global config and resolve the effective AWS selection. */
export function loadCatalogContext(flags: GlobalFlags): CatalogContext {
    const global = loadGlobalConfig();
    const loaded = loadCatalog();
    const sel = resolveAws(flags, loaded.catalog, global);

    return { ...loaded, global, sel };
}

/**
 * Resolve the AWS selection for an existing deployment. CLI flags win, then the
 * region/profile recorded when the deployment was created.
 */
export function selectionForDeployment(state: DeploymentState, flags: GlobalFlags): AwsSelection {
    return {
        region: flags.region ?? state.region,
        profile: flags.profile ?? state.profile,
    };
}
