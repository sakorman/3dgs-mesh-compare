import type { Quality, Sample, Summary } from "./types";
export function quantile(values: number[], q: number) {
  if (!values.length) throw new Error("没有有效样本");
  const a = [...values].sort((x, y) => x - y),
    p = (a.length - 1) * q,
    i = Math.floor(p);
  return a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * (p - i);
}
export function summarize(samples: Sample[]): Summary {
  const cpu = samples.map((s) => s.cpuMs),
    frames = samples.map((s) => s.intervalMs),
    gpu = samples.flatMap((s) => (s.gpuMs === null ? [] : [s.gpuMs]));
  return {
    cpuMedian: quantile(cpu, 0.5),
    cpuP95: quantile(cpu, 0.95),
    frameMedian: quantile(frames, 0.5),
    fps: 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length),
    gpuMedian: gpu.length ? quantile(gpu, 0.5) : null,
    samples,
  };
}
// Wang et al. SSIM: 11×11 Gaussian window, sigma=1.5, valid interior,
// per-channel RGB, L=255; no crop/masking of missing Mesh geometry.
export function quality(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  w: number,
  h: number,
): Quality {
  if (w < 11 || h < 11 || a.length !== w * h * 4 || a.length !== b.length)
    throw new Error("画质图像尺寸不匹配");
  let mse = 0,
    mae = 0,
    ssim = 0;
  const kernel = Array.from({ length: 11 }, (_, i) =>
    Math.exp(-((i - 5) ** 2) / (2 * 1.5 ** 2)),
  );
  const total = kernel.reduce((x, y) => x + y);
  kernel.forEach((v, i) => (kernel[i] = v / total));
  const blur = (v: Float64Array) => {
    const tmp = new Float64Array(w * h),
      out = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 5; x < w - 5; x++) {
        let s = 0;
        for (let k = -5; k <= 5; k++) s += v[y * w + x + k] * kernel[k + 5];
        tmp[y * w + x] = s;
      }
    for (let y = 5; y < h - 5; y++)
      for (let x = 5; x < w - 5; x++) {
        let s = 0;
        for (let k = -5; k <= 5; k++) s += tmp[(y + k) * w + x] * kernel[k + 5];
        out[y * w + x] = s;
      }
    return out;
  };
  for (let c = 0; c < 3; c++) {
    const x = new Float64Array(w * h),
      y = new Float64Array(w * h),
      xx = new Float64Array(w * h),
      yy = new Float64Array(w * h),
      xy = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
      x[i] = a[i * 4 + c];
      y[i] = b[i * 4 + c];
      xx[i] = x[i] * x[i];
      yy[i] = y[i] * y[i];
      xy[i] = x[i] * y[i];
      mse += (x[i] - y[i]) ** 2;
      mae += Math.abs(x[i] - y[i]);
    }
    const ux = blur(x),
      uy = blur(y),
      ex = blur(xx),
      ey = blur(yy),
      exy = blur(xy),
      c1 = 6.5025,
      c2 = 58.5225;
    for (let j = 5; j < h - 5; j++)
      for (let i = 5; i < w - 5; i++) {
        const k = j * w + i,
          mx = ux[k],
          my = uy[k],
          vx = Math.max(0, ex[k] - mx * mx),
          vy = Math.max(0, ey[k] - my * my),
          cov = exy[k] - mx * my;
        ssim +=
          ((2 * mx * my + c1) * (2 * cov + c2)) /
          ((mx * mx + my * my + c1) * (vx + vy + c2));
      }
  }
  mse /= w * h * 3;
  return {
    psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
    ssim: ssim / ((w - 10) * (h - 10) * 3),
    mae: mae / (w * h * 3),
  };
}
