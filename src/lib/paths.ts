import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Filesystem locations used by llmrun.
 *
 * - The package root holds the bundled Terraform tree and scaffold templates.
 * - The home directory (`~/.llmrun`) holds per-deployment workspaces and state.
 */

const thisFile = fileURLToPath(import.meta.url);

/** Root of the installed package (one level up from `dist/` or `src/lib`). */
export function packageRoot(): string {
    // At runtime this file lives in `dist/lib/paths.js`; the package root is two levels up.
    // During `tsx` dev it lives in `src/lib/paths.ts`; still two levels up.
    return path.resolve(path.dirname(thisFile), "..", "..");
}

/** Bundled Terraform tree shipped with the package (`main/`, `modules/`, `tfvars/`). */
export function bundledTerraformDir(): string {
    return path.join(packageRoot(), "terraform");
}

/** Bundled scaffold templates (e.g. the sample `llmrun.yaml`). */
export function templatesDir(): string {
    return path.join(packageRoot(), "templates");
}

/** Base directory for llmrun's mutable state: `~/.llmrun`. */
export function homeDir(): string {
    if (process.env.LLMRUN_HOME) {
        return path.resolve(process.env.LLMRUN_HOME);
    }

    return path.join(homedir(), ".llmrun");
}

/** Directory holding all deployment workspaces: `~/.llmrun/deployments`. */
export function deploymentsDir(): string {
    return path.join(homeDir(), "deployments");
}

/** Workspace directory for a single deployment. */
export function deploymentDir(name: string): string {
    return path.join(deploymentsDir(), name);
}

/** Global config file: `~/.llmrun/config.json`. */
export function globalConfigPath(): string {
    return path.join(homeDir(), "config.json");
}

/** Durable usage ledger: `~/.llmrun/history.jsonl` (append-only, survives `down`). */
export function historyFile(): string {
    return path.join(homeDir(), "history.jsonl");
}
