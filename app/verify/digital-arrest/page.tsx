"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";

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
const RED_FLAGS = [
  {
    id: "stay_on_call",
    question:
      "Are they telling you to stay on this video/phone call, keep your camera on, or not hang up?",
    reason:
      "No Indian law-enforcement agency keeps you on a call or video as part of a real investigation.",
  },
  {
    id: "secrecy",
    question: "Have they told you not to tell your family, your bank, or a lawyer about this?",
    reason:
      "A genuine case is never confidential from your own family or bank — that secrecy demand is a control tactic, not a legal requirement.",
  },
  {
    id: "money_to_verify",
    question:
      'Have they asked you to transfer money, or pay a "fine," to "verify," "secure," or "release" your funds?',
    reason:
      "No agency asks for money to verify, secure, or release funds that are already yours. This is the single clearest tell there is.",
  },
  {
    id: "fake_document",
    question: "Did they show you a warrant, FIR, or court order on screen or over WhatsApp/chat?",
    reason:
      "Uniforms, badges, and documents shown over video or chat are easy to fake and aren't how real legal notices are served.",
  },
  {
    id: "callback_number",
    question:
      "Did they ask you to call them back on a number they gave you, instead of one you looked up yourself?",
    reason: "Always call an agency back on its own published number — never one the caller hands you.",
  },
  {
    id: "cold_open",
    question:
      "Did the call start about a parcel, your Aadhaar, a bank account, or a relative in trouble — from someone you didn't contact first?",
    reason:
      "This is the standard opening line for this scam, designed to create instant panic before the other tactics kick in.",
  },
] as const;

type Answer = "yes" | "no";

export default function DigitalArrestCheckPage() {
  const router = useRouter();
  const supabase = createClient();
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [skipToHelp, setSkipToHelp] = useState(false);
  const [contactName, setContactName] = useState<string | null>(null);
  const [contactPhone, setContactPhone] = useState<string | null>(null);
  const [isIOS, setIsIOS] = useState(false);

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

  const matched = RED_FLAGS.filter((f) => answers[f.id] === "yes");
  const allAnswered = RED_FLAGS.every((f) => answers[f.id]);
  const showHelp = skipToHelp || matched.length > 0;
  const showCalm = !showHelp && allAnswered;

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
          ← Back
        </button>
        {/* "No credit used" not "Free" — same reasoning as /verify/sebi:
            this means no Quick Check/Deep Investigation credit is spent,
            not that the app has no subscription fee. */}
        <div className="credits">No credit used</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">SCAM PREVENTION</p>
        <h1>Is this call a scam?</h1>
        <p className="sub" style={{ margin: "0 0 10px" }}>
          If someone on the phone or video is claiming to be police, CBI, customs, RBI, or a bank
          and pressuring you, answer these quickly — you don&apos;t need to finish the whole list.
        </p>
        <p className="hint" style={{ margin: "0 0 24px" }}>
          No Indian law-enforcement agency arrests, investigates, or collects a fine over a phone or
          video call. If you&apos;re not sure, hang up and verify in person.
        </p>

        {!showHelp && (
          <button className="text-button" style={{ marginBottom: 20 }} onClick={() => setSkipToHelp(true)}>
            Already sure this is a scam? Skip straight to what to do →
          </button>
        )}

        <div style={{ display: "grid", gap: 16 }}>
          {RED_FLAGS.map((f) => (
            <div key={f.id} className="panel" style={{ width: "100%" }}>
              <p style={{ margin: "0 0 12px", fontSize: 16, lineHeight: 1.5 }}>{f.question}</p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  style={{
                    width: "auto",
                    padding: "0 22px",
                    marginTop: 0,
                    background: answers[f.id] === "yes" ? "#b42318" : undefined,
                  }}
                  onClick={() => answer(f.id, "yes")}
                >
                  Yes
                </button>
                <button
                  className="secondary"
                  style={{
                    width: "auto",
                    padding: "0 22px",
                    marginTop: 0,
                    opacity: answers[f.id] === "no" ? 1 : 0.85,
                  }}
                  onClick={() => answer(f.id, "no")}
                >
                  No
                </button>
              </div>
              {answers[f.id] === "yes" && (
                <p className="caution" style={{ marginTop: 14 }}>
                  {f.reason}
                </p>
              )}
            </div>
          ))}
        </div>

        {showHelp && (
          <div className="scam-warning" style={{ marginTop: 28 }}>
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
              This matches the digital arrest / scary-call scam pattern
            </p>
            <p className="caution" style={{ margin: 0 }}>
              {matched.length > 0
                ? "No Indian agency does what you just described. Hang up now — you can't be arrested, fined, or investigated over a call, and nobody genuine will ask you to stay on one."
                : "If anyone is pressuring you for money, secrecy, or to stay on a call, treat it as a scam. Hang up — you can always call a real agency back yourself to check."}
            </p>

            <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
              <a className="secondary-link" href="tel:1930" style={{ width: "100%" }}>
                Call 1930 (national cybercrime helpline)
              </a>
              <a
                className="secondary-link"
                href="https://cybercrime.gov.in"
                target="_blank"
                rel="noopener noreferrer"
                style={{ width: "100%" }}
              >
                Report at cybercrime.gov.in
              </a>
              <a
                className="secondary-link"
                href="https://sancharsaathi.gov.in/sfc"
                target="_blank"
                rel="noopener noreferrer"
                style={{ width: "100%" }}
              >
                Report this number (Chakshu)
              </a>
            </div>

            <div style={{ marginTop: 26, borderTop: "1px solid #f3b4ac", paddingTop: 20 }}>
              <p style={{ margin: "0 0 12px", fontWeight: 600 }}>Tell someone right now</p>
              {contactPhone ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <a
                    className="primary-link"
                    href={waLink!}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ width: "100%" }}
                  >
                    Message {contactName || "your contact"} on WhatsApp
                  </a>
                  <a className="secondary-link" href={smsLink!} style={{ width: "100%" }}>
                    Text {contactName || "your contact"} instead
                  </a>
                </div>
              ) : (
                <p className="hint">
                  You haven&apos;t set up a trusted contact yet. <a href="/settings">Add one in Settings</a>{" "}
                  so you can alert them in one tap next time.
                </p>
              )}
            </div>
          </div>
        )}

        {showCalm && (
          <div className="qr-payment" style={{ marginTop: 28 }}>
            <span>NO CLASSIC WARNING SIGNS MATCHED</span>
            <h3>Still, stay cautious</h3>
            <p className="caution">
              None of the usual tells matched what you described. That&apos;s reassuring, but it
              doesn&apos;t guarantee the call is genuine — if anything about it still feels off, you can
              always hang up and call the agency back yourself on a number you look up independently,
              not one given to you on the call.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
