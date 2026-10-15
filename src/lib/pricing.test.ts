import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const send = vi.fn();

vi.mock("@aws-sdk/client-pricing", () => ({
    PricingClient: class {
        send = send;
    },
    GetProductsCommand: class {
        constructor(public input: unknown) {}
    },
}));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => ({}) }));

const offer = (usd: string, regionCode = "us-east-1") =>
    JSON.stringify({
        product: { attributes: { regionCode } },
        terms: { OnDemand: { t: { priceDimensions: { d: { pricePerUnit: { USD: usd } } } } } },
    });

describe("pricing", () => {
    let home: string;
    const prev = process.env.LLMRUN_HOME;

    beforeEach(() => {
        home = mkdtempSync(path.join(tmpdir(), "llmrun-price-"));
        process.env.LLMRUN_HOME = home;
        send.mockReset();
        vi.resetModules(); // reset the module-level cache memo + inflight map
    });
    afterEach(() => {
        if (prev === undefined) delete process.env.LLMRUN_HOME;
        else process.env.LLMRUN_HOME = prev;
        rmSync(home, { recursive: true, force: true });
    });

    it("fetches, caches to disk, and serves the second call from cache", async () => {
        send.mockResolvedValue({ PriceList: [offer("1.006")] });
        const { getLiveRate, getCachedRate } = await import("./pricing.js");

        expect(await getLiveRate({}, "us-east-1", "g5.xlarge")).toBe(1.006);
        expect(await getLiveRate({}, "us-east-1", "g5.xlarge")).toBe(1.006);
        expect(send).toHaveBeenCalledTimes(1);
        expect(getCachedRate("us-east-1", "g5.xlarge")).toBe(1.006);
        expect(JSON.parse(readFileSync(path.join(home, "prices.json"), "utf8"))["us-east-1:g5.xlarge"].usdPerHour).toBe(
            1.006
        );
    });

    it("dedupes concurrent fetches for the same key", async () => {
        send.mockResolvedValue({ PriceList: [offer("2.5")] });
        const { getLiveRate } = await import("./pricing.js");
        const r = await Promise.all([1, 2, 3].map(() => getLiveRate({}, "us-east-1", "g5.2xlarge")));

        expect(r).toEqual([2.5, 2.5, 2.5]);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("returns undefined (never throws) when the API fails or has no offer", async () => {
        const { getLiveRate } = await import("./pricing.js");

        send.mockRejectedValueOnce(new Error("AccessDenied"));
        expect(await getLiveRate({}, "us-east-1", "p4d.24xlarge")).toBeUndefined();

        send.mockResolvedValueOnce({ PriceList: [] });
        expect(await getLiveRate({}, "us-east-1", "p4d.24xlarge")).toBeUndefined();
    });

    it("ignores offers for another region, zero prices, and malformed JSON", async () => {
        send.mockResolvedValue({ PriceList: ["{bad", offer("0.0000000000"), offer("9.9", "eu-west-1"), offer("3.3")] });
        const { getLiveRate } = await import("./pricing.js");

        expect(await getLiveRate({}, "us-east-1", "g6.xlarge")).toBe(3.3);
    });

    it("treats stale and invalid cache entries as absent", async () => {
        writeFileSync(
            path.join(home, "prices.json"),
            JSON.stringify({
                "us-east-1:old": { usdPerHour: 1, fetchedAt: "2020-01-01T00:00:00.000Z" },
                "us-east-1:neg": { usdPerHour: -1, fetchedAt: new Date().toISOString() },
                "us-east-1:ok": { usdPerHour: 4, fetchedAt: new Date().toISOString() },
            })
        );
        const { getCachedRate } = await import("./pricing.js");

        expect(getCachedRate("us-east-1", "old")).toBeUndefined();
        expect(getCachedRate("us-east-1", "neg")).toBeUndefined();
        expect(getCachedRate("us-east-1", "ok")).toBe(4);
    });

    it("survives a corrupt cache file", async () => {
        writeFileSync(path.join(home, "prices.json"), "{{{");
        const { getCachedRate } = await import("./pricing.js");

        expect(getCachedRate("us-east-1", "x")).toBeUndefined();
    });

    it("refreshRatesFor dedupes targets and skips blanks", async () => {
        send.mockResolvedValue({ PriceList: [offer("1")] });
        const { refreshRatesFor } = await import("./pricing.js");

        await refreshRatesFor({}, [
            { region: "us-east-1", instanceType: "a" },
            { region: "us-east-1", instanceType: "a" },
            { region: "", instanceType: "b" },
        ]);

        expect(send).toHaveBeenCalledTimes(1);
    });
});
