import { NextRequest, NextResponse } from "next/server";
const base =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";
export async function GET(
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
      `${base.replace(/\/$/, "")}/admin/merchants/${encodeURIComponent(id)}`,
      {
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
      { message: "Merchant data is unavailable." },
      { status: 503 },
    );
  }
}
