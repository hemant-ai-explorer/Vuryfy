// PhotoDNA Edge Hash V2 generation — Sept 26, 2026.
//
// Wraps Microsoft's PhotoDNA.EdgeHashGeneration SDK (v1.05.009) so
// lib/content-safety.ts can compute a real PhotoDNA hash for an image and
// submit it to the PhotoDNA Cloud Service's MatchHash endpoint. See
// content-safety.ts's own header for the full pipeline and why this only
// covers images (PhotoDNA, as approved for this account, is an image
// product — video/audio remain the documented stub there).
//
// WHY THIS IS A CUSTOM, FROM-SCRATCH LOADER rather than using Microsoft's
// own webassembly/photoDnaEdgeHash.js glue file directly: that file is
// written for a browser (it touches `document`, `self`, and `Worker` at
// module-evaluation time, unconditionally, to wire up either a Web Worker
// or a `<script>`-tag-relative path) and throws immediately if merely
// required/evaluated in Node — there is no supported Node/server target in
// this SDK release. Rather than patching or `eval`-ing a minified
// third-party file (fragile, and silently breakable by a future SDK
// update), this module re-implements the small, pure-computation core of
// that glue (`CreateChrysalisHash` in their file) directly against the raw
// WebAssembly exports, using Node's built-in `WebAssembly` global — which
// is the same API surface a browser exposes, so this needed no
// unofficial/native dependency, just a from-scratch reading of:
//   - webassembly/photoDnaEdgeHash.wasm's export table (10 exports, renamed
//     to single letters by the SDK's minifier/wasm-opt pass), and
//   - photoDnaEdgeHash.js's own mapping of those letters to real names:
//     `_PhotoDnaChrysalisHash=U.e`, `_free=U.h`, `_malloc=U.i`, `U.c` is the
//     exported memory, and `U.d` is a one-time runtime-init/ctors export
//     that must be called before any other export (mirrors what that
//     file's own `onRuntimeInitialized` path does).
//   - The two required imports (module "a", entries "a"/"b") are Emscripten's
//     minimal abort handler and memory-growth handler — copied near-verbatim
//     from the glue's own minified `T = {a: ..., b: ...}` since they're
//     the standard Emscripten shims, not PhotoDNA-specific logic.
//   - Constants (buffer sizes, pixel-format flags, error codes) were read
//     directly out of the same glue file's top-level `const` declarations
//     (pdnaHeadSize, pdnaDimsSize, pdnaChSize, pdnaEdgeV2Size, PdnaHashAlloc,
//     pdnaInputRgb/Rgba) — these are fixed by the compiled .wasm binary
//     itself, not something a future non-breaking SDK point-release would
//     be expected to change silently.
//
// Verified (Sept 26, 2026, outside this codebase) against the SDK's own
// bundled sample images (samples/TestImages/img_130.jpg, decoded via
// `sharp`) before writing this into the real pipeline: produces a
// result code 0, hash version 2 (Edge Hash V2), a 1232-character base64
// string beginning with the "PDNA" magic header (base64 "UEROQQ..." decodes
// to ASCII "PDNA"), and — decoded via `sharp` at the image's native
// resolution — a hash sharing a long identical substring with the example
// hash value in Microsoft's own onboarding email, which was almost
// certainly generated from this same bundled sample image. That is about
// as strong a correctness signal as is available without a second,
// independent implementation to diff against.
//
// The .wasm binary itself (~30KB) is vendored at
// lib/vendor/photoDnaEdgeHash.wasm — see that directory for the SDK's own
// license terms (Microsoft's PhotoDNA Cloud Service Terms of Use, referenced
// in the onboarding email); it is Microsoft's compiled binary, not source
// this project wrote, and must not be modified.

import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const WASM_PATH = path.join(process.cwd(), "lib", "vendor", "photoDnaEdgeHash.wasm");

// Constants read directly from Microsoft's photoDnaEdgeHash.js — see file
// header. These describe the compiled .wasm binary's own fixed memory
// layout and are not expected to change without a new SDK version (which
// would need re-verifying against a real sample image regardless).
const PDNA_HEAD_SIZE = 32;
const PDNA_DIMS_SIZE = 16;
const PDNA_CH_HEADER_SIZE = 64;
const PDNA_CH_SIZE = 27648 + PDNA_CH_HEADER_SIZE;
const PDNA_EDGE_V2_SIZE = ((5 + 1) * 144 + 12 + 48) * 4 / 3; // 1232
const PDNA_HASH_ALLOC = PDNA_HEAD_SIZE + 2 * (PDNA_DIMS_SIZE + PDNA_CH_SIZE);
const PDNA_INPUT_RGB = 0;

// Recommended by Microsoft's own webassembly demo (EdgeHashV2DemoClient.html
// sets `maximumHashDimension = 2048`) — the hash function does not scale
// images itself, and hashing at full resolution for a very large image can
// request more WASM memory than is practical. Downscaling preserves the
// hash's own robustness-to-resizing property (that's the point of a
// perceptual hash), so this doesn't reduce match quality.
const MAX_HASH_DIMENSION = 2048;

function hashSizeForVersion(version: number): number {
  return version === 2 ? PDNA_EDGE_V2_SIZE : PDNA_CH_SIZE;
}

interface PdnaHashEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  photoDna: string;
}

interface PdnaHashResult {
  result: number;
  version: number;
  count: number;
  data: PdnaHashEntry[];
}

interface PdnaModule {
  hash(rawPixels: Uint8Array, width: number, height: number): PdnaHashResult;
}

let cachedModule: Promise<PdnaModule> | null = null;

async function loadPdnaModule(): Promise<PdnaModule> {
  const wasmBuffer = readFileSync(WASM_PATH);
  const compiled = await WebAssembly.compile(wasmBuffer);

  let memory: WebAssembly.Memory;
  let heapU8: Uint8Array;

  function refreshViews() {
    heapU8 = new Uint8Array(memory.buffer);
  }

  // Minimal Emscripten runtime shims — see file header. Import module "a",
  // entries "a" (abort) and "b" (grow memory), matching this specific
  // compiled binary's import table exactly (verified via
  // WebAssembly.Module.imports()).
  const importObject: WebAssembly.Imports = {
    a: {
      a: () => {
        throw new WebAssembly.RuntimeError("PhotoDNA Edge Hash WASM aborted");
      },
      b: (requestedPages: number) => {
        const current = heapU8.length;
        requestedPages = requestedPages >>> 0;
        if (requestedPages > 2147483648) return false;
        for (let overshoot = 1; overshoot <= 4; overshoot *= 2) {
          const target = Math.min(current * (1 + 0.2 / overshoot), requestedPages + 100663296);
          const growPages =
            ((Math.min(2147483648, 65536 * Math.ceil(Math.max(requestedPages, target) / 65536)) -
              memory.buffer.byteLength +
              65535) /
              65536) |
            0;
          try {
            memory.grow(growPages);
            refreshViews();
            return true;
          } catch {
            // try the next overshoot factor
          }
        }
        return false;
      },
    },
  };

  const instance = await WebAssembly.instantiate(compiled, importObject);
  const exp = instance.exports as unknown as {
    c: WebAssembly.Memory; // memory
    d: () => void; // one-time runtime init/ctors — must run before other exports
    e: (format: number, width: number, height: number, imageDataPtr: number, hashDataPtr: number) => number; // _PhotoDnaChrysalisHash
    h: (ptr: number) => void; // _free
    i: (size: number) => number; // _malloc
  };

  memory = exp.c;
  refreshViews();
  exp.d();

  function utf8ToString(ptr: number, maxLen: number): string {
    let end = ptr;
    const limit = ptr + maxLen;
    while (heapU8[end] !== 0 && end < limit) end++;
    return Buffer.from(heapU8.subarray(ptr, end)).toString("utf8");
  }

  function hash(rawPixels: Uint8Array, width: number, height: number): PdnaHashResult {
    let imageDataPtr = 0;
    let hashDataPtr = 0;
    try {
      imageDataPtr = exp.i(rawPixels.length);
      if (!imageDataPtr) throw new Error("PhotoDNA WASM malloc failed (image buffer)");
      hashDataPtr = exp.i(PDNA_HASH_ALLOC);
      if (!hashDataPtr) throw new Error("PhotoDNA WASM malloc failed (hash buffer)");

      heapU8.set(rawPixels, imageDataPtr);

      const count = exp.e(PDNA_INPUT_RGB, width, height, imageDataPtr, hashDataPtr);

      // Re-derive views in case malloc/hash triggered a memory grow.
      refreshViews();
      const info = new Int32Array(memory.buffer, hashDataPtr + 20, 3);
      const result = info[0];
      const version = info[1];

      if (count < 0) {
        return { result: count, version, count: 0, data: [] };
      }

      const data: PdnaHashEntry[] = [];
      let offset = PDNA_HEAD_SIZE;
      const hSize = hashSizeForVersion(version);
      for (let c = 0; c < count; c++) {
        const dims = new Int32Array(memory.buffer, hashDataPtr + offset, 4);
        const [x, y, w, h] = [dims[0], dims[1], dims[2], dims[3]];
        offset += PDNA_DIMS_SIZE;
        const photoDna = utf8ToString(hashDataPtr + offset, hSize);
        offset += hSize;
        data.push({ x, y, w, h, photoDna });
      }
      return { result, version, count, data };
    } finally {
      if (hashDataPtr) exp.h(hashDataPtr);
      if (imageDataPtr) exp.h(imageDataPtr);
    }
  }

  return { hash };
}

function getPdnaModule(): Promise<PdnaModule> {
  // Cache across invocations within the same warm serverless instance —
  // compiling the ~30KB module is cheap, but no reason to redo it per
  // request when the instance is reused.
  if (!cachedModule) cachedModule = loadPdnaModule();
  return cachedModule;
}

export interface PhotoDnaEdgeHashes {
  /** The full-image hash — always present when generation succeeds. */
  primary: string;
  /**
   * A second hash of the image with a detected border/letterbox removed.
   * Present only when the SDK detected one; submitting both to MatchHash
   * costs nothing extra (up to 5 hashes count as one request) and catches
   * a match that only the cropped version would hit.
   */
  borderRemoved: string | null;
}

// Computes real PhotoDNA Edge Hash V2 value(s) for an image. Returns null
// (never throws) on any failure — decode error, image too small/flat for
// the algorithm, WASM error — so a hashing failure degrades to "can't
// generate a hash" rather than crashing the request; the caller
// (lib/content-safety.ts) treats a null return the same as any other
// scan-unavailable case: fail open, log loudly.
export async function generatePhotoDnaEdgeHashes(imageBytes: Buffer): Promise<PhotoDnaEdgeHashes | null> {
  try {
    const pdna = await getPdnaModule();

    const { data, info } = await sharp(imageBytes)
      .rotate() // apply EXIF orientation before hashing, same as any real viewer would show
      .resize(MAX_HASH_DIMENSION, MAX_HASH_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 3) {
      console.error(`[photodna-edge-hash] unexpected decoded channel count ${info.channels} (expected 3) — skipping`);
      return null;
    }

    const result = pdna.hash(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);

    if (result.result < 0 || result.count === 0 || result.data.length === 0) {
      // Negative result = a real SDK error code (image too small/flat, bad
      // dimensions, etc.) — not a crash, just "couldn't hash this one".
      console.error(`[photodna-edge-hash] hash generation returned result=${result.result} count=${result.count} — skipping`);
      return null;
    }

    return {
      primary: result.data[0].photoDna,
      borderRemoved: result.count > 1 ? result.data[1].photoDna : null,
    };
  } catch (err) {
    console.error("[photodna-edge-hash] generation failed — treating as unavailable:", err);
    return null;
  }
}
