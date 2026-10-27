import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import QRCode from "qrcode";
import { defineModule } from "@/core/types";

/**
 * Demonstrates inputMode "none": the module takes no files, so the UI renders
 * only the option form and no dropzone. One line per entry means a batch of
 * QR codes from a single paste.
 */
export default defineModule({
  id: "qr-generate",
  name: "QR kod uret",
  description:
    "Metin, URL veya wifi bilgisinden QR kod. Her satir icin ayri bir kod uretilir.",
  category: "utility",
  engine: "inproc",
  icon: "🔳",

  inputMode: "none",

  options: [
    {
      key: "content",
      type: "text",
      label: "Icerik",
      default: "",
      multiline: true,
      placeholder: "https://example.com\nhttps://baska-site.com",
      help: "Her satir ayri bir QR kod olur.",
    },
    {
      key: "format",
      type: "select",
      label: "Cikti formati",
      default: "png",
      choices: [
        { value: "png", label: "PNG" },
        { value: "svg", label: "SVG (vektor)" },
      ],
    },
    {
      key: "size",
      type: "number",
      label: "Boyut (px)",
      default: 512,
      min: 64,
      max: 4096,
      step: 64,
      showWhen: { key: "format", equals: ["png"] },
    },
    {
      key: "margin",
      type: "number",
      label: "Kenar boslugu",
      default: 2,
      min: 0,
      max: 16,
      step: 1,
      help: "Modul cinsinden. Tarayicilarin okuyabilmesi icin 1'in altina inme.",
      advanced: true,
    },
    {
      key: "ecl",
      type: "select",
      label: "Hata duzeltme",
      default: "M",
      choices: [
        { value: "L", label: "Dusuk (%7) - en kucuk kod" },
        { value: "M", label: "Orta (%15)" },
        { value: "Q", label: "Yuksek (%25)" },
        { value: "H", label: "En yuksek (%30) - logo koyacaksan" },
      ],
      advanced: true,
    },
    { key: "dark", type: "text", label: "On plan rengi", default: "#000000", advanced: true },
    { key: "light", type: "text", label: "Arka plan rengi", default: "#ffffff", advanced: true },
  ],

  async run({ outDir, options, onProgress, log, signal }) {
    const lines = String(options.content ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) throw new Error("Icerik bos. En az bir satir yaz.");

    const format = String(options.format);
    const width = Number(options.size) || 512;
    const opts = {
      margin: Number(options.margin) ?? 2,
      errorCorrectionLevel: String(options.ecl) as "L" | "M" | "Q" | "H",
      color: { dark: String(options.dark), light: String(options.light) },
    };

    const outputs = [];
    const pad = String(lines.length).length;

    for (const [index, line] of lines.entries()) {
      signal.throwIfAborted();

      const name = `${slug(line, index, pad)}.${format}`;
      const target = join(outDir, name);

      if (format === "svg") {
        await writeFile(target, await QRCode.toString(line, { ...opts, type: "svg" }), "utf8");
      } else {
        await QRCode.toFile(target, line, { ...opts, type: "png", width });
      }

      outputs.push({ path: target, name });
      log(`${name} <- ${line.slice(0, 60)}${line.length > 60 ? "..." : ""}`);
      onProgress(((index + 1) / lines.length) * 100, `${index + 1}/${lines.length}`);
    }

    return { outputs, summary: `${outputs.length} QR kod uretildi` };
  },
});

/** Readable filename from arbitrary content, with an index so nothing collides. */
function slug(text: string, index: number, pad: number): string {
  const base = text
    .replace(/^https?:\/\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${String(index + 1).padStart(pad, "0")}-${base || "qr"}`;
}
