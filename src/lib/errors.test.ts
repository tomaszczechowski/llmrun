import { describe, expect, it } from "vitest";
import { LlmrunError, formatDuration, parseDuration, parseSinceIso } from "./errors.js";

describe("parseDuration", () => {
    it("parses single and compound units", () => {
        expect(parseDuration("30m")).toBe(1800);
        expect(parseDuration("1h")).toBe(3600);
        expect(parseDuration("90s")).toBe(90);
        expect(parseDuration("2h30m")).toBe(9000);
        expect(parseDuration("7d")).toBe(7 * 86400);
        expect(parseDuration("1d2h")).toBe(86400 + 7200);
    });

    it("treats a bare number as minutes", () => {
        expect(parseDuration("45")).toBe(2700);
    });

    it("is case/whitespace tolerant", () => {
        expect(parseDuration("  2H 30M ")).toBe(9000);
    });

    it("rejects garbage", () => {
        expect(() => parseDuration("soon")).toThrow(LlmrunError);
        expect(() => parseDuration("")).toThrow(LlmrunError);
    });
});

describe("parseSinceIso", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");

    it("returns undefined for empty input (= all time)", () => {
        expect(parseSinceIso(undefined, now)).toBeUndefined();
        expect(parseSinceIso("   ", now)).toBeUndefined();
    });

    it("subtracts a duration from now", () => {
        expect(parseSinceIso("12h", now)).toBe("2026-10-15T00:00:00.000Z");
        expect(parseSinceIso("30d", now)).toBe("2026-09-15T12:00:00.000Z");
        expect(parseSinceIso("90m", now)).toBe("2026-10-15T10:30:00.000Z");
    });

    it("treats a bare number as DAYS (unlike parseDuration)", () => {
        expect(parseSinceIso("7", now)).toBe("2026-10-08T12:00:00.000Z");
    });

    it("rejects zero and invalid ranges", () => {
        expect(() => parseSinceIso("0", now)).toThrow(LlmrunError);
        expect(() => parseSinceIso("0m", now)).toThrow(LlmrunError);
        expect(() => parseSinceIso("abc", now)).toThrow(LlmrunError);
    });

    it("does not leak a raw RangeError for absurdly large ranges", () => {
        // Date overflow -> toISOString() throws RangeError("Invalid time value").
        expect(() => parseSinceIso("999999999999d", now)).toThrow(LlmrunError);
    });
});

describe("formatDuration", () => {
    it("formats seconds, minutes and hours without rounding up", () => {
        expect(formatDuration(0)).toBe("0s");
        expect(formatDuration(45)).toBe("45s");
        expect(formatDuration(60)).toBe("1m");
        expect(formatDuration(3599)).toBe("59m 59s");
        expect(formatDuration(3600)).toBe("1h");
        expect(formatDuration(5400)).toBe("1h 30m");
    });

    it("clamps negatives and truncates fractions", () => {
        expect(formatDuration(-5)).toBe("0s");
        expect(formatDuration(59.9)).toBe("59s");
    });
});
