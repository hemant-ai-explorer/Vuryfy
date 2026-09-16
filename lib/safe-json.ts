// Safe JSON parsing for fetch responses — Sept 16, 2026.
//
// Every verify/*/page.tsx submit handler (claim, qr, image, audio, video)
// calls `const d = await r.json()` directly on a fetch response, then
// throws `new Error(d.error || "...")` if `!r.ok`. That's fine as long as
// the server always answers with JSON — but confirmed live this session:
// right after a `npm run dev` restart, the first hit to a route still
// mid-compile (video's combined routes are the heaviest — Storage
// download, Gemini File API upload, video-analysis — so the most likely
// to still be compiling) can come back as an HTML error interstitial
// instead of JSON. `r.json()` then throws a raw `SyntaxError: Unexpected
// token 'A', "An error o"... is not valid JSON`, which every call site
// was passing straight through as `e.message` to the user — unreadable
// even in English, and doubly so for someone who reads only Hindi.
//
// parseJsonResponse reads the body as text first (so a non-JSON response
// never throws mid-parse) and only calls JSON.parse on it, throwing a
// clean, catchable NonJsonResponseError with a plain-language message
// when the body isn't JSON. The original response text is logged to the
// console (truncated) so it's still there to debug from, but never shown
// to the user raw.
export class NonJsonResponseError extends Error {
  status: number;
  bodyPreview: string;
  constructor(status: number, bodyPreview: string) {
    super(
      status >= 500 || status === 0
        ? "The server hit an unexpected error. Please wait a moment and try again."
        : "Something went wrong reaching the server. Please try again."
    );
    this.name = "NonJsonResponseError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

export async function parseJsonResponse(r: Response): Promise<any> {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    console.error(`[safe-json] non-JSON response (status ${r.status}):`, text.slice(0, 500));
    throw new NonJsonResponseError(r.status, text.slice(0, 200));
  }
}
