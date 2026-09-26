import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // sharp (added Sept 26, 2026 for the real PhotoDNA image-safety pipeline —
  // see lib/content-safety.ts and lib/photodna-edge-hash.ts) ships
  // per-platform prebuilt native binaries. This tells Next's server bundler
  // to require() it at runtime like a normal Node dependency instead of
  // trying to trace/bundle it as ordinary JS, which is the documented fix
  // for native-binary npm packages on Vercel's Node.js runtime.
  serverExternalPackages: ["sharp"],
  // The vendored PhotoDNA Edge Hash WebAssembly binary
  // (lib/vendor/photoDnaEdgeHash.wasm) is loaded at runtime via
  // fs.readFileSync (see lib/photodna-edge-hash.ts), not imported as a JS
  // module, so Next's static import-tracing has no way to discover it on
  // its own. Without this, Vercel's build can silently omit the file from
  // the deployed function and every image-safety scan would fail at
  // runtime with "file not found" the first time it's hit in production.
  // NOTE: this pattern is standard for Next 15 App Router API routes, but
  // has not yet been verified against a real Vercel deployment for this
  // specific file — confirm the .wasm file is actually present in the
  // deployed function (Vercel's build output / a successful first real
  // scan) before relying on this in production.
  outputFileTracingIncludes: {
    "/api/**/*": ["./lib/vendor/photoDnaEdgeHash.wasm"],
  },
};

export default nextConfig;
