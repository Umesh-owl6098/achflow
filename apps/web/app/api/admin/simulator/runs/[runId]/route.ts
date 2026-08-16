import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  try {
    const { runId } = await context.params;
    const response = await fetch(
      `${base.replace(/\/$/, "")}/admin/simulator/runs/${encodeURIComponent(runId)}`,
      {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    return NextResponse.json(await response.json().catch(() => null), {
      status: response.status,
    });
  } catch {
    return NextResponse.json(
      { message: "Simulator run is unavailable." },
      { status: 503 },
    );
  }
}
