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

  async load(input: PairedSpec): Promise<{ model: M; format: ModelFormat; fallbackReason?: string }> {
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
    const check = () => signal.throwIfAborted();
    const response = async (url: string) => {
      const result = await this.driver.fetch(url, signal);
      if (signal.aborted || !result.ok) {
        await result.body?.cancel().catch(() => {});
        check();
        throw new Error(`Model HTTP ${result.status}`);
      }
      return result;
    };
    const verify = async (bytes: Uint8Array, expected: string) => {
      const digest = await sha256(bytes);
      check();
      if (hashHex(digest) !== expected) throw new Error("Paired model digest mismatch");
      return digest;
    };
    const initialize = async (bytes: Uint8Array, format: ModelFormat, alpha?: Uint8Array, modelHash?: Uint8Array) => {
      check();
      const model = this.driver.create(bytes, format);
      try {
        // Spark initialization is not cancellable. Do not dispose until it settles.
        await this.driver.initialized(model);
        check();
        const target = this.driver.attributes(model);
        if (target.count !== spec.count || target.sh !== 3) throw new Error("Paired model count/SH mismatch");
        if (alpha) applyAlpha16(alpha, target.words, target.count, modelHash!);
        this.driver.prepare(model);
        check();
        this.driver.publish(model);
      } catch (error) {
        this.driver.dispose(model);
        throw error;
      }
      const old = this.current;
      this.current = model;
      if (old !== undefined) this.driver.dispose(old);
      return model;
    };
    try {
      try {
        const spz = new Uint8Array(await (await response(spec.spzUrl)).arrayBuffer());
        check();
        const modelHash = await verify(spz, spec.spzSha256);
        const alpha = await readAlpha16Response(await response(spec.alphaUrl), spec.count, modelHash, signal);
        check();
        // Header binding alone cannot detect stale opacity for the same SPZ bytes.
        await verify(alpha, spec.alphaRawSha256);
        return { model: await initialize(spz, "spz", alpha, modelHash), format: "spz" };
      } catch (candidateError) {
        check(); // Cancellation is never a reason to fetch a fallback.
        try {
          const ply = new Uint8Array(await readPlyResponse(await response(spec.plyUrl), signal));
          check();
          await verify(ply, spec.plySha256);
          return { model: await initialize(ply, "ply"), format: "ply", fallbackReason: String(candidateError) };
        } catch (fallbackError) {
          check();
          throw new AggregateError([candidateError, fallbackError], "Candidate and PLY fallback failed");
        }
      }
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }
}
