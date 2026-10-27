import { basename, extname, join } from "node:path";
import { stat } from "node:fs/promises";
import {
  encoderWorks,
  ffmpegHealth,
  formatBytes,
  formatDuration,
  parseTimecode,
  probe,
  runFFmpeg,
} from "@/core/ffmpeg";
import { defineModule } from "@/core/types";

/** Anything ffmpeg can demux. .dat is the old VCD/MPEG-1 case specifically. */
const INPUTS = [
  "dat", "mpg", "mpeg", "m1v", "m2v", "vob", "avi", "wmv", "asf", "flv",
  "mkv", "mov", "mp4", "m4v", "webm", "ogv", "ts", "m2ts", "mts", "3gp",
  "divx", "rm", "rmvb", "f4v", "mxf",
];

/**
 * CRF is a quality target, not a bitrate: the encoder spends whatever bits the
 * footage needs to hit it. NVENC has no CRF, so each preset carries the
 * equivalent constant-quality value for the hardware path.
 */
const QUALITY: Record<string, { crf: number; cq: number; label: string }> = {
  highest: { crf: 18, cq: 19, label: "gorsel olarak kayipsiz" },
  high: { crf: 20, cq: 21, label: "yuksek" },
  balanced: { crf: 23, cq: 24, label: "dengeli" },
  small: { crf: 28, cq: 30, label: "kucuk dosya" },
};

export default defineModule({
  id: "video-convert",
  name: "Video donustur",
  description:
    "DAT, MPG, AVI, MKV ve digerlerini MP4'e cevirir. Sure ve boyut siniri yok, GPU hizlandirmali.",
  category: "video",
  engine: "binary",
  icon: "🎬",

  inputMode: "files",
  accepts: { ext: INPUTS, multiple: true },

  health: ffmpegHealth,

  options: [
    {
      key: "format",
      type: "select",
      label: "Hedef format",
      default: "mp4",
      choices: [
        { value: "mp4", label: "MP4 (H.264) - her yerde acilir" },
        { value: "mp4_hevc", label: "MP4 (H.265) - ayni kalite, yari boyut" },
        { value: "mkv", label: "MKV (H.264)" },
        { value: "webm", label: "WEBM (VP9)" },
        { value: "mov", label: "MOV (H.264)" },
        { value: "gif", label: "GIF (animasyon)" },
      ],
    },
    {
      key: "quality",
      type: "select",
      label: "Kalite",
      default: "highest",
      choices: [
        { value: "highest", label: "En yuksek - gozle kayipsiz" },
        { value: "high", label: "Yuksek" },
        { value: "balanced", label: "Dengeli" },
        { value: "small", label: "Kucuk dosya" },
      ],
      help: "Sabit kalite hedefi. Kodlayici her sahne icin gereken biti harcar.",
      showWhen: { key: "format", equals: ["mp4", "mp4_hevc", "mkv", "webm", "mov"] },
    },
    {
      key: "resolution",
      type: "select",
      label: "Cozunurluk",
      default: "original",
      choices: [
        { value: "original", label: "Kaynakla ayni" },
        { value: "2160", label: "4K - 2160p" },
        { value: "1440", label: "1440p" },
        { value: "1080", label: "1080p" },
        { value: "720", label: "720p" },
        { value: "480", label: "480p" },
      ],
      help: "Kaynaktan buyuk bir deger secersen goruntu buyutulmez, oldugu gibi kalir.",
    },
    {
      key: "hardware",
      type: "boolean",
      label: "GPU hizlandirma (NVENC)",
      default: true,
      help: "Ekran kartiyla kodlar, cok daha hizli. Kart desteklemezse CPU'ya duser.",
    },
    {
      key: "gifFps",
      type: "number",
      label: "GIF kare hizi",
      default: 15,
      min: 5,
      max: 30,
      step: 1,
      showWhen: { key: "format", equals: ["gif"] },
    },
    {
      key: "gifWidth",
      type: "number",
      label: "GIF genisligi (px)",
      default: 640,
      min: 120,
      max: 1920,
      step: 20,
      showWhen: { key: "format", equals: ["gif"] },
    },
    {
      key: "fps",
      type: "select",
      label: "Kare hizi",
      default: "original",
      choices: [
        { value: "original", label: "Kaynakla ayni" },
        { value: "60", label: "60 fps" },
        { value: "30", label: "30 fps" },
        { value: "24", label: "24 fps" },
      ],
      advanced: true,
      showWhen: { key: "format", equals: ["mp4", "mp4_hevc", "mkv", "webm", "mov"] },
    },
    {
      key: "audio",
      type: "boolean",
      label: "Sesi koru",
      default: true,
      advanced: true,
      showWhen: { key: "format", equals: ["mp4", "mp4_hevc", "mkv", "webm", "mov"] },
    },
    {
      key: "trimStart",
      type: "text",
      label: "Baslangic",
      default: "",
      placeholder: "00:00:10",
      help: "Bos birak = bastan. Bicim: sa:dk:sn veya saniye.",
      advanced: true,
    },
    {
      key: "trimEnd",
      type: "text",
      label: "Bitis",
      default: "",
      placeholder: "00:01:30",
      help: "Bos birak = sonuna kadar.",
      advanced: true,
    },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    const format = String(options.format);
    const preset = QUALITY[String(options.quality)] ?? QUALITY.highest;
    const wantsHardware = Boolean(options.hardware);

    const start = parseTimecode(String(options.trimStart ?? ""));
    const end = parseTimecode(String(options.trimEnd ?? ""));
    if (String(options.trimStart ?? "").trim() && start === null) {
      throw new Error("Baslangic zamani anlasilmadi. Ornek: 00:00:10");
    }
    if (String(options.trimEnd ?? "").trim() && end === null) {
      throw new Error("Bitis zamani anlasilmadi. Ornek: 00:01:30");
    }
    if (start !== null && end !== null && end <= start) {
      throw new Error("Bitis zamani baslangictan sonra olmali.");
    }

    // Resolved once: probing the GPU per file would repeat the same check.
    const choice = await pickEncoder(format, wantsHardware);
    if (format !== "gif" && choice.note) {
      log(`GPU kullanilamadi, CPU'ya dusuldu - ${choice.note}`);
    }

    const outputs = [];
    let bytesIn = 0;
    let bytesOut = 0;

    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();

      const info = await probe(file.path);
      if (!info.hasVideo) throw new Error(`${file.name}: video akisi yok.`);

      // Trimming shortens what ffmpeg reports, so progress must divide by the
      // trimmed span rather than the source duration.
      const from = start ?? 0;
      const to = end ?? info.durationSec;
      const span = Math.max(0.001, Math.min(to, info.durationSec || to) - from);

      const stem = basename(file.name, extname(file.name));
      const ext = format === "mp4_hevc" ? "mp4" : format;
      const target = join(outDir, `${stem}.${ext}`);

      const args: string[] = [];
      if (start !== null) args.push("-ss", String(start));
      args.push("-i", file.path);
      if (end !== null) args.push("-t", String(span));

      if (format === "gif") {
        const fps = Number(options.gifFps) || 15;
        const width = Number(options.gifWidth) || 640;
        // One pass: split the stream, build an optimal palette from it, then
        // apply that palette. A global palette is what keeps GIF from banding.
        args.push(
          "-vf",
          `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
          "-loop", "0",
          "-an"
        );
      } else {
        const filters: string[] = [];
        const height = Number(options.resolution);
        if (Number.isFinite(height) && height > 0) {
          // -2 keeps the aspect ratio and lands on an even number, which every
          // H.264/H.265 encoder requires. min() prevents upscaling.
          filters.push(`scale=-2:'min(${height},ih)'`);
        }
        if (options.fps !== "original") filters.push(`fps=${Number(options.fps)}`);
        if (filters.length) args.push("-vf", filters.join(","));

        const { encoder, hardware } = choice;
        args.push("-c:v", encoder);

        if (hardware) {
          args.push("-preset", "p6", "-rc", "vbr", "-cq", String(preset.cq), "-b:v", "0");
        } else if (format === "webm") {
          args.push("-crf", String(preset.crf), "-b:v", "0", "-row-mt", "1", "-deadline", "good");
        } else {
          args.push("-preset", "medium", "-crf", String(preset.crf));
        }

        // Chroma format most players and browsers can actually decode.
        if (format !== "webm") args.push("-pix_fmt", "yuv420p");

        if (!options.audio || !info.hasAudio) {
          args.push("-an");
        } else if (format === "webm") {
          args.push("-c:a", "libopus", "-b:a", "160k");
        } else {
          args.push("-c:a", "aac", "-b:a", "192k");
        }

        // Lets a partially-downloaded MP4 start playing instead of needing the
        // whole file first.
        if (format === "mp4" || format === "mp4_hevc" || format === "mov") {
          args.push("-movflags", "+faststart");
        }

        log(
          `${file.name}: ${info.width}x${info.height} ${info.videoCodec ?? "?"} ` +
            `${formatDuration(span)} -> ${encoder}${hardware ? " (GPU)" : " (CPU)"}`
        );
      }

      args.push("-y", target);

      await runFFmpeg(args, {
        totalSec: span,
        signal,
        onProgress: (fraction, speed) => {
          const overall = ((index + fraction) / inputs.length) * 100;
          onProgress(
            overall,
            `${index + 1}/${inputs.length} · ${Math.round(fraction * 100)}%${speed ? ` · ${speed}` : ""}`
          );
        },
      });

      const size = (await stat(target)).size;
      bytesIn += file.size;
      bytesOut += size;
      outputs.push({ path: target, name: `${stem}.${ext}` });
      log(`${stem}.${ext} hazir - ${formatBytes(size)}`);
    }

    return {
      outputs,
      summary:
        `${outputs.length} video donusturuldu ` +
        `(${formatBytes(bytesIn)} -> ${formatBytes(bytesOut)}, ${preset.label})`,
    };
  },
});

/**
 * Prefer the GPU, but only after confirming the encoder actually opens.
 *
 * Being listed in `-encoders` is not enough: a driver older than the build's
 * NVENC API fails at open time. Probing once up front means the batch silently
 * uses the CPU instead of dying on the first file, and `note` explains why.
 */
async function pickEncoder(
  format: string,
  wantsHardware: boolean
): Promise<{ encoder: string; hardware: boolean; note?: string }> {
  if (format === "webm") return { encoder: "libvpx-vp9", hardware: false };

  const hevc = format === "mp4_hevc";
  const cpu = hevc ? "libx265" : "libx264";
  if (!wantsHardware) return { encoder: cpu, hardware: false };

  const gpu = hevc ? "hevc_nvenc" : "h264_nvenc";
  const status = await encoderWorks(gpu);
  return status.ok
    ? { encoder: gpu, hardware: true }
    : { encoder: cpu, hardware: false, note: status.reason };
}
