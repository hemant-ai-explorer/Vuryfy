// Shared translation dictionary — Phase 1 of Part 11's locked multilingual
// design, Sept 16, 2026. Launched with English + Hindi only (the user's
// explicit choice, to prove the whole mechanism — signup picker, stored
// preference, localized UI chrome, localized AI verification output,
// settings-page override — before scaling to the remaining 6 launch
// languages Part 11 names: Kannada, Malayalam, Tamil, Telugu, Gujarati,
// Bengali).
//
// This file is plain data plus a pure lookup function — no "use client"
// directive, no framework import — so it can be imported from both server
// code (API routes, lib/quick-check.ts, lib/deep-investigation.ts, for the
// small set of pipeline-level fallback strings that need localizing) and
// client code (via app/providers/language-provider.tsx's useLanguage()
// hook).
//
// Coverage in this pass (original Phase 1): the home screen, the
// sign-in/sign-up screen (incl. the new language-picker step), the unified
// text/URL verify screen, and the settings screen. Extended by the two
// fast-follows below the same day to cover everything else.
//
// Sept 16, 2026 fast-follow #1: extended coverage to the video/audio/image
// authenticity pipelines (lib/video-analysis.ts, lib/audio-analysis.ts,
// lib/image-analysis.ts) after a real user reported that choosing Hindi
// localized the plain-text Quick Check/Deep Investigation flow but NOT
// these media pipelines — their `summary`/`caveats` output is built partly
// from the model's own free text (now localized via each file's own
// languageInstruction(), same pattern as quick-check.ts/
// deep-investigation.ts) and partly from hardcoded English strings in code
// (AI-generation labels, the fixed disclaimer, caveat sentences) — those
// hardcoded pieces are the "pipeline.video.*"/"pipeline.audio.*"/
// "pipeline.image.*"/"pipeline.common.*" keys added below. The
// True/False/Misleading/Unverified/Scam and Clean/Suspicious/Inconclusive/
// Out of Context verdict words themselves remain deliberately unlocalized
// (same as this file's original Phase 1 decision for the text pipeline) —
// they're short, fixed enum values the result page already styles/colors
// by exact string match, and localizing them would require threading
// translated labels through every verdict-comparison call site for a
// cosmetic-only gain.
//
// Sept 16, 2026 fast-follow #2: closed the remaining screen-chrome gap
// this file's own header used to flag as deliberately out of scope —
// static text on the result page and on the QR/image/audio/video confirm
// screens now comes from this dictionary too (the "result.*"/"qr.*"/
// "image.*"/"audio.*"/"video.*" keys below, plus a handful of small shared
// keys — "nav.*", "status.*", "transcript.badge", "noSpeech.badge",
// "action.chooseAnother", "hint.checkIt", "payee.*" — reused across more
// than one of those screens where the English wording was identical).
// Verdict words and the "Quick Check"/"Deep Investigation"/"Checking…"/
// "Investigating…" labels reuse the existing "claim.*" keys rather than
// duplicating them, since that wording was already identical everywhere it
// appears. One dynamic string, the payee look-alike warning on the QR
// page, is templated with {name}/{id} placeholders substituted in code
// (see app/verify/qr/page.tsx) rather than kept as JSX with embedded bold
// text — a deliberate small simplification, not a bug.
// Sept 18, 2026: extended from English+Hindi to all 8 launch languages
// Part 11 originally named. The 6 new dictionaries (kn/ml/ta/te/gu/bn) live
// in their own files (lib/translations-<code>.ts) rather than inline here
// — this file had already grown to ~60KB with just two languages, and a
// single file holding all 8 would make every future edit to it a large,
// risky rewrite. Each per-language file carries the same key set as `en`
// below (checked by convention, not an automated test — translate() falls
// back to English for a missing key, so a gap fails silently rather than
// breaking the build, which is why key-parity matters even without
// enforcement).
import { kn } from "./translations-kn";
import { ml } from "./translations-ml";
import { ta } from "./translations-ta";
import { te } from "./translations-te";
import { gu } from "./translations-gu";
import { bn } from "./translations-bn";
import { mr } from "./translations-mr";

// Sept 18, 2026 (later same day): added Marathi (mr) as a 9th language,
// beyond Part 11's original 8-language list, per the user's direct request.
// Same per-language-file pattern as kn/ml/ta/te/gu/bn above — see this
// file's header comment for the full rationale.
export type Language = "en" | "hi" | "kn" | "ml" | "ta" | "te" | "gu" | "bn" | "mr";

export const SUPPORTED_LANGUAGES: { code: Language; label: string; nativeLabel: string }[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ" },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം" },
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்" },
  { code: "te", label: "Telugu", nativeLabel: "తెలుగు" },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી" },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা" },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी" },
];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  hi: "Hindi",
  kn: "Kannada",
  ml: "Malayalam",
  ta: "Tamil",
  te: "Telugu",
  gu: "Gujarati",
  bn: "Bengali",
  mr: "Marathi",
};

type Dictionary = Record<string, string>;

const en: Dictionary = {
  "home.eyebrow": "VURYFY",
  "home.heading": "What do you want to verify?",
  "home.sub": "Choose what you want to verify, then pick Quick Check for a fast answer or Deep Investigation when you need a more thorough examination.",
  "home.verifyText": "Verify Text",
  "home.verifyUrl": "Verify URL/Claims",
  "home.verifyQr": "Verify a QR Code",
  "home.verifyPhoto": "Verify a Photo/Image",
  "home.verifyAudio": "Verify Audio",
  "home.verifyVideo": "Verify a Video",
  // Nov 20, 2026: added for the SEBI intermediary-registration check
  // (app/verify/sebi/page.tsx) — the only home-actions entry that's free
  // (doesn't draw from Quick Check/Deep Investigation credits), hence the
  // separate badge key rather than folding it into the label itself and
  // breaking the "Verify X" naming pattern the other buttons use.
  "home.verifyBreachCheck": "Check for Data Breaches",
  "home.verifySebi": "Verify SEBI Registration",
  "home.verifyDigitalArrest": "Scam Call Check",
  // Nov 20, 2026: briefly changed to "No Credit" over concern that a bare
  // "Free" badge could read as "this app has no subscription fee" — user
  // decided to keep "Free" after seeing it in place; reverted same day.
  "home.free": "Free",
  "home.quickChecks": "Quick Checks",
  "home.deepInvestigations": "Deep Investigations",
  "home.settings": "Settings",
  "home.signOut": "Sign out",
  // Sept 18, 2026: added alongside the new history screen (app/saved/
  // page.tsx) and the WhatsApp submission MVP. English-only for now —
  // translate() falls back to this value for every other language until
  // the other 8 dictionaries pick it up, same as any other missing key.
  "home.history": "History",
  "home.noPlan": "You don't have an active plan yet.",
  "home.subEnding": "Your subscription is scheduled to end at the end of the current paid period.",
  "landing.eyebrow": "VERIFY WHAT MATTERS",
  "landing.heading": "Know what to trust",
  "landing.sub": "Investigate claims and information with explainable AI-powered verification.",
  "landing.cta": "Sign in or sign up",
  "landing.signIn": "Sign in",
  "landing.signUp": "Sign up",
  "landing.hint": "New to Vuryfy? Enter your phone number on the next screen — your account is created automatically, no separate sign-up needed.",
  "login.eyebrowStart": "GET STARTED",
  "login.eyebrowSignin": "WELCOME BACK",
  "login.eyebrowCode": "WELCOME",
  "login.headingStart": "Sign in or sign up.",
  "login.headingSignin": "Sign in.",
  "login.headingSignup": "Sign up.",
  "login.headingCode": "Enter your code.",
  "login.subStart": "Use your phone number. No password required.",
  "login.subSignin": "Use your phone number. No password required.",
  "login.subSignup": "Enter your phone number — your account is created automatically, no password required.",
  "login.subCode": "Use the one-time code sent to your phone.",
  "login.phonePlaceholder": "Phone number",
  "login.continue": "Continue",
  "login.sending": "Sending…",
  "login.otpPlaceholder": "6-digit OTP",
  "login.verify": "Verify & continue",
  "login.verifying": "Verifying…",
  "login.useAnotherNumber": "Use another number",
  "language.eyebrow": "ONE LAST STEP",
  "language.heading": "Choose your language.",
  "language.sub": "Vuryfy will show its screens and verification results in this language. You can change it any time from Settings.",
  "language.continue": "Continue",
  "language.saving": "Saving…",
  "claim.textEyebrow": "VERIFY TEXT",
  "claim.textHeading": "What should we verify?",
  "claim.textSub": "Paste a claim or statement, then choose Quick Check for a fast answer or Deep Investigation for a more thorough one.",
  "claim.textPlaceholder": "Paste a claim or statement…",
  "claim.urlEyebrow": "VERIFY URL/CLAIMS",
  "claim.urlHeading": "What link or claim should we verify?",
  "claim.urlSub": "Paste a URL, or a claim about one, then choose Quick Check for a fast answer or Deep Investigation for a more thorough one.",
  "claim.urlPlaceholder": "Paste a URL, link, or claim…",
  "claim.deepInvestigation": "Deep Investigation",
  "claim.investigating": "Investigating…",
  "claim.quickCheck": "Quick Check",
  "claim.checking": "Checking…",
  "claim.minLengthHint": "Enter at least 5 characters to run a check.",
  "claim.hintQrText": "Have a QR code instead?",
  "claim.hintQrLink": "Scan it",
  "claim.hintPhotoText": "Got a photo?",
  "claim.hintPhotoLink": "Check it",
  "claim.hintAudioText": "Got audio?",
  "claim.hintAudioLink": "Check it",
  "claim.hintVideoText": "Got a video?",
  "claim.hintVideoLink": "Check it",
  "settings.eyebrow": "SETTINGS",
  "settings.heading": "Settings.",
  "settings.languageLabel": "Language",
  "settings.languageSub": "Choose the language Vuryfy uses for its screens and for verification results.",
  "settings.save": "Save",
  "settings.saving": "Saving…",
  "settings.saved": "Saved.",
  "settings.moreComingSoon": "Credits & Subscription settings are moving here soon.",
  "nav.back": "← Back",
  "nav.credits": "Credits",
  "pipeline.noEvidenceQuick": "No evidence could be found to check this claim against. Try rephrasing it or adding more specific detail.",
  "pipeline.noEvidenceDeep": "No evidence could be found across any of the angles this investigation looked into. Try rephrasing the claim or adding more specific detail.",
  "pipeline.common.observedPrefix": "Observed: ",
  "pipeline.common.noSignalsDescribed": "No specific signals were described.",
  "pipeline.common.noExplanation": "No explanation was returned.",
  "pipeline.video.summaryPrefix": "Manipulated/AI-generated:",
  "pipeline.video.aiLikely": "Likely manipulated or AI-generated",
  "pipeline.video.aiUnlikely": "Unlikely to be manipulated or AI-generated",
  "pipeline.video.aiUncertain": "Uncertain whether this is manipulated or AI-generated",
  "pipeline.video.disclaimer": "This is primarily a visual and audio read of the video itself — Vuryfy has no way to independently confirm who filmed this, when, or where. Deepfake and AI video generation tools keep improving, and a well-made fake can look convincing even on close review.",
  "pipeline.video.caveatFace": "Top-tier deepfake/face-swap tools are built to hold up on a casual watch-through, including matched lighting and natural blinking — an \"unlikely\"/\"uncertain\" call here means no inconsistency was found either way, not that the face is confirmed real.",
  "pipeline.video.caveatNoFace": "Top-tier AI video generators (Sora, Runway, Kling, Veo, and similar) are improving quickly at physical plausibility — an \"unlikely\"/\"uncertain\" call here means no inconsistency was found either way, not that the footage is confirmed to be real camera footage.",
  "pipeline.video.contextInconsistent": "The described context doesn't visually match what's shown in the video.",
  "pipeline.video.contextConsistent": "What's shown is at least plausible with the context described, though this is still only a watch-through, not a confirmed match.",
  "pipeline.audio.summaryPrefix": "AI-generated:",
  "pipeline.audio.aiLikely": "Likely AI-generated",
  "pipeline.audio.aiUnlikely": "Unlikely to be AI-generated",
  "pipeline.audio.aiUncertain": "Uncertain whether this is AI-generated",
  "pipeline.audio.disclaimer": "This is primarily an audible read of the recording itself — Vuryfy has no way to independently confirm who recorded this, when, or where.",
  "pipeline.audio.caveatSpeech": "Top-tier AI voice-cloning tools (ElevenLabs and similar) are built to sound indistinguishable from real speech, breath sounds and all — a listen-through like this one cannot reliably catch the best of them, so an \"unlikely\"/\"uncertain\" call here means no capture-environment evidence was found either way, not that the voice is confirmed human.",
  "pipeline.audio.contextInconsistent": "The described context doesn't audibly match what's heard in the recording.",
  "pipeline.audio.contextConsistent": "What's audible is at least plausible with the context described, though this is still only a listen-through, not a confirmed match.",
  "pipeline.image.disclaimer": "This is primarily a visual read of the image itself — Vuryfy has no way to independently confirm who took this photo, when, or where, beyond what any cited web pages below actually say.",
  "pipeline.image.contextInconsistent": "The described context doesn't visually match what's shown in the image.",
  "pipeline.image.contextConsistent": "What's visible in the image is at least plausible with the context described, though this is still only a visual read, not a confirmed match.",
  "nav.newCheck": "← New check",
  "nav.creditsPrefix": "Credits · ",
  "status.reading": "Reading…",
  "status.processing": "Processing…",
  "status.transcribing": "Transcribing…",
  "status.uploading": "Uploading…",
  "transcript.badge": "TRANSCRIPT (EDIT IF NEEDED)",
  "noSpeech.badge": "NO SPEECH FOUND",
  "action.chooseAnother": "Choose another",
  "hint.checkIt": "Check it",
  "payee.unnamed": "Unnamed payee",
  "payee.investigateEyebrow": "INVESTIGATE THIS PAYEE",
  // Sept 17, 2026: closes the explicitly-flagged gap from the Sept 16
  // multilingual work (see architecture-decisions.md/-addendum's "payee
  // routes' own hardcoded English DISCLAIMER caveat" entries) —
  // app/api/verify-payee/route.ts and app/api/deep-payee/route.ts now call
  // translate(language, "payee.disclaimer") instead of a hardcoded English
  // const, same pattern as every other pipeline's disclaimer caveat.
  "payee.disclaimer":
    "This searches the public web for reports about this payee — it can't confirm who actually controls the payment ID, and finding nothing doesn't mean they're legitimate. Most real businesses and most scammers alike often have little to no searchable footprint.",
  // Sept 17, 2026: payee-reputation results (Quick Check and Deep
  // Investigation both) no longer show the raw True/False/Misleading/
  // Unverified verdict word — those labels read as confusing or alarming
  // for what is really an identity/reputation lookup, not a fact-check.
  // See app/result/page.tsx's new payee_reputation branch: the result now
  // always leads with the payee's own name/ID (same treatment the free
  // QR-decode preview already gives it), then either this "no reports
  // found" status line, or the existing red Scam warning card when the
  // verdict actually is "Scam" — nothing else changes below that (why,
  // evidence, caveats still render in full either way).
  "result.payeeBadge": "PAYEE",
  "result.payeeClear": "No public scam reports found for this payee.",
  // Sept 23, 2026: rendered by app/result/page.tsx only when
  // r.registeredIdentity?.available is true — i.e. only once a real VPA-
  // verification provider is wired into lib/vpa-registered-name.ts. Until
  // then this key exists but is never shown, since the stub always
  // reports unavailable.
  "result.registeredNameLabel": "Registered to: ",
  "result.registeredNameMismatch":
    "This doesn't match the name shown on the QR code — verify directly with who you intend to pay before proceeding.",
  "result.receiptEyebrow": "PAYMENT RECEIPT",
  "result.receiptBadge": "THIS LOOKS LIKE A PAYMENT RECEIPT",
  "result.receiptAmountUnclear": "Amount not clearly readable",
  "result.receiptFrom": "From: ",
  "result.receiptTo": "To: ",
  "result.receiptVia": "Via: ",
  "result.receiptTxnId": "Transaction ID: ",
  "result.receiptDate": "Date: ",
  "result.receiptCaution": "Vuryfy can't confirm a private payment like this actually went through — there's no public record of a bank/UPI transfer for a search to check, so we can't give this a Verified/Unverified score the way we would a public claim. Receipts and screenshots like this can also be faked with widely available apps, even when they look completely convincing. The only way to be sure is to check your own bank or UPI app for the actual credit before relying on this. No credit was charged for this check.",
  "result.whatWeRead": "WHAT WE READ",
  "result.checkAnother": "Check another",
  "result.requestEyebrow": "PAYMENT REQUEST / QR CODE",
  "result.requestBadge": "THIS LOOKS LIKE A \"SCAN TO PAY\" CARD",
  "result.requestCaution": "Vuryfy can't verify who actually controls a payment ID like this — that isn't something a web search can confirm, whether it arrives as a scannable QR code or a screenshot of one. Before paying, make sure the name above matches who you intend to pay, and confirm directly with them if you're unsure. No credit was charged for this check.",
  "result.investigateHint": "This searches the public web for the payee's name and ID — scam reports, complaints, or a legitimate business presence. It still can't confirm who controls the ID; it can only tell you what's publicly findable, which may be nothing either way.",
  "result.deepResultEyebrow": "DEEP INVESTIGATION RESULT",
  "result.quickResultEyebrow": "QUICK CHECK RESULT",
  "result.scamWarning": "⚠ SCAM WARNING",
  "result.confidencePrefix": "Confidence · ",
  "result.scamCaution": "This was flagged as a scam based on the evidence found — don't click through, pay, or share personal details with it. Check the evidence below for what we found.",
  "result.claimLabel": "CLAIM",
  "result.whyLabel": "WHY",
  "result.evidenceLabel": "EVIDENCE",
  "result.notesLabel": "NOTES",
  "result.shareResult": "Copy result",
  "result.copied": "Copied to clipboard.",
  "result.copyFailed": "Couldn't copy — try selecting and copying the text yourself.",
  "result.verifyAnother": "Verify another",
  "result.eyebrowPhoto": "THE PHOTO ITSELF",
  "result.eyebrowVideo": "THE VIDEO ITSELF",
  "result.eyebrowRecording": "THE RECORDING ITSELF",
  "qr.eyebrow": "QR CODE",
  "qr.heading": "Scan a QR code.",
  "qr.sub": "Upload a photo of a QR code and choose Quick Check or Deep Investigation for what it points to. Only the text inside the code is sent to us — the photo itself never leaves your device.",
  "qr.choosePhoto": "Choose or take a photo",
  "qr.scanLive": "Scan a QR code",
  "qr.decodeErrorNotFound": "Couldn't find a QR code in that image. Try a clearer, well-lit photo where the code fills more of the frame.",
  "qr.decodeErrorGeneric": "Couldn't read that image. Try a different photo.",
  "qr.hintPhotoText": "Got a regular photo instead of a QR code?",
  "qr.hintAudioText": "Got audio?",
  "qr.hintVideoText": "Got a video?",
  "qr.paymentBadge": "THIS IS A PAYMENT QR CODE",
  "qr.similarNameWarning": "⚠ SIMILAR NAME, DIFFERENT PAYMENT ID",
  "qr.similarNameCaution": "This name is very close to {name} (ID: {id}), which you've scanned before in Vuryfy — but this QR code uses a different payment ID. This is a common impersonation pattern. Vuryfy can't tell you which of the two is the real one — verify directly with who you intend to pay before proceeding.",
  "qr.paymentCaution": "Vuryfy can't verify who actually controls a payment ID from a QR code alone — that isn't something a web search can confirm. Before paying, make sure the name above matches who you intend to pay, and confirm directly with them if you're unsure.",
  "qr.investigateHint": "This searches the public web for the payee's name and ID — scam reports, complaints, or a legitimate business presence. It still can't confirm this transaction or who controls the ID; it can only tell you what's publicly findable, which may be nothing either way.",
  // Sept 23, 2026: originally a three-way choice for a UPI payee
  // investigation — plain Quick Check, Quick Check + Registered Name (its
  // own button, 2 credits), or Deep Investigation (which always included
  // the registered name at no extra cost). Each button on
  // app/verify/qr/page.tsx carries its own one-line caption
  // (qr.quickCheckCaption / qr.deepIncludesNameHint) stating exactly what
  // that option shows, replacing an earlier single lead-in sentence.
  //
  // Nov 27, 2026: the "Quick Check + Registered Name" button and its
  // qr.quickCheckWithNameLabel/qr.quickCheckWithNameCaption keys were
  // REMOVED (not just hidden) from here and from every other
  // translations-<code>.ts file — see app/verify/qr/page.tsx's own removal
  // comment and business-ops-2026-10-21.md for why: every vendor
  // researched for the real bank-verified registered-name lookup
  // (Decentro, Signzy, Cashfree) requires Vuryfy to be an RBI/SEBI-
  // regulated entity, which it isn't, so that 2-credit button was
  // charging users double credits for a lookup that could never resolve.
  // qr.deepIncludesNameHint was reworded the same day for the same reason
  // — it used to promise a registered name "at no extra cost" that was
  // equally never coming — in this file and all 7 other launch-language
  // files.
  "qr.quickCheckCaption": "Shows the payee name",
  "qr.deepIncludesNameHint": "Shows the payee name, with a deeper reputation search",
  // Sept 17, 2026: shown for a non-UPI payment link (paypal.me, etc. — no
  // payee name/ID to investigate), on the pre-choice screen that now
  // deliberately withholds identity until after Quick Check/Deep
  // Investigation is chosen. See qr.paymentBadge's usage in
  // app/verify/qr/page.tsx for the full rationale.
  "qr.paymentLinkHint": "This is a payment link. Vuryfy can't confirm who controls it or investigate it further — confirm directly with who you intend to pay before proceeding.",
  "qr.scanAnother": "Scan another",
  "qr.decodedBadge": "WE FOUND THIS IN YOUR QR CODE",
  "qr.decodedHint": "Quick Check gives a fast answer. Deep Investigation researches it more thoroughly and takes longer.",
  "image.eyebrow": "IMAGE",
  "image.heading": "Check a photo.",
  "image.sub": "Upload a photo. If it has readable text, we'll offer to check that. Either way, you can also have us look at the photo itself for signs of editing or AI generation.",
  "image.hintQrText": "Have a QR code instead?",
  "image.hintQrLink": "Scan it",
  "image.ocrFoundBadge": "WE FOUND TEXT IN THIS IMAGE",
  "image.ocrFoundHint": "We'll also look at the photo itself for signs of editing or AI generation — both checks run from the buttons below.",
  "image.analyzeBadge": "ANALYZE THE PHOTO ITSELF",
  "image.hintCombined": "Quick Check gives a fast answer for both. Deep Investigation researches more thoroughly and takes longer.",
  "image.hintVisionOnly": "We'll look at the image for signs of editing or AI generation — not a source-verified fact-check, just a visual read. Optionally tell us what this photo is supposed to show, and we'll note whether that looks visually consistent.",
  "image.contextPlaceholder": "What is this photo supposed to show? (optional)",
  "audio.eyebrow": "AUDIO",
  "audio.heading": "Check a recording.",
  "audio.sub": "Upload an audio file. If we can make out speech, we'll transcribe it so you can check what's said, and we'll also listen to the recording itself for signs of AI voice synthesis or splicing — both from the same check.",
  "audio.chooseFile": "Choose an audio file",
  "audio.processError": "Couldn't process that audio file. Try a different file.",
  "audio.hintPhotoText": "Got a photo instead?",
  "audio.hintVideoText": "Got a video instead?",
  "audio.transcriptHint": "We'll also listen to the recording itself for signs of AI voice synthesis or splicing.",
  "audio.combinedHint": "Quick Check gives a fast answer on both what's said and the recording itself. Deep Investigation researches more thoroughly and takes longer.",
  "audio.noSpeechBody": "We couldn't make out any spoken words in this recording — only the authenticity check below is available for it.",
  "audio.noSpeechHint": "We'll listen for signs of AI voice synthesis or splicing — not a source-verified fact-check, just a listen-through. Optionally tell us what this recording is supposed to be, and we'll note whether that sounds consistent.",
  "audio.contextPlaceholder": "What is this recording supposed to be? (optional)",
  "video.eyebrow": "VIDEO",
  "video.heading": "Check a video.",
  "video.sub": "Upload a video clip — up to 250MB, so several minutes of typical phone video. If we can make out speech, we'll transcribe it so you can check what's said, and we'll also watch the video itself for signs of deepfakes, face-swaps, or AI-generated footage — both from the same check.",
  "video.chooseVideo": "Choose a video",
  "video.processError": "Couldn't process that video file. Try a different file.",
  "video.hintAudioText": "Got audio instead?",
  "video.hintPhotoText": "Got a photo?",
  "video.transcriptHint": "We'll also watch the video itself for signs of deepfakes, face-swaps, or AI-generated footage.",
  "video.combinedHint": "Quick Check gives a fast answer on both what's said and the video itself. Deep Investigation researches more thoroughly and takes longer.",
  "video.noSpeechBody": "We couldn't make out any spoken words in this video — only the authenticity check below is available for it.",
  "video.noSpeechHint": "We'll watch for signs of deepfakes, face-swaps, or AI-generated footage — not a source-verified fact-check, just a watch-through. Optionally tell us what this video is supposed to show, and we'll note whether that sounds consistent.",
  "video.contextPlaceholder": "What is this video supposed to show? (optional)",
  // Verdict-word display labels — Sept 16, 2026, added after the user
  // pointed out that a Hindi-only reader can localize every surrounding
  // word but still can't tell what the verdict actually SAYS if the
  // verdict word itself ("Unverified", "Clean", etc.) stays in English —
  // for someone who reads no English at all, that's the one word that
  // matters most. These are DISPLAY-ONLY labels, looked up via
  // translateVerdict() below at the point of rendering — the underlying
  // verdict strings returned by the pipelines (lib/quick-check.ts, lib/
  // deep-investigation.ts, lib/video-analysis.ts, lib/audio-analysis.ts,
  // lib/image-analysis.ts) are deliberately UNCHANGED and stay fixed
  // English enum values, since the result page and CSS style by exact
  // string match (e.g. r.verdict === "Scam") and every verdict-comparison
  // call site across the codebase would otherwise need to be touched for
  // a purely cosmetic gain. translateVerdict() falls back to the raw
  // string for anything not in this list, so an unrecognized verdict
  // value never disappears or crashes — it just renders untranslated.
  "verdict.True": "True",
  "verdict.False": "False",
  "verdict.Misleading": "Misleading",
  "verdict.Unverified": "Unverified",
  "verdict.Scam": "Scam",
  "verdict.Clean": "Clean",
  "verdict.Suspicious": "Suspicious",
  "verdict.Inconclusive": "Inconclusive",
  "verdict.OutOfContext": "Out of Context",

  // Nov 21, 2026 — Daily Check (see claude/architecture-decisions-
  // addendum-2026-11-21.md, "Daily Check", in the Vuryfy project notes).
  // Static chrome for the public /today/[slug] page; the headline/
  // summary/caveats content itself is per-entry data, not a translation
  // key — see lib/daily-check.ts.
  "dailyCheck.title": "Today's Check",
  "dailyCheck.claimLabel": "What was checked",
  "dailyCheck.caveatsHeading": "Worth knowing",
  "dailyCheck.sourcesHeading": "Sources",
  "dailyCheck.notFoundHeading": "Check not found",
  "dailyCheck.notFoundBody": "This link may have expired or the check isn't available anymore.",
  "dailyCheck.openApp": "Open Vuryfy",
  "dailyCheck.openAppPrompt": "Protect yourself from scams like this one — Free",
  "dailyCheck.shareWhatsapp": "Share on WhatsApp",

  // Nov 21, 2026: multilingual coverage for the SEBI check, digital-arrest
  // checklist, and the Settings trusted-contact panel — these three
  // shipped Nov 20, 2026 English-only (an explicitly flagged gap, see
  // claude/scam-feature-digital-arrest-2026-11-20.md and
  // claude/scam-feature-sebi-check-2026-11-20.md) and a user selecting
  // Hindi reported they were still showing English. "da." = digital-arrest,
  // "sebi." = the SEBI check page. {name}/{date}/{from}/{to}/{syncedSuffix}
  // are placeholders substituted in code via .replace(), same pattern as
  // the qr page's {name}/{id} payee warning.
  "scam.eyebrow": "SCAM PREVENTION",
  "nav.freeCredits": "Free — no credit used",
  "da.heading": "Is this call a scam?",
  "da.sub": "If someone on the phone or video is claiming to be police, CBI, customs, RBI, or a bank and pressuring you, answer these quickly — you don't need to finish the whole list.",
  "da.hint": "No Indian law-enforcement agency arrests, investigates, or collects a fine over a phone or video call. If you're not sure, hang up and verify in person.",
  "da.skipPrefix": "Already sure this is a scam?",
  "da.skipLink": "Skip straight to what to do",
  "da.yes": "Yes",
  "da.no": "No",
  "da.flag.stay_on_call.question": "Are they telling you to stay on this video/phone call, keep your camera on, or not hang up?",
  "da.flag.stay_on_call.reason": "No Indian law-enforcement agency keeps you on a call or video as part of a real investigation.",
  "da.flag.secrecy.question": "Have they told you not to tell your family, your bank, or a lawyer about this?",
  "da.flag.secrecy.reason": "A genuine case is never confidential from your own family or bank — that secrecy demand is a control tactic, not a legal requirement.",
  "da.flag.money_to_verify.question": "Have they asked you to transfer money, or pay a \"fine,\" to \"verify,\" \"secure,\" or \"release\" your funds?",
  "da.flag.money_to_verify.reason": "No agency asks for money to verify, secure, or release funds that are already yours. This is the single clearest tell there is.",
  "da.flag.fake_document.question": "Did they show you a warrant, FIR, or court order on screen or over WhatsApp/chat?",
  "da.flag.fake_document.reason": "Uniforms, badges, and documents shown over video or chat are easy to fake and aren't how real legal notices are served.",
  "da.flag.callback_number.question": "Did they ask you to call them back on a number they gave you, instead of one you looked up yourself?",
  "da.flag.callback_number.reason": "Always call an agency back on its own published number — never one the caller hands you.",
  "da.flag.cold_open.question": "Did the call start about a parcel, your Aadhaar, a bank account, or a relative in trouble — from someone you didn't contact first?",
  "da.flag.cold_open.reason": "This is the standard opening line for this scam, designed to create instant panic before the other tactics kick in.",
  "da.warningLabel": "This matches the digital arrest / scary-call scam pattern",
  "da.warningMatched": "No Indian agency does what you just described. Hang up now — you can't be arrested, fined, or investigated over a call, and nobody genuine will ask you to stay on one.",
  "da.warningSkip": "If anyone is pressuring you for money, secrecy, or to stay on a call, treat it as a scam. Hang up — you can always call a real agency back yourself to check.",
  "da.call1930": "Call 1930 (national cybercrime helpline)",
  "da.reportCybercrime": "Report at cybercrime.gov.in",
  "da.reportChakshu": "Report this number (Chakshu)",
  "da.tellSomeone": "Tell someone right now",
  "da.messageContact": "Message {name} on WhatsApp",
  "da.textContact": "Text {name} instead",
  "da.yourContact": "your contact",
  "da.noContactText": "You haven't set up a trusted contact yet.",
  "da.noContactLink": "Add one in Settings",
  "da.noContactSuffix": "so you can alert them in one tap next time.",
  "da.calmBadge": "NO CLASSIC WARNING SIGNS MATCHED",
  "da.calmHeading": "Still, stay cautious",
  "da.calmBody": "None of the usual tells matched what you described. That's reassuring, but it doesn't guarantee the call is genuine — if anything about it still feels off, you can always hang up and call the agency back yourself on a number you look up independently, not one given to you on the call.",
  "sebi.heading": "Is this entity SEBI-registered?",
  "sebi.sub": "Before trusting a stock tip, trading group, or entity claiming to be SEBI-registered, check whether their name or registration number actually appears in SEBI's own public records.",
  "sebi.placeholder": "Name, or registration number (e.g. INA000017523 or IN-DP-870-2026)…",
  "sebi.checkButton": "Check",
  "sebi.notFound": "NOT FOUND",
  "sebi.noMatchHeading": "No match in SEBI's records",
  "sebi.noMatchBody": "This name or registration number doesn't appear in our copy of SEBI's registry{syncedSuffix}. This does NOT by itself confirm a scam — our data could be out of date, or the name could be spelled differently from what you entered — but a genuinely SEBI-registered entity should appear here. If you're unsure, verify directly on SEBI's own site before trusting anyone claiming this credential.",
  "sebi.lastSyncedSuffix": " (last synced {date})",
  "sebi.notSyncedHint": "Our SEBI registry hasn't finished its first sync yet — results may be incomplete right now.",
  "sebi.registered": "REGISTERED WITH SEBI",
  "sebi.lapsed": "REGISTRATION LAPSED/CANCELLED",
  "sebi.activeSince": "Active since {date}",
  "sebi.validFromUntil": "Was valid from {from} until {to}",
  "sebi.unspecifiedDate": "an unspecified date",
  "sebi.registeredCaution": "This confirms the registration itself is genuine. It does NOT confirm that the specific person or channel who contacted you is actually authorized to represent this registered entity — fraudsters sometimes cite a real entity's name or number while impersonating them. If anything about the contact feels off, verify directly with the firm through a channel you trust.",
  "sebi.lastSyncedHint": "SEBI registry last synced {date}.",

  // "breach." = the email/password breach-check page (Nov 24, 2026). See
  // lib/breach-check.ts's header for the data source and rationale.
  "breach.heading": "Has your email or password been hacked or leaked?",
  "breach.sub": "Check whether an email address — or a password you use — has shown up in a publicly known data breach, so you know exactly which account to secure.",
  "breach.emailHeading": "Check an email address",
  "breach.emailPlaceholder": "you@example.com",
  "breach.emailCheckButton": "Check email",
  "breach.emailFoundHeading": "Found in known data breaches",
  "breach.emailFoundCount": "This email appears in {count} known breach(es).",
  "breach.emailExposedLabel": "Exposed:",
  "breach.emailRemediation": "Change your password on this service, and turn on two-factor authentication if it offers it.",
  "breach.emailNotFoundHeading": "No known breaches found",
  "breach.emailNotFoundBody": "This email address doesn't appear in any publicly known data breach we checked. That's good news — though it doesn't guarantee it never will.",
  "breach.passwordHeading": "Check a password",
  "breach.passwordSub": "Your password is never sent or stored — only a scrambled fragment of it is checked.",
  "breach.passwordPlaceholder": "Enter a password to check",
  "breach.passwordCheckButton": "Check password",
  "breach.passwordFoundHeading": "This password has been seen in known data breaches",
  "breach.passwordFoundBody": "Passwords that show up in breach data are the first ones attackers try. If you use this password anywhere, change it — especially anywhere you haven't already made it unique.",
  "breach.passwordNotFoundHeading": "Not found in known breach data",
  "breach.passwordNotFoundBody": "This exact password doesn't appear in the breach data we checked. That's a good sign, but not a guarantee — a unique password for every account is still the safest habit.",
  "breach.unavailable": "Breach check is temporarily unavailable — please try again shortly.",
  "breach.caution": "This only covers breaches that are publicly known and included in our data source. It can't see a breach that hasn't been discovered or published yet, and it never means Vuryfy itself was breached.",
  "settings.trustedContactHeading": "Trusted contact for Scam SOS",
  "settings.trustedContactSub": "If you're ever on a scary call pressuring you for money or secrecy, the digital-arrest check can message this person in one tap. Set it up now, not mid-call.",
  "settings.trustedContactNamePlaceholder": "Name (e.g. a family member or close friend)",
  "settings.trustedContactPhonePlaceholder": "Their phone number (e.g. 98XXXXXXXX)",
  "settings.saveContact": "Save contact",
  "settings.trustedContactSavedHint": "Saved — you can clear both fields and save again to remove it.",
};

const hi: Dictionary = {
  "home.eyebrow": "वुर्यफाई",
  "home.heading": "आप क्या सत्यापित करना चाहते हैं?",
  "home.sub": "आप जो सत्यापित करना चाहते हैं उसे चुनें, फिर तुरंत जवाब के लिए क्विक चेक या अधिक गहन जांच के लिए डीप इन्वेस्टिगेशन चुनें।",
  "home.verifyText": "टेक्स्ट सत्यापित करें",
  "home.verifyUrl": "URL/दावे सत्यापित करें",
  "home.verifyQr": "QR कोड सत्यापित करें",
  "home.verifyPhoto": "फ़ोटो/इमेज सत्यापित करें",
  "home.verifyAudio": "ऑडियो सत्यापित करें",
  "home.verifyVideo": "वीडियो सत्यापित करें",
  "home.verifyBreachCheck": "डेटा लीक की जांच करें",
  "home.verifySebi": "सेबी पंजीकरण सत्यापित करें",
  "home.verifyDigitalArrest": "स्कैम कॉल जांच",
  "home.free": "फ़्री",
  "home.quickChecks": "क्विक चेक",
  "home.deepInvestigations": "डीप इन्वेस्टिगेशन",
  "home.settings": "सेटिंग्स",
  "home.signOut": "साइन आउट",
  "home.noPlan": "आपके पास अभी कोई सक्रिय प्लान नहीं है।",
  "home.subEnding": "आपकी सदस्यता वर्तमान भुगतान अवधि के अंत में समाप्त होने वाली है।",
  "landing.eyebrow": "जो मायने रखता है उसे सत्यापित करें",
  "landing.heading": "जानें किस पर भरोसा करें",
  "landing.sub": "व्याख्या योग्य AI-संचालित सत्यापन के साथ दावों और जानकारी की जांच करें।",
  "landing.cta": "साइन इन या साइन अप करें",
  "landing.signIn": "साइन इन करें",
  "landing.signUp": "साइन अप करें",
  "landing.hint": "वुर्यफाई में नए हैं? अगली स्क्रीन पर अपना फ़ोन नंबर डालें — आपका खाता अपने आप बन जाएगा, अलग साइन-अप की ज़रूरत नहीं।",
  "login.eyebrowStart": "शुरू करें",
  "login.eyebrowSignin": "वापसी पर स्वागत है",
  "login.eyebrowCode": "स्वागत है",
  "login.headingStart": "साइन इन या साइन अप करें।",
  "login.headingSignin": "साइन इन करें।",
  "login.headingSignup": "साइन अप करें।",
  "login.headingCode": "अपना कोड डालें।",
  "login.subStart": "अपना फ़ोन नंबर इस्तेमाल करें। पासवर्ड की ज़रूरत नहीं।",
  "login.subSignin": "अपना फ़ोन नंबर इस्तेमाल करें। पासवर्ड की ज़रूरत नहीं।",
  "login.subSignup": "अपना फ़ोन नंबर डालें — आपका खाता अपने आप बन जाएगा, पासवर्ड की ज़रूरत नहीं।",
  "login.subCode": "आपके फ़ोन पर भेजा गया वन-टाइम कोड डालें।",
  "login.phonePlaceholder": "फ़ोन नंबर",
  "login.continue": "जारी रखें",
  "login.sending": "भेजा जा रहा है…",
  "login.otpPlaceholder": "6-अंकों का OTP",
  "login.verify": "सत्यापित करें और जारी रखें",
  "login.verifying": "सत्यापित हो रहा है…",
  "login.useAnotherNumber": "दूसरा नंबर इस्तेमाल करें",
  "language.eyebrow": "आखिरी कदम",
  "language.heading": "अपनी भाषा चुनें।",
  "language.sub": "वुर्यफाई अपनी स्क्रीन और सत्यापन परिणाम इसी भाषा में दिखाएगा। आप इसे कभी भी सेटिंग्स से बदल सकते हैं।",
  "language.continue": "जारी रखें",
  "language.saving": "सहेजा जा रहा है…",
  "claim.textEyebrow": "टेक्स्ट सत्यापित करें",
  "claim.textHeading": "हमें क्या सत्यापित करना चाहिए?",
  "claim.textSub": "कोई दावा या कथन पेस्ट करें, फिर तुरंत जवाब के लिए क्विक चेक या अधिक गहन जांच के लिए डीप इन्वेस्टिगेशन चुनें।",
  "claim.textPlaceholder": "कोई दावा या कथन पेस्ट करें…",
  "claim.urlEyebrow": "URL/दावे सत्यापित करें",
  "claim.urlHeading": "हमें कौन-सा लिंक या दावा सत्यापित करना चाहिए?",
  "claim.urlSub": "कोई URL, या उसके बारे में कोई दावा पेस्ट करें, फिर तुरंत जवाब के लिए क्विक चेक या अधिक गहन जांच के लिए डीप इन्वेस्टिगेशन चुनें।",
  "claim.urlPlaceholder": "कोई URL, लिंक, या दावा पेस्ट करें…",
  "claim.deepInvestigation": "डीप इन्वेस्टिगेशन",
  "claim.investigating": "जांच जारी है…",
  "claim.quickCheck": "क्विक चेक",
  "claim.checking": "जांचा जा रहा है…",
  "claim.minLengthHint": "जांच चलाने के लिए कम से कम 5 अक्षर दर्ज करें।",
  "claim.hintQrText": "इसके बजाय QR कोड है?",
  "claim.hintQrLink": "स्कैन करें",
  "claim.hintPhotoText": "कोई फ़ोटो है?",
  "claim.hintPhotoLink": "जांचें",
  "claim.hintAudioText": "कोई ऑडियो है?",
  "claim.hintAudioLink": "जांचें",
  "claim.hintVideoText": "कोई वीडियो है?",
  "claim.hintVideoLink": "जांचें",
  "settings.eyebrow": "सेटिंग्स",
  "settings.heading": "सेटिंग्स।",
  "settings.languageLabel": "भाषा",
  "settings.languageSub": "वुर्यफाई अपनी स्क्रीन और सत्यापन परिणामों के लिए जो भाषा इस्तेमाल करे, वह चुनें।",
  "settings.save": "सहेजें",
  "settings.saving": "सहेजा जा रहा है…",
  "settings.saved": "सहेज लिया गया।",
  "settings.moreComingSoon": "क्रेडिट और सब्सक्रिप्शन सेटिंग्स जल्द ही यहां आ रही हैं।",
  "nav.back": "← वापस",
  "nav.credits": "क्रेडिट",
  "pipeline.noEvidenceQuick": "इस दावे की जांच के लिए कोई सबूत नहीं मिला। इसे दोबारा लिखने या अधिक विशेष जानकारी जोड़ने की कोशिश करें।",
  "pipeline.noEvidenceDeep": "इस जांच ने जिन भी पहलुओं को देखा, उनमें से किसी में भी कोई सबूत नहीं मिला। दावे को दोबारा लिखने या अधिक विशेष जानकारी जोड़ने की कोशिश करें।",
  "pipeline.common.observedPrefix": "देखा गया: ",
  "pipeline.common.noSignalsDescribed": "कोई विशेष संकेत नहीं बताया गया।",
  "pipeline.common.noExplanation": "कोई स्पष्टीकरण नहीं मिला।",
  "pipeline.video.summaryPrefix": "छेड़छाड़/AI-जनित:",
  "pipeline.video.aiLikely": "संभवतः छेड़छाड़ की गई या AI-जनित",
  "pipeline.video.aiUnlikely": "छेड़छाड़ या AI-जनित होने की संभावना नहीं",
  "pipeline.video.aiUncertain": "यह छेड़छाड़ की गई है या AI-जनित है, यह अनिश्चित है",
  "pipeline.video.disclaimer": "यह मुख्य रूप से वीडियो के दृश्य और ऑडियो का विश्लेषण है — वुर्यफाई के पास यह स्वतंत्र रूप से पुष्टि करने का कोई तरीका नहीं है कि इसे किसने, कब या कहाँ फिल्माया। डीपफेक और AI वीडियो जनरेशन टूल लगातार बेहतर हो रहे हैं, और एक बढ़िया नकली वीडियो बारीकी से देखने पर भी असली लग सकता है।",
  "pipeline.video.caveatFace": "बेहतरीन डीपफेक/फेस-स्वैप टूल एक सामान्य नज़र में असली दिखने के लिए ही बनाए जाते हैं, जिसमें मेल खाती लाइटिंग और स्वाभाविक पलकें झपकाना शामिल है — यहाँ \"संभावना नहीं\"/\"अनिश्चित\" का मतलब है कि कोई असंगति नहीं मिली, न कि यह कि चेहरा असली होने की पुष्टि हो गई।",
  "pipeline.video.caveatNoFace": "बेहतरीन AI वीडियो जनरेटर (Sora, Runway, Kling, Veo, और इसी तरह के) भौतिक यथार्थता में तेज़ी से बेहतर हो रहे हैं — यहाँ \"संभावना नहीं\"/\"अनिश्चित\" का मतलब है कि कोई असंगति नहीं मिली, न कि यह कि फुटेज असली कैमरा फुटेज होने की पुष्टि हो गई।",
  "pipeline.video.contextInconsistent": "बताया गया संदर्भ वीडियो में दिखाए गए दृश्य से मेल नहीं खाता।",
  "pipeline.video.contextConsistent": "जो दिखाया गया है वह बताए गए संदर्भ के साथ कम से कम प्रशंसनीय है, हालांकि यह अभी भी केवल एक नज़र है, पुष्टि किया गया मेल नहीं।",
  "pipeline.audio.summaryPrefix": "AI-जनित:",
  "pipeline.audio.aiLikely": "संभवतः AI-जनित",
  "pipeline.audio.aiUnlikely": "AI-जनित होने की संभावना नहीं",
  "pipeline.audio.aiUncertain": "यह AI-जनित है या नहीं, यह अनिश्चित है",
  "pipeline.audio.disclaimer": "यह मुख्य रूप से रिकॉर्डिंग की ऑडियो जांच है — वुर्यफाई के पास यह स्वतंत्र रूप से पुष्टि करने का कोई तरीका नहीं है कि इसे किसने, कब या कहाँ रिकॉर्ड किया।",
  "pipeline.audio.caveatSpeech": "बेहतरीन AI वॉइस-क्लोनिंग टूल (ElevenLabs और इसी तरह के) असली आवाज़ जैसी ही, सांस लेने की आवाज़ सहित, सुनाई देने के लिए बनाए जाते हैं — इस तरह की सुनवाई उनमें से सबसे बेहतरीन को भरोसे के साथ नहीं पकड़ सकती, इसलिए यहाँ \"संभावना नहीं\"/\"अनिश्चित\" का मतलब है कि रिकॉर्डिंग-माहौल का कोई सबूत नहीं मिला, न कि यह कि आवाज़ इंसानी होने की पुष्टि हो गई।",
  "pipeline.audio.contextInconsistent": "बताया गया संदर्भ रिकॉर्डिंग में सुनाई देने वाली चीज़ से मेल नहीं खाता।",
  "pipeline.audio.contextConsistent": "जो सुनाई देता है वह बताए गए संदर्भ के साथ कम से कम प्रशंसनीय है, हालांकि यह अभी भी केवल एक सुनवाई है, पुष्टि किया गया मेल नहीं।",
  "pipeline.image.disclaimer": "यह मुख्य रूप से इमेज की दृश्य जांच है — वुर्यफाई के पास यह स्वतंत्र रूप से पुष्टि करने का कोई तरीका नहीं है कि यह फ़ोटो किसने, कब या कहाँ ली, नीचे बताए गए किसी भी वेब पेज की जानकारी से आगे।",
  "pipeline.image.contextInconsistent": "बताया गया संदर्भ इमेज में दिखाए गए दृश्य से मेल नहीं खाता।",
  "pipeline.image.contextConsistent": "इमेज में जो दिखाई देता है वह बताए गए संदर्भ के साथ कम से कम प्रशंसनीय है, हालांकि यह अभी भी केवल एक दृश्य जांच है, पुष्टि किया गया मेल नहीं।",
  "nav.newCheck": "← नई जांच",
  "nav.creditsPrefix": "क्रेडिट · ",
  "status.reading": "पढ़ा जा रहा है…",
  "status.processing": "प्रोसेस हो रहा है…",
  "status.transcribing": "ट्रांसक्रिप्ट बनाया जा रहा है…",
  "status.uploading": "अपलोड हो रहा है…",
  "transcript.badge": "ट्रांसक्रिप्ट (ज़रूरत हो तो बदलें)",
  "noSpeech.badge": "कोई आवाज़ नहीं मिली",
  "action.chooseAnother": "दूसरा चुनें",
  "hint.checkIt": "जांचें",
  "payee.unnamed": "अनाम प्राप्तकर्ता",
  "payee.investigateEyebrow": "इस प्राप्तकर्ता की जांच करें",
  "payee.disclaimer":
    "यह इस प्राप्तकर्ता के बारे में रिपोर्ट के लिए सार्वजनिक वेब पर खोज करता है — यह पुष्टि नहीं कर सकता कि पेमेंट ID पर वास्तव में किसका नियंत्रण है, और कुछ न मिलने का मतलब यह नहीं कि वे वैध हैं। ज़्यादातर असली व्यवसायों और ज़्यादातर धोखेबाज़ों, दोनों का अक्सर वेब पर बहुत कम या कोई खोजने योग्य निशान नहीं होता।",
  "result.payeeBadge": "प्राप्तकर्ता",
  "result.payeeClear": "इस प्राप्तकर्ता के लिए कोई सार्वजनिक धोखाधड़ी रिपोर्ट नहीं मिली।",
  "result.registeredNameLabel": "पंजीकृत नाम: ",
  "result.registeredNameMismatch":
    "यह QR कोड पर दिखाए गए नाम से मेल नहीं खाता — आगे बढ़ने से पहले जिसे आप भुगतान करना चाहते हैं, उससे सीधे पुष्टि करें।",
  "result.receiptEyebrow": "भुगतान रसीद",
  "result.receiptBadge": "यह एक भुगतान रसीद लगती है",
  "result.receiptAmountUnclear": "राशि स्पष्ट रूप से पढ़ी नहीं जा सकी",
  "result.receiptFrom": "किससे: ",
  "result.receiptTo": "किसे: ",
  "result.receiptVia": "ज़रिए: ",
  "result.receiptTxnId": "लेन-देन ID: ",
  "result.receiptDate": "तारीख: ",
  "result.receiptCaution": "वुर्यफाई यह पुष्टि नहीं कर सकता कि इस तरह का निजी भुगतान वाकई हुआ — बैंक/UPI ट्रांसफर का कोई सार्वजनिक रिकॉर्ड नहीं होता जिसे खोजकर जांचा जा सके, इसलिए हम इसे किसी सार्वजनिक दावे की तरह वेरिफाइड/अनवेरिफाइड स्कोर नहीं दे सकते। इस तरह की रसीदें और स्क्रीनशॉट आसानी से उपलब्ध ऐप्स से नकली भी बनाए जा सकते हैं, भले ही वे पूरी तरह असली लगें। इस पर भरोसा करने से पहले असली क्रेडिट के लिए अपने बैंक या UPI ऐप में खुद जांच करना ही सुनिश्चित होने का एकमात्र तरीका है। इस जांच के लिए कोई क्रेडिट नहीं लिया गया।",
  "result.whatWeRead": "हमने क्या पढ़ा",
  "result.checkAnother": "दूसरा जांचें",
  "result.requestEyebrow": "भुगतान अनुरोध / QR कोड",
  "result.requestBadge": "यह एक \"स्कैन करके भुगतान करें\" कार्ड लगता है",
  "result.requestCaution": "वुर्यफाई यह पुष्टि नहीं कर सकता कि इस तरह के भुगतान ID को वाकई कौन नियंत्रित करता है — यह कोई वेब सर्च से पता नहीं चलता, चाहे यह स्कैन करने योग्य QR कोड के रूप में आए या उसके स्क्रीनशॉट के रूप में। भुगतान करने से पहले सुनिश्चित करें कि ऊपर दिया गया नाम उस व्यक्ति से मेल खाता है जिसे आप भुगतान करना चाहते हैं, और अगर अनिश्चित हों तो सीधे उनसे पुष्टि करें। इस जांच के लिए कोई क्रेडिट नहीं लिया गया।",
  "result.investigateHint": "यह प्राप्तकर्ता के नाम और ID के लिए सार्वजनिक वेब पर खोज करता है — धोखाधड़ी की रिपोर्ट, शिकायतें, या किसी वैध व्यवसाय की मौजूदगी। यह अब भी यह पुष्टि नहीं कर सकता कि ID को कौन नियंत्रित करता है; यह केवल वही बता सकता है जो सार्वजनिक रूप से मिल सकता है, जो दोनों ही तरह से कुछ न भी हो सकता है।",
  "result.deepResultEyebrow": "डीप इन्वेस्टिगेशन परिणाम",
  "result.quickResultEyebrow": "क्विक चेक परिणाम",
  "result.scamWarning": "⚠ धोखाधड़ी की चेतावनी",
  "result.confidencePrefix": "विश्वास · ",
  "result.scamCaution": "मिले सबूतों के आधार पर इसे धोखाधड़ी के रूप में चिह्नित किया गया है — इस पर क्लिक न करें, भुगतान न करें, या इसके साथ व्यक्तिगत जानकारी साझा न करें। हमें जो मिला उसके लिए नीचे सबूत देखें।",
  "result.claimLabel": "दावा",
  "result.whyLabel": "क्यों",
  "result.evidenceLabel": "सबूत",
  "result.notesLabel": "नोट्स",
  "result.shareResult": "परिणाम कॉपी करें",
  "result.copied": "क्लिपबोर्ड पर कॉपी हो गया।",
  "result.copyFailed": "कॉपी नहीं हो सका — कृपया टेक्स्ट को स्वयं चुनकर कॉपी करें।",
  "result.verifyAnother": "दूसरा सत्यापित करें",
  "qr.eyebrow": "QR कोड",
  "qr.heading": "QR कोड स्कैन करें।",
  "qr.sub": "QR कोड की फ़ोटो अपलोड करें और यह किस ओर इशारा करता है उसके लिए क्विक चेक या डीप इन्वेस्टिगेशन चुनें। केवल कोड के अंदर का टेक्स्ट हमें भेजा जाता है — फ़ोटो खुद आपकी डिवाइस से कभी बाहर नहीं जाती।",
  "qr.choosePhoto": "फ़ोटो चुनें या लें",
  "qr.scanLive": "QR कोड स्कैन करें",
  "qr.decodeErrorNotFound": "उस इमेज में कोई QR कोड नहीं मिला। ज़्यादा साफ़, अच्छी रोशनी वाली फ़ोटो आज़माएं जिसमें कोड फ्रेम का ज़्यादा हिस्सा भरता हो।",
  "qr.decodeErrorGeneric": "वह इमेज नहीं पढ़ी जा सकी। कोई दूसरी फ़ोटो आज़माएं।",
  "qr.hintPhotoText": "QR कोड की जगह सामान्य फ़ोटो है?",
  "qr.hintAudioText": "कोई ऑडियो है?",
  "qr.hintVideoText": "कोई वीडियो है?",
  "qr.paymentBadge": "यह एक भुगतान QR कोड है",
  "qr.similarNameWarning": "⚠ मिलता-जुलता नाम, अलग भुगतान ID",
  "qr.similarNameCaution": "यह नाम {name} (ID: {id}) से काफी मिलता-जुलता है, जिसे आपने पहले वुर्यफाई में स्कैन किया था — लेकिन इस QR कोड का भुगतान ID अलग है। यह एक आम प्रतिरूपण पैटर्न है। वुर्यफाई यह नहीं बता सकता कि इनमें से कौन-सा असली है — भुगतान करने से पहले जिसे आप भुगतान करना चाहते हैं, उससे सीधे पुष्टि करें।",
  "qr.paymentCaution": "वुर्यफाई यह पुष्टि नहीं कर सकता कि QR कोड से भुगतान ID को वाकई कौन नियंत्रित करता है — यह कोई वेब सर्च से पता नहीं चलता। भुगतान करने से पहले सुनिश्चित करें कि ऊपर दिया गया नाम उस व्यक्ति से मेल खाता है जिसे आप भुगतान करना चाहते हैं, और अगर अनिश्चित हों तो सीधे उनसे पुष्टि करें।",
  "qr.investigateHint": "यह प्राप्तकर्ता के नाम और ID के लिए सार्वजनिक वेब पर खोज करता है — धोखाधड़ी की रिपोर्ट, शिकायतें, या किसी वैध व्यवसाय की मौजूदगी। यह अब भी इस लेन-देन या यह ID किसे नियंत्रित करता है, इसकी पुष्टि नहीं कर सकता; यह केवल वही बता सकता है जो सार्वजनिक रूप से मिल सकता है, जो दोनों ही तरह से कुछ न भी हो सकता है।",
  // Nov 27, 2026: "qr.quickCheckWithNameLabel"/"qr.quickCheckWithNameCaption"
  // removed — see lib/translations.ts's English `en` section above for the
  // full rationale (the registered-name lookup those powered can never
  // resolve for Vuryfy right now). qr.deepIncludesNameHint reworded for the
  // same reason, same day.
  "qr.quickCheckCaption": "प्राप्तकर्ता का नाम दिखाता है",
  "qr.deepIncludesNameHint": "प्राप्तकर्ता का नाम + अधिक गहन प्रतिष्ठा खोज दिखाता है",
  "qr.paymentLinkHint": "यह एक भुगतान लिंक है। वुर्यफाई यह पुष्टि नहीं कर सकता कि इसे कौन नियंत्रित करता है, और न ही इसकी आगे जांच कर सकता है — आगे बढ़ने से पहले जिसे आप भुगतान करना चाहते हैं, उससे सीधे पुष्टि करें।",
  "qr.scanAnother": "दूसरा स्कैन करें",
  "qr.decodedBadge": "हमें आपके QR कोड में यह मिला",
  "qr.decodedHint": "क्विक चेक तुरंत जवाब देता है। डीप इन्वेस्टिगेशन अधिक गहराई से जांच करता है और समय लेता है।",
  "image.eyebrow": "इमेज",
  "image.heading": "फ़ोटो जांचें।",
  "image.sub": "फ़ोटो अपलोड करें। अगर उसमें पढ़ने योग्य टेक्स्ट है, तो हम उसे जांचने का विकल्प देंगे। किसी भी तरह, हम फ़ोटो को एडिटिंग या AI जनरेशन के संकेतों के लिए भी देख सकते हैं।",
  "image.hintQrText": "इसके बजाय QR कोड है?",
  "image.hintQrLink": "स्कैन करें",
  "image.ocrFoundBadge": "हमें इस इमेज में टेक्स्ट मिला",
  "image.ocrFoundHint": "हम फ़ोटो को एडिटिंग या AI जनरेशन के संकेतों के लिए भी देखेंगे — दोनों जांच नीचे दिए गए बटनों से चलती हैं।",
  "image.analyzeBadge": "फ़ोटो का ही विश्लेषण करें",
  "image.hintCombined": "क्विक चेक दोनों के लिए तुरंत जवाब देता है। डीप इन्वेस्टिगेशन अधिक गहराई से जांच करता है और समय लेता है।",
  "image.hintVisionOnly": "हम इमेज को एडिटिंग या AI जनरेशन के संकेतों के लिए देखेंगे — यह स्रोत-सत्यापित फैक्ट-चेक नहीं, बस एक दृश्य जांच है। चाहें तो बताएं कि यह फ़ोटो क्या दिखाने वाली है, और हम बताएंगे कि क्या यह दृश्य रूप से उससे मेल खाती है।",
  "image.contextPlaceholder": "यह फ़ोटो क्या दिखाने वाली है? (वैकल्पिक)",
  "audio.eyebrow": "ऑडियो",
  "audio.heading": "रिकॉर्डिंग जांचें।",
  "audio.sub": "ऑडियो फ़ाइल अपलोड करें। अगर हम आवाज़ समझ पाते हैं, तो हम उसे ट्रांसक्राइब करेंगे ताकि आप कही गई बात जांच सकें, और हम रिकॉर्डिंग को AI आवाज़ जनरेशन या जोड़-तोड़ के संकेतों के लिए भी सुनेंगे — दोनों एक ही जांच से।",
  "audio.chooseFile": "ऑडियो फ़ाइल चुनें",
  "audio.processError": "वह ऑडियो फ़ाइल प्रोसेस नहीं हो सकी। कोई दूसरी फ़ाइल आज़माएं।",
  "audio.hintPhotoText": "इसके बजाय कोई फ़ोटो है?",
  "audio.hintVideoText": "इसके बजाय कोई वीडियो है?",
  "audio.transcriptHint": "हम रिकॉर्डिंग में AI आवाज़ जनरेशन या जोड़-तोड़ के संकेत भी सुनेंगे।",
  "audio.combinedHint": "क्विक चेक कही गई बात और रिकॉर्डिंग दोनों पर तुरंत जवाब देता है। डीप इन्वेस्टिगेशन अधिक गहराई से जांच करता है और समय लेता है।",
  "audio.noSpeechBody": "हम इस रिकॉर्डिंग में कोई बोले गए शब्द नहीं समझ पाए — इसके लिए केवल नीचे दी गई प्रामाणिकता जांच उपलब्ध है।",
  "audio.noSpeechHint": "हम AI आवाज़ जनरेशन या जोड़-तोड़ के संकेतों के लिए सुनेंगे — यह स्रोत-सत्यापित फैक्ट-चेक नहीं, बस एक श्रवण जांच है। चाहें तो बताएं कि यह रिकॉर्डिंग क्या होनी चाहिए, और हम बताएंगे कि क्या यह उससे मेल खाती लगती है।",
  "audio.contextPlaceholder": "यह रिकॉर्डिंग क्या होनी चाहिए? (वैकल्पिक)",
  "video.eyebrow": "वीडियो",
  "video.heading": "वीडियो जांचें।",
  "video.sub": "वीडियो क्लिप अपलोड करें — 250MB तक, यानी सामान्य फ़ोन वीडियो के कई मिनट। अगर हम आवाज़ समझ पाते हैं, तो हम उसे ट्रांसक्राइब करेंगे ताकि आप कही गई बात जांच सकें, और हम वीडियो को डीपफेक, फेस-स्वैप, या AI-जनित फुटेज के संकेतों के लिए भी देखेंगे — दोनों एक ही जांच से।",
  "video.chooseVideo": "वीडियो चुनें",
  "video.processError": "वह वीडियो फ़ाइल प्रोसेस नहीं हो सकी। कोई दूसरी फ़ाइल आज़माएं।",
  "video.hintAudioText": "इसके बजाय कोई ऑडियो है?",
  "video.hintPhotoText": "कोई फ़ोटो है?",
  "video.transcriptHint": "हम वीडियो में डीपफेक, फेस-स्वैप, या AI-जनित फुटेज के संकेत भी देखेंगे।",
  "video.combinedHint": "क्विक चेक कही गई बात और वीडियो दोनों पर तुरंत जवाब देता है। डीप इन्वेस्टिगेशन अधिक गहराई से जांच करता है और समय लेता है।",
  "video.noSpeechBody": "हम इस वीडियो में कोई बोले गए शब्द नहीं समझ पाए — इसके लिए केवल नीचे दी गई प्रामाणिकता जांच उपलब्ध है।",
  "video.noSpeechHint": "हम डीपफेक, फेस-स्वैप, या AI-जनित फुटेज के संकेतों के लिए देखेंगे — यह स्रोत-सत्यापित फैक्ट-चेक नहीं, बस एक दृश्य जांच है। चाहें तो बताएं कि यह वीडियो क्या दिखाने वाला है, और हम बताएंगे कि क्या यह उससे मेल खाता लगता है।",
  "video.contextPlaceholder": "यह वीडियो क्या दिखाने वाला है? (वैकल्पिक)",
  "result.eyebrowPhoto": "फ़ोटो के बारे में",
  "result.eyebrowVideo": "वीडियो के बारे में",
  "result.eyebrowRecording": "रिकॉर्डिंग के बारे में",
  "verdict.True": "सही",
  "verdict.False": "गलत",
  "verdict.Misleading": "भ्रामक",
  "verdict.Unverified": "असत्यापित",
  "verdict.Scam": "धोखाधड़ी",
  "verdict.Clean": "स्वच्छ",
  "verdict.Suspicious": "संदिग्ध",
  "verdict.Inconclusive": "अनिर्णायक",
  "verdict.OutOfContext": "संदर्भ से बाहर",

  // Nov 21, 2026 — Daily Check. See the matching comment in `en` above.
  "dailyCheck.title": "आज की जांच",
  "dailyCheck.claimLabel": "क्या जांचा गया",
  "dailyCheck.caveatsHeading": "जानने योग्य बातें",
  "dailyCheck.sourcesHeading": "स्रोत",
  "dailyCheck.notFoundHeading": "जांच नहीं मिली",
  "dailyCheck.notFoundBody": "यह लिंक समाप्त हो गया हो सकता है या यह जांच अब उपलब्ध नहीं है।",
  "dailyCheck.openApp": "वुर्यफाई खोलें",
  "dailyCheck.openAppPrompt": "इस जैसे घोटालों से खुद को बचाएं — मुफ़्त में",
  "dailyCheck.shareWhatsapp": "व्हाट्सएप पर शेयर करें",

  // Nov 21, 2026 — see the matching comment in `en` above.
  "scam.eyebrow": "धोखाधड़ी से बचाव",
  "nav.freeCredits": "फ़्री — कोई क्रेडिट इस्तेमाल नहीं हुआ",
  "da.heading": "क्या यह कॉल धोखाधड़ी है?",
  "da.sub": "अगर फ़ोन या वीडियो पर कोई खुद को पुलिस, सीबीआई, कस्टम्स, आरबीआई या बैंक बताकर आप पर दबाव बना रहा है, तो इन सवालों के जवाब जल्दी दें — पूरी सूची खत्म करना ज़रूरी नहीं है।",
  "da.hint": "कोई भी भारतीय कानून-प्रवर्तन एजेंसी फ़ोन या वीडियो कॉल पर गिरफ़्तार नहीं करती, जांच नहीं करती, या जुर्माना नहीं वसूलती। अगर यकीन न हो, तो कॉल काटें और खुद जाकर पुष्टि करें।",
  "da.skipPrefix": "पहले से यकीन है कि यह धोखाधड़ी है?",
  "da.skipLink": "सीधे बताएं क्या करना है",
  "da.yes": "हां",
  "da.no": "नहीं",
  "da.flag.stay_on_call.question": "क्या वे आपसे इस वीडियो/फ़ोन कॉल पर बने रहने, कैमरा चालू रखने, या कॉल न काटने के लिए कह रहे हैं?",
  "da.flag.stay_on_call.reason": "कोई भी भारतीय कानून-प्रवर्तन एजेंसी असली जांच के दौरान आपको कॉल या वीडियो पर बनाए नहीं रखती।",
  "da.flag.secrecy.question": "क्या उन्होंने आपसे यह बात अपने परिवार, बैंक या वकील को न बताने के लिए कहा है?",
  "da.flag.secrecy.reason": "असली मामला कभी भी आपके अपने परिवार या बैंक से गुप्त नहीं रखा जाता — यह गोपनीयता की मांग एक नियंत्रण की चाल है, कानूनी ज़रूरत नहीं।",
  "da.flag.money_to_verify.question": "क्या उन्होंने आपसे पैसे ट्रांसफ़र करने या अपने ही पैसे \"वेरीफ़ाई,\" \"सुरक्षित,\" या \"रिलीज़\" करने के लिए \"जुर्माना\" देने को कहा है?",
  "da.flag.money_to_verify.reason": "कोई भी एजेंसी आपके ही पैसे वेरीफ़ाई, सुरक्षित या रिलीज़ करने के लिए पैसे नहीं मांगती। यह सबसे साफ़ पहचान है।",
  "da.flag.fake_document.question": "क्या उन्होंने स्क्रीन पर या व्हाट्सऐप/चैट पर आपको कोई वारंट, एफ़आईआर या अदालती आदेश दिखाया?",
  "da.flag.fake_document.reason": "वर्दी, बैज और वीडियो/चैट पर दिखाए गए दस्तावेज़ आसानी से नकली बनाए जा सकते हैं — असली कानूनी नोटिस इस तरह नहीं भेजे जाते।",
  "da.flag.callback_number.question": "क्या उन्होंने आपसे खुद ढूंढे नंबर की बजाय, उनके दिए गए नंबर पर वापस कॉल करने के लिए कहा?",
  "da.flag.callback_number.reason": "हमेशा एजेंसी को उसके अपने प्रकाशित नंबर पर वापस कॉल करें — कभी भी कॉल करने वाले के दिए नंबर पर नहीं।",
  "da.flag.cold_open.question": "क्या कॉल की शुरुआत किसी पार्सल, आपके आधार, बैंक खाते, या किसी रिश्तेदार की मुसीबत की बात से हुई — किसी ऐसे व्यक्ति से जिससे आपने पहले संपर्क नहीं किया था?",
  "da.flag.cold_open.reason": "यह इस धोखाधड़ी की आम शुरुआती लाइन है, जो बाकी तरकीबें शुरू होने से पहले तुरंत घबराहट पैदा करने के लिए बनाई गई है।",
  "da.warningLabel": "यह डिजिटल अरेस्ट / डरावनी कॉल धोखाधड़ी के पैटर्न से मेल खाता है",
  "da.warningMatched": "जो आपने अभी बताया, वह कोई भी भारतीय एजेंसी नहीं करती। अभी कॉल काटें — आपको कॉल पर गिरफ़्तार, जुर्माना या जांच के दायरे में नहीं लाया जा सकता, और कोई असली व्यक्ति आपसे कॉल पर बने रहने को नहीं कहेगा।",
  "da.warningSkip": "अगर कोई आप पर पैसे, गोपनीयता, या कॉल पर बने रहने के लिए दबाव बना रहा है, तो इसे धोखाधड़ी मानें। कॉल काटें — आप हमेशा खुद असली एजेंसी को वापस कॉल करके पुष्टि कर सकते हैं।",
  "da.call1930": "1930 पर कॉल करें (राष्ट्रीय साइबर क्राइम हेल्पलाइन)",
  "da.reportCybercrime": "cybercrime.gov.in पर रिपोर्ट करें",
  "da.reportChakshu": "इस नंबर की रिपोर्ट करें (चक्षु)",
  "da.tellSomeone": "अभी किसी को बताएं",
  "da.messageContact": "{name} को व्हाट्सऐप पर मैसेज करें",
  "da.textContact": "इसके बजाय {name} को टेक्स्ट करें",
  "da.yourContact": "अपने संपर्क",
  "da.noContactText": "आपने अभी तक कोई भरोसेमंद संपर्क सेट नहीं किया है।",
  "da.noContactLink": "सेटिंग्स में एक जोड़ें",
  "da.noContactSuffix": "ताकि अगली बार आप उन्हें एक टैप में सूचित कर सकें।",
  "da.calmBadge": "कोई सामान्य चेतावनी संकेत नहीं मिला",
  "da.calmHeading": "फिर भी, सतर्क रहें",
  "da.calmBody": "आपने जो बताया, उससे सामान्य पहचान-चिह्न मेल नहीं खाए। यह राहत की बात है, पर इससे यह गारंटी नहीं मिलती कि कॉल असली है — अगर अब भी कुछ गड़बड़ लगे, तो आप हमेशा कॉल काट सकते हैं और खुद ढूंढे नंबर पर एजेंसी को वापस कॉल कर सकते हैं, न कि कॉल पर दिए गए नंबर पर।",
  "sebi.heading": "क्या यह इकाई सेबी-पंजीकृत है?",
  "sebi.sub": "किसी स्टॉक टिप, ट्रेडिंग ग्रुप, या सेबी-पंजीकृत होने का दावा करने वाली इकाई पर भरोसा करने से पहले जांचें कि उसका नाम या पंजीकरण नंबर वाकई सेबी के अपने सार्वजनिक रिकॉर्ड में मौजूद है या नहीं।",
  "sebi.placeholder": "नाम, या पंजीकरण नंबर (जैसे INA000017523 या IN-DP-870-2026)…",
  "sebi.checkButton": "जांचें",
  "sebi.notFound": "नहीं मिला",
  "sebi.noMatchHeading": "सेबी के रिकॉर्ड में कोई मेल नहीं",
  "sebi.noMatchBody": "यह नाम या पंजीकरण नंबर हमारी सेबी रजिस्ट्री की प्रति में मौजूद नहीं है{syncedSuffix}। यह अपने आप में धोखाधड़ी की पुष्टि नहीं करता — हमारा डेटा पुराना हो सकता है, या नाम अलग तरह से लिखा गया हो सकता है — लेकिन असली सेबी-पंजीकृत इकाई यहां ज़रूर दिखनी चाहिए। अगर यकीन न हो, तो इस साख का दावा करने वाले किसी पर भरोसा करने से पहले सीधे सेबी की अपनी वेबसाइट पर जांच लें।",
  "sebi.lastSyncedSuffix": " (आखिरी बार {date} को सिंक किया गया)",
  "sebi.notSyncedHint": "हमारी सेबी रजिस्ट्री का पहला सिंक अभी पूरा नहीं हुआ है — नतीजे अभी अधूरे हो सकते हैं।",
  "sebi.registered": "सेबी के साथ पंजीकृत",
  "sebi.lapsed": "पंजीकरण समाप्त/रद्द",
  "sebi.activeSince": "{date} से सक्रिय",
  "sebi.validFromUntil": "{from} से {to} तक मान्य था",
  "sebi.unspecifiedDate": "एक अनिर्दिष्ट तारीख",
  "sebi.registeredCaution": "यह सिर्फ़ इतना पुष्टि करता है कि पंजीकरण असली है। यह पुष्टि नहीं करता कि आपसे संपर्क करने वाला विशेष व्यक्ति या माध्यम वाकई इस पंजीकृत इकाई का प्रतिनिधित्व करने के लिए अधिकृत है — धोखेबाज़ कभी-कभी किसी असली इकाई का नाम या नंबर लेकर उसकी नकल करते हैं। अगर संपर्क में कुछ भी गड़बड़ लगे, तो किसी भरोसेमंद माध्यम से सीधे फ़र्म से पुष्टि करें।",
  "sebi.lastSyncedHint": "सेबी रजिस्ट्री आखिरी बार {date} को सिंक हुई।",

  // "breach." = the email/password breach-check page (Nov 24, 2026).
  "breach.heading": "क्या आपका ईमेल या पासवर्ड हैक या लीक हुआ है?",
  "breach.sub": "जांचें कि कोई ईमेल पता — या आपका इस्तेमाल किया हुआ कोई पासवर्ड — किसी सार्वजनिक रूप से ज्ञात डेटा ब्रीच में तो नहीं आया, ताकि आपको पता चले कि किस अकाउंट को सुरक्षित करना है।",
  "breach.emailHeading": "ईमेल पता जांचें",
  "breach.emailPlaceholder": "you@example.com",
  "breach.emailCheckButton": "ईमेल जांचें",
  "breach.emailFoundHeading": "ज्ञात डेटा ब्रीच में मिला",
  "breach.emailFoundCount": "यह ईमेल {count} ज्ञात ब्रीच(ों) में मौजूद है।",
  "breach.emailExposedLabel": "उजागर हुआ:",
  "breach.emailRemediation": "इस सेवा पर अपना पासवर्ड बदलें, और अगर यह उपलब्ध हो तो टू-फ़ैक्टर ऑथेंटिकेशन चालू करें।",
  "breach.emailNotFoundHeading": "कोई ज्ञात ब्रीच नहीं मिला",
  "breach.emailNotFoundBody": "यह ईमेल पता हमारे द्वारा जांचे गए किसी भी सार्वजनिक रूप से ज्ञात डेटा ब्रीच में नहीं मिला। यह अच्छी खबर है — हालांकि यह गारंटी नहीं देता कि भविष्य में ऐसा नहीं होगा।",
  "breach.passwordHeading": "पासवर्ड जांचें",
  "breach.passwordSub": "आपका पासवर्ड कभी भेजा या सेव नहीं किया जाता — सिर्फ़ उसका एक बिखरा हुआ हिस्सा जांचा जाता है।",
  "breach.passwordPlaceholder": "जांचने के लिए पासवर्ड डालें",
  "breach.passwordCheckButton": "पासवर्ड जांचें",
  "breach.passwordFoundHeading": "यह पासवर्ड ज्ञात डेटा ब्रीच में देखा गया है",
  "breach.passwordFoundBody": "जो पासवर्ड ब्रीच डेटा में दिखते हैं, हमलावर सबसे पहले वही आज़माते हैं। अगर आप यह पासवर्ड कहीं भी इस्तेमाल करते हैं, तो उसे बदल दें — खासकर जहां आपने इसे पहले से अलग नहीं बनाया है।",
  "breach.passwordNotFoundHeading": "ज्ञात ब्रीच डेटा में नहीं मिला",
  "breach.passwordNotFoundBody": "यह पासवर्ड हमारे द्वारा जांचे गए ब्रीच डेटा में नहीं मिला। यह अच्छा संकेत है, पर गारंटी नहीं — हर अकाउंट के लिए अलग पासवर्ड रखना अभी भी सबसे सुरक्षित आदत है।",
  "breach.unavailable": "ब्रीच जांच अभी अस्थायी रूप से उपलब्ध नहीं है — कृपया थोड़ी देर बाद पुनः प्रयास करें।",
  "breach.caution": "यह सिर्फ़ उन ब्रीच को कवर करता है जो सार्वजनिक रूप से ज्ञात हैं और हमारे डेटा स्रोत में शामिल हैं। यह किसी ऐसे ब्रीच को नहीं देख सकता जो अभी तक सामने नहीं आया है, और इसका यह मतलब कभी नहीं कि Vuryfy खुद हैक हुआ है।",
  "settings.trustedContactHeading": "स्कैम एसओएस के लिए भरोसेमंद संपर्क",
  "settings.trustedContactSub": "अगर आप कभी किसी डरावनी कॉल पर हों जो पैसे या गोपनीयता के लिए दबाव बना रही हो, तो डिजिटल-अरेस्ट जांच इस व्यक्ति को एक टैप में मैसेज कर सकती है। इसे अभी सेट करें, कॉल के बीच में नहीं।",
  "settings.trustedContactNamePlaceholder": "नाम (जैसे परिवार का कोई सदस्य या करीबी दोस्त)",
  "settings.trustedContactPhonePlaceholder": "उनका फ़ोन नंबर (जैसे 98XXXXXXXX)",
  "settings.saveContact": "संपर्क सहेजें",
  "settings.trustedContactSavedHint": "सहेज लिया गया — इसे हटाने के लिए दोनों फ़ील्ड खाली करके फिर से सहेजें।",
};

const DICTIONARIES: Record<Language, Dictionary> = { en, hi, kn, ml, ta, te, gu, bn, mr };

export function translate(language: Language, key: string): string {
  return DICTIONARIES[language]?.[key] ?? DICTIONARIES.en[key] ?? key;
}

// Display-only verdict label lookup — see the "verdict.*" keys' comment
// above for the full rationale. Deliberately separate from translate()
// rather than just calling translate(language, `verdict.${verdict}`)
// directly at call sites, so an unrecognized verdict string (anything
// outside this fixed list) safely falls back to itself instead of
// rendering a raw, ugly "verdict.SomeUnknownValue" key string.
const VERDICT_KEYS: Record<string, string> = {
  True: "verdict.True",
  False: "verdict.False",
  Misleading: "verdict.Misleading",
  Unverified: "verdict.Unverified",
  Scam: "verdict.Scam",
  Clean: "verdict.Clean",
  Suspicious: "verdict.Suspicious",
  Inconclusive: "verdict.Inconclusive",
  "Out of Context": "verdict.OutOfContext",
};

export function translateVerdict(language: Language, verdict: string): string {
  const key = VERDICT_KEYS[verdict];
  return key ? translate(language, key) : verdict;
}

export function isSupportedLanguage(value: unknown): value is Language {
  return (
    value === "en" ||
    value === "hi" ||
    value === "kn" ||
    value === "ml" ||
    value === "ta" ||
    value === "te" ||
    value === "gu" ||
    value === "bn" ||
    value === "mr"
  );
}
