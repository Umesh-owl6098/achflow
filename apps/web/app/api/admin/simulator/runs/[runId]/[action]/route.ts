import { NextRequest, NextResponse } from "next/server";

const base =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";
const actions = new Set(["pause", "resume", "stop"]);

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ runId: string; action: string }> },
) {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  const { runId, action } = await context.params;
  if (!actions.has(action))
    return NextResponse.json(
      { message: "Unknown simulator action." },
      { status: 404 },
    );
  try {
    const response = await fetch(
      `${base.replace(/\/$/, "")}/admin/simulator/runs/${encodeURIComponent(runId)}/${action}`,
      {
        method: "POST",
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
      { message: "Simulator control request failed." },
      { status: 503 },
    );
  }
}
