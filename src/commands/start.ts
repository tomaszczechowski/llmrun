import { selectionForDeployment, type GlobalFlags } from "../lib/context.js";
import { loadDeployment, updateDeployment } from "../lib/state.js";
import { resolveDeploymentName } from "../lib/select.js";
import { assertPreflight } from "./doctor.js";
import { startInstance, waitForInstanceState, waitForSsmOnline } from "../lib/aws.js";
import { establishPortForward, isProcessAlive } from "../lib/ssm.js";
import { waitForModelHealthy } from "../lib/health.js";
import { LlmrunError } from "../lib/errors.js";
import { heading, info, warn, keyValues, spinner, bold } from "../lib/ui.js";

/** Restart a stopped deployment and re-establish its port-forward. */
export async function startCommand(flags: GlobalFlags, nameArg: string | undefined): Promise<void> {
    const name = await resolveDeploymentName(nameArg);
    const state = loadDeployment(name);
    const sel = selectionForDeployment(state, flags);

    if (!state.instanceId) {
        throw new LlmrunError(`Deployment "${name}" has no instance.`, "It may never have finished `up`.");
    }

    await assertPreflight(sel);

    try {
        await startInstance(sel, state.instanceId);
    } catch (err: any) {
        if (err?.Code === "InsufficientInstanceCapacity" || err?.name === "InsufficientInstanceCapacity") {
            throw new LlmrunError(
                `No capacity for ${state.instanceType} in the current region right now.`,
                [
                    `Options:`,
                    `  • Wait 15–60 min and retry — spot capacity fluctuates`,
                    `  • Edit llmrun.yaml to use a different instance_type (e.g. g5.2xlarge)`,
                    `    then run: llmrun down ${name} && llmrun up`,
                    `  • Try a different region with --region (e.g. --region us-east-1)`,
                ].join("\n")
            );
        }
        throw err;
    }

    const spin = spinner("Waiting for the instance to reach 'running'");
    await waitForInstanceState(sel, state.instanceId, ["running"]);
    spin.succeed("Instance running");

    if (!isProcessAlive(state.forwardPid)) {
        const ssmSpin = spinner("Waiting for the SSM agent to register");
        const online = await waitForSsmOnline(sel, state.instanceId);

        if (!online) {
            ssmSpin.fail("Instance did not register with SSM in time");
            throw new LlmrunError(
                "The instance never connected to SSM.",
                `Retry with \`llmrun connect ${name}\` once it's registered.`
            );
        }
        ssmSpin.succeed("SSM agent online");
        const pid = await establishPortForward(sel, state);
        updateDeployment(name, { forwardPid: pid });
    }

    const healthSpin = spinner(`Waiting for the model to be ready on localhost:${state.localPort}`);
    const healthy = await waitForModelHealthy(state.localPort);

    if (healthy) healthSpin.succeed("Model is ready");
    else {
        healthSpin.fail("Model did not become healthy in time");
        warn(`Check \`llmrun logs ${name}\`.`);
    }

    heading(`"${name}" is up`);
    keyValues([
        ["Endpoint", bold(`http://localhost:${state.localPort}/v1`)],
        ["Model name", state.hf_repo],
        ["Instance", `${state.instanceId} (${state.instanceType})`],
    ]);
    info(`Manage it: llmrun ls · llmrun logs ${name} · llmrun stop ${name}`);
}
