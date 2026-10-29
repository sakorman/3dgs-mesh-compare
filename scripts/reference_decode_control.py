"""Decode served JPEGs independently and prepare lossless diagnostic controls."""
import argparse
import hashlib
import json
import platform
from pathlib import Path

import numpy as np
import PIL
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def difference(a, b):
    if a.shape != b.shape:
        raise ValueError(f"RGBA dimensions differ: {a.shape} / {b.shape}")
    delta = np.abs(a.astype(np.int16) - b.astype(np.int16))[:, :, :3]
    return {"changedRGBChannels": int(np.count_nonzero(delta)),
            "maxRGBDifference": int(delta.max()), "meanRGBDifference": float(delta.mean()),
            "alphaIdentical": bool(np.array_equal(a[:, :, 3], b[:, :, 3]))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, default=ROOT / ".qa/reference-pixels")
    parser.add_argument("--output", type=Path, default=ROOT / ".qa/reference-decode")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    matrix = json.loads((ROOT / "docs/benchmarks/reference-pixels-matrix-2026-10-29.json").read_text())
    records = []
    for scene in ["pipes", "office"]:
        metadata = json.loads((ROOT / f"public/scenes/{scene}/scene.json").read_text())
        for index, view in enumerate(metadata["views"]):
            if not view["heldOut"]:
                continue
            source = ROOT / "public/scenes" / scene / view["url"]
            with Image.open(source) as image:
                if image.size != (view["width"], view["height"]):
                    raise ValueError("Source dimensions do not match metadata")
                # No resizing or extra color transform; retain decoded 8-bit RGB.
                rgb = image.convert("RGB")
                rgba = np.array(rgb.convert("RGBA"))
                info_keys = sorted(image.info)
            name = f"{scene}-{index:02}"
            png = args.output / f"{name}.png"
            rgb.save(png, compress_level=6)
            with Image.open(png) as control:
                assert np.array_equal(np.array(control.convert("RGBA")), rgba)
            raw = args.output / f"{name}.rgba"
            raw.write_bytes(rgba.tobytes())
            comparisons = []
            for row in matrix["records"]:
                if row["scene"] != scene or row["view"] != view["image_name"] or row["repeat"] or row["originalFirst"]:
                    continue
                previous_file = args.raw_dir / (row["naturalHash"] + ".rgba")
                if not previous_file.exists():
                    comparisons.append({"readFrequently": row["cpu"], "previousHash": row["naturalHash"],
                                        "status": "capture-unavailable"})
                    continue
                previous = previous_file.read_bytes()
                if digest(previous) != row["naturalHash"]:
                    raise ValueError("Previous raw capture digest mismatch")
                comparisons.append({"readFrequently": row["cpu"], "previousHash": row["naturalHash"],
                                    **difference(rgba, np.frombuffer(previous, np.uint8).reshape(rgba.shape))})
            records.append({"scene": scene, "index": index, "view": view["image_name"],
                            "width": view["width"], "height": view["height"], "imageInfoKeys": info_keys,
                            "sourceUrl": f"/scenes/{scene}/{view['url']}", "sourceSha256": digest(source.read_bytes()),
                            "sourceBytes": source.stat().st_size, "png": png.name, "pngSha256": digest(png.read_bytes()),
                            "pngBytes": png.stat().st_size, "raw": raw.name, "rgbaSha256": digest(rgba.tobytes()),
                            "comparisons": comparisons})
    report = {"baseline": "08e1507", "python": platform.python_version(), "pillow": PIL.__version__,
              "libjpegApi": features.version_codec("jpg"), "libjpegTurbo": features.version_feature("libjpeg_turbo"),
              "method": "Decode existing served JPEG with Pillow convert RGB; no resize or additional color transform. PNG is a diagnostic re-encoding of that RGB, not recovered pre-JPEG ground truth.",
              "records": records}
    (args.output / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"controls": len(records), "jpegBytes": sum(r["sourceBytes"] for r in records),
                      "pngBytes": sum(r["pngBytes"] for r in records)}, indent=2))


if __name__ == "__main__":
    main()
