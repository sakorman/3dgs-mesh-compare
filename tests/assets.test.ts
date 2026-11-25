import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readPlyResponse } from "../src/model-bytes";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
for (const scene of ["pipes", "office"])
  test(`${scene}: hashes, holdout isolation, GLB indices and streamed PLY bytes`, async () => {
    const base = new URL(`../public/scenes/${scene}/`, import.meta.url);
    const data = JSON.parse(readFileSync(new URL("scene.json", base), "utf8"));
    const train = new Set(
      data.views
        .filter((v: { heldOut: boolean }) => !v.heldOut)
        .map((v: { image_name: string }) => v.image_name),
    );
    assert.equal(train.size, data.trainingViews);
    assert.equal(data.views.length - train.size, data.evaluationViews);
    for (const pair of data.mesh.pairs) {
      assert.ok(train.has(pair.left));
      assert.ok(train.has(pair.right));
    }
    for (const kind of ["gaussian", "mesh"]) {
      const bytes = readFileSync(new URL(data[kind].url, base));
      assert.equal(bytes.length, data[kind].bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        data[kind].sha256,
      );
    }
    const ply = gunzipSync(readFileSync(new URL(data.gaussian.url, base)));
    assert.equal(ply.length, data.gaussian.decodedBytes);
    const source = Readable.toWeb(
      createReadStream(new URL(data.gaussian.url, base), {
        highWaterMark: 16384,
      }),
    );
    const streamed = await readPlyResponse(
      new Response(source as ReadableStream<Uint8Array>),
    );
    assert.ok(
      Buffer.from(streamed).equals(ply),
      "streamed decoder must preserve every PLY byte",
    );
    assert.ok(
      ply
        .subarray(0, 3000)
        .toString()
        .includes(`element vertex ${data.gaussian.count}\n`),
    );
    const glb = readFileSync(new URL("mesh.glb", base));
    assert.equal(glb.readUInt32LE(0), 0x46546c67);
    assert.equal(glb.readUInt32LE(8), glb.length);
    const length = glb.readUInt32LE(12);
    const doc = JSON.parse(glb.subarray(20, 20 + length).toString());
    let triangles = 0;
    for (const primitive of doc.meshes[0].primitives) {
      const index = doc.accessors[primitive.indices];
      const pos = doc.accessors[primitive.attributes.POSITION];
      const bv = doc.bufferViews[index.bufferView];
      assert.equal(index.count % 3, 0);
      assert.equal(index.count * 4, bv.byteLength);
      triangles += index.count / 3;
      const offset = 28 + length + (bv.byteOffset ?? 0);
      for (let i = 0; i < index.count; i++)
        assert.ok(glb.readUInt32LE(offset + i * 4) < pos.count);
    }
    assert.equal(triangles, data.mesh.triangles);
  });

for (const scene of ["pipes", "office"])
  test(`${scene}: navigation thumbnails and reference photos are separate JPEGs`, () => {
    const base = new URL(`../public/scenes/${scene}/`, import.meta.url);
    const { views } = JSON.parse(readFileSync(new URL("scene.json", base), "utf8"));
    const thumbnails = new Set<string>();
    for (const { url, thumbnailUrl } of views) {
      assert.equal(typeof thumbnailUrl, "string");
      assert.notEqual(thumbnailUrl, url);
      const preview = readFileSync(new URL(thumbnailUrl, base));
      const reference = readFileSync(new URL(url, base));
      assert.equal(preview.readUInt16BE(0), 0xffd8);
      assert.equal(preview.readUInt16BE(preview.length - 2), 0xffd9);
      assert.ok(preview.length < reference.length);
      thumbnails.add(thumbnailUrl);
    }
    assert.equal(thumbnails.size, views.length);
  });
