import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";
export async function GET(
  request: NextRequest,
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
      `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(endpointId)}/deliveries${request.nextUrl.search}`,
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
      { message: "Webhook delivery data is unavailable." },
      { status: 503 },
    );
  }
}
