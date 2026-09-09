import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { homeDir } from "./paths.js";
import { LlmrunError } from "./errors.js";

/**
 * The `llmrun.yaml` catalog: defaults plus a list of models, where each model
 * maps a user-chosen alias to a HuggingFace repo and the EC2 instance needed to
 * serve it. Resolution order (later overrides earlier):
 *   1. built-in defaults
 *   2. ~/.llmrun/models.yaml   (user-global catalog)
 *   3. ./llmrun.yaml           (project-local catalog, cwd)
 */

const cpuVllmSchema = z
    .object({
        image: z.string().min(1).optional(), // CPU vLLM Docker image (default: vllm/vllm-openai-cpu:v0.28.0, pinned)
        kvcache_space: z.number().int().positive().optional(), // VLLM_CPU_KVCACHE_SPACE, GiB (default: 16)
        omp_threads_bind: z.string().optional(), // VLLM_CPU_OMP_THREADS_BIND, e.g. "0-31" (default: all vCPUs)
    })
    .strict();

const cpuFallbackSchema = z
    .object({
        instance_type: z.string().min(1),
        engine: z.enum(["vllm", "ollama"]).default("ollama"),
        quantization: z.string().optional(),
        max_params: z.string().optional(), // e.g. "16B" — guard against oversized models on CPU
        context_length: z.number().int().positive().optional(), // CPU-only override; large contexts eat RAM on CPU
        vllm: cpuVllmSchema.optional(), // only used when engine: vllm
    })
    .strict();

const modelSchema = z
    .object({
        alias: z.string().min(1, "model alias is required"),
        hf_repo: z.string().min(1, "hf_repo is required"),
        engine: z.enum(["vllm"]).default("vllm"),
        instance_type: z.string().min(1, "instance_type is required"),
        disk_gb: z.number().int().positive().default(100),
        context_length: z.number().int().positive().optional(),
        quantization: z.string().optional(),
        tool_call_parser: z.string().optional(), // vLLM --tool-call-parser, e.g. "hermes" for Qwen models
        hf_token_env: z.string().optional(),
        idle_timeout: z.string().optional(), // per-model override of defaults.idle_timeout
        cpu_fallback: cpuFallbackSchema.optional(),
    })
    .strict();

const defaultsSchema = z
    .object({
        aws_profile: z.string().optional(),
        aws_region: z.string().optional(),
        idle_timeout: z.string().default("30m"),
        base_port: z.number().int().min(1024).max(65535).default(8000),
        engine: z.enum(["vllm"]).default("vllm"),
    })
    .strict();

const catalogSchema = z
    .object({
        defaults: defaultsSchema.default({}),
        models: z.array(modelSchema).default([]),
    })
    .strict();

export type CpuFallback = z.infer<typeof cpuFallbackSchema>;
export type CpuVllm = z.infer<typeof cpuVllmSchema>;
export type Model = z.infer<typeof modelSchema>;
export type CatalogDefaults = z.infer<typeof defaultsSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

const BUILTIN_DEFAULTS = {
    idle_timeout: "30m",
    base_port: 8000,
    engine: "vllm" as const,
};

function readYamlFile(file: string): unknown {
    try {
        return parseYaml(readFileSync(file, "utf8")) ?? {};
    } catch (err) {
        throw new LlmrunError(
            `Failed to parse ${file}: ${(err as Error).message}`,
            "Check the YAML syntax against a sample from `llmrun init`."
        );
    }
}

/** Merge two partial catalogs; `override` wins. Models are merged by alias. */
function mergeCatalog(base: any, override: any): any {
    const models = new Map<string, any>();
    for (const m of base?.models ?? []) models.set(m.alias, m);
    for (const m of override?.models ?? []) models.set(m.alias, { ...models.get(m.alias), ...m });
    return {
        defaults: { ...base?.defaults, ...override?.defaults },
        models: Array.from(models.values()),
    };
}

export interface LoadCatalogOptions {
    /** Working directory to look for `./llmrun.yaml` in. Defaults to `process.cwd()`. */
    cwd?: string;
}

export interface LoadedCatalog {
    catalog: Catalog;
    /** Files that contributed, in precedence order (lowest first). */
    sources: string[];
}

export function loadCatalog(opts: LoadCatalogOptions = {}): LoadedCatalog {
    const cwd = opts.cwd ?? process.cwd();
    const globalCatalog = path.join(homeDir(), "models.yaml");
    const localCatalog = path.join(cwd, "llmrun.yaml");

    let merged: any = { defaults: { ...BUILTIN_DEFAULTS }, models: [] };
    const sources: string[] = [];

    for (const file of [globalCatalog, localCatalog]) {
        if (existsSync(file)) {
            merged = mergeCatalog(merged, readYamlFile(file));
            sources.push(file);
        }
    }

    const parsed = catalogSchema.safeParse(merged);

    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        throw new LlmrunError(`Invalid catalog configuration:\n${issues}`, "Fix your llmrun.yaml and try again.");
    }

    if (sources.length === 0) {
        throw new LlmrunError(
            "No llmrun.yaml found.",
            "Run `llmrun init` to create one in the current folder, or add ~/.llmrun/models.yaml."
        );
    }

    return { catalog: parsed.data, sources };
}

export function findModel(catalog: Catalog, alias: string): Model | undefined {
    return catalog.models.find((m) => m.alias === alias);
}

/** Effective idle timeout string for a model (per-model override or global default). */
export function idleTimeoutFor(catalog: Catalog, model: Model): string {
    return model.idle_timeout ?? catalog.defaults.idle_timeout;
}
