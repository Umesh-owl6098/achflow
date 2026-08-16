import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";
async function forward(request: NextRequest, endpointId: string) {
  const key = process.env.ACHFLOW_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Webhook API access is not configured." },
      { status: 500 },
    );
  const response = await fetch(
    `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(endpointId)}`,
    {
      method: request.method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(request.method === "PATCH"
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: request.method === "PATCH" ? await request.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  return NextResponse.json(await response.json().catch(() => null), {
    status: response.status,
  });
}
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ endpointId: string }> },
) {
  try {
    return await forward(request, (await context.params).endpointId);
  } catch {
    return NextResponse.json(
      { message: "Webhook request failed." },
      { status: 503 },
    );
  }
}
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ endpointId: string }> },
) {
  try {
    return await forward(request, (await context.params).endpointId);
  } catch {
    return NextResponse.json(
      { message: "Webhook request failed." },
      { status: 503 },
    );
  }
}
