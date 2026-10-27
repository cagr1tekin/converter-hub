import { NextResponse } from "next/server";
import { getManifests } from "@/core/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ modules: await getManifests() });
}
