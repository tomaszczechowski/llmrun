import { select, confirm } from "@inquirer/prompts";
import { randomUUID } from "node:crypto";
import { loadCatalogContext, type GlobalFlags } from "../lib/context.js";
import { resolveBasePort } from "../lib/config.js";
import { idleTimeoutFor, type Model } from "../lib/catalog.js";
import { LlmrunError, parseDuration, formatDuration } from "../lib/errors.js";
import { assertPreflight } from "./doctor.js";
import { checkGpuQuota } from "../lib/doctor.js";
import { estimateCost, formatUsd, getInstanceSpec, checkVramFit } from "../lib/instances.js";
import { allocateLocalPort } from "../lib/ports.js";
import {
    uniqueDeploymentName,
    saveDeployment,
    updateDeployment,
    removeDeployment,
    loadDeployment,
    type DeploymentState,
} from "../lib/state.js";
import * as tf from "../lib/terraform.js";
import { waitForInstanceState, waitForSsmOnline, getInstanceTypeAzs } from "../lib/aws.js";
import { establishPortForward } from "../lib/ssm.js";
import { flushInstanceUsage, reconcileLifecycle, appendEvent } from "../lib/history.js";
import { waitForModelHealthy } from "../lib/health.js";
import { heading, info, success, warn, error, keyValues, spinner, dim, cyan, bold, symbols } from "../lib/ui.js";

export interface UpOptions {
    name?: string;
    yes?: boolean;
    port?: number;
}

interface ResolvedTarget {
    engine: "vllm" | "ollama";
    instanceType: string;
    mode: "gpu" | "cpu";
    quantization?: string;
}

/** Provision, serve, and connect a model chosen from the catalog. */
export async function upCommand(flags: GlobalFlags, opts: UpOptions): Promise<void> {
    const { catalog, sel, global } = loadCatalogContext(flags);

    if (catalog.models.length === 0) {
        throw new LlmrunError("No models in your catalog.", "Add a model to llmrun.yaml, then run `llmrun up`.");
    }

    // Automatic background preflight (tooling + AWS credentials/region).
    await assertPreflight(sel);

    // Always pick from the catalog — never type a model name by hand.
    const alias = await select({
        message: "Select a model to run",
        choices: catalog.models.map((m) => {
            const cost = estimateCost(m.instance_type);
            const price = cost ? `~${formatUsd(cost.usdPerHour)}/hr` : "cost unknown";

            return { name: `${m.alias}  ${dim(`(${m.hf_repo} · ${m.instance_type} · ${price})`)}`, value: m.alias };
        }),
    });
    const model = catalog.models.find((m) => m.alias === alias)!;

    // Resolve the instance/engine to use, applying the CPU fallback if GPU quota is short.
    const target = await resolveTarget(sel, model);

    // Cost preview + explicit approval.
    const approved = await previewCostAndConfirm(model, target, opts.yes ?? false);

    if (!approved) {
        info("Aborted. Nothing was provisioned.");
        return;
    }

    const name = uniqueDeploymentName(opts.name ?? model.alias);
    const basePort = opts.port ?? resolveBasePort(catalog, global);
    const localPort = await allocateLocalPort(basePort);
    const idleTimeout = idleTimeoutFor(catalog, model);
    const idleSeconds = parseDuration(idleTimeout);

    if (!sel.region) {
        throw new LlmrunError("No AWS region resolved.", "Set `region` in llmrun.yaml defaults or pass --region.");
    }

    const hfToken = model.hf_token_env ? process.env[model.hf_token_env] : undefined;

    if (model.hf_token_env && !hfToken) {
        warn(`Env var ${model.hf_token_env} is empty — gated HuggingFace repos may fail to download.`);
    }

    const state: DeploymentState = {
        name,
        alias: model.alias,
        hf_repo: model.hf_repo,
        engine: target.engine,
        instanceType: target.instanceType,
        mode: target.mode,
        region: sel.region,
        profile: sel.profile,
        localPort,
        remotePort: 8000,
        idleTimeout,
        deploymentId: randomUUID(),
        createdAt: new Date().toISOString(),
        provisioningAt: new Date().toISOString(),
    };
    saveDeployment(state);
    const deploymentId = state.deploymentId!;

    heading(`Provisioning "${name}"`);
    info(
        `Model ${cyan(model.hf_repo)} on ${cyan(target.instanceType)} (${target.mode.toUpperCase()}) in ${sel.region}`
    );

    // Pre-check: find AZs that offer this instance type (capacity is not
    // guaranteed, but we can skip AZs that never have it and show the plan).
    const azCheckSpin = spinner(`Checking availability zones for ${target.instanceType}`);
    const offeredAzs = await getInstanceTypeAzs(sel, target.instanceType);

    if (offeredAzs.length === 0) {
        azCheckSpin.warn(`Could not determine AZ availability — will try the region default.`);
    } else {
        azCheckSpin.succeed(
            `${target.instanceType} offered in: ${offeredAzs.join(", ")} — will try each if needed`
        );
    }

    const vars: tf.TerraformVars = {
        name,
        region: sel.region,
        instance_type: target.instanceType,
        disk_gb: model.disk_gb,
        hf_repo: model.hf_repo,
        engine: target.engine,
        mode: target.mode,
        remote_port: 8000,
        idle_timeout_seconds: idleSeconds,
        az_index: 0,
        context_length: model.context_length,
        quantization: target.quantization,
        tool_call_parser: model.tool_call_parser,
        hf_token: hfToken,
    };
    tf.prepareWorkspace(name, vars);

    const initSpin = spinner("terraform init");
    try {
        await tf.init(name, sel);
        initSpin.succeed("terraform init");
    } catch (err) {
        initSpin.fail("terraform init");
        throw err;
    }

    // Retry across offered AZs when a given AZ has no capacity right now.
    // Terraform will fail fast (~4 min timeout) instead of hanging 10+ min.
    const maxAz = Math.max(offeredAzs.length, 1);
    let capacityExhausted = false;
    for (let azIdx = 0; azIdx < maxAz; azIdx++) {
        if (azIdx > 0) {
            const prevAz = offeredAzs[azIdx - 1] ?? `AZ ${azIdx - 1}`;
            const nextAz = offeredAzs[azIdx] ?? `AZ ${azIdx}`;
            warn(`No capacity in ${prevAz} — retrying in ${nextAz}…`);
            vars.az_index = azIdx;
            tf.prepareWorkspace(name, vars);
        }
        info(
            `Applying Terraform (creating EC2 instance, IAM, VPC)${azIdx > 0 ? ` — ${offeredAzs[azIdx] ?? `AZ ${azIdx}`}` : ""}…`
        );
        try {
            await tf.apply(name, sel);
            capacityExhausted = false;
            break;
        } catch (err) {
            if (!tf.isCapacityError(err)) throw err;
            capacityExhausted = true;
            if (azIdx < maxAz - 1) continue;
            // All AZs exhausted — clean up orphaned infra before surfacing the error.
            warn(`No ${target.instanceType} capacity available in any AZ (${offeredAzs.join(", ")}).`);
            warn("Cleaning up partial infrastructure…");
            try {
                await tf.destroy(name, sel);
            } catch {
                // Best-effort cleanup; don't mask the original capacity error.
            }
            removeDeployment(name);
            throw new LlmrunError(
                `No ${target.instanceType} capacity available in ${sel.region}.`,
                `Options:\n` +
                    `  • Wait 15–60 min and try again — AWS capacity is often transient.\n` +
                    `  • Try a different region: add --region <region> or change aws_region in llmrun.yaml.\n` +
                    `  • Use a different instance type in your model's llmrun.yaml entry.`
            );
        }
    }

    const out = await tf.outputs(name, sel);

    if (!out.instance_id) {
        throw new LlmrunError("Terraform did not return an instance id.", "Check the Terraform output above.");
    }
    updateDeployment(name, { instanceId: out.instance_id, provisioningAt: undefined });
    success(`Instance ${cyan(out.instance_id)} created`);

    // Open the deployment's record in the durable usage ledger.
    appendEvent({
        t: "up",
        id: deploymentId,
        ts: new Date().toISOString(),
        name,
        alias: model.alias,
        hfRepo: model.hf_repo,
        instanceId: out.instance_id,
        instanceType: target.instanceType,
        engine: target.engine,
        mode: target.mode,
        region: sel.region,
        diskGb: model.disk_gb,
        contextLength: model.context_length,
        quantization: target.quantization,
        toolCallParser: model.tool_call_parser,
        usdPerHour: estimateCost(target.instanceType)?.usdPerHour ?? 0,
    });

    const runSpin = spinner("Waiting for the instance to reach 'running'");
    await waitForInstanceState(sel, out.instance_id, ["running"]);
    runSpin.succeed("Instance running");

    // Record the running window in the ledger (EC2 ground truth).
    await reconcileLifecycle(sel, loadDeployment(name)).catch(() => {
        // Best-effort — the next llmrun ls/stop/down reconciles.
    });

    // The SSM agent registers a little after "running"; wait before forwarding.
    const ssmSpin = spinner("Waiting for the SSM agent to register");
    const online = await waitForSsmOnline(sel, out.instance_id);

    if (!online) {
        ssmSpin.fail("Instance did not register with SSM in time");
        throw new LlmrunError(
            "The instance never connected to SSM.",
            `Run \`llmrun doctor\`, check the SSM agent via the console, then retry \`llmrun connect ${name}\`.`
        );
    }
    ssmSpin.succeed("SSM agent online");

    // Establish the port-forward (verified listening), then wait for the server.
    const forwardPid = await establishPortForward(sel, { ...state, instanceId: out.instance_id });
    updateDeployment(name, { forwardPid });

    info(`To follow progress in another terminal: ${cyan(`llmrun logs ${name}`)}`);

    const healthSpin = spinner(
        `Waiting for the model to be ready on localhost:${localPort} (first boot downloads the model — this can take several minutes)`
    );
    const healthy = await waitForModelHealthy(localPort);

    if (healthy) {
        healthSpin.succeed(`Model is ready`);
    } else {
        healthSpin.fail("Model did not become healthy in time");
        warn(`The instance is up but the server isn't responding. Check \`llmrun logs ${name}\`.`);
        warn(
            "A common cause is the model not fitting the GPU (vLLM CUDA out-of-memory, crash-looping). " +
                "If so, use a larger instance or a quantized model."
        );
    }

    // Best-effort: pull usage lines the instance monitor has staged so far.
    try {
        await flushInstanceUsage(sel, out.instance_id, deploymentId);
        updateDeployment(name, { lastFlushAt: new Date().toISOString() });
    } catch {
        // Instance may be briefly unreachable — the next lifecycle command pulls it.
    }

    heading(`"${name}" is up`);
    keyValues([
        ["Endpoint", bold(`http://localhost:${localPort}/v1`)],
        ["Model name", model.hf_repo],
        ["Instance", `${out.instance_id} (${target.instanceType})`],
        ["Idle auto-stop", formatDuration(idleSeconds)],
    ]);
    console.log("");
    info("Try it:");
    console.log(
        dim(
            `  curl http://localhost:${localPort}/v1/chat/completions \\\n` +
                `    -H "Content-Type: application/json" \\\n` +
                `    -d '{"model":"${model.hf_repo}","messages":[{"role":"user","content":"Hello"}]}'`
        )
    );
    console.log("");
    info(`Manage it: ${dim(`llmrun ls · llmrun logs ${name} · llmrun stop ${name} · llmrun down ${name}`)}`);
}

/** Decide the instance type/engine, offering the CPU fallback when GPU quota is short. */
async function resolveTarget(sel: { region?: string; profile?: string }, model: Model): Promise<ResolvedTarget> {
    const gpuTarget: ResolvedTarget = {
        engine: model.engine,
        instanceType: model.instance_type,
        mode: "gpu",
        quantization: model.quantization,
    };

    const quota = await checkGpuQuota(sel, model.instance_type);

    if (quota.status !== "fail") {
        return gpuTarget;
    }

    // GPU quota is insufficient — surface guidance.
    error(`GPU quota check: ${quota.detail}`);
    if (quota.hint) {
        for (const line of quota.hint.split("\n")) console.log(`  ${dim(line)}`);
    }

    if (!model.cpu_fallback) {
        throw new LlmrunError(
            "Insufficient GPU quota and no CPU fallback configured for this model.",
            "Request a quota increase (link above), or add a `cpu_fallback` block to this model in llmrun.yaml."
        );
    }

    const fb = model.cpu_fallback;
    console.log("");
    warn(
        `A CPU fallback is available: ${fb.instance_type} via ${fb.engine}` +
            (fb.max_params ? ` (models ≤ ${fb.max_params})` : "") +
            ". This is MUCH slower — for functional dev/testing, not throughput."
    );
    const useCpu = await confirm({ message: `Run "${model.alias}" on CPU instead?`, default: false });

    if (!useCpu) {
        throw new LlmrunError("Aborted: GPU quota insufficient and CPU fallback declined.");
    }

    return { engine: fb.engine, instanceType: fb.instance_type, mode: "cpu", quantization: fb.quantization };
}

/** Show the cost estimate and ask for confirmation. Returns true to proceed. */
async function previewCostAndConfirm(model: Model, target: ResolvedTarget, autoYes: boolean): Promise<boolean> {
    const spec = getInstanceSpec(target.instanceType);
    const cost = estimateCost(target.instanceType);

    heading("Cost preview");
    keyValues([
        ["Model", `${model.alias} (${model.hf_repo})`],
        [
            "Instance",
            `${target.instanceType}${spec ? ` — ${spec.vcpus} vCPU, ${spec.gpus > 0 ? `${spec.gpus}×${spec.gpuType}` : "CPU-only"}` : ""}`,
        ],
        [
            "Est. cost",
            cost ? `~${formatUsd(cost.usdPerHour)}/hr  (~${formatUsd(cost.usdPerDay)}/day if left running)` : "unknown",
        ],
        ["Disk", `${model.disk_gb} GB`],
    ]);
    console.log(
        "  " +
            dim(
                `${symbols.info} You're only charged while running; the instance auto-stops when idle. Costs are approximate.`
            )
    );

    // Warn if the model won't fit the instance's GPU memory with a usable KV cache.
    // This catches both the hard OOM case and the subtler "weights fit but no KV
    // cache headroom" case that causes vLLM to crash on startup.
    if (target.mode === "gpu") {
        const fit = checkVramFit(target.instanceType, model.hf_repo, target.quantization);

        if (fit && !fit.fits) {
            console.log("");
            const kvBudget = Math.max(fit.kvBudgetGb, 0);

            if (kvBudget < 0.5) {
                // Weights barely fit or overflow — almost no KV cache headroom.
                warn(
                    `~${fit.paramsB}B params need ~${fit.usedGb.toFixed(1)} GB (weights + overhead) ` +
                        `but only ${fit.vramGb} GB VRAM available — vLLM will crash: no room for KV cache.`
                );
                console.log(
                    "  " +
                        dim(
                            "Fix: use a larger / multi-GPU instance, or a smaller model. " +
                                `A ${fit.paramsB}B AWQ model needs at least ${Math.ceil(fit.usedGb + 2)} GB VRAM to serve any requests.`
                        )
                );
            } else {
                // Weights fit but KV cache budget is too small for a useful context window.
                // KV cache scales ~linearly with context length; estimate tokens from budget.
                const maxCtx = Math.floor((kvBudget / 8) * 32768);
                warn(
                    `~${fit.paramsB}B params leave only ${kvBudget.toFixed(1)} GB for KV cache on ${fit.vramGb} GB VRAM. ` +
                        `Max context length is roughly ${maxCtx.toLocaleString()} tokens — ` +
                        `vLLM will crash if context_length (${model.context_length ?? 0}) exceeds this.`
                );
                console.log(
                    "  " +
                        dim(`Fix: set context_length: ${Math.min(maxCtx, 4096)} (or lower) in llmrun.yaml for this model.`)
                );
            }

            if (!autoYes) {
                const proceed = await confirm({ message: "Provision anyway?", default: false });

                if (!proceed) return false;
            }
        }
    }
    console.log("");

    if (autoYes) return true;

    return confirm({ message: "Provision this instance?", default: true });
}
