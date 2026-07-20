import { confirm } from "@inquirer/prompts";
import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment, removeDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { stopPortForward } from "../lib/ssm.js";
import * as tf from "../lib/terraform.js";
import { LlmrunError } from "../lib/errors.js";
import { info, success } from "../lib/ui.js";

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

    info("Running terraform destroy…");
    try {
        await tf.destroy(name, sel);
    } catch (err: any) {
        // Workspace missing means terraform never ran — nothing to destroy.
        if (!(err instanceof LlmrunError) || !err.message.includes("workspace")) throw err;
        info("No terraform workspace found — skipping destroy.");
    }

    removeDeployment(name);
    success(`Deployment "${name}" removed.`);
}
