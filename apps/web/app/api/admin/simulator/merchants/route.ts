import { NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";

export async function GET() {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key) {
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(
      `${base.replace(/\/$/, "")}/admin/simulator/merchants`,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    return NextResponse.json(await response.json().catch(() => null), {
      status: response.status,
    });
  } catch {
    return NextResponse.json(
      { message: "Simulator merchants are unavailable." },
      { status: 503 },
    );
  }
}
