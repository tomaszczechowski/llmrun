import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { deploymentDir, deploymentsDir } from "./paths.js";

/**
 * Per-deployment state persisted at `~/.llmrun/deployments/<name>/deployment.json`.
 * A "deployment" is one running (or stopped) instance created by `llmrun up`.
 * Its name defaults to the selected model alias and is the handle for all
 * lifecycle commands.
 */

const deploymentStateSchema = z.object({
    name: z.string(),
    alias: z.string(),
    hf_repo: z.string(),
    engine: z.enum(["vllm", "ollama"]),
    instanceType: z.string(),
    mode: z.enum(["gpu", "cpu"]).default("gpu"),
    region: z.string(),
    profile: z.string().optional(),
    localPort: z.number(),
    remotePort: z.number().default(8000),
    idleTimeout: z.string(),
    instanceId: z.string().optional(),
    createdAt: z.string(),
    /** Set while `llmrun up` is running; cleared once the instance ID is known. */
    provisioningAt: z.string().optional(),
    /** PID of the active SSM port-forward process, if any. */
    forwardPid: z.number().optional(),
});

export type DeploymentState = z.infer<typeof deploymentStateSchema>;

function statePath(name: string): string {
    return path.join(deploymentDir(name), "deployment.json");
}

export function deploymentExists(name: string): boolean {
    return existsSync(statePath(name));
}

export function saveDeployment(state: DeploymentState): void {
    mkdirSync(deploymentDir(state.name), { recursive: true });
    writeFileSync(statePath(state.name), JSON.stringify(deploymentStateSchema.parse(state), null, 4) + "\n");
}

export function loadDeployment(name: string): DeploymentState {
    const file = statePath(name);

    if (!existsSync(file)) {
        throw new Error(`No deployment named "${name}".`);
    }

    return deploymentStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function updateDeployment(name: string, patch: Partial<DeploymentState>): DeploymentState {
    const next = { ...loadDeployment(name), ...patch };
    saveDeployment(next);
    return next;
}

export function listDeployments(): DeploymentState[] {
    const dir = deploymentsDir();

    if (!existsSync(dir)) return [];

    const names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    const results: DeploymentState[] = [];

    for (const name of names) {
        if (existsSync(statePath(name))) {
            try {
                results.push(loadDeployment(name));
            } catch {
                // Skip corrupt/partial state directories rather than failing the whole listing.
            }
        }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a deployment's workspace directory entirely (after `terraform destroy`). */
export function removeDeployment(name: string): void {
    rmSync(deploymentDir(name), { recursive: true, force: true });
}

/**
 * Pick a unique deployment name from a desired base, appending `-2`, `-3`, …
 * if a deployment with that name already exists.
 */
export function uniqueDeploymentName(base: string): string {
    if (!deploymentExists(base)) return base;
    for (let i = 2; ; i++) {
        const candidate = `${base}-${i}`;

        if (!deploymentExists(candidate)) return candidate;
    }
}
