/**
 * One command to run everything: `pnpm go`.
 *
 * Checks and repairs its own prerequisites instead of asking the user to.
 * Dependencies, the ffmpeg binary, the module registry and the production build
 * are each brought up to date only when they are actually stale, so a warm
 * start is a couple of seconds. Docker is optional — if it is down, the app
 * still starts and the modules that need it report why in the UI.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

/**
 * Next's own entry point, run through node directly.
 *
 * Node 20+ refuses to spawn .cmd/.bat shims without a shell (the fix for
 * CVE-2024-27980), so calling `pnpm.cmd` throws EINVAL on Windows. Going
 * straight to the JS entry point sidesteps shell quoting entirely.
 */
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");

const BASE_PORT = Number(process.env.PORT) || 4747;
const DEV = process.argv.includes("--dev");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const steps = [];
const note = (label, status, detail = "") => {
  steps.push({ label, status, detail });
  const mark = status === "ok" ? c.green("✓") : status === "warn" ? c.yellow("!") : c.red("✗");
  process.stdout.write(`  ${mark} ${label}${detail ? c.dim(` — ${detail}`) : ""}\n`);
};

console.log(`\n${c.bold("Converter Hub")} ${c.dim("hazirlaniyor...")}\n`);

/* ------------------------------------------------------- 1. dependencies */

if (!existsSync(join(root, "node_modules"))) {
  note("Bagimliliklar", "warn", "kuruluyor, bir kaç dakika sürebilir");
  // pnpm has no JS entry point to target, so this one needs a shell.
  const install = spawnSync("pnpm install", {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (install.status !== 0) {
    note("Bagimliliklar", "fail", "pnpm install basarisiz");
    process.exit(1);
  }
  note("Bagimliliklar", "ok", "kuruldu");
} else {
  note("Bagimliliklar", "ok");
}

/* ------------------------------------------------------------ 2. ffmpeg */

if (existsSync(join(root, "bin", "ffmpeg.exe")) || !isWindows) {
  note("ffmpeg", existsSync(join(root, "bin", "ffmpeg.exe")) ? "ok" : "warn",
    existsSync(join(root, "bin", "ffmpeg.exe")) ? "" : "bulunamadi, video/ses moduleri kapali");
} else {
  note("ffmpeg", "warn", "indiriliyor (~100 MB, tek seferlik)");
  const got = spawnSync(process.execPath, [join(root, "scripts", "get-ffmpeg.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  note("ffmpeg", got.status === 0 ? "ok" : "warn",
    got.status === 0 ? "hazir" : "indirilemedi, video/ses moduleri kapali");
}

/* ---------------------------------------------------------- 3. registry */

const gen = spawnSync(process.execPath, [join(root, "scripts", "gen-registry.mjs")], {
  cwd: root,
  encoding: "utf8",
});
const moduleLine = (gen.stdout || "").trim().replace("[registry] ", "");
note("Moduller", gen.status === 0 ? "ok" : "fail", moduleLine);

/* ------------------------------------------------------------ 4. docker */

const dockerUp =
  spawnSync(isWindows ? "docker.exe" : "docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    windowsHide: true,
  }).status === 0;

note(
  "Docker",
  dockerUp ? "ok" : "warn",
  dockerUp
    ? "sidecar moduller kullanilabilir"
    : "kapali — arka plan silme beklemede, digerleri calisir"
);

/* ------------------------------------------------------------- 5. build */

if (!DEV) {
  if (needsBuild()) {
    note("Derleme", "warn", "kaynak degismis, yeniden derleniyor");
    const build = spawnSync(process.execPath, [nextBin, "build"], {
      cwd: root,
      stdio: "inherit",
    });
    if (build.status !== 0) {
      note("Derleme", "fail", "basarisiz");
      process.exit(1);
    }
    note("Derleme", "ok", "guncel");
  } else {
    note("Derleme", "ok", "guncel");
  }
}

/* -------------------------------------------------------------- 6. serve */

const port = await findFreePort(BASE_PORT);
const url = `http://localhost:${port}`;

console.log(`\n  ${c.bold("Adres:")} ${c.cyan(url)}   ${c.dim("(durdurmak icin Ctrl+C)")}\n`);

const server = spawn(
  process.execPath,
  [nextBin, DEV ? "dev" : "start", "-p", String(port)],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
);

let opened = false;
const watchOutput = (chunk) => {
  const text = chunk.toString();
  // Next prints its own banner; only surface real problems and the ready line.
  for (const line of text.split("\n")) {
    if (/error|warn|⨯/i.test(line) && line.trim()) console.log(`  ${line.trim()}`);
  }
  if (!opened && /Ready in|started server|Local:/i.test(text)) {
    opened = true;
    openBrowser(url);
  }
};
server.stdout.on("data", watchOutput);
server.stderr.on("data", watchOutput);

// Fallback: some Next versions are quiet, so open once the port answers.
if (!DEV) {
  waitForServer(url).then(() => {
    if (!opened) {
      opened = true;
      openBrowser(url);
    }
  });
}

const shutdown = () => {
  server.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("close", (code) => process.exit(code ?? 0));

/* -------------------------------------------------------------- helpers */

/** Rebuild only when a source file is newer than the last build. */
function needsBuild() {
  const buildId = join(root, ".next", "BUILD_ID");
  if (!existsSync(buildId)) return true;
  const builtAt = statSync(buildId).mtimeMs;

  const watched = ["app", "core", "modules", "package.json", "next.config.ts", "postcss.config.mjs"];
  for (const entry of watched) {
    if (newestMtime(join(root, entry)) > builtAt) return true;
  }
  return false;
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (info.isFile()) return info.mtimeMs;

  let newest = info.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

/** Walk upward from the preferred port so a busy port never blocks startup. */
async function findFreePort(start) {
  for (let port = start; port < start + 40; port++) {
    if (await isFree(port)) return port;
  }
  return start;
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function waitForServer(target) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(target, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function openBrowser(target) {
  if (process.env.NO_OPEN) return;
  if (isWindows) spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
}
