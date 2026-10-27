import "server-only";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Minimal store-only (no compression) ZIP writer.
 *
 * Store-only is the right choice here: outputs are JPEG/PNG/WEBP/MP4, all
 * already compressed, so deflate would burn CPU for ~0% gain.
 *
 * Each file is read twice — once to compute its CRC32, once to stream its
 * bytes — because a local file header must carry the CRC before the data, and
 * the alternative (data descriptors) is less widely supported. Two passes keep
 * memory flat regardless of file size, which matters once video lands.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, chunk: Buffer): number {
  let c = crc;
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

async function crc32OfFile(path: string): Promise<number> {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(path)) crc = crc32Update(crc, chunk as Buffer);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only format the ZIP local header understands. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Entry {
  path: string;
  name: string;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Build a ZIP of `files` as a streaming response body. */
export function createZipStream(files: { path: string; name?: string }[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const entries: Entry[] = [];
        const used = new Set<string>();
        let offset = 0;

        for (const file of files) {
          const info = await stat(file.path);
          if (!info.isFile()) continue;

          const name = uniqueName(file.name ?? basename(file.path), used);
          const nameBytes = Buffer.from(name, "utf8");
          const crc = await crc32OfFile(file.path);
          const { time, date } = dosDateTime(info.mtime);

          const header = Buffer.alloc(30 + nameBytes.length);
          header.writeUInt32LE(0x04034b50, 0);
          header.writeUInt16LE(20, 4); // version needed
          header.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
          header.writeUInt16LE(0, 8); // method: store
          header.writeUInt16LE(time, 10);
          header.writeUInt16LE(date, 12);
          header.writeUInt32LE(crc, 14);
          header.writeUInt32LE(info.size, 18); // compressed == uncompressed
          header.writeUInt32LE(info.size, 22);
          header.writeUInt16LE(nameBytes.length, 26);
          header.writeUInt16LE(0, 28); // extra field length
          nameBytes.copy(header, 30);
          controller.enqueue(header);

          for await (const chunk of createReadStream(file.path)) {
            controller.enqueue(chunk as Buffer);
          }

          entries.push({ path: file.path, name, crc, size: info.size, offset, time, date });
          offset += header.length + info.size;
        }

        const cdStart = offset;
        for (const e of entries) {
          const nameBytes = Buffer.from(e.name, "utf8");
          const cd = Buffer.alloc(46 + nameBytes.length);
          cd.writeUInt32LE(0x02014b50, 0);
          cd.writeUInt16LE(20, 4); // version made by
          cd.writeUInt16LE(20, 6); // version needed
          cd.writeUInt16LE(0x0800, 8);
          cd.writeUInt16LE(0, 10); // method: store
          cd.writeUInt16LE(e.time, 12);
          cd.writeUInt16LE(e.date, 14);
          cd.writeUInt32LE(e.crc, 16);
          cd.writeUInt32LE(e.size, 20);
          cd.writeUInt32LE(e.size, 24);
          cd.writeUInt16LE(nameBytes.length, 28);
          cd.writeUInt16LE(0, 30); // extra
          cd.writeUInt16LE(0, 32); // comment
          cd.writeUInt16LE(0, 34); // disk number start
          cd.writeUInt16LE(0, 36); // internal attributes
          cd.writeUInt32LE(0, 38); // external attributes
          cd.writeUInt32LE(e.offset, 42);
          nameBytes.copy(cd, 46);
          controller.enqueue(cd);
          offset += cd.length;
        }

        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(0, 4); // this disk
        end.writeUInt16LE(0, 6); // disk with central directory
        end.writeUInt16LE(entries.length, 8);
        end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(offset - cdStart, 12);
        end.writeUInt32LE(cdStart, 16);
        end.writeUInt16LE(0, 20); // comment length
        controller.enqueue(end);

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** ZIP entries must be unique; append " (2)" style suffixes like Explorer does. */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) {
    const dot = name.lastIndexOf(".");
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    n++;
  }
  used.add(candidate);
  return candidate;
}
