import type { SupabaseClient } from "@supabase/supabase-js";
import { isSupportedLanguage, type Language } from "@/lib/translations";

// Server-side counterpart to app/api/preferences/route.ts, for the AI
// pipelines (lib/quick-check.ts, lib/deep-investigation.ts) rather than the
// client. Fails open to "en" on any lookup problem (missing row, DB error)
// — a language-preference bug must never be able to block a verification
// from running, same fail-open convention as every other secondary lookup
// in this codebase (lib/verification-cache.ts, lib/web-detection.ts, etc.).
export async function getUserLanguage(admin: SupabaseClient, userId: string): Promise<Language> {
  try {
    const { data, error } = await admin
      .from("user_preferences")
      .select("language")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return "en";
    return isSupportedLanguage(data.language) ? data.language : "en";
  } catch (err) {
    console.error("[user-language] lookup failed, defaulting to English:", err);
    return "en";
  }
}
