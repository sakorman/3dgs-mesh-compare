# 重建对照台 · 3DGS × Mesh

用同一组真实照片，对比 **3D Gaussian Splatting** 和 **传统立体匹配 + Poisson Mesh** 的重建效果、浏览器渲染性能与模型体积。默认使用 [sakorman/web-scan](https://github.com/sakorman/web-scan) 的 ETH3D 管道房照片，可切换办公室。

项目包含实际训练的 SH3 高斯模型、独立重建的纹理 GLB 和照片，克隆后即可运行，不需要 GPU 训练环境。没有预填 FPS 或画质成绩。

## 运行

需要 Node.js 20.19+、npm，以及支持 WebGL2 和 DecompressionStream 的现代浏览器。

```bash
git clone https://github.com/sakorman/3dgs-mesh-compare.git
cd 3dgs-mesh-compare
npm ci
npm run dev
```

打开 `http://127.0.0.1:5178`。两个场景的数据总计约 130 MiB，首次下载高斯模型需要等待；开发服务和 GitHub Pages 使用的 gzip 响应方式都已兼容。代码与默认数据都是静态文件，没有后端服务。

```bash
npm run build   # strict TypeScript + Vite 构建
npm run preview
npm test        # 数值、相机和模型解压测试
```

## 页面怎么用

首页只保留模型、照片与查看操作。详细性能/画质评测位于独立的 `benchmark.html` 实验页，可通过页头「评测实验」进入。首页不显示评测表格和说明折叠区。

- **拍摄视角 / 照片条**：左右使用完全相同的相机外参、内参和画幅。蓝点表示留出照片。
- **自由查看**：拖动任一模型同步旋转，右键平移，滚轮缩放；重置回标定照片视角。
- **对照原照片**：明确切换两边画面为对应去畸变照片；默认显示真实 WebGL 模型。
- **Mesh 线框**：查看三角结构，不参与性能或画质评分。
- **运行性能对比**：当前分辨率、固定相机；交替单独绘制每个后端，避免双画布并行竞争。
- **评测留出画质**：依次渲染所有留出视角，计算与同尺寸去畸变照片的 PSNR、SSIM。
- **导出 JSON**：保存原始性能样本、逐视角画质、相机、分辨率、浏览器和模型来源。

切换场景/分辨率会清空报告；切换拍摄视角会清空该视角的性能成绩。测试时冻结控制，进入后台、窗口变化、上下文丢失或点击取消会作废测试。

## 数据与重建

| 场景 | 总照片 | 训练 / 留出 | 3DGS |
| --- | ---: | ---: | ---: |
| ETH3D pipes（默认） | 14 | 12 / 2 | 300,000 高斯，SH3 |
| ETH3D office | 26 | 22 / 4 | 231,428 高斯，SH3 |

**共享阶段**：复用 web-scan 已完成的 COLMAP 3.13.0 位姿与去畸变结果，两条路径使用同一场景归一化坐标。所有照片都参与了 SfM。留出仅针对高斯训练、稠密立体匹配及纹理，因此这是固定几何下的渲染留出实验，不是完全独立的端到端泛化测试。

**3DGS**：直接复用 web-scan 的 Brush 0.3.0 / 10,000 步 / 1024 分辨率模型。保留完整 SH3；使用 Spark 2.3.1、深度排序、关闭 LoD，未将原照片伪装成模型。场景记录原任务 ID、文件 SHA-256 和历史训练时间。

**Mesh**：独立读取相同训练照片与相机；选择有重叠的照片对，极线校正后执行 OpenCV SGBM、左右一致性及光度检查，获得真实深度。点云法线朝向拍摄相机，体素融合和离群过滤后，Open3D Screened Poisson 重建连续表面；按射线可见性和夹角选择训练照片为三角形贴图。输出包含纹理的 GLB。Mesh 流程不读取高斯位置、颜色或协方差。

这是一个可在 CPU 上复现的传统摄影测量基线，**不代表经过调优的 COLMAP PatchMatch / OpenMVS / 商业摄影测量软件上限**。弱纹理、反光、匹配失败会损伤几何；Poisson 会填补缺少观测的区域；贴图可能有接缝。应同时看原照片、留出误差和自由视角，而非只按模型点数判断质量。

默认参数、照片哈希、立体匹配对、几何数量、模型哈希在 `public/scenes/<scene>/scene.json` 中。照片经过相同长边 1024 缩放，内参随尺寸缩放。留出集合从原 Brush 评估输出的文件名读取，不假定照片排序。

## 评测口径

### 浏览器性能

AB / BA / AB / BA 共四轮，每组每轮 12 帧预热 + 40 帧采样，总计每组 160 帧。固定同一个标定相机、相同像素尺寸、DPR=1、黑色背景、关闭 MSAA，排序稳定后开始。结果仅反映**固定视角稳态渲染**；不测首次下载/解码、训练、移动镜头排序延迟或峰值显存。

- CPU：主线程 `renderer.render()` 提交中位数 / P95，不包含异步高斯排序 Worker。
- GPU：`EXT_disjoint_timer_query_webgl2` 异步查询；不可用时留空，发生 disjoint 时丢弃该组全部 GPU 结果。不调用 `gl.finish()`。
- FPS：`requestAnimationFrame` 实际间隔的倒数，受屏幕刷新率与调度限制，不能等同于无限制渲染吞吐。
- 两种表示执行不同的工作量，三角数与高斯数不是可直接等价比较的单位。
- 双模型预览不作为正式性能结果；无头浏览器或软件渲染的结果不能代替真实 GPU 测量。

### 画质

在当前渲染尺寸，读取浏览器实际模型像素，和同样缩放的 JPEG 去畸变照片比较。两边使用相同背景、画幅及相机，无曝光拟合、裁剪或遮罩，Mesh 未覆盖的黑色区域计入误差。

PSNR 使用全图 RGB MSE；SSIM 使用每通道 RGB、11×11 Gaussian 窗口（σ=1.5）、有效内部区域、C1=(0.01×255)²、C2=(0.03×255)²。先逐视角计算，再等权平均。完全一致的 PSNR 用 JSON `null` / UI `∞` 表示。这里是浏览器实现与显示管线的画质；不直接与 Brush 日志中的训练器指标混算。不含 LPIPS、几何真值 Chamfer/F-score。

### 重建时间与体积

3DGS 时间来自 web-scan 历史 GPU 训练记录；Mesh 时间来自当前 CPU 构建，均单独标识，不推导速度倍数。模型大小是 gzip PLY 与含纹理 GLB 的文件字节数，不是 GPU 显存占用。高斯解压后字节数也记录在 manifest。

## 复现 Mesh

需要 Python 3.12，以及有相应任务产物的本地 web-scan 数据目录。源码仓库本身不含 web-scan 的 `.data`；本项目已经提交了可直接查看的两组结果。

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/prepare_scenes.py --web-scan /path/to/web-scan --scene all
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

脚本只读来源仓库，写入当前项目 `public/scenes`。精确任务 ID 为 pipes `82acea65e9874f64806815a592015dec`、office `59bb5740d2e945d9a459ca2514c66bb2`；它们对应 web-scan 公开的精细档质量记录。重建脚本可调整 `--resolution` 和 `--stride`，这些改变会写入新 manifest；应重新运行网页评分。

## GitHub Pages

构建使用相对路径，支持仓库子路径。Settings → Pages → Source 选择 GitHub Actions，再运行 **Deploy comparison to GitHub Pages** 工作流。普通推送运行 CI，不自动变更线上部署。

## 目录

```text
src/                  同步相机、双渲染器、测量、画质和界面
scripts/prepare_scenes.py  独立 Mesh 重建与场景打包
public/scenes/         两组照片、模型和来源清单
public/licenses/      运行时第三方许可与数据说明
tests/                数学与数据完整性检查
docs/                 设计与验证记录
.github/workflows/    CI 与手动 Pages 发布
```

代码为 MIT。**照片及衍生模型使用 ETH3D 的 CC BY-NC-SA 4.0，限非商业用途**；这部分不适用项目 MIT 许可。详见 [第三方与数据许可](THIRD_PARTY_NOTICES.md)。

技术参考：[3DGS 原论文与实现](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)、[OpenCV StereoSGBM](https://docs.opencv.org/4.x/d2/d85/classcv_1_1StereoSGBM.html)、[Open3D 表面重建](https://www.open3d.org/docs/release/tutorial/geometry/surface_reconstruction.html)、[Spark](https://sparkjs.dev/docs/)、[ETH3D](https://www.eth3d.net/datasets)。
