import "server-only";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** All job data lives here. Gitignored; safe to delete wholesale. */
export const WORKSPACE = resolve(process.cwd(), "workspace");

export const inputDir = (jobId: string) => join(WORKSPACE, jobId, "in");
export const outputDir = (jobId: string) => join(WORKSPACE, jobId, "out");

export async function prepareJobDirs(jobId: string) {
  const input = inputDir(jobId);
  const output = outputDir(jobId);
  await mkdir(input, { recursive: true });
  await mkdir(output, { recursive: true });
  return { input, output };
}

export async function removeJobDir(jobId: string) {
  await rm(join(WORKSPACE, jobId), { recursive: true, force: true });
}

/**
 * Resolve a path that came from a request and refuse anything outside the
 * workspace. Without this, a crafted `../..` download path would read any file
 * on the machine.
 */
export function safeWorkspacePath(relative: string): string | null {
  const abs = resolve(WORKSPACE, relative);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + sep)) return null;
  return abs;
}

/** Delete job directories older than `maxAgeMs`. Called opportunistically. */
export async function pruneWorkspace(maxAgeMs = 24 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = await readdir(WORKSPACE, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = join(WORKSPACE, e.name);
        try {
          const s = await stat(dir);
          if (s.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
        } catch {
          /* raced with another prune; nothing to do */
        }
      })
  );
}
