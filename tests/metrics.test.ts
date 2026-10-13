import test from "node:test";
import assert from "node:assert/strict";
import { quality, quantile, summarize } from "../src/metrics";
test("PSNR and SSIM match analytic constant-image values", () => {
  const image = (value: number) => {
    const a = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 400; i++) {
      a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = value;
      a[i * 4 + 3] = 255;
    }
    return a;
  };
  const same = quality(image(100), image(100), 20, 20);
  assert.equal(same.psnr, null);
  assert.ok(Math.abs(same.ssim - 1) < 1e-8);
  assert.equal(same.mae, 0);
  const q = quality(image(100), image(120), 20, 20);
  assert.ok(Math.abs(q.psnr! - 10 * Math.log10(255 ** 2 / 400)) < 1e-8);
  assert.ok(
    Math.abs(q.ssim - (2 * 100 * 120 + 6.5025) / (10000 + 14400 + 6.5025)) <
      1e-8,
  );
  assert.equal(q.mae, 20);
});
test("quantiles interpolate and GPU unsupported stays null", () => {
  assert.equal(quantile([3, 1, 2, 4], 0.5), 2.5);
  assert.throws(() => quantile([], 0.5));
  const s = summarize(
    [10, 20, 30].map((n) => ({
      cpuMs: n / 10,
      intervalMs: n,
      gpuMs: null,
      draws: 1,
      triangles: 2,
    })),
  );
  assert.equal(s.fps, 50);
  assert.equal(s.gpuMedian, null);
});
test("invalid image dimensions rejected", () =>
  assert.throws(() =>
    quality(new Uint8ClampedArray(4), new Uint8ClampedArray(4), 1, 1),
  ));
