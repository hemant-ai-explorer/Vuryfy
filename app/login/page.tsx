"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Phone OTP via Supabase Auth directly (no custom backend endpoint —
// Supabase handles the challenge/verify state itself). Real SMS delivery
// isn't wired up yet (needs the Send SMS Hook + 2Factor/Message Central
// account); until then, add test phone numbers with fixed OTPs under
// Supabase Dashboard → Authentication → Providers → Phone → Test OTPs,
// which lets this whole flow be tested end-to-end today.
export default function Login() {
  const router = useRouter();
  const supabase = createClient();
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  function toE164(input: string) {
    const digits = input.replace(/\D/g, "");
    if (input.trim().startsWith("+")) return `+${digits}`;
    // Assume a bare 10-digit number is an Indian mobile number.
    if (digits.length === 10) return `+91${digits}`;
    return `+${digits}`;
  }

  async function requestOtp() {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithOtp({ phone: toE164(phone) });
    if (error) {
      setMessage(error.message);
    } else {
      setOtpSent(true);
      setMessage("Enter the code sent to your phone.");
    }
    setLoading(false);
  }

  async function verify() {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.verifyOtp({
      phone: toE164(phone),
      token: otp.trim(),
      type: "sms",
    });
    if (error) {
      setMessage(error.message);
    } else {
      router.push("/");
      router.refresh();
    }
    setLoading(false);
  }

  return (
    <main className="shell">
      <nav>
        <div className="brand">Vuryfy</div>
      </nav>
      <section className="hero">
        <p className="eyebrow">{otpSent ? "WELCOME" : "GET STARTED"}</p>
        <h1>{otpSent ? "Enter your code." : "Sign in or sign up."}</h1>
        <p className="sub">
          {otpSent
            ? "Use the one-time code sent to your phone."
            : "Use your phone number. No password required."}
        </p>
        <div className="panel">
          {!otpSent ? (
            <>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone number"
                inputMode="tel"
              />
              <button disabled={loading || phone.trim().length < 8} onClick={requestOtp}>
                {loading ? "Sending…" : "Continue"}
              </button>
            </>
          ) : (
            <>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="6-digit OTP"
                inputMode="numeric"
                autoFocus
              />
              <button disabled={loading || otp.trim().length < 4} onClick={verify}>
                {loading ? "Verifying…" : "Verify & continue"}
              </button>
              <button
                className="back-action"
                onClick={() => {
                  setOtpSent(false);
                  setMessage("");
                }}
              >
                Use another number
              </button>
            </>
          )}
          {message && <p className="message">{message}</p>}
        </div>
      </section>
    </main>
  );
}
