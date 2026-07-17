import { select } from "@inquirer/prompts";
import { listDeployments, deploymentExists } from "./state.js";
import { LlmrunError } from "./errors.js";

/**
 * Resolve which deployment a lifecycle command targets:
 *   - explicit name → validate it exists
 *   - exactly one deployment → infer it
 *   - several deployments → interactive picker
 */
export async function resolveDeploymentName(name: string | undefined): Promise<string> {
    if (name) {
        if (!deploymentExists(name)) {
            throw new LlmrunError(`No deployment named "${name}".`, "Run `llmrun ls` to see current deployments.");
        }

        return name;
    }

    const deployments = listDeployments();

    if (deployments.length === 0) {
        throw new LlmrunError("There are no deployments.", "Create one with `llmrun up`.");
    }
    if (deployments.length === 1) {
        return deployments[0]!.name;
    }

    return select({
        message: "Select a deployment",
        choices: deployments.map((d) => ({
            name: `${d.name}  (${d.alias} · ${d.instanceType} · ${d.region})`,
            value: d.name,
        })),
    });
}
