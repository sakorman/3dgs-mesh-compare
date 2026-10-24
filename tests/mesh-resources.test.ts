import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { disposeMeshResources } from "../src/mesh-resources";

class BitmapFixture {
  width = 8;
  height = 8;
  closed = 0;
  close() {
    this.closed++;
    this.width = this.height = 0;
  }
}
function withBitmaps(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  Object.defineProperty(globalThis, "ImageBitmap", {
    value: BitmapFixture,
    configurable: true,
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "ImageBitmap", previous);
    else Reflect.deleteProperty(globalThis, "ImageBitmap");
  }
}
function texture(bitmap: BitmapFixture) {
  return new THREE.Texture(bitmap as unknown as ImageBitmap);
}
function disposed(
  resource: THREE.BufferGeometry | THREE.Material | THREE.Texture,
) {
  let count = 0;
  resource.addEventListener("dispose", () => count++);
  return () => count;
}

test("shared geometry, material and image sources are released once per root", () =>
  withBitmaps(() => {
    const image = new BitmapFixture(),
      map = texture(image),
      clone = map.clone();
    const geometry = new THREE.BufferGeometry();
    const a = new THREE.MeshStandardMaterial({ map, normalMap: clone });
    const b = new THREE.MeshBasicMaterial({ map });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, [a, b]), new THREE.Mesh(geometry, a));
    const counters = [geometry, a, b, map, clone].map(disposed);
    assert.deepEqual(disposeMeshResources(root), {
      geometries: 1,
      materials: 2,
      textures: 2,
      bitmaps: 1,
    });
    assert.deepEqual(
      counters.map((count) => count()),
      [1, 1, 1, 1, 1],
    );
    assert.equal(image.closed, 1);
  }));

test("all GLTF texture slots release their decoded images, not only base color", () =>
  withBitmaps(() => {
    const images = Array.from({ length: 4 }, () => new BitmapFixture());
    const maps = images.map(texture);
    const material = new THREE.MeshStandardMaterial({
      map: maps[0],
      normalMap: maps[1],
      roughnessMap: maps[2],
      emissiveMap: maps[3],
    });
    const root = new THREE.Group();
    root.add(
      new THREE.Group().add(
        new THREE.Mesh(new THREE.BufferGeometry(), material),
      ),
    );
    const counts = maps.map(disposed);
    assert.equal(disposeMeshResources(root).textures, 4);
    assert.deepEqual(
      images.map((image) => image.closed),
      [1, 1, 1, 1],
    );
    assert.deepEqual(
      counts.map((count) => count()),
      [1, 1, 1, 1],
    );
  }));

test("DataTexture and non-bitmap image sources require no bitmap API", () => {
  const map = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const root = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ map }),
  );
  const count = disposed(map);
  assert.equal(disposeMeshResources(root).bitmaps, 0);
  assert.equal(count(), 1);
});

test("disposing one loaded root leaves independently loaded roots usable", () =>
  withBitmaps(() => {
    const oldImage = new BitmapFixture(),
      activeImage = new BitmapFixture();
    const old = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ map: texture(oldImage) }),
    );
    const active = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ map: texture(activeImage) }),
    );
    const activeDisposals = disposed(active.material);
    disposeMeshResources(old);
    assert.equal(oldImage.closed, 1);
    assert.equal(activeImage.width, 8);
    assert.equal(activeDisposals(), 0);
  }));

test("empty roots and untextured meshes dispose without image assumptions", () => {
  assert.deepEqual(disposeMeshResources(new THREE.Group()), {
    geometries: 0,
    materials: 0,
    textures: 0,
    bitmaps: 0,
  });
  assert.deepEqual(
    disposeMeshResources(
      new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()),
    ),
    { geometries: 1, materials: 1, textures: 0, bitmaps: 0 },
  );
});
