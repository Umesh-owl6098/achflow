import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";

async function forward(request: NextRequest) {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key) {
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  }
  const response = await fetch(
    `${base.replace(/\/$/, "")}/admin/simulator/runs`,
    {
      method: request.method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(request.method === "POST"
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  return NextResponse.json(await response.json().catch(() => null), {
    status: response.status,
  });
}

export async function GET(request: NextRequest) {
  try {
    return await forward(request);
  } catch {
    return NextResponse.json(
      { message: "Simulator runs are unavailable." },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    return await forward(request);
  } catch {
    return NextResponse.json(
      { message: "Simulator request failed." },
      { status: 503 },
    );
  }
}
