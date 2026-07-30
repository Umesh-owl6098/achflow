import { NextRequest, NextResponse } from "next/server";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";

export async function GET(request: NextRequest) {
  const apiKey = process.env.ACHFLOW_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { message: "NACHA Files API access is not configured." },
      { status: 500 },
    );
  }
  try {
    const response = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/nacha-files?${request.nextUrl.searchParams.toString()}`,
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
        { message: "NACHA file data is unavailable." },
        { status: response.status },
      );
    }
    const requestId = response.headers.get("x-request-id");
    return NextResponse.json(body, {
      headers: requestId ? { "x-request-id": requestId } : {},
    });
  } catch {
    return NextResponse.json(
      { message: "NACHA file data is unavailable." },
      { status: 503 },
    );
  }
}
