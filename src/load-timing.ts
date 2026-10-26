export type LoadStage =
  | "metadata"
  | "gaussianReadDecode"
  | "gaussianInitialize"
  | "meshRead"
  | "meshParse"
  | "settle";
export type LoadSpan = {
  stage: LoadStage;
  startMs: number;
  endMs: number;
  durationMs: number;
};
export type LoadTimings = {
  schemaVersion: 1;
  scene: string;
  createdAt: string;
  totalMs: number;
  spans: LoadSpan[];
  resolution: number[];
  camera: string;
  visibility: "foreground" | "backgrounded";
  cache: "uncontrolled";
  scope: "scene-load-to-settled-submission";
  execution: "parallel-model-loading";
};

/** Wall-clock spans may overlap; their sum is not the scene's loading time. */
export class LoadClock {
  private readonly origin: number;
  private readonly spans: LoadSpan[] = [];
  constructor(private readonly now = () => performance.now()) {
    this.origin = now();
  }
  start(stage: LoadStage) {
    const startMs = this.now() - this.origin;
    return () => {
      const endMs = this.now() - this.origin;
      this.spans.push({ stage, startMs, endMs, durationMs: endMs - startMs });
    };
  }
  finish() {
    return {
      totalMs: this.now() - this.origin,
      spans: this.spans
        .map((span) => ({ ...span }))
        .sort((a, b) => a.startMs - b.startMs),
    };
  }
}
