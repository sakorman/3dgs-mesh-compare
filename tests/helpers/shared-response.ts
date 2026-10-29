import type { ServerResponse } from "node:http";
import { MODEL_PACING } from "./paced-response";

export interface SharedPacingRecord {
  bytesPerSecond: number; delayMs: number; chunkBytes: number;
  requestedMs: number; readyMs: number; bytesOffered: number;
  // Timestamp relative to the shared scheduler's origin, then encoded body byte count.
  writes: [number, number][];
}
/** One body-byte budget for all responses in a run; no idle credit or catch-up bursts.
 * Round-robin ready responses, respecting each response's backpressure and server hold.
 * This is server pacing, not a TCP/HTTP2, RTT, packet-loss or wire-byte simulator.
 */
export function sharedResponsePacer(settings = MODEL_PACING) {
  const { bytesPerSecond, delayMs, chunkBytes } = settings;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || !Number.isFinite(delayMs) || delayMs < 0 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("Invalid shared pacing settings");
  const origin = performance.now();
  let lastWrite = origin;
  type Job = { response: ServerResponse; bytes: Uint8Array; readyAt: number; row: SharedPacingRecord; drain: () => void };
  const queue: Job[] = [];
  let selected: { job: Job; end: number; due: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (action: () => void, ms: number) => { timer = setTimeout(action, Math.max(1, Math.ceil(ms))); };
  function pump() {
    if (selected) return;
    clearTimeout(timer); timer = undefined;
    const now = performance.now();
    const index = queue.findIndex(job => job.readyAt <= now);
    if (index < 0) {
      if (queue.length) later(pump, Math.min(...queue.map(job => job.readyAt)) - now);
      return;
    }
    const job = queue.splice(index, 1)[0];
    const end = Math.min(job.bytes.length, job.row.bytesOffered + chunkBytes);
    if (end === job.row.bytesOffered) { job.response.end(); pump(); return; }
    const due = Math.max(now, lastWrite) + (end - job.row.bytesOffered) / bytesPerSecond * 1000;
    selected = { job, end, due };
    later(write, due - now);
  }
  function write() {
    const pending = selected;
    if (!pending) return;
    const remaining = pending.due - performance.now();
    if (remaining > 0) { later(write, remaining); return; }
    const { job, end } = pending;
    selected = undefined; timer = undefined;
    lastWrite = performance.now();
    const count = end - job.row.bytesOffered;
    const chunk = job.bytes.subarray(job.row.bytesOffered, end);
    job.row.bytesOffered = end;
    job.row.writes.push([lastWrite - origin, count]);
    const ready = job.response.write(chunk);
    if (!job.response.destroyed) {
      if (end === job.bytes.length) job.response.end();
      else if (ready) queue.push(job);
      else job.response.once("drain", job.drain);
    }
    pump();
  }
  return (response: ServerResponse, bytes: Uint8Array): SharedPacingRecord => {
    const requested = performance.now();
    const row: SharedPacingRecord = { ...settings, requestedMs: requested - origin,
      readyMs: requested + delayMs - origin, bytesOffered: 0, writes: [] };
    if (response.destroyed) return row;
    const job: Job = { response, bytes, readyAt: requested + delayMs, row,
      drain: () => { if (!response.destroyed) { queue.push(job); pump(); } } };
    response.once("close", () => {
      response.off("drain", job.drain);
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      if (selected?.job === job) { clearTimeout(timer); timer = undefined; selected = undefined; }
      pump();
    });
    queue.push(job); pump();
    return row;
  };
}
