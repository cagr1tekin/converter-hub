import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { defineModule } from "@/core/types";

export default defineModule({
  id: "image-resize",
  name: "Gorsel boyutlandir / sikistir",
  description:
    "Toplu yeniden boyutlandirma ve sikistirma. Formati korur, sadece boyutu dusurur.",
  category: "image",
  engine: "inproc",
  icon: "📐",

  inputMode: "files",
  accepts: { ext: ["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff"], multiple: true },

  options: [
    {
      key: "mode",
      type: "select",
      label: "Boyutlandirma",
      default: "longest",
      choices: [
        { value: "longest", label: "Uzun kenari sabitle" },
        { value: "width", label: "Genisligi sabitle" },
        { value: "height", label: "Yuksekligi sabitle" },
        { value: "percent", label: "Yuzde olarak kucult" },
        { value: "none", label: "Boyutlandirma, sadece sikistir" },
      ],
    },
    {
      key: "size",
      type: "number",
      label: "Piksel",
      default: 1920,
      min: 16,
      max: 20000,
      step: 1,
      showWhen: { key: "mode", equals: ["longest", "width", "height"] },
    },
    {
      key: "percent",
      type: "number",
      label: "Yuzde (%)",
      default: 50,
      min: 1,
      max: 100,
      step: 1,
      showWhen: { key: "mode", equals: ["percent"] },
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
        "1-100. 100 = en yuksek kalite. Kaynak format korunur, sadece sikistirma " +
        "degisir. PNG kaynaklarda bu deger yok sayilir cunku PNG kayipsizdir.",
    },
    {
      key: "noEnlarge",
      type: "boolean",
      label: "Kucuk gorselleri buyutme",
      default: true,
      help: "Hedeften zaten kucuk olan gorseller oldugu gibi birakilir.",
      advanced: true,
    },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    const mode = String(options.mode);
    const size = Number(options.size) || 1920;
    const percent = Number(options.percent) || 50;
    const quality = Number(options.quality) || 100;
    const noEnlarge = Boolean(options.noEnlarge);

    const outputs = [];
    let bytesIn = 0;
    let bytesOut = 0;

    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();

      const stem = basename(file.name, extname(file.name));
      const ext = extname(file.name).slice(1).toLowerCase() || "jpg";
      const target = join(outDir, `${stem}.${ext}`);

      const image = sharp(file.path);
      const meta = await image.metadata();

      let pipeline = image;
      if (mode !== "none") {
        // `fit: inside` preserves aspect ratio; only the constrained side is exact.
        const resize: sharp.ResizeOptions = { fit: "inside", withoutEnlargement: noEnlarge };
        if (mode === "longest") {
          const landscape = (meta.width ?? 0) >= (meta.height ?? 0);
          pipeline = pipeline.resize({
            ...resize,
            width: landscape ? size : undefined,
            height: landscape ? undefined : size,
          });
        } else if (mode === "width") {
          pipeline = pipeline.resize({ ...resize, width: size });
        } else if (mode === "height") {
          pipeline = pipeline.resize({ ...resize, height: size });
        } else {
          pipeline = pipeline.resize({
            ...resize,
            width: Math.max(1, Math.round((meta.width ?? 1) * (percent / 100))),
          });
        }
      }

      if (ext === "png") pipeline = pipeline.png({ compressionLevel: 9 });
      else if (ext === "webp") pipeline = pipeline.webp({ quality });
      else if (ext === "avif") pipeline = pipeline.avif({ quality });
      else if (ext === "tif" || ext === "tiff") pipeline = pipeline.tiff({ quality });
      else pipeline = pipeline.jpeg({ quality, mozjpeg: true });

      const info = await pipeline.toFile(target);
      bytesIn += file.size;
      bytesOut += info.size;
      outputs.push({ path: target, name: `${stem}.${ext}` });

      log(
        `${file.name}: ${meta.width}x${meta.height} -> ${info.width}x${info.height} ` +
          `(${fmt(file.size)} -> ${fmt(info.size)})`
      );
      onProgress(((index + 1) / inputs.length) * 100, `${index + 1}/${inputs.length}`);
    }

    const saved = bytesIn > 0 ? Math.round((1 - bytesOut / bytesIn) * 100) : 0;
    return {
      outputs,
      summary: `${outputs.length} dosya islendi, %${saved} kucuduler (${fmt(bytesIn)} -> ${fmt(bytesOut)})`,
    };
  },
});

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
