/**
 * secureFetch.ts – HTTPS-enforcing fetch wrapper
 *
 * Security guarantees:
 *   • Rejects any URL whose protocol is not 'https:' (prevents mixed-content
 *     and man-in-the-middle downgrade attacks).
 *   • Sets credentials to 'omit' by default, preventing cookies / auth tokens
 *     from leaking to third-party tile/data servers.
 *   • Applies a configurable timeout via AbortController so a slow or
 *     unresponsive server cannot stall the UI indefinitely.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SecureFetchOptions extends RequestInit {
  /** Override the default 15-second request timeout (in milliseconds). */
  timeoutMs?: number;
}

/**
 * A thin wrapper around the Fetch API that enforces HTTPS and applies
 * caller-friendly defaults.
 *
 * @throws {Error} if the URL uses a non-HTTPS protocol.
 * @throws {DOMException} (AbortError) if the request exceeds `timeoutMs`.
 */
export async function secureFetch(
  url: string,
  options: SecureFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  /* ── Protocol check ─────────────────────────────────────── */
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`secureFetch: invalid URL "${url}"`);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error(
      `secureFetch: only HTTPS URLs are permitted. Received "${parsedUrl.protocol}//${parsedUrl.host}".`,
    );
  }

  /* ── Timeout via AbortController ────────────────────────── */
  const controller = new AbortController();
  const timerId    = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      credentials: 'omit',      // do not send cookies to third-party servers
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timerId);
  }
}
