export type View = {
  view: number[][];
  K: number[][];
  width: number;
  height: number;
  image_name: string;
  url: string;
  heldOut: boolean;
  sha256: string;
};
export type SceneData = {
  schemaVersion: number;
  id: string;
  title: string;
  source: {
    repository: string;
    job: string;
    dataset: string;
    url: string;
    authors: string;
    license: string;
    licenseUrl: string;
  };
  views: View[];
  trainingViews: number;
  evaluationViews: number;
  gaussian: {
    url: string;
    count: number;
    bytes: number;
    decodedBytes: number;
    engine: string;
    steps: number;
    resolution: number;
    seconds: number;
  };
  mesh: {
    url: string;
    vertices: number;
    triangles: number;
    bytes: number;
    engine: string;
    resolution: number;
    seconds: number;
    pairs: unknown[];
  };
  limitations: string[];
};
export type Backend = "gaussian" | "mesh";
export type Sample = {
  cpuMs: number;
  intervalMs: number;
  gpuMs: number | null;
  draws: number;
  triangles: number;
};
export type Summary = {
  cpuMedian: number;
  cpuP95: number;
  frameMedian: number;
  fps: number;
  gpuMedian: number | null;
  samples: Sample[];
};
export type Quality = { psnr: number | null; ssim: number; mae: number };
