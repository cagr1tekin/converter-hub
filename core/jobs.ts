import "server-only";
import { relative } from "node:path";
import { getModule } from "./registry";
import { prepareJobDirs, WORKSPACE } from "./workspace";
import type { InputFile, OptionValues, RunContext } from "./types";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobOutput {
  name: string;
  /** Path relative to the workspace root — what the download route expects. */
  href: string;
  size: number;
}

export interface Job {
  id: string;
  moduleId: string;
  moduleName: string;
  status: JobStatus;
  progress: number;
  message: string;
  log: string[];
  outputs: JobOutput[];
  summary?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

type Listener = (job: Job) => void;

interface JobRuntime {
  job: Job;
  controller: AbortController;
  listeners: Set<Listener>;
}

/**
 * Jobs live in memory. Next's dev server re-evaluates modules on edit, so the
 * store hangs off globalThis to survive hot reloads — otherwise a running job
 * would become unreachable the moment a file is saved.
 */
const store: Map<string, JobRuntime> = ((globalThis as Record<string, unknown>)
  .__converterHubJobs as Map<string, JobRuntime>) ?? new Map();
(globalThis as Record<string, unknown>).__converterHubJobs = store;

function emit(rt: JobRuntime) {
  for (const listener of rt.listeners) {
    try {
      listener(rt.job);
    } catch {
      /* a dead SSE connection must not kill the job */
    }
  }
}

export function getJob(id: string): Job | undefined {
  return store.get(id)?.job;
}

export function subscribe(id: string, listener: Listener): () => void {
  const rt = store.get(id);
  if (!rt) return () => {};
  rt.listeners.add(listener);
  return () => rt.listeners.delete(listener);
}

export function cancelJob(id: string): boolean {
  const rt = store.get(id);
  if (!rt || rt.job.status === "done" || rt.job.status === "error") return false;
  rt.controller.abort();
  return true;
}

export async function createJob(
  moduleId: string,
  options: OptionValues,
  saveInputs: (dir: string) => Promise<InputFile[]>
): Promise<Job> {
  const mod = getModule(moduleId);
  if (!mod) throw new Error(`Unknown module: ${moduleId}`);

  const id = crypto.randomUUID();
  const { input, output } = await prepareJobDirs(id);
  const inputs = await saveInputs(input);

  if (mod.inputMode === "files" && inputs.length === 0) {
    throw new Error("En az bir dosya secmelisin.");
  }

  const job: Job = {
    id,
    moduleId,
    moduleName: mod.name,
    status: "queued",
    progress: 0,
    message: "Sirada",
    log: [],
    outputs: [],
    createdAt: Date.now(),
  };
  const rt: JobRuntime = { job, controller: new AbortController(), listeners: new Set() };
  store.set(id, rt);

  // Deliberately not awaited: the POST returns the job id immediately and the
  // client follows progress over SSE.
  void execute(rt, mod.run, { inputs, outDir: output, options });

  return job;
}

async function execute(
  rt: JobRuntime,
  run: (ctx: RunContext) => Promise<import("./types").RunResult>,
  args: { inputs: InputFile[]; outDir: string; options: OptionValues }
) {
  const { job, controller } = rt;
  job.status = "running";
  job.message = "Calisiyor";
  emit(rt);

  const ctx: RunContext = {
    inputs: args.inputs,
    outDir: args.outDir,
    options: args.options,
    signal: controller.signal,
    onProgress: (pct, message) => {
      job.progress = Math.max(0, Math.min(100, Math.round(pct)));
      if (message) job.message = message;
      emit(rt);
    },
    log: (message) => {
      job.log.push(message);
      if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
      emit(rt);
    },
  };

  try {
    const result = await run(ctx);
    const { stat } = await import("node:fs/promises");
    job.outputs = await Promise.all(
      result.outputs.map(async (o) => ({
        name: o.name,
        href: relative(WORKSPACE, o.path).split("\\").join("/"),
        size: await stat(o.path).then((s) => s.size).catch(() => 0),
      }))
    );
    job.summary = result.summary;
    job.status = "done";
    job.progress = 100;
    job.message = result.summary ?? "Tamamlandi";
  } catch (err) {
    if (controller.signal.aborted) {
      job.status = "cancelled";
      job.message = "Iptal edildi";
    } else {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.message = "Hata";
    }
  } finally {
    job.finishedAt = Date.now();
    emit(rt);
  }
}

