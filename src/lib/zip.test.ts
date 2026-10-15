import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { createZip } from "./zip.js";

interface ParsedEntry {
    name: string;
    method: number;
    crc: number;
    data: Buffer;
}

/** Independent reader: walk the central directory, then inflate each local entry. */
function readZip(zip: Buffer): ParsedEntry[] {
    const eocd = zip.length - 22;

    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);

    const count = zip.readUInt16LE(eocd + 10);
    const cdSize = zip.readUInt32LE(eocd + 12);
    const cdOffset = zip.readUInt32LE(eocd + 16);

    expect(cdOffset + cdSize).toBe(eocd);

    const out: ParsedEntry[] = [];
    let p = cdOffset;

    for (let i = 0; i < count; i++) {
        expect(zip.readUInt32LE(p)).toBe(0x02014b50);

        const method = zip.readUInt16LE(p + 10);
        const crc = zip.readUInt32LE(p + 16);
        const compSize = zip.readUInt32LE(p + 20);
        const size = zip.readUInt32LE(p + 24);
        const nameLen = zip.readUInt16LE(p + 28);
        const localOffset = zip.readUInt32LE(p + 42);
        const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");

        expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);

        const lNameLen = zip.readUInt16LE(localOffset + 26);
        const lExtraLen = zip.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const body = zip.subarray(start, start + compSize);
        const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

        expect(data.length).toBe(size);
        out.push({ name, method, crc, data });
        p += 46 + nameLen;
    }

    return out;
}

// Reference CRC-32 via a straightforward bitwise implementation.
function refCrc(buf: Buffer): number {
    let c = 0xffffffff;

    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }

    return (c ^ 0xffffffff) >>> 0;
}

describe("createZip", () => {
    it("round-trips text and binary entries with correct CRCs", () => {
        const text = "hello ledger\n".repeat(200);
        const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const zip = createZip([
            { name: "history.jsonl", data: text },
            { name: "deployments/a/deployment.json", data: bin },
        ]);
        const entries = readZip(zip);

        expect(entries.map((e) => e.name)).toEqual(["history.jsonl", "deployments/a/deployment.json"]);
        expect(entries[0]!.data.toString("utf8")).toBe(text);
        expect(entries[0]!.method).toBe(8);
        expect(entries[1]!.data.equals(bin)).toBe(true);

        for (const e of entries) expect(e.crc).toBe(refCrc(e.data));
    });

    it("stores incompressible data instead of deflating it", () => {
        const tiny = createZip([{ name: "x", data: "a" }]);

        expect(readZip(tiny)[0]!.method).toBe(0);
    });

    it("handles empty entries and an empty archive", () => {
        expect(readZip(createZip([{ name: "empty", data: "" }]))[0]!.data.length).toBe(0);
        expect(readZip(createZip([]))).toEqual([]);
    });

    it("keeps UTF-8 names intact", () => {
        const [e] = readZip(createZip([{ name: "zażółć.txt", data: "ok" }]));

        expect(e!.name).toBe("zażółć.txt");
    });

    it("clamps pre-1980 dates instead of corrupting the header", () => {
        expect(() => createZip([{ name: "a", data: "b" }], new Date("1975-01-01T00:00:00Z"))).not.toThrow();
    });
});
