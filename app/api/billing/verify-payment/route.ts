import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyCheckoutSignature } from "@/lib/razorpay";

// Billing engine, Phase 1b — Nov 25, 2026. Called by the frontend
// immediately after Razorpay's Checkout modal reports success, with the
// three fields it hands back. This is a FAST, NON-AUTHORITATIVE check —
// see lib/razorpay.ts's verifyCheckoutSignature comment. It confirms the
// checkout response is genuine (not forged client-side) so the UI can show
// an honest "payment received, activating your plan" message right away,
// but the actual subscription status flip happens separately when
// Razorpay calls app/api/webhooks/razorpay/route.ts server-to-server —
// usually within seconds, but this route does not wait for or guarantee
// that, and never writes payment_required/status itself.

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const paymentId = typeof body?.razorpay_payment_id === "string" ? body.razorpay_payment_id : null;
  const subscriptionId = typeof body?.razorpay_subscription_id === "string" ? body.razorpay_subscription_id : null;
  const signature = typeof body?.razorpay_signature === "string" ? body.razorpay_signature : null;

  if (!paymentId || !subscriptionId || !signature) {
    return NextResponse.json({ error: "Missing payment fields." }, { status: 400 });
  }

  const valid = verifyCheckoutSignature({
    razorpayPaymentId: paymentId,
    razorpaySubscriptionId: subscriptionId,
    razorpaySignature: signature,
  });

  if (!valid) {
    console.error("[verify-payment] signature mismatch for user", user.id);
    return NextResponse.json({ error: "Could not verify this payment." }, { status: 400 });
  }

  const admin = createAdminClient();
  await admin.from("payments").insert({
    user_id: user.id,
    gateway: "razorpay",
    gateway_payment_id: paymentId,
    gateway_event: "client_verified",
    status: "signature_valid",
    raw_payload: { razorpay_subscription_id: subscriptionId },
  });

  return NextResponse.json({ verified: true });
}
