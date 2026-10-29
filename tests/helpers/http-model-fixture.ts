import { sharedResponsePacer, type SharedPacingRecord } from "./shared-response";
import { paceResponse, type PacingRecord } from "./paced-response";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpAsset { bytes: Uint8Array; digest: string; encoding?: string }
export interface HttpSceneAssets { spz: HttpAsset; alpha: HttpAsset; ply: HttpAsset; oldAlpha: HttpAsset }
export interface HttpRecord {
  run: string; policy: string; scene: string; kind: string; version: string | null;
  ifNoneMatch: string | null; etag: string; status: number; bodyBytesOffered: number;
  finished: boolean; closed: boolean;
  sample?: string | null; pacing?: PacingRecord; shared?: SharedPacingRecord;
}
/** Loopback-only test middleware. The caller supplies a fixed allowlist of model bytes. */
export function modelHttpFixture(assets: Record<string, HttpSceneAssets>) {
  const records: HttpRecord[] = [];
  const updated = new Set<string>();
  const shared = new Map<string, ReturnType<typeof sharedResponsePacer>>();
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (!url.pathname.startsWith("/__model_http/")) return next();
    const parts = url.pathname.split("/").slice(2);
    const [run, policy, scene, kind] = parts;
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(run ?? "")) { response.writeHead(400).end(); return; }
    if (policy === "records" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(records.filter(row => row.run === run))); return;
    }
    if (policy === "update" && request.method === "POST") {
      if (!assets[scene]) { response.writeHead(404).end(); return; }
      updated.add(`${run}/${scene}`); response.writeHead(204, { "Cache-Control": "no-store" }).end(); return;
    }
    const source = assets[scene];
    if (request.method !== "GET" || !source || !["spz", "alpha", "ply"].includes(kind) ||
        !["fresh", "validate", "mutable", "versioned", "paced", "shared", "cut", "slow"].includes(policy)) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end(); return;
    }
    const version = url.searchParams.get("sha256");
    let asset = source[kind as "spz" | "alpha" | "ply"];
    if (kind === "alpha" && policy === "mutable" && !updated.has(`${run}/${scene}`)) asset = source.oldAlpha;
    if (["versioned", "paced", "shared"].includes(policy)) {
      if (kind === "alpha" && version === source.oldAlpha.digest) asset = source.oldAlpha;
      if (version !== asset.digest) { response.writeHead(404, { "Cache-Control": "no-store" }).end(); return; }
    }
    const etag = `"${createHash("sha256").update(asset.bytes).digest("hex")}"`;
    const cache = policy === "validate" ? "no-cache" : ["cut", "slow"].includes(policy) ? "no-store" : "public, max-age=3600";
    const conditional = request.headers["if-none-match"] === etag;
    const row: HttpRecord = { run, policy, scene, kind, version, ifNoneMatch: request.headers["if-none-match"] as string ?? null,
      etag, status: conditional ? 304 : 200, bodyBytesOffered: 0, finished: false, closed: false };
    records.push(row);
    response.once("finish", () => { row.finished = true; });
    response.once("close", () => { row.closed = true; });
    const headers: Record<string, string | number> = { "Cache-Control": cache, ETag: etag, "Content-Type": "application/octet-stream" };
    if (asset.encoding) headers["Content-Encoding"] = asset.encoding;
    if (conditional) { response.writeHead(304, headers).end(); return; }
    headers["Content-Length"] = asset.bytes.length;
    response.writeHead(200, headers);
    if (kind === "alpha" && ["cut", "slow"].includes(policy)) {
      const first = asset.bytes.subarray(0, 1024);
      response.write(first); row.bodyBytesOffered += first.length;
      // Leave a real, incomplete HTTP body outstanding until reset/abort is observed.
      const timer = setTimeout(() => response.destroy(), policy === "cut" ? 50 : 10000);
      response.once("close", () => clearTimeout(timer)); return;
    }
    if (policy === "shared") {
      let pace = shared.get(run);
      if (!pace) { pace = sharedResponsePacer(); shared.set(run, pace); }
      row.sample = url.searchParams.get("sample");
      row.shared = pace(response, asset.bytes);
      response.once("close", () => { row.bodyBytesOffered = row.shared!.bytesOffered; });
      return;
    }
    if (policy === "paced") {
      row.sample = url.searchParams.get("sample");
      row.pacing = paceResponse(response, asset.bytes);
      response.once("close", () => { row.bodyBytesOffered = row.pacing!.bytesOffered; });
      return;
    }
    row.bodyBytesOffered = asset.bytes.length;
    response.end(asset.bytes);
  };
}
