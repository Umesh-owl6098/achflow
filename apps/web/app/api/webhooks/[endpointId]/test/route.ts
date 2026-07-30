import { NextRequest, NextResponse } from "next/server";
const base =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ endpointId: string }> },
) {
  const key = process.env.ACHFLOW_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Webhook API access is not configured." },
      { status: 500 },
    );
  try {
    const endpointId = (await context.params).endpointId;
    const response = await fetch(
      `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(endpointId)}/test`,
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
      { message: "Webhook test could not be queued." },
      { status: 503 },
    );
  }
}
