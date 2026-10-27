import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { defineModule } from "@/core/types";

const FORMATS = ["jpeg", "png", "webp", "avif", "tiff"] as const;
type Format = (typeof FORMATS)[number];

/** Extensions sharp can read out of the box. HEIC is absent by design: the
 *  stock libvips build ships without libheif because of HEVC patent concerns. */
const READABLE = ["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff", "gif", "svg"];

export default defineModule({
  id: "image-convert",
  name: "Gorsel donustur",
  description:
    "PNG, JPEG, WEBP, AVIF ve TIFF arasinda toplu donusturme. Dosya sayisi sinirsiz.",
  category: "image",
  engine: "inproc",
  icon: "🖼️",

  inputMode: "files",
  accepts: { ext: READABLE, multiple: true },

  options: [
    {
      key: "format",
      type: "select",
      label: "Hedef format",
      default: "jpeg",
      choices: [
        { value: "jpeg", label: "JPEG (.jpg)" },
        { value: "png", label: "PNG (.png)" },
        { value: "webp", label: "WEBP (.webp)" },
        { value: "avif", label: "AVIF (.avif)" },
        { value: "tiff", label: "TIFF (.tiff)" },
      ],
    },
    {
      key: "quality",
      type: "number",
      label: "Kalite",
      default: 100,
      min: 1,
      max: 100,
      step: 1,
      help:
        "1-100. 100 = en yuksek kalite, en buyuk dosya. Dosya boyutu sorun olursa " +
        "85 gozle ayirt edilemeyecek kadar yakin, 60-70 mail/mesaj icin yeterli.",
      showWhen: { key: "format", equals: ["jpeg", "webp", "avif", "tiff"] },
    },
    {
      key: "background",
      type: "text",
      label: "Saydam alan rengi",
      default: "#ffffff",
      placeholder: "#ffffff",
      help: "JPEG saydamligi desteklemez, saydam pikseller bu renkle doldurulur.",
      showWhen: { key: "format", equals: ["jpeg"] },
      advanced: true,
    },
    {
      key: "stripMetadata",
      type: "boolean",
      label: "EXIF / metadata temizle",
      default: true,
      help: "Konum ve kamera bilgisini kaldirir.",
      advanced: true,
    },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    const format = options.format as Format;
    const quality = Number(options.quality) || 100;
    const background = String(options.background || "#ffffff");
    const strip = Boolean(options.stripMetadata);

    const outputs = [];
    let bytesIn = 0;
    let bytesOut = 0;

    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();

      const stem = basename(file.name, extname(file.name));
      const ext = format === "jpeg" ? "jpg" : format;
      const target = join(outDir, `${stem}.${ext}`);

      let pipeline = sharp(file.path, { animated: format === "webp" });
      // keepMetadata() is the opt-in; sharp drops metadata unless asked.
      if (!strip) pipeline = pipeline.keepMetadata();

      if (format === "jpeg") {
        pipeline = pipeline.flatten({ background }).jpeg({ quality, mozjpeg: true });
      } else if (format === "png") {
        pipeline = pipeline.png({ compressionLevel: 9 });
      } else if (format === "webp") {
        pipeline = pipeline.webp({ quality });
      } else if (format === "avif") {
        pipeline = pipeline.avif({ quality });
      } else {
        pipeline = pipeline.tiff({ quality });
      }

      const info = await pipeline.toFile(target);
      bytesIn += file.size;
      bytesOut += info.size;
      outputs.push({ path: target, name: `${stem}.${ext}` });

      log(`${file.name} -> ${stem}.${ext} (${fmt(file.size)} -> ${fmt(info.size)})`);
      onProgress(((index + 1) / inputs.length) * 100, `${index + 1}/${inputs.length}`);
    }

    return {
      outputs,
      summary: `${outputs.length} dosya donusturuldu (${fmt(bytesIn)} -> ${fmt(bytesOut)})`,
    };
  },
});

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
