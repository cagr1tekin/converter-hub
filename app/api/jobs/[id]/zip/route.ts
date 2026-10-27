import { getJob } from "@/core/jobs";
import { createZipStream } from "@/core/zip";
import { safeWorkspacePath } from "@/core/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return new Response("Is bulunamadi.", { status: 404 });
  if (job.outputs.length === 0) return new Response("Cikti yok.", { status: 409 });

  const files = job.outputs
    .map((o) => ({ path: safeWorkspacePath(o.href), name: o.name }))
    .filter((f): f is { path: string; name: string } => f.path !== null);

  const filename = `${job.moduleId}-${id.slice(0, 8)}.zip`;
  return new Response(createZipStream(files), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
