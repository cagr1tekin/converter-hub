import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { safeWorkspacePath } from "@/core/workspace";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
};

type Params = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, { params }: Params) {
  const segments = (await params).path ?? [];
  const abs = safeWorkspacePath(segments.map(decodeURIComponent).join("/"));
  if (!abs) return new Response("Gecersiz yol.", { status: 400 });

  let info;
  try {
    info = await stat(abs);
  } catch {
    return new Response("Dosya bulunamadi.", { status: 404 });
  }
  if (!info.isFile()) return new Response("Dosya bulunamadi.", { status: 404 });

  const name = basename(abs);
  const download = new URL(request.url).searchParams.has("download");
  const type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";

  const body = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(info.size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      // svg is served from the same origin; block scripts inside it either way.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });
}
