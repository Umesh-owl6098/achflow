import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";

async function forwardMerchantWrite(request: NextRequest) {
  const key = process.env.ACHFLOW_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Webhook API access is not configured." },
      { status: 500 },
    );
  const response = await fetch(
    `${base.replace(/\/$/, "")}/webhooks${request.nextUrl.search}`,
    {
      method: request.method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(request.method === "POST" || request.method === "PATCH"
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  return NextResponse.json(body, { status: response.status });
}
export async function GET(request: NextRequest) {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Webhook operations access is not configured." },
      { status: 500 },
    );
  try {
    const response = await fetch(
      `${base.replace(/\/$/, "")}/admin/webhooks${request.nextUrl.search}`,
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
      { message: "Webhook data is unavailable." },
      { status: 503 },
    );
  }
}
export async function POST(request: NextRequest) {
  try {
    return await forwardMerchantWrite(request);
  } catch {
    return NextResponse.json(
      { message: "Webhook request failed." },
      { status: 503 },
    );
  }
}
