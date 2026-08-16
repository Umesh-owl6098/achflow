import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as base } from "@/lib/server-api-base-url";
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ merchantId: string }> },
) {
  const key = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!key)
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  try {
    const id = (await ctx.params).merchantId;
    const r = await fetch(
      `${base.replace(/\/$/, "")}/admin/merchants/${encodeURIComponent(id)}/api-key/rotate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    return NextResponse.json(await r.json().catch(() => null), {
      status: r.status,
    });
  } catch {
    return NextResponse.json(
      { message: "API key could not be rotated." },
      { status: 503 },
    );
  }
}
