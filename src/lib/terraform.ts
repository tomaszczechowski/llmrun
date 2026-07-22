import { cpSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { bundledTerraformDir, deploymentDir } from "./paths.js";
import type { AwsSelection } from "./config.js";
import { LlmrunError } from "./errors.js";

/**
 * Drives Terraform for a deployment. The bundled Terraform tree
 * (`main/`, `modules/`, `tfvars/`) is copied into the deployment's workspace so
 * each deployment gets isolated local state, then `terraform` is run in the
 * copied `main/` directory with a generated tfvars file.
 */

export interface TerraformVars {
    name: string;
    region: string;
    instance_type: string;
    disk_gb: number;
    hf_repo: string;
    engine: string;
    mode: string;
    remote_port: number;
    idle_timeout_seconds: number;
    az_index?: number;
    context_length?: number;
    quantization?: string;
    tool_call_parser?: string;
    hf_token?: string;
}

function workspaceRoot(name: string): string {
    return path.join(deploymentDir(name), "terraform");
}

function mainDir(name: string): string {
    return path.join(workspaceRoot(name), "main");
}

function tfvarsFile(name: string): string {
    return path.join(workspaceRoot(name), "tfvars", `${name}.tfvars.json`);
}

/** Copy the bundled Terraform tree into the deployment workspace (idempotent). */
export function prepareWorkspace(name: string, vars: TerraformVars): void {
    const dest = workspaceRoot(name);
    mkdirSync(dest, { recursive: true });
    // Copy templates but never clobber existing local state under main/.
    cpSync(bundledTerraformDir(), dest, {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}.terraform`) && !src.endsWith(".tfstate"),
    });
    mkdirSync(path.dirname(tfvarsFile(name)), { recursive: true });
    // Strip undefined values so Terraform uses its declared defaults.
    const clean = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined));
    writeFileSync(tfvarsFile(name), JSON.stringify(clean, null, 4) + "\n");
}

function envFor(sel: AwsSelection): NodeJS.ProcessEnv {
    const env = { ...process.env };

    if (sel.profile) env.AWS_PROFILE = sel.profile;
    // Always override AWS_REGION so the shell environment can't silently redirect
    // the deployment to a different region than what llmrun.yaml specifies.
    if (sel.region) env.AWS_REGION = sel.region;
    else delete env.AWS_REGION;

    return env;
}

async function runTerraform(
    name: string,
    sel: AwsSelection,
    args: string[],
    quiet = false
): Promise<{ stdout: string; stderr: string }> {
    const cwd = mainDir(name);

    if (!existsSync(cwd)) {
        throw new LlmrunError(`Terraform workspace for "${name}" is missing.`, "Try running `llmrun up` again.");
    }

    // Stream to the user AND capture for error analysis.
    const stdioOpt = quiet
        ? (["ignore", "pipe", "pipe"] as const)
        : (["ignore", ["inherit", "pipe"], ["inherit", "pipe"]] as const);

    const result = await execa("terraform", args, {
        cwd,
        env: envFor(sel),
        stdio: stdioOpt,
        reject: false,
    });

    if (result.exitCode !== 0) {
        const captured = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        const err = new LlmrunError(
            `Terraform ${args[0]} failed (exit ${result.exitCode}).`,
            quiet ? result.stderr : "See the Terraform output above."
        ) as LlmrunError & { captured: string };
        err.captured = captured;
        throw err;
    }

    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export async function init(name: string, sel: AwsSelection): Promise<void> {
    await runTerraform(name, sel, ["init", "-input=false", "-no-color"], true);
}

export async function apply(name: string, sel: AwsSelection): Promise<void> {
    await runTerraform(name, sel, [
        "apply",
        "-auto-approve",
        "-input=false",
        "-no-color",
        `-var-file=${tfvarsFile(name)}`,
    ]);
}

export async function destroy(name: string, sel: AwsSelection): Promise<void> {
    await runTerraform(name, sel, [
        "destroy",
        "-auto-approve",
        "-input=false",
        "-no-color",
        `-var-file=${tfvarsFile(name)}`,
    ]);
}

/** Returns true when a terraform error is due to EC2 capacity being unavailable in the target AZ. */
export function isCapacityError(err: unknown): boolean {
    const captured = (err as any)?.captured ?? "";
    const message = (err as any)?.message ?? "";
    return (
        captured.includes("InsufficientInstanceCapacity") || message.includes("InsufficientInstanceCapacity")
    );
}

export interface TerraformOutputs {
    instance_id?: string;
    public_ip?: string;
}

export async function outputs(name: string, sel: AwsSelection): Promise<TerraformOutputs> {
    const { stdout: raw } = await runTerraform(name, sel, ["output", "-json", "-no-color"], true);

    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as Record<string, { value: unknown }>;

    return {
        instance_id: parsed.instance_id?.value as string | undefined,
        public_ip: parsed.public_ip?.value as string | undefined,
    };
}
