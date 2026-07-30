import { NextRequest, NextResponse } from "next/server";

const base =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";
async function forward(request: NextRequest) {
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
  try {
    return await forward(request);
  } catch {
    return NextResponse.json(
      { message: "Webhook data is unavailable." },
      { status: 503 },
    );
  }
}
export async function POST(request: NextRequest) {
  try {
    return await forward(request);
  } catch {
    return NextResponse.json(
      { message: "Webhook request failed." },
      { status: 503 },
    );
  }
}
