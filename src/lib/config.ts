import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { globalConfigPath, homeDir } from "./paths.js";
import type { Catalog } from "./catalog.js";

/**
 * Global, machine-level config stored at `~/.llmrun/config.json`. This is a
 * lightweight fallback layer beneath a project's `llmrun.yaml` — useful for
 * defaults a user wants across every project (e.g. their usual AWS profile).
 */

const globalConfigSchema = z
    .object({
        profile: z.string().optional(),
        region: z.string().optional(),
        base_port: z.number().int().min(1024).max(65535).optional(),
        idle_timeout: z.string().optional(),
        state_backend: z.enum(["local"]).default("local"),
    })
    .strict();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export function loadGlobalConfig(): GlobalConfig {
    const file = globalConfigPath();

    if (!existsSync(file)) {
        return globalConfigSchema.parse({});
    }

    return globalConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function saveGlobalConfig(config: GlobalConfig): void {
    mkdirSync(homeDir(), { recursive: true });
    writeFileSync(globalConfigPath(), JSON.stringify(globalConfigSchema.parse(config), null, 4) + "\n");
}

export interface AwsSelection {
    profile?: string;
    region?: string;
}

export interface CliAwsFlags {
    profile?: string;
    region?: string;
}

/**
 * Resolve the effective AWS profile and region.
 * Precedence (highest first): CLI flags → environment → catalog defaults →
 * global config → AWS CLI default (represented as `undefined`).
 */
export function resolveAws(flags: CliAwsFlags, catalog: Catalog | undefined, global: GlobalConfig): AwsSelection {
    const profile =
        flags.profile ?? process.env.AWS_PROFILE ?? catalog?.defaults.aws_profile ?? global.profile ?? undefined;
    const region =
        flags.region ??
        process.env.AWS_REGION ??
        process.env.AWS_DEFAULT_REGION ??
        catalog?.defaults.region ??
        global.region ??
        undefined;

    return { profile, region };
}

/** The default local port base, resolved from catalog then global config. */
export function resolveBasePort(catalog: Catalog | undefined, global: GlobalConfig): number {
    return catalog?.defaults.base_port ?? global.base_port ?? 8000;
}
