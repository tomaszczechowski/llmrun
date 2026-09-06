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
    /** Instance memory in GiB (known for CPU instances; used for the CPU vLLM RAM check). */
    memoryGb?: number;
    /** Approximate on-demand price, USD/hour, us-east-1. */
    usdPerHour: number;
}

export const INSTANCE_SPECS: Record<string, InstanceSpec> = {
    // --- G4dn (NVIDIA T4, 16 GB VRAM) ---
    "g4dn.xlarge": { vcpus: 4, gpus: 1, gpuType: "T4", usdPerHour: 0.526 },
    "g4dn.2xlarge": { vcpus: 8, gpus: 1, gpuType: "T4", usdPerHour: 0.752 },
    "g4dn.4xlarge": { vcpus: 16, gpus: 1, gpuType: "T4", usdPerHour: 1.204 },
    "g4dn.8xlarge": { vcpus: 32, gpus: 1, gpuType: "T4", usdPerHour: 2.264 },
    "g4dn.12xlarge": { vcpus: 48, gpus: 4, gpuType: "T4", usdPerHour: 3.912 },
    "g4dn.16xlarge": { vcpus: 64, gpus: 1, gpuType: "T4", usdPerHour: 4.352 },

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
    // Compute-optimized c7i (1:2 vCPU:RAM)
    "c7i.2xlarge": { vcpus: 8, gpus: 0, memoryGb: 16, usdPerHour: 0.357 },
    "c7i.4xlarge": { vcpus: 16, gpus: 0, memoryGb: 32, usdPerHour: 0.714 },
    "c7i.8xlarge": { vcpus: 32, gpus: 0, memoryGb: 64, usdPerHour: 1.428 },
    "c7i.12xlarge": { vcpus: 48, gpus: 0, memoryGb: 96, usdPerHour: 2.142 },
    // General-purpose m7i (1:2)
    "m7i.2xlarge": { vcpus: 8, gpus: 0, memoryGb: 32, usdPerHour: 0.4032 },
    "m7i.4xlarge": { vcpus: 16, gpus: 0, memoryGb: 64, usdPerHour: 0.8064 },
    "m7i.8xlarge": { vcpus: 32, gpus: 0, memoryGb: 128, usdPerHour: 1.6128 },
    // Memory-optimized r7i (1:8)
    "r7i.2xlarge": { vcpus: 8, gpus: 0, memoryGb: 64, usdPerHour: 0.5292 },
    "r7i.4xlarge": { vcpus: 16, gpus: 0, memoryGb: 128, usdPerHour: 1.0584 },
    "r7i.8xlarge": { vcpus: 32, gpus: 0, memoryGb: 256, usdPerHour: 2.1168 },
    // Memory-optimized r8i (1:8, Intel Granite Rapids)
    "r8i.2xlarge": { vcpus: 8, gpus: 0, memoryGb: 64, usdPerHour: 0.5557 },
    "r8i.4xlarge": { vcpus: 16, gpus: 0, memoryGb: 128, usdPerHour: 1.1114 },
    "r8i.8xlarge": { vcpus: 32, gpus: 0, memoryGb: 256, usdPerHour: 2.2227 },
    "r8i.12xlarge": { vcpus: 48, gpus: 0, memoryGb: 384, usdPerHour: 3.3341 },
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
    T4: 16,
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
    // AWQ/GPTQ 4-bit: theoretical 0.5 B/param but vLLM loading overhead raises it to ~0.68 in practice.
    if (/awq|gptq|int4|4bit|nf4/i.test(quantization)) return 0.68;
    if (/fp8|int8|8bit/i.test(quantization)) return 1;

    return 2;
}

// GPU driver + CUDA context + activation buffers consumed before any model weight.
const CUDA_OVERHEAD_GB = 1.5;
// Minimum KV cache needed to serve at least one request at a reasonable context length.
const MIN_KV_CACHE_GB = 2.0;

export interface VramFit {
    paramsB: number;
    weightsGb: number;
    vramGb: number;
    /** Whether weights + loading overhead + minimum KV cache plausibly fit in VRAM. */
    fits: boolean;
    /** GB consumed by weights + CUDA overhead (excludes KV cache). */
    usedGb: number;
    /** GB left over for KV cache after weights and overhead. */
    kvBudgetGb: number;
}

/**
 * Heuristic check of whether a model fits an instance's GPU memory with room
 * for a usable KV cache. Returns undefined when the parameter count or VRAM
 * can't be determined.
 *
 * Formula: weightsGb + CUDA_OVERHEAD (1.5 GB) + MIN_KV_CACHE (2 GB) <= total VRAM
 *
 * This catches the common failure mode of AWQ/GPTQ models that technically fit
 * weight-wise on a GPU but leave no headroom for KV cache, causing vLLM to crash.
 */
export function checkVramFit(instanceType: string, nameOrRepo: string, quantization?: string): VramFit | undefined {
    const paramsB = estimateParamsB(nameOrRepo);
    const vramGb = instanceVramGb(instanceType);

    if (paramsB === undefined || vramGb === 0) return undefined;

    const weightsGb = paramsB * bytesPerParam(quantization);
    const usedGb = weightsGb + CUDA_OVERHEAD_GB;
    const kvBudgetGb = vramGb - usedGb;

    return {
        paramsB,
        weightsGb,
        vramGb,
        usedGb,
        kvBudgetGb,
        fits: usedGb + MIN_KV_CACHE_GB <= vramGb,
    };
}

// Memory consumed by the vLLM CPU process (torch runtime, model loading,
// activations, page cache) before weights + KV cache.
const CPU_RAM_OVERHEAD_GB = 12;

export interface CpuRamFit {
    paramsB: number;
    weightsGb: number;
    kvcacheGb: number;
    memoryGb: number;
    /** Estimated total RAM needed (weights + KV cache + runtime overhead). */
    requiredGb: number;
    fits: boolean;
}

/**
 * Heuristic check of whether a model fits a CPU instance's RAM when served by
 * vLLM's CPU build: weights + VLLM_CPU_KVCACHE_SPACE + runtime overhead.
 * Returns undefined when the parameter count or instance memory is unknown.
 */
export function checkCpuRamFit(
    instanceType: string,
    nameOrRepo: string,
    quantization?: string,
    kvcacheGb = 16
): CpuRamFit | undefined {
    const paramsB = estimateParamsB(nameOrRepo);
    const memoryGb = getInstanceSpec(instanceType)?.memoryGb;

    if (paramsB === undefined || !memoryGb) return undefined;

    const weightsGb = paramsB * bytesPerParam(quantization);
    const requiredGb = weightsGb + kvcacheGb + CPU_RAM_OVERHEAD_GB;

    return { paramsB, weightsGb, kvcacheGb, memoryGb, requiredGb, fits: requiredGb <= memoryGb };
}
