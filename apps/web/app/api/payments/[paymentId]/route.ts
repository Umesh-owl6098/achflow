import { NextRequest, NextResponse } from "next/server";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const apiKey = process.env.ACHFLOW_API_KEY;
  if (!apiKey)
    return NextResponse.json(
      { message: "Payment API access is not configured." },
      { status: 500 },
    );
  try {
    const { paymentId } = await params;
    const response = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/payments/${encodeURIComponent(paymentId)}`,
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
    if (!response.ok)
      return NextResponse.json(
        { message: "Payment data is unavailable." },
        { status: response.status },
      );
    return NextResponse.json(body);
  } catch {
    return NextResponse.json(
      { message: "Payment data is unavailable." },
      { status: 503 },
    );
  }
}
