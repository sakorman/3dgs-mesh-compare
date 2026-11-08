import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {attributeStorage, retainModelResources, type GaussianResource} from "./helpers/lifecycle-resources";
import {disposeMeshResources} from "../src/mesh-resources";

class BitmapFixture {
  width = 8;
  height = 8;
  close() { this.width = this.height = 0; }
}

function fixture(run: (f: ReturnType<typeof create>) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ImageBitmap");
  Object.defineProperty(globalThis, "ImageBitmap", {value: BitmapFixture, configurable: true});
  try { run(create()); } finally {
    if (previous) Object.defineProperty(globalThis, "ImageBitmap", previous);
    else Reflect.deleteProperty(globalThis, "ImageBitmap");
  }
}

function create() {
  const bitmap = new BitmapFixture();
  const map = new THREE.Texture(bitmap as unknown as ImageBitmap);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({map}));
  const gaussian = new THREE.Object3D() as GaussianResource;
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const ext = {extArrays: [new Uint32Array(4)], extra: {}, textures: [texture]};
  gaussian.extSplats = ext;
  new THREE.Scene().add(mesh, gaussian);
  const probe = retainModelResources(gaussian, mesh);
  const clearGaussian = () => {
    ext.extArrays = [];
    texture.dispose();
    texture.source.data = null;
    gaussian.extSplats = undefined;
  };
  return {bitmap, mesh, gaussian, ext, texture, probe, clearGaussian};
}

test("dropping active pointers and detaching models cannot hide retained resources", () => fixture(f => {
  const viewer: {gaussian?: GaussianResource; mesh?: THREE.Object3D} = {gaussian: f.gaussian, mesh: f.mesh};
  const activeBytes = () => attributeStorage(viewer.gaussian?.extSplats).viewBytes;
  f.mesh.removeFromParent(); f.gaussian.removeFromParent();
  viewer.mesh = undefined; viewer.gaussian = undefined;
  assert.equal(activeBytes(), 0);
  const state = f.probe.inspect();
  assert.equal(state.passed, false);
  assert.equal(state.attributes.viewBytes, 16);
  assert.equal(state.openBitmaps, 1);
}));

test("dispose events alone do not prove bitmap close or texture source clearing", () => fixture(f => {
  f.mesh.removeFromParent(); f.gaussian.removeFromParent();
  f.mesh.geometry.dispose(); f.mesh.material.dispose(); f.mesh.material.map!.dispose();
  f.clearGaussian();
  assert.equal(f.probe.inspect().passed, false);
  assert.equal(f.probe.inspect().openBitmaps, 1);
  f.bitmap.close();
  f.texture.source.data = {data: new Uint8Array(4)};
  assert.equal(f.probe.inspect().passed, false);
}));

test("retained resources pass only after cleanup and reject repeated disposal", () => fixture(f => {
  f.mesh.removeFromParent(); f.gaussian.removeFromParent();
  disposeMeshResources(f.mesh); f.clearGaussian();
  assert.equal(f.probe.inspect().passed, true);
  f.mesh.material.map!.dispose();
  assert.equal(f.probe.inspect().passed, false);
}));

test("attribute storage separates view bytes from unique backing capacity", () => {
  const buffer = new ArrayBuffer(64);
  const ext = {extArrays: [new Uint32Array(buffer, 0, 4), new Uint32Array(buffer, 16, 4)],
    extra: {sh1: new Uint32Array(buffer, 0, 2)}, textures: []};
  assert.deepEqual(attributeStorage(ext), {viewBytes: 40, backingBufferBytes: 64, backingBuffers: 1});
  assert.deepEqual(attributeStorage(), {viewBytes: 0, backingBufferBytes: 0, backingBuffers: 0});
});

test("zero-length views still retaining a backing allocation cannot pass cleanup", () => fixture(f => {
  const retainedBuffer = f.ext.extArrays[0].buffer;
  f.mesh.removeFromParent(); f.gaussian.removeFromParent();
  disposeMeshResources(f.mesh); f.clearGaussian();
  f.ext.extArrays = [new Uint32Array(retainedBuffer, 0, 0)];
  const state = f.probe.inspect();
  assert.equal(state.attributes.viewBytes, 0);
  assert.equal(state.attributes.backingBufferBytes, 16);
  assert.equal(state.passed, false);
}));
