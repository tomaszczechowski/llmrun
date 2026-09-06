/**
 * Minimal Prometheus text-format parser for vLLM's `/metrics` endpoint.
 *
 * The bridge fetches this over the local SSM port-forward (same port as the
 * API) — no CloudWatch, no new plumbing. Only the metric names the dashboard
 * consumes are extracted; label variants of the same name are summed (a
 * single-model instance emits one series per metric).
 */

const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+]+)$/;

export type MetricName = string;

/** Raw parsed metrics: base name → summed value across label variants. */
export type ParsedMetrics = Record<MetricName, number>;

export function parsePrometheus(text: string): ParsedMetrics {
    const out: ParsedMetrics = {};

    for (const line of text.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const m = line.match(METRIC_LINE);

        if (!m) continue;
        const name = m[1]!;
        const value = parseFloat(m[3]!);

        if (Number.isNaN(value)) continue;
        out[name] = (out[name] ?? 0) + value;
    }
    return out;
}

export interface VllmMetricSnapshot {
    /** Gauge: tokens decoded per second across the engine. */
    tokensPerSecond: number | null;
    /** Counters (cumulative since process start). */
    promptTokens: number | null;
    generationTokens: number | null;
    requestsRunning: number;
    requestsWaiting: number;
    /** KV cache occupancy, 0-100 (%). Note: this is KV cache, not VRAM. */
    kvCachePct: number | null;
    requestSuccessTotal: number;
    /** Histogram means, in ms (null when no samples yet). */
    e2eLatencyMs: number | null;
    ttftMs: number | null;
    tpotMs: number | null;
}

function histogramMeanMs(parsed: ParsedMetrics, base: string): number | null {
    const sum = parsed[`${base}_sum`];
    const count = parsed[`${base}_count`];

    if (sum === undefined || count === undefined || count <= 0) return null;

    return (sum / count) * 1000;
}

export function extractVllmMetrics(parsed: ParsedMetrics): VllmMetricSnapshot {
    const kv = parsed["vllm:gpu_cache_usage_perc"];

    return {
        tokensPerSecond: parsed["vllm:iteration_tokens_per_second"] ?? null,
        promptTokens: parsed["vllm:prompt_tokens_total"] ?? null,
        generationTokens: parsed["vllm:generation_tokens_total"] ?? null,
        requestsRunning: parsed["vllm:num_requests_running"] ?? 0,
        requestsWaiting: parsed["vllm:num_requests_waiting"] ?? 0,
        kvCachePct: kv !== undefined ? Math.min(100, Math.max(0, Math.round(kv * 100))) : null,
        requestSuccessTotal: parsed["vllm:request_success_total"] ?? 0,
        e2eLatencyMs: histogramMeanMs(parsed, "vllm:e2e_request_latency_seconds"),
        ttftMs: histogramMeanMs(parsed, "vllm:time_to_first_token_seconds"),
        tpotMs: histogramMeanMs(parsed, "vllm:time_per_output_token_seconds"),
    };
}
