import { readPlyResponse } from "../../src/model-bytes";
import { applyAlpha16 } from "./alpha16";
import { MAX_ALPHA16_BYTES, readAlpha16Response } from "./alpha16-stream";

export interface PairedSpec {
  count: number;
  spzUrl: string;
  spzSha256: string;
  alphaUrl: string;
  alphaRawSha256: string;
  plyUrl: string;
  plySha256: string;
}
export type ModelFormat = "spz" | "ply";
export interface ModelPhase { name: string; ms: number; startMs: number; endMs: number }
/** Union of wall-clock intervals: parallel phases must not be added twice. */
export function elapsedModelPhases(phases: ModelPhase[]) {
  let total = 0, end = 0;
  for (const phase of [...phases].sort((a, b) => a.startMs - b.startMs)) {
    total += Math.max(0, phase.endMs - Math.max(end, phase.startMs));
    end = Math.max(end, phase.endMs);
  }
  return total;
}
export interface ModelDriver<M> {
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  create(bytes: Uint8Array, format: ModelFormat): M;
  initialized(model: M): Promise<unknown>;
  attributes(model: M): { count: number; sh: number; words: Uint32Array };
  prepare(model: M): void;
  // Synchronous scene swap; on failure leave the previously displayed model intact.
  publish(model: M): void;
  // Remove only this model and release its resources; must not throw.
  dispose(model: M): void;
}
export async function sha256(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}
export const hashHex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");

/** Experimental paired-file loader. Owns only models it creates, not the viewer's baseline. */
export class PairedModelLoader<M> {
  private active?: AbortController;
  private current?: M;
  private closed = false;
  constructor(private readonly driver: ModelDriver<M>) {}

  cancel() { this.active?.abort(); }
  clear() {
    this.cancel();
    const old = this.current;
    this.current = undefined;
    if (old !== undefined) this.driver.dispose(old);
  }
  dispose() { this.closed = true; this.clear(); }

  async load(input: PairedSpec, format: ModelFormat = "spz"): Promise<{ model: M; format: ModelFormat; fallbackReason?: string; phases: ModelPhase[] }> {
    if (this.closed) throw new Error("Paired loader disposed");
    // Snapshot the manifest so a caller cannot change identity during an await.
    const spec = { ...input };
    if (!Number.isInteger(spec.count) || spec.count < 1 || 48 + spec.count * 2 > MAX_ALPHA16_BYTES ||
        [spec.spzSha256, spec.alphaRawSha256, spec.plySha256].some(hash => !/^[0-9a-f]{64}$/.test(hash)))
      throw new Error("Invalid paired model manifest");
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    const { signal } = controller;
    const phases: ModelPhase[] = [];
    const origin = performance.now();
    let recording = true;
    const record = (name: string, start: number) => {
      if (!recording) return; // A cancelled driver can still deliver a late response.
      const end = performance.now();
      phases.push({ name, ms: end - start, startMs: start - origin, endMs: end - origin });
    };
    const phase = async <T>(name: string, action: () => Promise<T>) => {
      const start = performance.now();
      try { return await action(); }
      finally { record(name, start); }
    };
    const check = () => signal.throwIfAborted();
    const response = async (url: string, pending = signal) => {
      const result = await this.driver.fetch(url, pending);
      if (pending.aborted || !result.ok) {
        await result.body?.cancel().catch(() => {});
        pending.throwIfAborted();
        throw new Error(`Model HTTP ${result.status}`);
      }
      return result;
    };
    const verify = async (bytes: Uint8Array, expected: string, pending = signal) => {
      const digest = await sha256(bytes);
      pending.throwIfAborted();
      if (hashHex(digest) !== expected) throw new Error("Paired model digest mismatch");
      return digest;
    };
    const initialize = async (bytes: Uint8Array, format: ModelFormat, alpha?: Uint8Array, modelHash?: Uint8Array) => {
      check();
      const start = performance.now();
      const model = this.driver.create(bytes, format);
      try {
        // Spark initialization is not cancellable. Do not dispose until it settles.
        await this.driver.initialized(model);
        record(`${format}-initialize`, start);
        check();
        const prepareStart = performance.now();
        const target = this.driver.attributes(model);
        if (target.count !== spec.count || target.sh !== 3) throw new Error("Paired model count/SH mismatch");
        if (alpha) applyAlpha16(alpha, target.words, target.count, modelHash!);
        this.driver.prepare(model);
        check();
        this.driver.publish(model);
        record(`${format}-prepare-publish`, prepareStart);
      } catch (error) {
        this.driver.dispose(model);
        throw error;
      }
      const old = this.current;
      this.current = model;
      if (old !== undefined) this.driver.dispose(old);
      return model;
    };
    const loadPly = async () => {
      const ply = await phase("ply-read", async () => new Uint8Array(await readPlyResponse(await response(spec.plyUrl), signal)));
      check();
      await phase("ply-hash", () => verify(ply, spec.plySha256));
      return { model: await initialize(ply, "ply"), format: "ply" as const, phases };
    };
    try {
      // Direct PLY control uses the same fetch, validation and ownership path as fallback.
      if (format === "ply") return await loadPly();
      try {
        const candidate = new AbortController();
        const pending = AbortSignal.any([signal, candidate.signal]);
        // The manifest is the expected binding, not proof that either file is valid.
        const modelHash = Uint8Array.from(spec.spzSha256.match(/../g)!, pair => Number.parseInt(pair, 16));
        try {
          const [spz, alpha] = await Promise.all([
            (async () => {
              const bytes = await phase("spz-read", async () => new Uint8Array(await (await response(spec.spzUrl, pending)).arrayBuffer()));
              pending.throwIfAborted();
              await phase("spz-hash", () => verify(bytes, spec.spzSha256, pending));
              return bytes;
            })(),
            (async () => {
              const bytes = await phase("alpha-read-validate", async () => readAlpha16Response(await response(spec.alphaUrl, pending), spec.count, modelHash, pending));
              pending.throwIfAborted();
              // Header binding alone cannot detect stale opacity for the same SPZ bytes.
              await phase("alpha-hash", () => verify(bytes, spec.alphaRawSha256, pending));
              return bytes;
            })(),
          ]);
          check();
          return { model: await initialize(spz, "spz", alpha, modelHash), format: "spz", phases };
        } finally {
          // Stop the sibling request on failure without aborting a valid PLY fallback.
          candidate.abort();
        }
      } catch (candidateError) {
        check(); // Cancellation is never a reason to fetch a fallback.
        try {
          return { ...await loadPly(), fallbackReason: String(candidateError) };
        } catch (fallbackError) {
          check();
          throw new AggregateError([candidateError, fallbackError], "Candidate and PLY fallback failed");
        }
      }
    } finally {
      recording = false;
      if (this.active === controller) this.active = undefined;
    }
  }
}
