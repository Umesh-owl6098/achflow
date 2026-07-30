import { NextResponse } from "next/server";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";

export async function GET() {
  const adminKey = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!adminKey) {
    return NextResponse.json(
      { message: "Admin API access is not configured." },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/admin/system/status`,
      {
        headers: {
          Authorization: `Bearer ${adminKey}`,
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
      { message: "System status is unavailable." },
      { status: 503 },
    );
  }
}
