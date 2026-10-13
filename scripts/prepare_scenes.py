"""Build an independent, textured stereo Mesh from web-scan training photos.

No Gaussian geometry is read by the Mesh branch. Calibrated SfM is shared.
Held-out images are excluded from stereo matching AND texture generation.
"""

from __future__ import annotations
import argparse, gzip, hashlib, io, json, platform, struct, time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

JOBS = {
    "pipes": "82acea65e9874f64806815a592015dec",
    "office": "59bb5740d2e945d9a459ca2514c66bb2",
}
TITLES = {"pipes": "管道房", "office": "办公室"}
ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def grid_triangles(points, valid, max_relative_edge=0.07):
    h, w = valid.shape
    ids = np.arange(h * w).reshape(h, w)
    a, b, c, d = ids[:-1, :-1], ids[:-1, 1:], ids[1:, :-1], ids[1:, 1:]
    faces = np.concatenate(
        [np.stack([a, c, b], -1).reshape(-1, 3), np.stack([b, c, d], -1).reshape(-1, 3)]
    )
    faces = faces[valid.ravel()[faces].all(axis=1)]
    p = points.reshape(-1, 3)[faces]
    edges = np.maximum.reduce(
        [
            np.linalg.norm(p[:, 0] - p[:, 1], axis=1),
            np.linalg.norm(p[:, 0] - p[:, 2], axis=1),
            np.linalg.norm(p[:, 1] - p[:, 2], axis=1),
        ]
    )
    return faces[
        edges < np.maximum(0.004, np.abs(p[:, :, 2]).min(axis=1) * max_relative_edge)
    ]


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.doc = {
            "asset": {
                "version": "2.0",
                "generator": "3dgs-mesh-compare / calibrated SGBM",
            },
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": []}],
            "bufferViews": [],
            "accessors": [],
            "materials": [],
            "textures": [],
            "images": [],
            "samplers": [
                {"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}
            ],
            "extensionsUsed": ["KHR_materials_unlit"],
        }

    def view(self, data):
        while len(self.bin) % 4:
            self.bin.append(0)
        idx = len(self.doc["bufferViews"])
        self.doc["bufferViews"].append(
            {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        )
        self.bin.extend(data)
        return idx

    def accessor(self, a, kind, component):
        a = np.ascontiguousarray(a)
        idx = len(self.doc["accessors"])
        value = {
            "bufferView": self.view(a.tobytes()),
            "componentType": component,
            "count": len(a),
            "type": kind,
        }
        if kind == "VEC3":
            value.update(min=a.min(axis=0).tolist(), max=a.max(axis=0).tolist())
        self.doc["accessors"].append(value)
        return idx

    def add(self, xyz, uv, faces, photo):
        used, indices = np.unique(faces, return_inverse=True)
        pos = self.accessor(xyz.reshape(-1, 3)[used].astype("<f4"), "VEC3", 5126)
        tex = self.accessor(uv.reshape(-1, 2)[used].astype("<f4"), "VEC2", 5126)
        ind = self.accessor(indices.ravel().astype("<u4"), "SCALAR", 5125)
        stream = io.BytesIO()
        Image.fromarray(photo).save(stream, format="JPEG", quality=92)
        n = len(self.doc["images"])
        self.doc["images"].append(
            {"bufferView": self.view(stream.getvalue()), "mimeType": "image/jpeg"}
        )
        self.doc["textures"].append({"source": n, "sampler": 0})
        self.doc["materials"].append(
            {
                "doubleSided": True,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": n},
                    "metallicFactor": 0,
                    "roughnessFactor": 1,
                },
                "extensions": {"KHR_materials_unlit": {}},
            }
        )
        self.doc["meshes"][0]["primitives"].append(
            {
                "attributes": {"POSITION": pos, "TEXCOORD_0": tex},
                "indices": ind,
                "material": n,
            }
        )
        return len(used), len(faces)

    def save(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.doc["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.doc, separators=(",", ":")).encode()
        js += b" " * ((-len(js)) % 4)
        path.write_bytes(
            struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(self.bin))
            + struct.pack("<II", len(js), 0x4E4F534A)
            + js
            + struct.pack("<II", len(self.bin), 0x004E4942)
            + self.bin
        )


def stereo_pair(left, right, points, size, stride):
    v1, v2 = np.array(left["view"]), np.array(right["view"])
    k1, k2 = np.array(left["K"]), np.array(right["K"])
    images = []
    for v, k in [(left, k1), (right, k2)]:
        image = cv2.imread(v["image"])
        if image is None:
            raise ValueError("Missing input photo: " + v["image"])
        k[0, :] *= size[0] / v["width"]
        k[1, :] *= size[1] / v["height"]
        images.append(cv2.resize(image, size, interpolation=cv2.INTER_AREA))
    rel = v2 @ np.linalg.inv(v1)
    r1, r2, p1, p2, q, *_ = cv2.stereoRectify(
        k1,
        None,
        k2,
        None,
        size,
        rel[:3, :3],
        rel[:3, 3],
        flags=cv2.CALIB_ZERO_DISPARITY,
        alpha=0,
    )
    # SGBM works along horizontal scan lines. Vertical pairs are skipped.
    if (
        abs(p2[1, 3]) > abs(p2[0, 3])
        or not np.isfinite(p1).all()
        or p1[0, 0] > size[0] * 4
    ):
        return None
    maps = [
        cv2.initUndistortRectifyMap(k, None, r, p[:3, :3], size, cv2.CV_32FC1)
        for k, r, p in [(k1, r1, p1), (k2, r2, p2)]
    ]
    rect = [cv2.remap(im, *mp, cv2.INTER_LINEAR) for im, mp in zip(images, maps)]
    sparse_camera = np.einsum(
        "ij,kj->ik", np.einsum("ij,kj->ik", points, v1[:3, :3]) + v1[:3, 3], r1
    )
    visible = sparse_camera[:, 2] > 0.03
    sparse_camera = sparse_camera[visible]
    if len(sparse_camera) < 12:
        return None
    depths = sparse_camera[:, 2]
    lo, hi = np.quantile(depths, [0.02, 0.98])
    lo = max(0.03, lo * 0.6)
    hi *= 1.5
    ds = -p2[0, 3] / np.array([lo, hi])
    low = int(np.floor(min(ds))) - 8
    high = int(np.ceil(max(ds))) + 8
    low = max(-size[0] // 3, low)
    high = min(size[0] // 3, high)
    count = int(np.ceil((high - low) / 16)) * 16
    if count < 16:
        return None
    params = dict(
        numDisparities=count,
        blockSize=5,
        P1=8 * 25,
        P2=32 * 25,
        disp12MaxDiff=1,
        uniquenessRatio=8,
        speckleWindowSize=80,
        speckleRange=2,
        mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
    )
    grey = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for im in rect]
    dl = (
        cv2.StereoSGBM_create(minDisparity=low, **params)
        .compute(*grey)
        .astype(np.float32)
        / 16
    )
    rlow = -low - count + 1
    dr = (
        cv2.StereoSGBM_create(minDisparity=rlow, **params)
        .compute(grey[1], grey[0])
        .astype(np.float32)
        / 16
    )
    yy, xx = np.indices(dl.shape)
    rx = np.rint(xx - dl).astype(int)
    inside = (rx >= 0) & (rx < size[0])
    rx = np.clip(rx, 0, size[0] - 1)
    valid = inside & (dl > low) & (dr[yy, rx] > rlow) & (np.abs(dl + dr[yy, rx]) < 1.5)
    valid &= np.abs(grey[0].astype(float) - grey[1][yy, rx].astype(float)) < 40
    valid &= (
        (maps[0][0] > 1)
        & (maps[0][0] < size[0] - 2)
        & (maps[0][1] > 1)
        & (maps[0][1] < size[1] - 2)
    )
    camera = cv2.reprojectImageTo3D(dl, q)
    valid &= (
        np.isfinite(camera).all(axis=2)
        & (camera[:, :, 2] > lo)
        & (camera[:, :, 2] < hi)
    )
    # Keep interior pixels so a single noisy match cannot create a long triangle.
    valid = cv2.erode(valid.astype("uint8"), np.ones((3, 3), np.uint8)).astype(bool)
    cam = camera[::stride, ::stride]
    mask = valid[::stride, ::stride]
    faces = grid_triangles(cam, mask)
    if len(faces) < 100:
        return None
    world = (cam @ r1 - v1[:3, 3]) @ v1[:3, :3]
    uv = np.stack([xx / size[0], yy / size[1]], axis=-1)[::stride, ::stride]
    return (
        world,
        uv,
        faces,
        cv2.cvtColor(rect[0], cv2.COLOR_BGR2RGB),
        float(mask.mean()),
    )


def fuse_and_texture(clouds, views, resolution):
    """Fuse independent stereo points and reconstruct a continuous oriented surface.

    Texture selection uses training cameras, surface orientation and an explicit
    ray visibility test; no evaluation image enters this function.
    """
    import open3d as o3d

    cloud = o3d.geometry.PointCloud()
    for part in clouds:
        cloud += part
    cloud = cloud.voxel_down_sample(0.003)
    cloud, _ = cloud.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
    cloud.normalize_normals()
    print("Poisson input", len(cloud.points), "points", flush=True)
    surface, density = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        cloud, depth=9, n_threads=4
    )
    density = np.asarray(density)
    surface.remove_vertices_by_mask(density < np.quantile(density, 0.01))
    surface = surface.simplify_quadric_decimation(180000)
    surface.remove_degenerate_triangles()
    surface.remove_unreferenced_vertices()
    surface.compute_triangle_normals()
    xyz = np.asarray(surface.vertices)
    faces = np.asarray(surface.triangles)
    normals = np.asarray(surface.triangle_normals)
    centroids = xyz[faces].mean(axis=1)
    raycaster = o3d.t.geometry.RaycastingScene(nthreads=4)
    raycaster.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(surface))
    best = np.full(len(faces), -np.inf)
    owner = np.full(len(faces), -1)
    for i, v in enumerate(views):
        matrix = np.array(v["view"])
        rotation = matrix[:3, :3]
        translation = matrix[:3, 3]
        k = np.array(v["K"])
        center = -rotation.T @ translation
        cp = (
            np.einsum("ij,kj->ik", xyz[faces].reshape(-1, 3), rotation).reshape(
                -1, 3, 3
            )
            + translation
        )
        pixels = np.einsum("...j,kj->...k", cp, k)
        pixels = pixels[:, :, :2] / np.maximum(pixels[:, :, 2:], 1e-8)
        inside = (
            (cp[:, :, 2] > 0.01).all(axis=1)
            & (pixels[:, :, 0] > 2).all(axis=1)
            & (pixels[:, :, 0] < v["width"] - 3).all(axis=1)
            & (pixels[:, :, 1] > 2).all(axis=1)
            & (pixels[:, :, 1] < v["height"] - 3).all(axis=1)
        )
        direction = centroids - center
        distance = np.linalg.norm(direction, axis=1)
        direction /= np.maximum(distance[:, None], 1e-8)
        cosine = np.abs(np.sum(normals * direction, axis=1))
        rays = np.concatenate(
            [np.broadcast_to(center, direction.shape), direction], axis=1
        ).astype(np.float32)
        hit = raycaster.cast_rays(o3d.core.Tensor(rays), nthreads=4)["t_hit"].numpy()
        visible = np.abs(hit - distance) < np.maximum(0.003, distance * 0.005)
        score = cosine**2 / np.maximum(distance, 0.01) ** 2
        use = inside & visible & (score > best)
        best[use] = score[use]
        owner[use] = i
    model = GLB()
    vertices = triangles = 0
    for i, v in enumerate(views):
        chosen = faces[owner == i]
        if not len(chosen):
            continue
        world = xyz[chosen].reshape(-1, 3)
        matrix = np.array(v["view"])
        cp = np.einsum("ij,kj->ik", world, matrix[:3, :3]) + matrix[:3, 3]
        p = np.einsum("ij,kj->ik", cp, np.array(v["K"]))
        uv = p[:, :2] / p[:, 2:] / np.array([v["width"], v["height"]])
        image = Image.open(v["image"]).convert("RGB")
        image.thumbnail((resolution, resolution), Image.Resampling.LANCZOS)
        nv, nt = model.add(
            world, uv, np.arange(len(world)).reshape(-1, 3), np.array(image)
        )
        vertices += nv
        triangles += nt
    if not triangles:
        raise ValueError("No visible Poisson surface")
    return (
        model,
        vertices,
        triangles,
        {
            "method": "Screened Poisson",
            "open3d": "0.19.0",
            "depth": 9,
            "voxelSize": 0.003,
            "densityTrimQuantile": 0.01,
            "pointCount": len(cloud.points),
            "preVisibilityTriangles": len(faces),
            "texturing": "per-face best visible training camera; ray depth test",
            "textureBlending": False,
        },
    )


def prepare(webscan, scene, resolution=1024, stride=3):
    import open3d as o3d

    job = webscan / ".data/jobs" / JOBS[scene]
    source = json.loads((job / "sfm/scene.json").read_text())
    original = json.loads((job / "artifacts/report.json").read_text())
    views = source["views"]
    # Derive split from actual Brush output filenames, not a guessed ordering.
    eval_names = {p.stem + ".jpg" for p in (job / "brush/eval_10000").glob("*.png")}
    if len(eval_names) != original["evaluation_views"]:
        raise ValueError("Evaluation split does not match Brush report")
    for view in views:
        view["image"] = str(job / "sfm/undistorted/images" / view["image_name"])
    train = [v for v in views if v["image_name"] not in eval_names]
    assert len(train) == original["training_views"]
    output = ROOT / "public/scenes" / scene
    output.mkdir(parents=True, exist_ok=True)
    (output / "photos").mkdir(exist_ok=True)
    all_views = []
    for i, v in enumerate(views):
        im = Image.open(v["image"]).convert("RGB")
        im.thumbnail((resolution, resolution), Image.Resampling.LANCZOS)
        photo = output / "photos" / f"{i:02}.jpg"
        im.save(photo, quality=95)
        k = np.array(v["K"])
        k[0] *= im.width / v["width"]
        k[1] *= im.height / v["height"]
        all_views.append(
            {
                "view": v["view"],
                "K": k.tolist(),
                "width": im.width,
                "height": im.height,
                "image_name": v["image_name"],
                "url": f"photos/{i:02}.jpg",
                "heldOut": v["image_name"] in eval_names,
                "sha256": digest(Path(v["image"])),
            }
        )
    started = time.perf_counter()
    cv2.setNumThreads(4)
    points = np.array(source["points"])
    model = GLB()
    pairs = []
    vertices = triangles = 0
    clouds = []
    centers = [
        -np.array(v["view"])[:3, :3].T @ np.array(v["view"])[:3, 3] for v in train
    ]
    forwards = [np.array(v["view"])[2, :3] for v in train]
    for i, left in enumerate(train):
        ranked = []
        for j in range(len(train)):
            angle = float(forwards[i] @ forwards[j])
            baseline = np.linalg.norm(centers[i] - centers[j])
            if i != j and angle > 0.65 and 0.015 < baseline < 1.0:
                ranked.append((baseline / (angle**3), j))
        # Pick the nearest viable overlapping pair, trying at most three candidates.
        for _, j in sorted(ranked)[:3]:
            size = (resolution, round(resolution * left["height"] / left["width"]))
            result = stereo_pair(left, train[j], points, size, stride)
            if result is None:
                continue
            xyz, uv, faces, image, coverage = result
            nt = len(faces)
            used = np.unique(faces)
            cloud = o3d.geometry.PointCloud(
                o3d.utility.Vector3dVector(xyz.reshape(-1, 3)[used])
            )
            cloud.estimate_normals(
                o3d.geometry.KDTreeSearchParamHybrid(radius=0.035, max_nn=30)
            )
            cloud.orient_normals_towards_camera_location(centers[i])
            clouds.append(cloud)
            pairs.append(
                {
                    "left": left["image_name"],
                    "right": train[j]["image_name"],
                    "triangles": nt,
                    "validGridFraction": round(coverage, 4),
                }
            )
            print(scene, i + 1, "/", len(train), "triangles", nt, flush=True)
            break
    if not pairs:
        raise ValueError("No valid stereo pairs")
    model, vertices, triangles, fusion = fuse_and_texture(clouds, train, resolution)
    meshfile = output / "mesh.glb"
    model.save(meshfile)
    mesh_seconds = time.perf_counter() - started
    gsfile = output / "gaussians.ply.gz"
    gsfile.write_bytes(
        gzip.compress(
            (job / "artifacts/gaussians.ply").read_bytes(), compresslevel=6, mtime=0
        )
    )
    manifest = {
        "schemaVersion": 1,
        "id": scene,
        "title": TITLES[scene],
        "source": {
            "repository": "https://github.com/sakorman/web-scan",
            "job": JOBS[scene],
            "dataset": "ETH3D " + scene,
            "url": "https://www.eth3d.net/datasets",
            "authors": "Schöps et al., CVPR 2017",
            "license": "CC BY-NC-SA 4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
        },
        "views": all_views,
        "trainingViews": len(train),
        "evaluationViews": len(eval_names),
        "normalization": source["normalization"],
        "sharedSfm": {
            "engine": "COLMAP 3.13.0",
            "registeredImages": len(views),
            "sparsePoints": original["sparse_points"],
            "reprojectionError": original["reprojection_error"],
            "note": "All photos participated in SfM; image holdout applies only to appearance and dense geometry.",
        },
        "gaussian": {
            "url": "gaussians.ply.gz",
            "count": original["gaussians"],
            "bytes": gsfile.stat().st_size,
            "decodedBytes": (job / "artifacts/gaussians.ply").stat().st_size,
            "sha256": digest(gsfile),
            "engine": "Brush 0.3.0 / SH3",
            "steps": original["steps"],
            "resolution": original["resolution"],
            "seconds": original["timings"]["training_and_model_export_seconds"],
            "timingSource": "web-scan historical run; not contemporaneous with Mesh reconstruction",
        },
        "mesh": {
            "url": "mesh.glb",
            "vertices": vertices,
            "triangles": triangles,
            "bytes": meshfile.stat().st_size,
            "sha256": digest(meshfile),
            "engine": "OpenCV StereoSGBM + Open3D Poisson + visibility-aware photo textures",
            "resolution": resolution,
            "stride": stride,
            "seconds": round(mesh_seconds, 4),
            "pairs": pairs,
            "fusion": fusion,
            "settings": {
                "blockSize": 5,
                "uniquenessRatio": 8,
                "leftRightTolerance": 1.5,
                "photometricTolerance": 40,
                "maxRelativeEdge": 0.07,
                "threads": 4,
            },
            "hardware": platform.platform(),
        },
        "limitations": [
            "Lightweight CPU stereo baseline, not a tuned COLMAP PatchMatch/OpenMVS pipeline.",
            "Poisson fills gaps without observed geometry; textures may have seams. No global texture blending.",
            "Shared SfM uses evaluation photos; this is not end-to-end unseen-camera evaluation.",
            "Historical GPU training and current CPU reconstruction times are not a controlled speed comparison.",
        ],
    }
    (output / "scene.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        scene,
        "DONE",
        triangles,
        "triangles",
        round(mesh_seconds, 2),
        "seconds",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-scan", type=Path, required=True)
    parser.add_argument("--scene", choices=["pipes", "office", "all"], default="all")
    parser.add_argument("--resolution", type=int, default=1024)
    parser.add_argument("--stride", type=int, default=3)
    args = parser.parse_args()
    if args.resolution < 256 or args.stride < 1:
        parser.error("resolution >= 256 and stride >= 1 required")
    for name in JOBS if args.scene == "all" else [args.scene]:
        prepare(args.web_scan.resolve(), name, args.resolution, args.stride)
