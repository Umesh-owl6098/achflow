import { NextRequest, NextResponse } from "next/server";
import { serverApiBaseUrl as apiBaseUrl } from "@/lib/server-api-base-url";

type RouteContext = { params: Promise<{ fileId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const apiKey = process.env.ACHFLOW_ADMIN_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { message: "Admin NACHA Files API access is not configured." },
      { status: 500 },
    );
  }
  const { fileId } = await context.params;
  try {
    const response = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/admin/nacha-files/${encodeURIComponent(fileId)}/download`,
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
