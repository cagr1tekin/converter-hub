import { NextResponse } from "next/server";
import { cancelJob, getJob } from "@/core/jobs";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const job = getJob((await params).id);
  if (!job) return NextResponse.json({ error: "Is bulunamadi." }, { status: 404 });
  return NextResponse.json({ job });
}

export async function DELETE(_request: Request, { params }: Params) {
  const ok = cancelJob((await params).id);
  return NextResponse.json({ cancelled: ok }, { status: ok ? 200 : 409 });
}
