import { english } from "../../i18n";

export class ApiError extends Error {
  constructor(public readonly status: number, description: string, public readonly code?: string) {
    super(description);
  }
}

export async function api<T = void>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(path, method, body, signal);
  return response.status === 204 ? undefined as T : response.json();
}

export async function signIn(email: string, password: string) {
  const response = await request("/auth/login", "POST", { email, password });
  const target = response.headers.get("x-workspace-path");
  if (target === "/workspace" || target === "/admin") return target;
  throw new Error("Invalid workspace destination");
}

async function request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    method, signal, credentials: "same-origin",
    headers: { "x-workspace-request": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    let description = response.status === 404 ? "This resource is unavailable or your permissions have changed." : raw || `Request failed (${response.status}).`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.error === "string") description = parsed.error;
      if (typeof parsed.code === "string") code = parsed.code;
    } catch { /* Plain-text errors can also come from the server. */ }
    throw new ApiError(response.status, description, code);
  }
  return response;
}

export function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 404) return english("common", "error.unavailable", "This resource is unavailable or your permissions have changed.");
    if (error.status === 429) return english("common", "error.rateLimit", "Wait a moment before trying again.");
    if (error.status >= 500) return english("common", "error.service", "The service is temporarily unavailable. Try again.");
    if (error.code) return english("errors", error.code, english("common", "error." + error.code, error.message));
  }
  if (error instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(error.message)) {
    return english("common", "error.network", "The request could not reach the server. Check your connection and try again.");
  }
  return error instanceof Error ? error.message : String(error);
}
