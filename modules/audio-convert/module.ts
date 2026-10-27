import { basename, extname, join } from "node:path";
import { stat } from "node:fs/promises";
import {
  ffmpegHealth,
  formatBytes,
  formatDuration,
  parseTimecode,
  probe,
  runFFmpeg,
} from "@/core/ffmpeg";
import { defineModule } from "@/core/types";

/** Videos are accepted too — pulling the audio out of one is the common case. */
const INPUTS = [
  "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "aiff", "alac", "amr",
  "mp4", "mkv", "mov", "avi", "webm", "dat", "mpg", "mpeg", "ts", "flv", "m4v", "wmv",
];

interface Codec {
  ext: string;
  args: (bitrate: number) => string[];
  lossless: boolean;
}

const CODECS: Record<string, Codec> = {
  mp3: { ext: "mp3", lossless: false, args: (b) => ["-c:a", "libmp3lame", "-b:a", `${b}k`] },
  m4a: { ext: "m4a", lossless: false, args: (b) => ["-c:a", "aac", "-b:a", `${b}k`] },
  opus: { ext: "opus", lossless: false, args: (b) => ["-c:a", "libopus", "-b:a", `${b}k`] },
  // 16-bit PCM: the interchange format every editor opens without complaint.
  wav: { ext: "wav", lossless: true, args: () => ["-c:a", "pcm_s16le"] },
  flac: { ext: "flac", lossless: true, args: () => ["-c:a", "flac", "-compression_level", "8"] },
};

export default defineModule({
  id: "audio-convert",
  name: "Ses donustur / cikar",
  description:
    "Videodan sesi ayirir veya ses dosyalarini donusturur. MP3, M4A, WAV, FLAC, Opus.",
  category: "audio",
  engine: "binary",
  icon: "🎵",

  inputMode: "files",
  accepts: { ext: INPUTS, multiple: true },

  health: ffmpegHealth,

  options: [
    {
      key: "format",
      type: "select",
      label: "Hedef format",
      default: "mp3",
      choices: [
        { value: "mp3", label: "MP3 - her yerde calar" },
        { value: "m4a", label: "M4A (AAC) - ayni boyutta daha iyi" },
        { value: "opus", label: "Opus - en verimli" },
        { value: "wav", label: "WAV - kayipsiz, buyuk" },
        { value: "flac", label: "FLAC - kayipsiz, sikistirilmis" },
      ],
    },
    {
      key: "bitrate",
      type: "select",
      label: "Bit hizi",
      default: "320",
      choices: [
        { value: "320", label: "320 kbps - en yuksek" },
        { value: "256", label: "256 kbps" },
        { value: "192", label: "192 kbps" },
        { value: "128", label: "128 kbps - kucuk dosya" },
        { value: "96", label: "96 kbps - konusma" },
      ],
      help: "Kayipsiz formatlarda (WAV, FLAC) bu deger kullanilmaz.",
      showWhen: { key: "format", equals: ["mp3", "m4a", "opus"] },
    },
    {
      key: "channels",
      type: "select",
      label: "Kanal",
      default: "original",
      choices: [
        { value: "original", label: "Kaynakla ayni" },
        { value: "2", label: "Stereo" },
        { value: "1", label: "Mono - yariya yakin kucuk" },
      ],
      advanced: true,
    },
    {
      key: "sampleRate",
      type: "select",
      label: "Ornekleme hizi",
      default: "original",
      choices: [
        { value: "original", label: "Kaynakla ayni" },
        { value: "48000", label: "48 kHz - video standardi" },
        { value: "44100", label: "44.1 kHz - CD" },
        { value: "22050", label: "22 kHz - konusma" },
      ],
      advanced: true,
    },
    {
      key: "normalize",
      type: "boolean",
      label: "Ses seviyesini esitle",
      default: false,
      help: "EBU R128 ile -16 LUFS'a getirir. Farkli kaynaklardan gelen dosyalar icin.",
      advanced: true,
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
      placeholder: "00:03:20",
      help: "Bos birak = sonuna kadar.",
      advanced: true,
    },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    const codec = CODECS[String(options.format)] ?? CODECS.mp3;
    const bitrate = Number(options.bitrate) || 320;

    const start = parseTimecode(String(options.trimStart ?? ""));
    const end = parseTimecode(String(options.trimEnd ?? ""));
    if (String(options.trimStart ?? "").trim() && start === null) {
      throw new Error("Baslangic zamani anlasilmadi. Ornek: 00:00:10");
    }
    if (String(options.trimEnd ?? "").trim() && end === null) {
      throw new Error("Bitis zamani anlasilmadi. Ornek: 00:03:20");
    }
    if (start !== null && end !== null && end <= start) {
      throw new Error("Bitis zamani baslangictan sonra olmali.");
    }

    const outputs = [];
    let bytesOut = 0;

    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();

      const info = await probe(file.path);
      if (!info.hasAudio) throw new Error(`${file.name}: ses akisi yok.`);

      const from = start ?? 0;
      const to = end ?? info.durationSec;
      const span = Math.max(0.001, Math.min(to, info.durationSec || to) - from);

      const stem = basename(file.name, extname(file.name));
      const target = join(outDir, `${stem}.${codec.ext}`);

      const args: string[] = [];
      if (start !== null) args.push("-ss", String(start));
      args.push("-i", file.path);
      if (end !== null) args.push("-t", String(span));

      // Drop video and cover-art streams; an attached picture would otherwise
      // make some encoders fail outright.
      args.push("-vn", ...codec.args(bitrate));

      if (options.channels !== "original") args.push("-ac", String(Number(options.channels)));
      if (options.sampleRate !== "original") args.push("-ar", String(Number(options.sampleRate)));
      if (options.normalize) args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");

      args.push("-y", target);

      log(
        `${file.name}: ${info.audioCodec ?? "?"} ${formatDuration(span)} -> ` +
          `${codec.ext}${codec.lossless ? " (kayipsiz)" : ` ${bitrate}k`}`
      );

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
      bytesOut += size;
      outputs.push({ path: target, name: `${stem}.${codec.ext}` });
    }

    return {
      outputs,
      summary: `${outputs.length} ses dosyasi hazir (${formatBytes(bytesOut)})`,
    };
  },
});
