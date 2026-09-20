"use client";
import { useEffect, useRef, useState } from "react";

// Sept 20, 2026: added after testing found Deep Investigation gives no
// progress feedback beyond a static "Investigating…" button label — video
// Deep Investigation in particular took close to 50 seconds with nothing
// else on screen, so on a slow connection a user might reasonably wonder
// if it's stuck. This isn't real progress (no pipeline reports partial
// completion), just an honest "still working, here's how long it's been"
// signal, appended to the busy-state label as "(Ns)" by each verify page —
// see app/verify/claim/page.tsx and friends. Ticks up once per second
// while `active` is true and resets to 0 the next time `active` goes from
// false to true, so five nearly-identical pages don't each reimplement
// their own interval/cleanup logic.
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (active) {
      setSeconds(0);
      intervalRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [active]);

  return seconds;
}
