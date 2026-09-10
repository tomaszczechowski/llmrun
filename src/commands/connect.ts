import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { listDeployments, loadDeployment, updateDeployment, type DeploymentState } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { describeInstance, waitForSsmOnline } from "../lib/aws.js";
import { establishPortForward, stopPortForward, isForwardAlive } from "../lib/ssm.js";
import { waitForModelHealthy } from "../lib/health.js";
import { warn, success, info, dim, spinner } from "../lib/ui.js";

export interface ConnectOptions {
    all?: boolean;
}

async function connectOne(state: DeploymentState, flags: GlobalFlags): Promise<void> {
    const sel = selectionForDeployment(state, flags);

    if (!state.instanceId) {
        warn(`"${state.name}" has no instance — skipping.`);
        return;
    }
    const inst = await describeInstance(sel, state.instanceId).catch(() => undefined);

    if (inst && inst.state !== "running") {
        warn(`"${state.name}" is ${inst.state} — run \`llmrun start ${state.name}\` first. Skipping.`);
        return;
    }

    // Restart the forward if a stale one is recorded (the parent may be gone but
    // its plugin child can still hold the port — isForwardAlive covers both).
    if (isForwardAlive(state.forwardPid)) {
        stopPortForward(state.forwardPid);
    }

    if (!(await waitForSsmOnline(sel, state.instanceId, 60_000))) {
        warn(`"${state.name}" is not registered with SSM yet — try again shortly. Skipping.`);
        return;
    }
    const pid = await establishPortForward(sel, state);
    updateDeployment(state.name, { forwardPid: pid });
    success(`"${state.name}" → ${dim(`http://localhost:${state.localPort}/v1`)}`);

    // A live tunnel is not a queryable model: vLLM may still be downloading or
    // loading. Wait for readiness so one `connect` yields a working endpoint.
    const healthSpin = spinner(`Waiting for the model to be ready on localhost:${state.localPort}`);
    const healthy = await waitForModelHealthy(state.localPort);

    if (healthy) healthSpin.succeed("Model is ready");
    else {
        healthSpin.fail("Model did not become healthy in time");
        warn(`Check \`llmrun logs ${state.name}\` and run \`llmrun connect ${state.name}\` again.`);
    }
}

/** (Re)establish SSM port-forward(s). Multiple deployments forward concurrently. */
export async function connectCommand(
    flags: GlobalFlags,
    nameArg: string | undefined,
    opts: ConnectOptions
): Promise<void> {
    if (opts.all) {
        const deployments = listDeployments();

        if (deployments.length === 0) {
            info("No deployments to connect.");
            return;
        }
        for (const d of deployments) {
            await connectOne(d, flags);
        }
        return;
    }

    const name = await resolveDeploymentName(nameArg);
    await connectOne(loadDeployment(name), flags);
}
