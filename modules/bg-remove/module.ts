import { basename, extname, join } from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { defineModule } from "@/core/types";
import { ensureSidecar, postForm, sidecarStatus, type SidecarSpec } from "@/core/docker";

/**
 * rembg runs as a sidecar rather than on the host: the package pins
 * `python >=3.11,<3.14` and this machine runs 3.14, so a host install is not
 * merely inconvenient, it is refused. The container also brings its own
 * onnxruntime, keeping a ~4GB dependency tree out of the project.
 */
const REMBG: SidecarSpec = {
  name: "converter-hub-rembg",
  label: "rembg",
  image: "danielgatis/rembg:latest",
  hostPort: 7333,
  containerPort: 7000,
  // --no-ui drops the Gradio interface, which otherwise burns CPU while idle.
  args: ["s", "--host", "0.0.0.0", "--port", "7000", "--no-ui"],
  env: { PYTHONUNBUFFERED: "1" },
  // Models land in /root/.rembg/models; without this volume every restart
  // re-downloads hundreds of megabytes.
  volumes: [{ name: "converter-hub-rembg-models", mountPath: "/root/.rembg" }],
  // Sized for the models offered below — the largest, isnet, peaks around 1.5GB.
  // Keeping the cap tight matters more than it looks: Docker Desktop's WSL2 VM
  // gets half the host RAM by default, and on a 16GB machine that is not enough
  // headroom for a container that grows unchecked. Exceeding this kills only
  // this container, which surfaces as a clear OOM message.
  memory: "3g",
  readyPath: "/api",
  readyTimeoutMs: 300_000,
};

export default defineModule({
  id: "bg-remove",
  name: "Arka plan sil",
  description:
    "Yapay zeka ile arka plani ayirir. Saydam PNG veya duz renk zemin uretir, toplu calisir.",
  category: "image",
  engine: "docker",
  icon: "✂️",

  inputMode: "files",
  accepts: { ext: ["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff", "bmp"], multiple: true },

  health: () => sidecarStatus(REMBG),

  options: [
    {
      key: "model",
      type: "select",
      label: "Model",
      default: "u2net",
      choices: [
        { value: "u2net", label: "u2net - genel amacli, dengeli" },
        { value: "u2net_human_seg", label: "u2net_human_seg - insan fotograflari" },
        { value: "isnet-general-use", label: "isnet - daha keskin kenar, yavas" },
        { value: "silueta", label: "silueta - hafif" },
        { value: "u2netp", label: "u2netp - en hizli, kaba" },
      ],
      help: "Ilk kullanimda model indirilir (40-200 MB), sonrasinda onbellekten gelir.",
    },
    {
      key: "output",
      type: "select",
      label: "Cikti",
      default: "transparent",
      choices: [
        { value: "transparent", label: "Saydam PNG" },
        { value: "color-png", label: "Duz renk zemin (PNG)" },
        { value: "color-jpg", label: "Duz renk zemin (JPEG)" },
      ],
    },
    {
      key: "background",
      type: "text",
      label: "Zemin rengi",
      default: "#ffffff",
      showWhen: { key: "output", equals: ["color-png", "color-jpg"] },
    },
    {
      key: "postProcess",
      type: "boolean",
      label: "Maskeyi temizle",
      default: true,
      help: "Kenardaki tek tuk lekeleri ve delikleri kapatir.",
    },
    {
      key: "onlyMask",
      type: "boolean",
      label: "Sadece maske uret",
      default: false,
      help: "Goruntu yerine siyah-beyaz maskeyi verir.",
      advanced: true,
    },
    {
      key: "alphaMatting",
      type: "boolean",
      label: "Alpha matting",
      default: false,
      help: "Sac ve tuy gibi ince detaylarda kenari yumusatir. Belirgin sekilde yavaslatir.",
      advanced: true,
    },
    {
      key: "foregroundThreshold",
      type: "number",
      label: "On plan esigi",
      default: 240,
      min: 0,
      max: 255,
      step: 1,
      advanced: true,
      showWhen: { key: "alphaMatting", equals: [true] },
    },
    {
      key: "backgroundThreshold",
      type: "number",
      label: "Arka plan esigi",
      default: 10,
      min: 0,
      max: 255,
      step: 1,
      advanced: true,
      showWhen: { key: "alphaMatting", equals: [true] },
    },
    {
      key: "erodeSize",
      type: "number",
      label: "Asindirma boyutu",
      default: 10,
      min: 0,
      max: 60,
      step: 1,
      advanced: true,
      showWhen: { key: "alphaMatting", equals: [true] },
    },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    await ensureSidecar(REMBG, log);

    const model = String(options.model);
    const output = String(options.output);
    const background = String(options.background || "#ffffff");
    const matting = Boolean(options.alphaMatting);

    const outputs = [];
    let bytesOut = 0;

    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();

      const form = new FormData();
      form.set("file", new Blob([await readFile(file.path)]), file.name);
      form.set("model", model);
      form.set("ppm", String(Boolean(options.postProcess)));
      form.set("om", String(Boolean(options.onlyMask)));
      form.set("a", String(matting));
      if (matting) {
        form.set("af", String(Number(options.foregroundThreshold)));
        form.set("ab", String(Number(options.backgroundThreshold)));
        form.set("ae", String(Number(options.erodeSize)));
      }

      // rembg always returns RGBA PNG. Compositing onto a solid colour is done
      // here with sharp rather than through the API's background parameter —
      // one less undocumented format to get right, and it keeps the colour
      // handling identical to the other image modules.
      const cutout = await postForm(REMBG, "/api/remove", form, { signal });

      const stem = basename(file.name, extname(file.name));
      const ext = output === "color-jpg" ? "jpg" : "png";
      const target = join(outDir, `${stem}.${ext}`);

      let pipeline = sharp(cutout);
      if (output === "color-jpg") {
        pipeline = pipeline.flatten({ background }).jpeg({ quality: 100, mozjpeg: true });
      } else if (output === "color-png") {
        pipeline = pipeline.flatten({ background }).png({ compressionLevel: 9 });
      } else {
        pipeline = pipeline.png({ compressionLevel: 9 });
      }

      const info = await pipeline.toFile(target);
      bytesOut += info.size;
      outputs.push({ path: target, name: `${stem}.${ext}` });

      log(`${file.name} -> ${stem}.${ext}`);
      onProgress(((index + 1) / inputs.length) * 100, `${index + 1}/${inputs.length}`);
    }

    return {
      outputs,
      summary: `${outputs.length} gorselin arka plani silindi (${formatBytes(bytesOut)})`,
    };
  },
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
