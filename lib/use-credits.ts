"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";

// Nov 25, 2026: shared nav-bar credit count for every /verify/* confirm
// screen (claim, qr, image, audio, video). Previously each of those pages
// rendered a bare "Credits" label in the nav with no number at all — only
// the home screen (app/page.tsx) ever fetched /api/me and showed the real
// total. Found while live-testing the credit-exhaustion flow: there was no
// way to see the count ticking down without navigating back home. This
// hook does the same /api/me fetch the home screen already does, so every
// confirm screen's nav can show "Credits · N" consistently.
//
// One known, accepted gap: like the home screen, this fetches once on
// mount and doesn't re-fetch after a check completes — acceptable because
// every submit path on these pages navigates away to /result on success,
// so the nav's count is never shown stale for more than an instant.
export function useCreditsTotal(): number | null {
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    apiFetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTotal(d?.credits?.total ?? null))
      .catch(() => {});
  }, []);

  return total;
}
