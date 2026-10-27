import "server-only";
import { spawn } from "node:child_process";
import type { HealthStatus } from "./types";

/**
 * Sidecar containers.
 *
 * The heavy modules (AI segmentation, document parsing) carry Python and
 * multi-gigabyte model stacks that would be painful to install on the host —
 * rembg alone pins `python >=3.11,<3.14`, which this machine's 3.14 fails. Each
 * one therefore runs as its own container and is reached over HTTP, so a module
 * stays a single folder with no host-level install step.
 *
 * A module declares its own spec; nothing here is global.
 */

export interface SidecarSpec {
  /** Container name. Prefix with `converter-hub-` so ours are recognisable. */
  name: string;
  image: string;
  hostPort: number;
  containerPort: number;
  /** Command arguments appended after the image. */
  args?: string[];
  env?: Record<string, string>;
  /** Named volumes, used to keep downloaded models across restarts. */
  volumes?: { name: string; mountPath: string }[];
  /** Hard memory cap, e.g. "6g". Without one a big model can take down Docker. */
  memory?: string;
  /** Request GPU access. Silently ignored when no GPU runtime is present. */
  gpu?: boolean;
  /** Path that returns 200 once the service is actually serving. */
  readyPath: string;
  /** How long to wait for readiness. Cold starts load large models. */
  readyTimeoutMs?: number;
  /** Human name used in messages. */
  label: string;
}

export const baseUrl = (spec: SidecarSpec) => `http://127.0.0.1:${spec.hostPort}`;

/* ------------------------------------------------------------------ docker */

let dockerCheck: { at: number; value: HealthStatus } | null = null;

export async function dockerStatus(): Promise<HealthStatus> {
  if (dockerCheck && Date.now() - dockerCheck.at < 15_000) return dockerCheck.value;

  let value: HealthStatus;
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    value = { ok: true };
  } catch {
    value = { ok: false, reason: "Docker calismiyor. Docker Desktop'i baslat." };
  }
  dockerCheck = { at: Date.now(), value };
  return value;
}

type ContainerState = { status: "missing" } | { status: string; exitCode: number; oom: boolean };

async function containerState(name: string): Promise<ContainerState> {
  try {
    const out = await run("docker", [
      "inspect", name,
      "--format", "{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}",
    ]);
    const [status, exitCode, oom] = out.trim().split("|");
    return { status, exitCode: Number(exitCode), oom: oom === "true" };
  } catch {
    return { status: "missing" };
  }
}

async function imagePresent(image: string): Promise<boolean> {
  return run("docker", ["image", "inspect", image]).then(
    () => true,
    () => false
  );
}

/* ------------------------------------------------------------------ status */

/** Non-mutating check for `health()` — never starts anything. */
export async function sidecarStatus(spec: SidecarSpec): Promise<HealthStatus> {
  const docker = await dockerStatus();
  if (!docker.ok) return docker;

  if (await isServing(spec)) return { ok: true };

  const state = await containerState(spec.name);
  if (state.status === "missing") {
    return (await imagePresent(spec.image))
      ? { ok: true, reason: undefined }
      : {
          ok: true,
          reason: `${spec.label} imaji henuz indirilmedi; ilk calistirma uzun surecek.`,
        };
  }
  if (state.status === "running") {
    return { ok: true, reason: `${spec.label} baslatiliyor.` };
  }
  if ("oom" in state && state.oom) {
    return {
      ok: false,
      reason: `${spec.label} bellek yetersizliginden durdu. Docker Desktop'a ayrilan RAM'i artir veya daha hafif bir model sec.`,
    };
  }
  return { ok: true, reason: `${spec.label} durdurulmus; calistirinca baslatilacak.` };
}

async function isServing(spec: SidecarSpec, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(baseUrl(spec) + spec.readyPath, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ ensure */

// One start attempt at a time per container, so a batch of parallel jobs does
// not race to create the same container.
const starting = new Map<string, Promise<void>>();

export function ensureSidecar(
  spec: SidecarSpec,
  log: (message: string) => void = () => {}
): Promise<void> {
  const inFlight = starting.get(spec.name);
  if (inFlight) return inFlight;

  const task = start(spec, log).finally(() => starting.delete(spec.name));
  starting.set(spec.name, task);
  return task;
}

async function start(spec: SidecarSpec, log: (message: string) => void): Promise<void> {
  const docker = await dockerStatus();
  if (!docker.ok) throw new Error(docker.reason);

  if (await isServing(spec)) return;

  if (!(await imagePresent(spec.image))) {
    log(`${spec.label} imaji indiriliyor (${spec.image}) - ilk seferde birkac dakika surebilir.`);
    await run("docker", ["pull", spec.image], 45 * 60_000);
  }

  const state = await containerState(spec.name);
  if (state.status === "missing") {
    log(`${spec.label} baslatiliyor.`);
    await run("docker", ["run", "-d", ...runFlags(spec), spec.image, ...(spec.args ?? [])]);
  } else if (state.status !== "running") {
    log(`${spec.label} yeniden baslatiliyor.`);
    await run("docker", ["start", spec.name]);
  }

  await waitUntilServing(spec, log);
}

function runFlags(spec: SidecarSpec): string[] {
  const flags = [
    "--name", spec.name,
    "-p", `${spec.hostPort}:${spec.containerPort}`,
    "--restart", "unless-stopped",
  ];

  for (const [key, value] of Object.entries(spec.env ?? {})) {
    flags.push("-e", `${key}=${value}`);
  }
  for (const volume of spec.volumes ?? []) {
    flags.push("-v", `${volume.name}:${volume.mountPath}`);
  }
  if (spec.memory) flags.push("--memory", spec.memory);
  if (spec.gpu) flags.push("--gpus", "all");

  return flags;
}

async function waitUntilServing(spec: SidecarSpec, log: (message: string) => void) {
  const deadline = Date.now() + (spec.readyTimeoutMs ?? 180_000);
  let announced = false;

  while (Date.now() < deadline) {
    if (await isServing(spec)) {
      if (announced) log(`${spec.label} hazir.`);
      return;
    }

    const state = await containerState(spec.name);
    if (state.status !== "running" && state.status !== "missing") {
      if ("oom" in state && state.oom) {
        throw new Error(
          `${spec.label} bellek yetersizliginden durdu (OOM). Docker Desktop'a ayrilan RAM'i artir ` +
            `veya daha hafif bir model sec.`
        );
      }
      throw new Error(
        `${spec.label} beklenmedik sekilde durdu (cikis kodu ${"exitCode" in state ? state.exitCode : "?"}). ` +
          `Ayrinti: docker logs ${spec.name}`
      );
    }

    if (!announced) {
      log(`${spec.label} hazirlaniyor, model yukleniyor...`);
      announced = true;
    }
    await delay(1500);
  }

  throw new Error(
    `${spec.label} zamaninda hazir olmadi. Kontrol et: docker logs ${spec.name}`
  );
}

/* -------------------------------------------------------------------- call */

/** POST multipart/form-data to a sidecar and return the raw response body. */
export async function postForm(
  spec: SidecarSpec,
  path: string,
  form: FormData,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Buffer> {
  const { signal, timeoutMs = 15 * 60_000 } = options;

  // Combine the caller's cancellation with a hard ceiling, so a wedged
  // container cannot hang a job forever.
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  const res = await fetch(baseUrl(spec) + path, {
    method: "POST",
    body: form,
    signal: combined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${spec.label} hata dondurdu (HTTP ${res.status}). ${detail.slice(0, 300)}`.trim()
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------- utils */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exit ${code}`));
    });
  });
}
