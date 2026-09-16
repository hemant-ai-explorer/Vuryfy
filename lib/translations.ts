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
// Coverage in this pass: the home screen, the sign-in/sign-up screen (incl.
// the new language-picker step), the unified text/URL verify screen, and
// the settings screen. The result page's static chrome (evidence/sources
// labels, etc.) and every other input type's confirm screen (QR, image,
// audio, video) are NOT yet wired to this dictionary — they still render
// English regardless of the user's stored preference. That's a deliberate,
// explicitly-scoped gap for this first pass, not an oversight; extending
// coverage to those screens is the natural next step once this mechanism
// is confirmed working end to end.
export type Language = "en" | "hi";

export const SUPPORTED_LANGUAGES: { code: Language; label: string; nativeLabel: string }[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  hi: "Hindi",
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
  "home.quickChecks": "Quick Checks",
  "home.deepInvestigations": "Deep Investigations",
  "home.settings": "Settings",
  "home.signOut": "Sign out",
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
};

const DICTIONARIES: Record<Language, Dictionary> = { en, hi };

export function translate(language: Language, key: string): string {
  return DICTIONARIES[language]?.[key] ?? DICTIONARIES.en[key] ?? key;
}

export function isSupportedLanguage(value: unknown): value is Language {
  return value === "en" || value === "hi";
}
