/**
 * Downloads a Windows ffmpeg/ffprobe build into bin/.
 *
 * bin/ is gitignored — binaries do not belong in the repo — so this script is
 * how a fresh clone becomes able to run the video and audio modules. Modules
 * report the missing binary through health() until it has run.
 *
 *   pnpm ffmpeg
 *
 * Build choice: gyan.dev "release-essentials" is a tagged stable release (not a
 * master snapshot) and ships the encoders this project needs — x264, x265,
 * libvpx, AAC, mp3, opus — plus NVENC/QSV/AMF hardware encoding.
 *
 * Licensing: this is a GPL build (x264/x265 are GPL). Invoking it as a separate
 * process is the standard pattern — HandBrake, Jellyfin and Plex all do it — and
 * carries no obligation for this project's own MIT-style code. It would matter
 * only if you redistributed a bundle containing the binary.
 */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "bin");
const tmpDir = join(root, "bin", ".tmp");

const SOURCES = [
  {
    name: "gyan.dev release-essentials",
    url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  },
  {
    name: "BtbN master gpl",
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
  },
];

if (process.platform !== "win32") {
  console.error("[ffmpeg] Bu script Windows icin. Diger platformlarda ffmpeg'i paket yoneticinle kur.");
  process.exit(1);
}

const wanted = ["ffmpeg.exe", "ffprobe.exe"];

if (!process.argv.includes("--force") && wanted.every((f) => existsSync(join(binDir, f)))) {
  console.log("[ffmpeg] bin/ zaten dolu. Yeniden indirmek icin: pnpm ffmpeg --force");
  process.exit(0);
}

await mkdir(tmpDir, { recursive: true });
const archive = join(tmpDir, "ffmpeg.zip");

let downloaded = false;
for (const source of SOURCES) {
  try {
    console.log(`[ffmpeg] Indiriliyor: ${source.name}`);
    await download(source.url, archive);
    downloaded = true;
    break;
  } catch (err) {
    console.warn(`[ffmpeg] ${source.name} basarisiz: ${err.message}`);
  }
}
if (!downloaded) {
  console.error("[ffmpeg] Hicbir kaynaktan indirilemedi. Aga erisimi kontrol et.");
  process.exit(1);
}

console.log("[ffmpeg] Aciliyor...");
await unzip(archive, tmpDir);

// Every build nests the executables in a versioned folder; find them wherever
// they landed rather than hard-coding a path that changes each release.
const found = new Map();
for await (const file of walk(tmpDir)) {
  const base = file.split(/[\\/]/).pop().toLowerCase();
  if (wanted.includes(base) && !found.has(base)) found.set(base, file);
}

for (const name of wanted) {
  const src = found.get(name);
  if (!src) {
    console.error(`[ffmpeg] Arsivde ${name} bulunamadi.`);
    process.exit(1);
  }
  await rename(src, join(binDir, name));
  const { size } = await stat(join(binDir, name));
  console.log(`[ffmpeg] bin/${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

await rm(tmpDir, { recursive: true, force: true });

const version = await run(join(binDir, "ffmpeg.exe"), ["-version"]);
console.log(`[ffmpeg] ${version.split("\n")[0]}`);

const encoders = await run(join(binDir, "ffmpeg.exe"), ["-hide_banner", "-encoders"]);
const hw = ["h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_amf"].filter((e) => encoders.includes(e));
console.log(hw.length ? `[ffmpeg] Donanim kodlayicilari: ${hw.join(", ")}` : "[ffmpeg] Donanim kodlayicisi yok (CPU kullanilacak)");

/* ------------------------------------------------------------------ utils */

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;
  let seen = 0;
  let lastPrint = 0;

  const reporter = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastPrint > 400) {
        lastPrint = now;
        const mb = (seen / 1024 / 1024).toFixed(1);
        process.stdout.write(
          total ? `\r[ffmpeg]   ${mb} MB / ${(total / 1024 / 1024).toFixed(1)} MB` : `\r[ffmpeg]   ${mb} MB`
        );
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(res.body.pipeThrough(reporter), createWriteStream(dest));
  process.stdout.write("\n");
}

function unzip(archive, dest) {
  // Expand-Archive ships with Windows; no extra dependency needed.
  return run("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`,
  ]);
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
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
