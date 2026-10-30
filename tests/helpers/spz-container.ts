import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { validateAlpha16 } from "./alpha16";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

// Diagnostic fixture only: keep the v3 SH3 payload/order, change its gzip envelope.
export function storedSpzControl(source: Uint8Array, alpha: Uint8Array, count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error("Invalid control count");
  validateAlpha16(alpha, count, digest(source));
  const expectedBytes = 16 + count * 65;
  const raw = gunzipSync(source, { maxOutputLength: expectedBytes });
  if (raw.length !== expectedBytes || raw.readUInt32LE(0) !== 0x5053474e ||
      raw.readUInt32LE(4) !== 3 || raw.readUInt32LE(8) !== count || raw[12] !== 3 ||
      (raw[14] & ~1) !== 0 || raw[15] !== 0) throw new Error("Expected plain v3 SH3 payload");
  const model = gzipSync(raw, { level: 0 });
  if (!gunzipSync(model, { maxOutputLength: expectedBytes }).equals(raw)) throw new Error("SPZ payload changed");
  // Rebind only after proving unchanged attributes and order; never change the source sidecar.
  const rebound = Uint8Array.from(alpha);
  rebound.set(digest(model), 16);
  validateAlpha16(rebound, count, digest(model));
  return { model, alpha: rebound, rawBytes: raw.length, rawSha256: digest(raw).toString("hex") };
}
