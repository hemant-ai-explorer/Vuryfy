// Native live QR scanning for the Capacitor Android app — added Nov 27,
// 2026 as a follow-up to lib/native-camera.ts's snap-a-photo support, after
// the user asked for a real point-and-scan experience for QR codes instead
// of (or alongside) taking a photo and decoding it afterward.
//
// Uses @capacitor-mlkit/barcode-scanning's scan() method, which on Android
// launches Google's own full-screen "Google Code Scanner" (a bundled Play
// Services module, the same one Google Lens/Chrome use) — point the camera
// at a QR code and it's detected instantly. We don't build or maintain any
// camera-preview UI ourselves; Google's module owns that screen entirely
// and just hands back the decoded text.
//
// Web behavior is unaffected: every call site branches on
// isNativePlatform() (see lib/native-camera.ts) and keeps the existing
// take-a-photo-then-decode flow (lib/decode-qr.ts) everywhere else, and
// this module is never imported into any web-only code path.
import { BarcodeScanner, BarcodeFormat } from "@capacitor-mlkit/barcode-scanning";

// Google's scanner module is a separate on-device component that may need
// a one-time download the first time ANY app on the device uses it.
// Checking/installing it before the first scan() call avoids a confusing
// failure on that first attempt — a no-op on devices that already have it.
async function ensureModuleInstalled(): Promise<void> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule();
  }
}

// Opens Google's native full-screen QR scanner and returns the decoded
// text, or null if the user backed out, nothing was found, or scanning
// isn't supported on this device. Callers should treat null as a silent
// no-op (same convention as lib/native-camera.ts's pickNativePhoto()) —
// the "Choose a photo" fallback still works regardless.
export async function scanQrCodeNative(): Promise<string | null> {
  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return null;
    await ensureModuleInstalled();
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const first = barcodes[0];
    if (!first) return null;
    return first.rawValue || first.displayValue || null;
  } catch {
    // User cancelled the scanner, denied a permission, or the device
    // genuinely doesn't support it — nothing to surface as an error here.
    return null;
  }
}
