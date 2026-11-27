// Native camera/photo-library access for the Capacitor Android (and future
// iOS) build — added Nov 27, 2026, see claude/roadmap-notes.md's "App icon +
// splash branding" section's punch list item 3.
//
// Real-device testing (Nov 27, 2026) showed the plain <input type="file">
// already used on the Image/QR verify screens only offers a plain "Photos"
// (gallery) picker inside the Capacitor WebView on Android — no "Camera"
// option at all, unlike a normal mobile browser's file input. So native
// camera capture genuinely needs @capacitor/camera, not just the existing
// file input.
//
// Web behavior is completely unchanged: isNativePlatform() is false in the
// ordinary Next.js web app (no window.Capacitor there), so every call site
// that branches on it keeps using the existing <input type="file"> flow —
// this file is additive, only active inside the native app shell.
import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

// Opens Capacitor's native action sheet (source: Prompt lets the user pick
// "Take Picture" or "Choose From Photos" in one native dialog, rather than
// us building two separate buttons) and returns a plain File — same shape
// <input type="file">'s onChange already hands to handleFile() on both
// verify screens, so none of the existing OCR/vision/QR-decode pipeline
// downstream needs to change at all.
//
// Returns null if the user backs out of the prompt (Capacitor rejects the
// promise on cancel) — callers should treat that as a silent no-op, not an
// error.
export async function pickNativePhoto(): Promise<File | null> {
  try {
    const photo = await Camera.getPhoto({
      quality: 90,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
    });
    if (!photo.dataUrl) return null;
    const res = await fetch(photo.dataUrl);
    const blob = await res.blob();
    const ext = photo.format || "jpeg";
    return new File([blob], `photo.${ext}`, { type: blob.type || `image/${ext}` });
  } catch {
    // User cancelled the native prompt, or denied the camera/photos
    // permission — either way, nothing to surface as an error here.
    return null;
  }
}
