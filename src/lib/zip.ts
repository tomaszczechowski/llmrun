import { deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer (deflate method) with no runtime dependencies — just
 * enough for `llmrun history export` to produce a single-file archive of the
 * ledger. Not a general-purpose zip library: UTF-8 names, no directories
 * entries (paths imply structure), no comments, no zip64.
 */

export interface ZipEntry {
    /** Archive path, e.g. `history.jsonl` or `deployments/foo/deployment.json`. */
    name: string;
    data: Uint8Array | string;
}

// CRC-32 (IEEE) with the standard polynomial, table-driven.
const CRC_TABLE = (() => {
    const table = new Int32Array(256);

    for (let i = 0; i < 256; i++) {
        let c = i;

        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }

    return table;
})();

function crc32(buf: Uint8Array): number {
    let c = -1;

    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    }

    return (c ^ -1) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
    const year = Math.max(1980, d.getFullYear());

    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/** Build a ZIP archive (deflate-compressed entries) as a single Buffer. */
export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
    const { time, date } = dosDateTime(now);
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
        const deflated = deflateRawSync(raw, { level: 9 });
        // Store instead of deflate when compression doesn't pay off.
        const useDeflate = deflated.length < raw.length;
        const body = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const nameBuf = Buffer.from(entry.name, "utf8");
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        locals.push(local, nameBuf, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42); // local header offset
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }

    const centralDir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4); // disk
    end.writeUInt16LE(0, 6); // disk with central dir
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...locals, centralDir, end]);
}
