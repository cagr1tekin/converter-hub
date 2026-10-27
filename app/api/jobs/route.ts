import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createJob } from "@/core/jobs";
import { pruneWorkspace } from "@/core/workspace";
import type { InputFile, OptionValues } from "@/core/types";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
  // Opportunistic cleanup of yesterday's jobs; failure here must not block work.
  void pruneWorkspace().catch(() => {});

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Gecersiz istek govdesi." }, { status: 400 });
  }

  const moduleId = String(form.get("moduleId") ?? "");
  if (!moduleId) return NextResponse.json({ error: "moduleId gerekli." }, { status: 400 });

  let options: OptionValues = {};
  const raw = form.get("options");
  if (typeof raw === "string" && raw) {
    try {
      options = JSON.parse(raw) as OptionValues;
    } catch {
      return NextResponse.json({ error: "options gecerli JSON degil." }, { status: 400 });
    }
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  try {
    const job = await createJob(moduleId, options, async (dir) => {
      const saved: InputFile[] = [];
      for (const [index, file] of files.entries()) {
        // Index-prefix the stored name so two uploads called "IMG_1.jpg" from
        // different folders cannot overwrite each other.
        const safe = sanitize(file.name) || `input-${index}`;
        const stored = join(dir, `${String(index).padStart(4, "0")}-${safe}`);
        await writeFile(stored, Buffer.from(await file.arrayBuffer()));
        saved.push({
          path: stored,
          name: safe,
          ext: extname(safe).slice(1).toLowerCase(),
          size: file.size,
        });
      }
      return saved;
    });
    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

/** Strip directory separators and anything the filesystem would reject. */
function sanitize(name: string): string {
  return name.replace(/[\/]/g, "_").replace(/[<>:"|?*\x00-\x1f]/g, "").trim();
}
