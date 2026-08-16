import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as apiBaseUrl } from "@/lib/server-api-base-url";

export async function GET(request: NextRequest) {
  const apiKey = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { message: "Admin payment API access is not configured." },
      { status: 500 },
    );
  }
  try {
    const response = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/admin/payments?${request.nextUrl.searchParams.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        { message: "Payment data is unavailable." },
        { status: response.status },
      );
    }
    const requestId = response.headers.get("x-request-id");
    return NextResponse.json(body, {
      headers: requestId ? { "x-request-id": requestId } : {},
    });
  } catch {
    return NextResponse.json(
      { message: "Payment data is unavailable." },
      { status: 503 },
    );
  }
}
