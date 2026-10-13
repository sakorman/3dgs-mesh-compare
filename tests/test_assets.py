import gzip, hashlib, json, struct, unittest
from pathlib import Path
import numpy as np
from scripts.prepare_scenes import grid_triangles

ROOT = Path(__file__).resolve().parents[1]


class Assets(unittest.TestCase):
    def test_both_scenes_have_independent_meshes_and_heldout_inputs(self):
        for scene in ["pipes", "office"]:
            root = ROOT / "public/scenes" / scene
            data = json.loads((root / "scene.json").read_text())
            train = {v["image_name"] for v in data["views"] if not v["heldOut"]}
            held = {v["image_name"] for v in data["views"] if v["heldOut"]}
            self.assertEqual(len(train), data["trainingViews"])
            self.assertEqual(len(held), data["evaluationViews"])
            self.assertTrue(train.isdisjoint(held))
            for pair in data["mesh"]["pairs"]:
                self.assertIn(pair["left"], train)
                self.assertIn(pair["right"], train)
            for kind in ["gaussian", "mesh"]:
                path = root / data[kind]["url"]
                self.assertEqual(path.stat().st_size, data[kind]["bytes"])
                self.assertEqual(
                    hashlib.sha256(path.read_bytes()).hexdigest(), data[kind]["sha256"]
                )
            with gzip.open(root / data["gaussian"]["url"], "rb") as f:
                header = f.read(3000).split(b"end_header")[0].decode()
                self.assertIn(
                    "element vertex " + str(data["gaussian"]["count"]), header
                )
            glb = (root / "mesh.glb").read_bytes()
            self.assertEqual(struct.unpack_from("<III", glb), (0x46546C67, 2, len(glb)))
            n = struct.unpack_from("<I", glb, 12)[0]
            doc = json.loads(glb[20 : 20 + n])
            binary = glb[28 + n :]
            triangles = 0
            for primitive in doc["meshes"][0]["primitives"]:
                positions = doc["accessors"][primitive["attributes"]["POSITION"]]
                bv = doc["bufferViews"][positions["bufferView"]]
                xyz = np.frombuffer(
                    binary,
                    dtype="<f4",
                    count=positions["count"] * 3,
                    offset=bv.get("byteOffset", 0),
                )
                self.assertTrue(np.isfinite(xyz).all())
                self.assertGreater(float(np.ptp(xyz)), 0)
                a = doc["accessors"][primitive["indices"]]
                triangles += a["count"] // 3
            self.assertEqual(triangles, data["mesh"]["triangles"])

    def test_depth_discontinuity_is_not_bridged(self):
        yy, xx = np.indices((4, 4))
        p = np.stack([xx * 0.01, yy * 0.01, np.ones((4, 4))], -1)
        valid = np.ones((4, 4), bool)
        self.assertEqual(len(grid_triangles(p, valid)), 18)
        p[:, 2:, 2] = 10
        faces = grid_triangles(p, valid)
        for face in faces:
            self.assertLess(np.ptp(p.reshape(-1, 3)[face, 2]), 1)


if __name__ == "__main__":
    unittest.main()
