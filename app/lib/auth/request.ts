/** Safe, actionable failures shared by the browser's authentication requests. */
export class AuthRequestError extends Error {
  constructor(message: string, public readonly status = 0, public readonly code = "request_failed", public readonly retryAfter = 0) { super(message); }
}

export function authErrorMessage(cause: unknown, fallback = "Something went wrong. Please try again.") {
  return cause instanceof AuthRequestError ? cause.message : fallback;
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, Math.ceil(seconds))) : 0;
}

export async function authRequest<T>(path: string, method: string, body?: unknown, validate?: (value: unknown) => value is T): Promise<T> {
  try {
    const response = await fetch(path, {
      method, headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const result = await response.json().catch(() => null);
    const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
    if (!response.ok) {
      const message = response.status >= 500 ? "We’re having trouble completing this request. Please try again in a moment."
        : typeof result?.error === "string" ? result.error
        : response.status === 429 ? "Too many requests. Please wait before trying again."
        : "We couldn’t complete this request. Please try again.";
      throw new AuthRequestError(message, response.status, typeof result?.code === "string" ? result.code : "request_failed", retryAfter);
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || (validate && !validate(result))) {
      throw new AuthRequestError("We couldn’t confirm the result. Please refresh the page before trying again.", response.status, "invalid_response");
    }
    return result as T;
  } catch (cause) {
    if (cause instanceof AuthRequestError) throw cause;
    if (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)) {
      throw new AuthRequestError("The request took too long. Check your inbox or refresh the page before trying again.", 0, "request_timeout");
    }
    throw new AuthRequestError("We couldn’t connect. Check your internet connection and try again.", 0, "network_error");
  }
}
