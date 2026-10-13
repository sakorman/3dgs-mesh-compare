import { Matrix4, PerspectiveCamera } from "three";
import type { View } from "./types";
export function applyView(camera: PerspectiveCamera, v: View) {
  if (
    v.view.flat().length !== 16 ||
    !v.view.flat().every(Number.isFinite) ||
    v.width <= 0 ||
    v.height <= 0
  )
    throw new Error("相机数据无效");
  const world = new Matrix4().set(
    ...(v.view.flat() as Parameters<Matrix4["set"]>),
  );
  if (Math.abs(world.determinant()) < 1e-8) throw new Error("相机矩阵不可逆");
  world
    .invert()
    .multiply(new Matrix4().makeScale(1, -1, -1))
    .decompose(camera.position, camera.quaternion, camera.scale);
  camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.updateMatrixWorld(true);
  const { K, width: w, height: h } = v,
    n = camera.near,
    f = camera.far;
  camera.projectionMatrix.set(
    (2 * K[0][0]) / w,
    0,
    1 - (2 * K[0][2]) / w,
    0,
    0,
    (2 * K[1][1]) / h,
    (2 * K[1][2]) / h - 1,
    0,
    0,
    0,
    -(f + n) / (f - n),
    (-2 * f * n) / (f - n),
    0,
    0,
    -1,
    0,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
