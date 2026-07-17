/**
 * Bundled instance specs and approximate on-demand pricing.
 *
 * Prices are approximate USD/hour for us-east-1 and are used only for the cost
 * preview shown before provisioning — treat them as estimates, not billing.
 * (Phase 2 will refresh these live via the AWS Pricing API.) vCPU counts are
 * used for the GPU service-quota check and are exact.
 */

export interface InstanceSpec {
    vcpus: number;
    /** Number of GPUs (0 for CPU instances). */
    gpus: number;
    gpuType?: string;
    /** Approximate on-demand price, USD/hour, us-east-1. */
    usdPerHour: number;
}

export const INSTANCE_SPECS: Record<string, InstanceSpec> = {
    // --- G6 (NVIDIA L4) ---
    "g6.xlarge": { vcpus: 4, gpus: 1, gpuType: "L4", usdPerHour: 0.8048 },
    "g6.2xlarge": { vcpus: 8, gpus: 1, gpuType: "L4", usdPerHour: 0.9776 },
    "g6.4xlarge": { vcpus: 16, gpus: 1, gpuType: "L4", usdPerHour: 1.323 },
    "g6.8xlarge": { vcpus: 32, gpus: 1, gpuType: "L4", usdPerHour: 2.014 },
    "g6.12xlarge": { vcpus: 48, gpus: 4, gpuType: "L4", usdPerHour: 4.602 },
    "g6.48xlarge": { vcpus: 192, gpus: 8, gpuType: "L4", usdPerHour: 13.35 },

    // --- G6e (NVIDIA L40S) ---
    "g6e.xlarge": { vcpus: 4, gpus: 1, gpuType: "L40S", usdPerHour: 1.861 },
    "g6e.2xlarge": { vcpus: 8, gpus: 1, gpuType: "L40S", usdPerHour: 2.242 },
    "g6e.4xlarge": { vcpus: 16, gpus: 1, gpuType: "L40S", usdPerHour: 3.004 },
    "g6e.12xlarge": { vcpus: 48, gpus: 4, gpuType: "L40S", usdPerHour: 10.49 },
    "g6e.48xlarge": { vcpus: 192, gpus: 8, gpuType: "L40S", usdPerHour: 30.13 },

    // --- G5 (NVIDIA A10G) ---
    "g5.xlarge": { vcpus: 4, gpus: 1, gpuType: "A10G", usdPerHour: 1.006 },
    "g5.2xlarge": { vcpus: 8, gpus: 1, gpuType: "A10G", usdPerHour: 1.212 },
    "g5.4xlarge": { vcpus: 16, gpus: 1, gpuType: "A10G", usdPerHour: 1.624 },
    "g5.12xlarge": { vcpus: 48, gpus: 4, gpuType: "A10G", usdPerHour: 5.672 },
    "g5.48xlarge": { vcpus: 192, gpus: 8, gpuType: "A10G", usdPerHour: 16.288 },

    // --- P4 (NVIDIA A100) ---
    "p4d.24xlarge": { vcpus: 96, gpus: 8, gpuType: "A100 40GB", usdPerHour: 32.7726 },

    // --- CPU instances (for the CPU fallback path) ---
    "c7i.2xlarge": { vcpus: 8, gpus: 0, usdPerHour: 0.357 },
    "c7i.4xlarge": { vcpus: 16, gpus: 0, usdPerHour: 0.714 },
    "c7i.8xlarge": { vcpus: 32, gpus: 0, usdPerHour: 1.428 },
    "m7i.2xlarge": { vcpus: 8, gpus: 0, usdPerHour: 0.4032 },
    "m7i.4xlarge": { vcpus: 16, gpus: 0, usdPerHour: 0.8064 },
};

export function getInstanceSpec(instanceType: string): InstanceSpec | undefined {
    return INSTANCE_SPECS[instanceType];
}

export interface CostEstimate {
    usdPerHour: number;
    usdPerDay: number;
    approximate: boolean;
}

/** Estimate cost for an instance type. Returns undefined if the type is unknown. */
export function estimateCost(instanceType: string): CostEstimate | undefined {
    const spec = getInstanceSpec(instanceType);

    if (!spec) return undefined;

    return {
        usdPerHour: spec.usdPerHour,
        usdPerDay: spec.usdPerHour * 24,
        approximate: true,
    };
}

export function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

/** VRAM per single GPU, in GB, keyed by the gpuType used in INSTANCE_SPECS. */
const GPU_VRAM_GB: Record<string, number> = {
    L4: 24,
    L40S: 48,
    A10G: 24,
    "A100 40GB": 40,
};

/** Total GPU memory (GB) for an instance type; 0 for CPU/unknown instances. */
export function instanceVramGb(instanceType: string): number {
    const spec = getInstanceSpec(instanceType);

    if (!spec || !spec.gpuType || spec.gpus === 0) return 0;

    return spec.gpus * (GPU_VRAM_GB[spec.gpuType] ?? 0);
}

/** Best-effort parse of a model's parameter count in billions from its repo/alias. */
export function estimateParamsB(nameOrRepo: string): number | undefined {
    const match = nameOrRepo.match(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/);

    return match ? parseFloat(match[1]!) : undefined;
}

/** Bytes-per-parameter implied by a quantization string (fp16 default). */
function bytesPerParam(quantization?: string): number {
    if (!quantization) return 2;
    if (/awq|gptq|int4|4bit|nf4/i.test(quantization)) return 0.6;
    if (/fp8|int8|8bit/i.test(quantization)) return 1;

    return 2;
}

export interface VramFit {
    paramsB: number;
    weightsGb: number;
    vramGb: number;
    /** Whether weights (plus modest overhead) plausibly fit in VRAM. */
    fits: boolean;
}

/**
 * Heuristic check of whether a model's weights fit an instance's GPU memory.
 * Returns undefined when the parameter count or VRAM can't be determined.
 * Accounts only for weights + ~10% overhead, leaving room for KV cache — it is a
 * guard against obvious over-provisioning (e.g. a 32B fp16 model on one 48GB GPU),
 * not an exact planner.
 */
export function checkVramFit(instanceType: string, nameOrRepo: string, quantization?: string): VramFit | undefined {
    const paramsB = estimateParamsB(nameOrRepo);
    const vramGb = instanceVramGb(instanceType);

    if (paramsB === undefined || vramGb === 0) return undefined;

    const weightsGb = paramsB * bytesPerParam(quantization);

    return { paramsB, weightsGb, vramGb, fits: weightsGb * 1.1 <= vramGb * 0.92 };
}
