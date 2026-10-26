import test from "node:test";
import assert from "node:assert/strict";
import { LoadClock } from "../src/load-timing";

test("parallel model spans keep offsets and do not inflate total loading time", () => {
  let now = 100;
  const clock = new LoadClock(() => now);
  const metadata = clock.start("metadata");
  now = 110;
  metadata();
  const gaussian = clock.start("gaussianReadDecode");
  now = 112;
  const mesh = clock.start("meshRead");
  now = 132;
  mesh();
  now = 160;
  gaussian();
  now = 165;
  const settle = clock.start("settle");
  now = 185;
  settle();
  const result = clock.finish();
  assert.equal(result.totalMs, 85);
  assert.deepEqual(
    result.spans.map((s) => [s.stage, s.startMs, s.endMs, s.durationMs]),
    [
      ["metadata", 0, 10, 10],
      ["gaussianReadDecode", 10, 60, 50],
      ["meshRead", 12, 32, 20],
      ["settle", 65, 85, 20],
    ],
  );
  assert.notEqual(
    result.totalMs,
    result.spans.reduce((n, s) => n + s.durationMs, 0),
  );
});

test("exported timing snapshots do not change when another stage completes", () => {
  let now = 0;
  const clock = new LoadClock(() => now);
  const read = clock.start("meshRead");
  now = 10;
  read();
  const snapshot = clock.finish();
  const parse = clock.start("meshParse");
  now = 20;
  parse();
  assert.equal(snapshot.totalMs, 10);
  assert.equal(snapshot.spans.length, 1);
  snapshot.spans[0].durationMs = 999;
  assert.equal(clock.finish().spans[0].durationMs, 10);
});
