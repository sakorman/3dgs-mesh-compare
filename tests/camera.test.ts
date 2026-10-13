import test from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";
import { applyView } from "../src/camera";
import type { View } from "../src/types";
const view: View = {
  view: [
    [1, 0, 0, -2],
    [0, 1, 0, -3],
    [0, 0, 1, -4],
    [0, 0, 0, 1],
  ],
  K: [
    [500, 0, 310],
    [0, 520, 230],
    [0, 0, 1],
  ],
  width: 640,
  height: 480,
  url: "",
  heldOut: true,
  image_name: "",
  sha256: "",
};
test("COLMAP world points project to the same image pixels with off-center intrinsics", () => {
  const c = new PerspectiveCamera(60, 1, 0.01, 100);
  applyView(c, view);
  for (const [x, y, z] of [
    [0, 0, 3],
    [0.4, -0.2, 2],
    [-0.5, 0.6, 4],
  ]) {
    const ndc = new Vector3(x + 2, y + 3, z + 4).project(c);
    assert.ok(Math.abs((ndc.x + 1) * 320 - ((500 * x) / z + 310)) < 1e-5);
    assert.ok(Math.abs((1 - ndc.y) * 240 - ((520 * y) / z + 230)) < 1e-5);
  }
  assert.deepEqual(c.position.toArray(), [2, 3, 4]);
});
test("singular camera rejected", () =>
  assert.throws(() =>
    applyView(new PerspectiveCamera(), {
      ...view,
      view: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    }),
  ));
