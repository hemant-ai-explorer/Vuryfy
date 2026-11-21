"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { useLanguage } from "@/app/providers/language-provider";

// Guided "digital arrest" / scary-call checklist — Nov 20, 2026. See
// claude/scam-feature-digital-arrest-2026-11-20.md (Vuryfy project notes)
// for the research this was built from (I4C/NCRP data, government and
// security-education guidance on the scam's mechanics and the official
// response advice).
//
// Unlike /verify/sebi, this isn't a lookup against a registry — there's
// no public database of "real CBI officers currently assigned to a case"
// to check a claim against. The actual defense is recognizing a small set
// of near-deterministic tells: per official guidance, each one below is
// on its own something a real Indian agency simply does not do, not a
// probabilistic signal that needs several to add up. So this is a
// short-circuiting checklist — ANY single "yes" immediately shows the
// scam verdict, rather than waiting for a score. Speed matters here in a
// way it doesn't for SEBI: someone using this page is plausibly mid-call
// right now.
//
// Also deliberately NOT routed through the general claim-verifier
// (/api/verify). architecture-decisions.md documents that its grounding
// was tightened to require a specific link/domain/entity, so a claim
// describing a general scam *pattern* with no named entity "can come back
// `True` rather than `Scam`" — the right tradeoff for the QR/domain
// false-positive problem it was built to fix, but wrong here: this page
// needs certainty on pattern recognition alone, which is why it's a
// deterministic checklist instead of an AI call with retrieval it doesn't
// need.
// Nov 21, 2026: question/reason text used to live inline here, but that
// made it impossible to translate (a hook like useLanguage() can't be
// called at module scope, only inside the component). The six flags now
// carry just their id, and the question/reason strings are looked up at
// render time via t(`da.flag.${id}.question`) / t(`da.flag.${id}.reason`)
// — see the matching "da.flag.*" keys in lib/translations.ts.
const RED_FLAG_IDS = [
  "stay_on_call",
  "secrecy",
  "money_to_verify",
  "fake_document",
  "callback_number",
  "cold_open",
] as const;

type Answer = "yes" | "no";

export default function DigitalArrestCheckPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [skipToHelp, setSkipToHelp] = useState(false);
  const [contactName, setContactName] = useState<string | null>(null);
  const [contactPhone, setContactPhone] = useState<string | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  // Nov 20, 2026: the "what to do" section (toolkit + SOS) renders below
  // the full six-question checklist, which stays visible even once
  // showHelp flips true. Without this, clicking "Skip straight to what to
  // do" from the top of the page changed nothing in the viewport — the
  // new section landed off-screen below ~6 question cards, so it looked
  // like the click did nothing. Scrolling the help section into view
  // whenever it appears (skip link OR answering any question "Yes") fixes
  // that for both paths.
  const helpRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  useEffect(() => {
    apiFetch("/api/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setContactName(d.trusted_contact_name ?? null);
        setContactPhone(d.trusted_contact_phone ?? null);
      })
      .catch(() => {});
    // sms: URIs split on "?" (Android) vs "&" (iOS) for the body param —
    // no reliable feature-detect for this, so a quick UA sniff is the
    // pragmatic call for one non-critical fallback link (WhatsApp, the
    // primary SOS path above it, doesn't have this problem).
    setIsIOS(/iPhone|iPad|iPod/.test(navigator.userAgent));
  }, []);

  function answer(id: string, value: Answer) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  const matched = RED_FLAG_IDS.filter((id) => answers[id] === "yes");
  const allAnswered = RED_FLAG_IDS.every((id) => answers[id]);
  const showHelp = skipToHelp || matched.length > 0;
  const showCalm = !showHelp && allAnswered;

  useEffect(() => {
    if (showHelp) {
      helpRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [showHelp]);

  const SOS_MESSAGE =
    'I think I might be on a scam call right now (possibly a fake police/CBI "digital arrest" call) and could use you on the phone — can you call me?';
  const waLink = contactPhone
    ? `https://wa.me/${contactPhone}?text=${encodeURIComponent(SOS_MESSAGE)}`
    : null;
  const smsLink = contactPhone
    ? `sms:${contactPhone}${isIOS ? "&" : "?"}body=${encodeURIComponent(SOS_MESSAGE)}`
    : null;

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">{t("nav.freeCredits")}</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("scam.eyebrow")}</p>
        <h1>{t("da.heading")}</h1>
        <p className="sub" style={{ margin: "0 0 10px" }}>
          {t("da.sub")}
        </p>
        <p className="hint" style={{ margin: "0 0 24px" }}>
          {t("da.hint")}
        </p>

        {!showHelp && (
          <button className="text-button" style={{ marginBottom: 20 }} onClick={() => setSkipToHelp(true)}>
            {t("da.skipPrefix")}{" "}
            <span style={{ textDecoration: "underline" }}>{t("da.skipLink")}</span> →
          </button>
        )}

        <div style={{ display: "grid", gap: 16 }}>
          {RED_FLAG_IDS.map((id) => (
            <div key={id} className="panel" style={{ width: "100%" }}>
              <p style={{ margin: "0 0 12px", fontSize: 16, lineHeight: 1.5 }}>
                {t(`da.flag.${id}.question`)}
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  style={{
                    width: "auto",
                    padding: "0 22px",
                    marginTop: 0,
                    background: answers[id] === "yes" ? "#b42318" : undefined,
                  }}
                  onClick={() => answer(id, "yes")}
                >
                  {t("da.yes")}
                </button>
                <button
                  className="secondary"
                  style={{
                    width: "auto",
                    padding: "0 22px",
                    marginTop: 0,
                    opacity: answers[id] === "no" ? 1 : 0.85,
                  }}
                  onClick={() => answer(id, "no")}
                >
                  {t("da.no")}
                </button>
              </div>
              {answers[id] === "yes" && (
                <p className="caution" style={{ marginTop: 14 }}>
                  {t(`da.flag.${id}.reason`)}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Nov 20, 2026: the escape toolkit (1930 / cybercrime.gov.in / Chakshu
            / trusted-contact SOS) used to be nested inside `showHelp`, so it
            only existed once a flag matched or the skip link was clicked.
            User feedback: these should be reachable regardless — someone
            mid-checklist, or who answered "No" to everything, can still want
            to report a number or message a contact. Only the
            pattern-matched warning text above it stays conditional on
            showHelp; the toolkit itself is now unconditional. */}
        <div ref={helpRef} className="scam-warning" style={{ marginTop: 28 }}>
          {showHelp && (
            <>
              <p
                style={{
                  margin: "0 0 10px",
                  fontWeight: 700,
                  fontSize: 13,
                  letterSpacing: ".04em",
                  textTransform: "uppercase",
                  color: "#7a281f",
                }}
              >
                {t("da.warningLabel")}
              </p>
              <p className="caution" style={{ margin: 0 }}>
                {matched.length > 0 ? t("da.warningMatched") : t("da.warningSkip")}
              </p>
            </>
          )}

          <div style={{ marginTop: showHelp ? 22 : 0, display: "grid", gap: 10 }}>
            <a className="secondary-link" href="tel:1930" style={{ width: "100%" }}>
              {t("da.call1930")}
            </a>
            <a
              className="secondary-link"
              href="https://cybercrime.gov.in"
              target="_blank"
              rel="noopener noreferrer"
              style={{ width: "100%" }}
            >
              {t("da.reportCybercrime")}
            </a>
            <a
              className="secondary-link"
              href="https://sancharsaathi.gov.in/sfc"
              target="_blank"
              rel="noopener noreferrer"
              style={{ width: "100%" }}
            >
              {t("da.reportChakshu")}
            </a>
          </div>

          <div style={{ marginTop: 26, borderTop: "1px solid #f3b4ac", paddingTop: 20 }}>
            <p style={{ margin: "0 0 12px", fontWeight: 600 }}>{t("da.tellSomeone")}</p>
            {contactPhone ? (
              <div style={{ display: "grid", gap: 10 }}>
                <a
                  className="primary-link"
                  href={waLink!}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ width: "100%" }}
                >
                  {t("da.messageContact").replace("{name}", contactName || t("da.yourContact"))}
                </a>
                <a className="secondary-link" href={smsLink!} style={{ width: "100%" }}>
                  {t("da.textContact").replace("{name}", contactName || t("da.yourContact"))}
                </a>
              </div>
            ) : (
              <p className="hint">
                {t("da.noContactText")} <a href="/settings">{t("da.noContactLink")}</a>{" "}
                {t("da.noContactSuffix")}
              </p>
            )}
          </div>
        </div>

        {showCalm && (
          <div className="qr-payment" style={{ marginTop: 28 }}>
            <span>{t("da.calmBadge")}</span>
            <h3>{t("da.calmHeading")}</h3>
            <p className="caution">{t("da.calmBody")}</p>
          </div>
        )}
      </section>
    </main>
  );
}
