# Third-party notices

Project code: MIT, copyright (c) 2026 sako. Camera coordinate conversion is adapted from sakorman/web-scan (MIT). Gaussian rendering uses Spark 2.3.1 (MIT, World Labs Technologies, Inc.) and Three.js 0.180.0 (MIT). License copies are in public/licenses and included in static builds. Brush 0.3.0 is an external Apache-2.0 training engine; it is not redistributed here.

The default scene photos and all derived Gaussian and mesh models in public/scenes are derived from **ETH3D, Schöps et al., CVPR 2017**, reused through sakorman/web-scan. They retain **CC BY-NC-SA 4.0** and are excluded from the code's MIT license. Noncommercial use only; attribution and ShareAlike apply to adaptations.

- Dataset: https://www.eth3d.net/datasets
- License: https://creativecommons.org/licenses/by-nc-sa/4.0/
- Source project: https://github.com/sakorman/web-scan
- Modifications: EXIF normalization, image resizing and undistortion; COLMAP calibration; Brush Gaussian training; CPU stereo depth estimation, Poisson reconstruction and photo texturing. Per-image provenance and hashes are in each scene.json.

Offline reconstruction dependencies: OpenCV 4.11 (Apache-2.0), Open3D 0.19 (MIT), NumPy and SciPy (BSD-3-Clause), Pillow (HPND). These are installed separately, not vendored. Their own distributions contain the applicable full license notices.
