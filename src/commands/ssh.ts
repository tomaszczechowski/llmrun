import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { openShell } from "../lib/ssm.js";
import { LlmrunError } from "../lib/errors.js";
import { info } from "../lib/ui.js";

/** Open an interactive SSM shell on a deployment's instance (no SSH keys needed). */
export async function sshCommand(flags: GlobalFlags, nameArg: string | undefined): Promise<void> {
    const name = await resolveDeploymentName(nameArg);
    const state = loadDeployment(name);
    const sel = selectionForDeployment(state, flags);

    if (!state.instanceId) {
        throw new LlmrunError(`Deployment "${name}" has no instance.`);
    }

    info(`Opening an SSM session on ${state.instanceId} (Ctrl-D to exit)…`);
    await openShell(sel, state.instanceId);
}
