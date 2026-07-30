import { NextRequest, NextResponse } from "next/server";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";

type RouteContext = { params: Promise<{ fileId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const apiKey = process.env.ACHFLOW_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { message: "NACHA Files API access is not configured." },
      { status: 500 },
    );
  }
  const { fileId } = await context.params;
  try {
    const response = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/nacha-files/${encodeURIComponent(fileId)}/download`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/plain" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return NextResponse.json(
        { message: "NACHA file download is unavailable." },
        { status: response.status },
      );
    }
    return new NextResponse(await response.arrayBuffer(), {
      headers: {
        "Content-Type":
          response.headers.get("content-type") ?? "text/plain; charset=utf-8",
        "Content-Disposition":
          response.headers.get("content-disposition") ?? "attachment",
      },
    });
  } catch {
    return NextResponse.json(
      { message: "NACHA file download is unavailable." },
      { status: 503 },
    );
  }
}
