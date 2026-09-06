import { confirm } from "@inquirer/prompts";
import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment, removeDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { stopPortForward } from "../lib/ssm.js";
import { describeInstance } from "../lib/aws.js";
import { appendEvent, closeOpenWindow, flushInstanceUsage } from "../lib/history.js";
import * as tf from "../lib/terraform.js";
import { LlmrunError } from "../lib/errors.js";
import { info, success, warn, spinner } from "../lib/ui.js";

export interface DownOptions {
    yes?: boolean;
}

/** Tear a deployment down entirely (`terraform destroy`) and remove its workspace. */
export async function downCommand(flags: GlobalFlags, nameArg: string | undefined, opts: DownOptions): Promise<void> {
    const name = await resolveDeploymentName(nameArg);
    const state = loadDeployment(name);
    const sel = selectionForDeployment(state, flags);

    if (!opts.yes) {
        const ok = await confirm({
            message: `Destroy deployment "${name}" (${state.instanceType}, ${state.hf_repo})? This deletes the instance and its disk.`,
            default: false,
        });

        if (!ok) {
            info("Aborted. Nothing was destroyed.");
            return;
        }
    }

    stopPortForward(state.forwardPid);

    // The instance's usage buffer dies with the instance — pull it before
    // destroy (one retry), then close the running window in the ledger.
    if (state.instanceId && state.deploymentId) {
        const inst = await describeInstance(sel, state.instanceId).catch(() => undefined);

        if (inst?.state === "running") {
            const spin = spinner("Pulling usage data from the instance");
            let ok = false;
            for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
                try {
                    await flushInstanceUsage(sel, state.instanceId, state.deploymentId);
                    ok = true;
                } catch {
                    // Retry once — a transient SSM blip shouldn't lose the data.
                }
            }
            if (ok) spin.succeed("Usage data pulled");
            else spin.fail("Usage data pull failed");
            if (!ok) warn("The session's final token counts may be missing from the history.");
            closeOpenWindow(state.deploymentId, new Date().toISOString(), "destroy");
        }
    }

    info("Running terraform destroy…");
    try {
        await tf.destroy(name, sel);
    } catch (err: any) {
        // Workspace missing means terraform never ran — nothing to destroy.
        if (!(err instanceof LlmrunError) || !err.message.includes("workspace")) throw err;
        info("No terraform workspace found — skipping destroy.");
    }

    removeDeployment(name);
    if (state.deploymentId) {
        appendEvent({ t: "down", id: state.deploymentId, ts: new Date().toISOString() });
    }
    success(`Deployment "${name}" removed.`);
}
