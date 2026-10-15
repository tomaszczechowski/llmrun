import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { pricesFile, homeDir } from "./paths.js";
import type { AwsSelection } from "./config.js";

/**
 * Live on-demand rates via the AWS Pricing API, replacing the bundled
 * (approximate, us-east-1) table as the source of truth whenever reachable.
 *
 * Results are cached in `~/.llmrun/prices.json` (per region:instanceType)
 * because the Pricing API is slow and rate-limited, and on-demand prices
 * change rarely. The bundled table in `lib/instances.ts` remains the offline
 * fallback.
 */

/** Cached rates are considered fresh for this long before a re-fetch. */
const RATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** gp3 baseline used for the storage-while-stopped estimate. */
export const STORAGE_USD_PER_GB_MONTH = 0.08;

/** AWS pricing "location" name per region (needed by the pricing filters). */
const REGION_LOCATIONS: Record<string, string> = {
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-1": "US West (N. California)",
    "us-west-2": "US West (Oregon)",
    "ca-central-1": "Canada (Central)",
    "ca-west-1": "Canada West (Calgary)",
    "eu-central-1": "EU (Frankfurt)",
    "eu-central-2": "EU (Zurich)",
    "eu-west-1": "EU (Ireland)",
    "eu-west-2": "EU (London)",
    "eu-west-3": "EU (Paris)",
    "eu-north-1": "EU (Stockholm)",
    "eu-south-1": "EU (Milan)",
    "eu-south-2": "EU (Spain)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ap-northeast-2": "Asia Pacific (Seoul)",
    "ap-northeast-3": "Asia Pacific (Osaka)",
    "ap-south-1": "Asia Pacific (Mumbai)",
    "ap-south-2": "Asia Pacific (Hyderabad)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-southeast-3": "Asia Pacific (Jakarta)",
    "ap-southeast-4": "Asia Pacific (Melbourne)",
    "sa-east-1": "South America (Sao Paulo)",
    "il-central-1": "Israel (Tel Aviv)",
    "me-south-1": "Middle East (Bahrain)",
    "me-central-1": "Middle East (UAE)",
    "af-south-1": "Africa (Cape Town)",
};

interface CacheEntry {
    usdPerHour: number;
    /** ISO timestamp of when the rate was fetched. */
    fetchedAt: string;
}

type CacheFile = Record<string, CacheEntry>;

function cacheKey(region: string, instanceType: string): string {
    return `${region}:${instanceType}`;
}

function readCache(): CacheFile {
    if (!existsSync(pricesFile())) return {};
    try {
        return JSON.parse(readFileSync(pricesFile(), "utf8")) as CacheFile;
    } catch {
        return {};
    }
}

function writeCache(cache: CacheFile): void {
    mkdirSync(homeDir(), { recursive: true });
    writeFileSync(pricesFile(), JSON.stringify(cache, null, 4) + "\n");
}

// In-memory memo so the 5 s studio deployments poll doesn't re-read the file.
let memo: { cache: CacheFile; at: number } | null = null;
const MEMO_TTL_MS = 30_000;

function cached(): CacheFile {
    if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.cache;
    memo = { cache: readCache(), at: Date.now() };

    return memo.cache;
}

/** Invalidate the in-memory memo (after writes) and persist. */
function persist(cache: CacheFile): void {
    writeCache(cache);
    memo = { cache, at: Date.now() };
}

/** The cached live rate for a region:instanceType, or undefined if absent/stale. */
export function getCachedRate(region: string, instanceType: string, now = Date.now()): number | undefined {
    const entry = cached()[cacheKey(region, instanceType)];

    if (!entry || typeof entry.usdPerHour !== "number" || entry.usdPerHour <= 0) return undefined;
    if (now - Date.parse(entry.fetchedAt) > RATE_TTL_MS) return undefined;

    return entry.usdPerHour;
}

function pricingClient(sel: AwsSelection): PricingClient {
    // The Pricing API is only served from a few regions; us-east-1 is universal.
    return new PricingClient({
        region: "us-east-1",
        credentials: fromNodeProviderChain(sel.profile ? { profile: sel.profile } : {}),
    });
}

/** Extract the on-demand USD/hour from one pricing offer JSON document. */
function offerRate(offerJson: string, region: string): number | undefined {
    let offer: any;
    try {
        offer = JSON.parse(offerJson);
    } catch {
        return undefined;
    }

    const attrs = offer?.product?.attributes ?? {};

    if (attrs.regionCode && attrs.regionCode !== region) return undefined;

    const onDemand = offer?.terms?.OnDemand ?? {};

    for (const term of Object.values<any>(onDemand)) {
        for (const dim of Object.values<any>(term?.priceDimensions ?? {})) {
            const usd = parseFloat(dim?.pricePerUnit?.USD ?? "");

            if (Number.isFinite(usd) && usd > 0) return usd;
        }
    }
    return undefined;
}

/**
 * Fetch the live Linux on-demand rate for an instance type in a region.
 * Returns undefined when the Pricing API can't answer (no offer, credentials
 * without pricing access, network) — callers fall back to the bundled table.
 */
export async function fetchLiveRate(
    sel: AwsSelection,
    region: string,
    instanceType: string,
    timeoutMs = 8_000
): Promise<number | undefined> {
    const filters = [
        { Type: "TERM_MATCH" as const, Field: "instanceType", Value: instanceType },
        { Type: "TERM_MATCH" as const, Field: "operatingSystem", Value: "Linux" },
        { Type: "TERM_MATCH" as const, Field: "tenancy", Value: "Shared" },
        { Type: "TERM_MATCH" as const, Field: "preInstalledSw", Value: "NA" },
        { Type: "TERM_MATCH" as const, Field: "capacitystatus", Value: "Used" },
    ];

    const location = REGION_LOCATIONS[region];

    if (location) {
        filters.push({ Type: "TERM_MATCH", Field: "location", Value: location });
    }

    try {
        const res = await pricingClient(sel).send(
            new GetProductsCommand({ ServiceCode: "AmazonEC2", Filters: filters }),
            { abortSignal: AbortSignal.timeout(timeoutMs) }
        );

        for (const offer of res.PriceList ?? []) {
            if (typeof offer !== "string") continue;
            const rate = offerRate(offer, region);

            if (rate !== undefined) return rate;
        }
    } catch {
        // No pricing access / offline / throttled — fall back to the table.
    }
    return undefined;
}

// In-flight dedupe: concurrent callers for the same key share one fetch.
const inflight = new Map<string, Promise<number | undefined>>();

/**
 * Get the live rate for region:instanceType — cached when fresh, otherwise
 * fetched and cached. Safe to call per-request/per-poll; never throws.
 */
export function getLiveRate(sel: AwsSelection, region: string, instanceType: string): Promise<number | undefined> {
    const hit = getCachedRate(region, instanceType);

    if (hit !== undefined) return Promise.resolve(hit);

    const key = cacheKey(region, instanceType);
    const running = inflight.get(key);

    if (running) return running;

    const p = fetchLiveRate(sel, region, instanceType)
        .then((rate) => {
            if (rate !== undefined) {
                const cache = readCache();
                cache[key] = { usdPerHour: rate, fetchedAt: new Date().toISOString() };
                persist(cache);
            }

            return rate;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, p);

    return p;
}

/**
 * Best-effort background refresh of rates for a set of deployments (used by
 * the studio bridge so cached rates exist by the time the UI asks). Never
 * throws; a failure just leaves the bundled table in play.
 */
export async function refreshRatesFor(
    sel: AwsSelection,
    targets: { region: string; instanceType: string }[]
): Promise<void> {
    const unique = new Map<string, { region: string; instanceType: string }>();

    for (const t of targets) {
        if (!t.region || !t.instanceType) continue;
        unique.set(cacheKey(t.region, t.instanceType), t);
    }
    await Promise.allSettled([...unique.values()].map((t) => getLiveRate(sel, t.region, t.instanceType)));
}
