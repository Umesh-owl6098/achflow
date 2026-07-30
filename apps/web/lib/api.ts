const defaultTimeoutMs = 10_000;

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(options: {
    status: number;
    message: string;
    requestId: string | null;
    body: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.requestId = options.requestId;
    this.body = options.body;
  }
}

export const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/v1";

function joinUrl(path: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return response.text();
  }

  return response.json().catch(() => null);
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = defaultTimeoutMs, headers, ...requestOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(joinUrl(path), {
      ...requestOptions,
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal: controller.signal,
    });
    const body = await parseResponseBody(response);
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("x-correlation-id");

    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "message" in body
          ? String(body.message)
          : `Request failed with status ${response.status}`;
      throw new ApiError({
        status: response.status,
        message,
        requestId,
        body,
      });
    }

    return body as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError({
        status: 0,
        message: "Request timed out. Please try again.",
        requestId: null,
        body: null,
      });
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
