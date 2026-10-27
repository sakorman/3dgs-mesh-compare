import type { ServerResponse } from "node:http";

export const MODEL_PACING = { bytesPerSecond: 5 * 1024 * 1024, delayMs: 40, chunkBytes: 64 * 1024 };
export interface PacingRecord {
  bytesPerSecond: number; delayMs: number; chunkBytes: number;
  chunks: number; bytesOffered: number; idealMs: number;
  firstChunkMs: number | null; lastChunkMs: number | null; maxLateMs: number;
}
/** Pace encoded HTTP body bytes; delay is server hold time, not an RTT model. */
export function paceResponse(response: ServerResponse, bytes: Uint8Array, settings = MODEL_PACING): PacingRecord {
  const { bytesPerSecond, delayMs, chunkBytes } = settings;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || !Number.isFinite(delayMs) || delayMs < 0 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("Invalid pacing settings");
  const record: PacingRecord = { ...settings, chunks: 0, bytesOffered: 0,
    idealMs: delayMs + bytes.length / bytesPerSecond * 1000, firstChunkMs: null, lastChunkMs: null, maxLateMs: 0 };
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); response.off("drain", schedule); };
  response.once("close", stop);
  function schedule() {
    if (response.destroyed) return;
    const end = Math.min(bytes.length, record.bytesOffered + chunkBytes);
    const due = delayMs + end / bytesPerSecond * 1000;
    const remaining = due - (performance.now() - start);
    if (remaining > 0) { timer = setTimeout(schedule, Math.ceil(remaining)); return; }
    const elapsed = performance.now() - start;
    record.firstChunkMs ??= elapsed; record.lastChunkMs = elapsed;
    record.maxLateMs = Math.max(record.maxLateMs, elapsed - due);
    const ready = response.write(bytes.subarray(record.bytesOffered, end));
    record.bytesOffered = end; record.chunks++;
    if (end === bytes.length) { response.end(); return; }
    if (ready) schedule(); else response.once("drain", schedule);
  }
  schedule(); return record;
}
