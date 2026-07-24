import { execa } from "execa";
import type { AwsSelection } from "./config.js";
import { getGpuVcpuQuota, quotaConsoleUrl, instanceFamilyPrefix } from "./aws.js";
import { getInstanceSpec } from "./instances.js";

/** A single preflight check result. */
export interface CheckResult {
    name: string;
    status: "ok" | "warn" | "fail";
    detail?: string;
    hint?: string;
}

async function commandExists(cmd: string, args: string[]): Promise<{ ok: boolean; version?: string }> {
    try {
        const res = await execa(cmd, args, { reject: false });

        if (res.exitCode !== 0 && res.exitCode !== undefined && !res.stdout) {
            return { ok: false };
        }
        const line = (res.stdout || res.stderr || "").split("\n")[0]?.trim();

        return { ok: true, version: line };
    } catch {
        return { ok: false };
    }
}

/** Checks for the external tools llmrun shells out to. */
export async function checkTooling(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    const tf = await commandExists("terraform", ["version"]);
    results.push({
        name: "terraform CLI",
        status: tf.ok ? "ok" : "fail",
        detail: tf.version,
        hint: tf.ok ? undefined : "Install Terraform: https://developer.hashicorp.com/terraform/install",
    });

    const aws = await commandExists("aws", ["--version"]);
    results.push({
        name: "aws CLI",
        status: aws.ok ? "ok" : "fail",
        detail: aws.version,
        hint: aws.ok
            ? undefined
            : "Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
    });

    const plugin = await commandExists("session-manager-plugin", []);
    results.push({
        name: "session-manager-plugin",
        status: plugin.ok ? "ok" : "fail",
        hint: plugin.ok
            ? undefined
            : "Required for SSM port-forwarding. Install: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html",
    });

    return results;
}

/** Checks that AWS credentials resolve and a region is set. */
export async function checkAws(sel: AwsSelection): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    results.push({
        name: "AWS region",
        status: sel.region ? "ok" : "fail",
        detail: sel.region ?? "not set",
        hint: sel.region ? undefined : "Set `region` in llmrun.yaml defaults, pass --region, or set AWS_REGION.",
    });

    const args = ["sts", "get-caller-identity", "--output", "text", "--query", "Account"];

    if (sel.region) args.push("--region", sel.region);
    if (sel.profile) args.push("--profile", sel.profile);
    try {
        const res = await execa("aws", args, { reject: false });

        if (res.exitCode === 0 && res.stdout.trim()) {
            results.push({
                name: "AWS credentials",
                status: "ok",
                detail: `account ${res.stdout.trim()}${sel.profile ? ` (profile ${sel.profile})` : ""}`,
            });
        } else {
            results.push({
                name: "AWS credentials",
                status: "fail",
                detail: res.stderr.trim().split("\n")[0],
                hint: "Configure credentials: `aws configure` or `aws sso login`, or set the right profile.",
            });
        }
    } catch {
        results.push({
            name: "AWS credentials",
            status: "fail",
            hint: "Could not run `aws sts get-caller-identity`. Is the AWS CLI installed and configured?",
        });
    }

    return results;
}

/**
 * Check the On-Demand GPU vCPU service quota against what an instance type needs.
 * Returns a `fail` result (with an increase-request link) when the quota is
 * insufficient, `warn` when it can't be determined, and `ok` otherwise.
 */
export async function checkGpuQuota(sel: AwsSelection, instanceType: string): Promise<CheckResult> {
    const spec = getInstanceSpec(instanceType);
    const family = instanceFamilyPrefix(instanceType);
    const needed = spec?.vcpus;

    try {
        const quota = await getGpuVcpuQuota(sel, instanceType);

        if (!quota) {
            // Not a GPU family we track (e.g. a CPU instance) — nothing to check.
            return { name: `GPU quota (${family})`, status: "ok", detail: "not a GPU-quota family" };
        }
        if (needed === undefined) {
            return {
                name: `GPU quota (${quota.family})`,
                status: "warn",
                detail: `limit ${quota.limit} vCPU; unknown vCPUs for ${instanceType}`,
            };
        }
        if (quota.limit >= needed) {
            return {
                name: `GPU quota (${quota.family})`,
                status: "ok",
                detail: `${quota.limit} vCPU available, ${instanceType} needs ${needed}`,
            };
        }

        return {
            name: `GPU quota (${quota.family})`,
            status: "fail",
            detail: `quota is ${quota.limit} vCPU but ${instanceType} needs ${needed}`,
            hint:
                `Request an increase for "${quota.quotaLabel}" (${quota.quotaCode}):\n` +
                `    ${quotaConsoleUrl(sel.region, quota.quotaCode)}\n` +
                `    G/P increases are reviewed manually by AWS and can take time. ` +
                `Meanwhile, a CPU fallback may be available for smaller models.`,
        };
    } catch (err) {
        return {
            name: `GPU quota (${family})`,
            status: "warn",
            detail: `could not query Service Quotas: ${(err as Error).message}`,
        };
    }
}

export function hasHardFailure(results: CheckResult[]): boolean {
    return results.some((r) => r.status === "fail");
}
