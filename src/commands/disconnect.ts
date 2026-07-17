import type { GlobalFlags } from "../lib/context.js";
import { listDeployments, loadDeployment, updateDeployment, type DeploymentState } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { stopPortForward, isProcessAlive } from "../lib/ssm.js";
import { success, info } from "../lib/ui.js";

export interface DisconnectOptions {
    all?: boolean;
}

function disconnectOne(state: DeploymentState): void {
    if (!isProcessAlive(state.forwardPid)) {
        info(`"${state.name}" was not connected.`);
        return;
    }
    stopPortForward(state.forwardPid);
    updateDeployment(state.name, { forwardPid: undefined });
    success(`"${state.name}" disconnected.`);
}

/** Tear down local port-forward(s) without stopping the instance(s). */
export async function disconnectCommand(
    _flags: GlobalFlags,
    nameArg: string | undefined,
    opts: DisconnectOptions
): Promise<void> {
    if (opts.all) {
        const deployments = listDeployments();

        if (deployments.length === 0) {
            info("No deployments to disconnect.");
            return;
        }
        for (const d of deployments) disconnectOne(d);
        return;
    }

    const name = await resolveDeploymentName(nameArg);
    disconnectOne(loadDeployment(name));
}
