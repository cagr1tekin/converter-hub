import "server-only";
import { modules } from "./generated-registry";
import type { ConverterModule, HealthStatus, ModuleManifest } from "./types";

const byId = new Map<string, ConverterModule>(modules.map((m) => [m.id, m]));

/** Fail fast on a duplicated id rather than silently shadowing a module. */
if (byId.size !== modules.length) {
  const seen = new Set<string>();
  const dupes = modules.map((m) => m.id).filter((id) => !seen.add(id));
  throw new Error(`Duplicate module id(s): ${dupes.join(", ")}`);
}

export function getModule(id: string): ConverterModule | undefined {
  return byId.get(id);
}

export function listModules(): ConverterModule[] {
  return modules;
}

const HEALTH_TTL_MS = 30_000;
const healthCache = new Map<string, { at: number; value: HealthStatus }>();

/**
 * Health checks can shell out or hit a container, so they are cached briefly —
 * the module list is requested on every page load.
 */
async function checkHealth(m: ConverterModule): Promise<HealthStatus> {
  if (!m.health) return { ok: true };

  const hit = healthCache.get(m.id);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.value;

  let value: HealthStatus;
  try {
    value = await m.health();
  } catch (err) {
    value = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  healthCache.set(m.id, { at: Date.now(), value });
  return value;
}

/** Serialisable view of every module, for the client. */
export async function getManifests(): Promise<ModuleManifest[]> {
  return Promise.all(
    modules.map(async (m) => {
      const { run: _run, health: _health, ...rest } = m;
      return { ...rest, health: await checkHealth(m) };
    })
  );
}
