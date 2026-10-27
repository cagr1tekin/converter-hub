import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HealthStatus } from "./types";

/**
 * Thin ffmpeg layer.
 *
 * Deliberately not fluent-ffmpeg: that wrapper was archived in May 2025 with a
 * note that it no longer works properly against recent ffmpeg builds. Building
 * the argument list directly is less code than working around a dead wrapper,
 * and it keeps every flag visible at the call site.
 */

const BIN = join(process.cwd(), "bin");

function resolveBinary(name: string): string | null {
  const local = join(BIN, `${name}.exe`);
  if (existsSync(local)) return local;
  // Fall back to PATH so a system-wide install also works.
  return process.env.PATH?.split(";").some((dir) => existsSync(join(dir, `${name}.exe`)))
    ? name
    : null;
}

export const ffmpegPath = () => resolveBinary("ffmpeg");
export const ffprobePath = () => resolveBinary("ffprobe");

export async function ffmpegHealth(): Promise<HealthStatus> {
  return ffmpegPath() && ffprobePath()
    ? { ok: true }
    : { ok: false, reason: "ffmpeg bulunamadi. Terminalde `pnpm ffmpeg` calistir." };
}

/* --------------------------------------------------------------- encoders */

let encoderCache: Set<string> | null = null;

/** Which encoders this build actually has — the answer decides CPU vs GPU. */
export async function availableEncoders(): Promise<Set<string>> {
  if (encoderCache) return encoderCache;
  const bin = ffmpegPath();
  if (!bin) return (encoderCache = new Set());

  const out = await capture(bin, ["-hide_banner", "-encoders"]).catch(() => "");
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
    if (m) found.add(m[1]);
  }
  return (encoderCache = found);
}

/**
 * Whether an encoder can actually be opened right now.
 *
 * Presence in `-encoders` only means it was compiled in. A hardware encoder can
 * still refuse to open — most often because the GPU driver is older than the
 * NVENC API the build was compiled against. Finding that out costs one ~200ms
 * encode of a synthetic frame, which is far better than failing an hour into a
 * batch.
 */
const encoderProbes = new Map<string, Promise<HealthStatus>>();

export function encoderWorks(name: string): Promise<HealthStatus> {
  const cached = encoderProbes.get(name);
  if (cached) return cached;

  const probing = (async (): Promise<HealthStatus> => {
    const bin = ffmpegPath();
    if (!bin) return { ok: false, reason: "ffmpeg bulunamadi." };
    if (!(await availableEncoders()).has(name)) {
      return { ok: false, reason: `${name} bu ffmpeg derlemesinde yok.` };
    }

    try {
      await capture(bin, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=0.2",
        "-c:v", name, "-frames:v", "1",
        "-f", "null", "-",
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: explainEncoderFailure(String(err)) };
    }
  })();

  encoderProbes.set(name, probing);
  return probing;
}

/** Turn ffmpeg's stderr into something that tells the user what to do. */
function explainEncoderFailure(stderr: string): string {
  const version = stderr.match(/Required:\s*([\d.]+)\s*Found:\s*([\d.]+)/);
  if (version) {
    const driver = stderr.match(/minimum required Nvidia driver[^\d]*([\d.]+)/i);
    return (
      `NVIDIA surucusu eski: NVENC ${version[1]} gerekiyor, kurulu olan ${version[2]}. ` +
      (driver ? `Surucuyu ${driver[1]} veya ustune guncelle.` : "Surucuyu guncelle.")
    );
  }
  if (/No capable devices|no NVENC capable devices/i.test(stderr)) {
    return "NVENC destekleyen bir GPU bulunamadi.";
  }
  if (/out of memory|OutOfMemory/i.test(stderr)) return "GPU bellegi yetersiz.";

  const first = stderr
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return first ? first.slice(0, 180) : "Kodlayici acilamadi.";
}

/* ------------------------------------------------------------------ probe */

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export async function probe(file: string): Promise<MediaInfo> {
  const bin = ffprobePath();
  if (!bin) throw new Error("ffprobe bulunamadi.");

  const raw = await capture(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);

  const data = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }[];
  };

  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  // Container duration is the reliable one; some formats (raw MPEG, .dat) only
  // carry it per-stream, so fall back before giving up.
  const duration =
    Number(data.format?.duration) ||
    Number(video?.duration) ||
    Number(audio?.duration) ||
    0;

  let fps = 0;
  if (video?.avg_frame_rate) {
    const [num, den] = video.avg_frame_rate.split("/").map(Number);
    if (num && den) fps = num / den;
  }

  return {
    durationSec: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
  };
}

/* -------------------------------------------------------------------- run */

export interface RunOptions {
  /** Known input duration, so byte-less progress can be turned into a percentage. */
  totalSec?: number;
  /** Called with 0-1 for this single ffmpeg invocation. */
  onProgress?: (fraction: number, speed?: string) => void;
  signal?: AbortSignal;
}

export async function runFFmpeg(args: string[], options: RunOptions = {}): Promise<void> {
  const bin = ffmpegPath();
  if (!bin) throw new Error("ffmpeg bulunamadi. `pnpm ffmpeg` calistir.");

  const { totalSec = 0, onProgress, signal } = options;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      bin,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        // Machine-readable progress on stdout, leaving stderr purely for errors.
        "-progress", "pipe:1",
        "-nostats",
        ...args,
      ],
      { windowsHide: true }
    );

    let stdoutBuf = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      let speed: string | undefined;
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "speed") speed = value?.trim();
        if (key === "out_time_us" && totalSec > 0 && onProgress) {
          const seconds = Number(value) / 1_000_000;
          if (Number.isFinite(seconds)) {
            onProgress(Math.max(0, Math.min(1, seconds / totalSec)), speed);
          }
        }
      }
    });

    // stderr is small at loglevel=error, but cap it so a pathological file
    // cannot grow it without bound.
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted) return reject(new Error("Iptal edildi."));
      if (code === 0) {
        onProgress?.(1);
        return resolve();
      }
      const detail = stderr.trim().split("\n").slice(-4).join(" | ");
      reject(new Error(detail || `ffmpeg ${code} koduyla cikti.`));
    });
  });
}

/* ------------------------------------------------------------------ utils */

function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))
    );
  });
}

/** `01:02:03` / `62` / `1:02.5` → seconds. Returns null when unparseable. */
export function parseTimecode(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p.trim()))) return null;

  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** Human-readable duration for logs. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
