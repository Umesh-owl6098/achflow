import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ merchantId: string }> },
) {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key) {
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  }

  try {
    const { merchantId } = await context.params;
    const response = await fetch(
      `${base.replace(/\/$/, "")}/admin/simulator/merchants/${encodeURIComponent(merchantId)}/demo-funding`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: await request.text(),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    return NextResponse.json(await response.json().catch(() => null), {
      status: response.status,
    });
  } catch {
    return NextResponse.json(
      { message: "Demo funding request failed." },
      { status: 503 },
    );
  }
}
