# 参考图读回与评分稳定性

2026-10-29，基线 `0344969`，Chromium 156 / macOS。接续[参考照片等待取消](IMAGE-DECODE.md)中办公室照片 01 的两种参考像素，分开记录原尺寸 Canvas2D 读回与 768 长边缩放结果。未修改生产代码、模型、照片、相机、划分或评分公式。

## 结论

**既有波动在原尺寸读回时就可观察到，不能只归因于缩放。** 取消恢复检查再次得到此前的 `36ca148f…`，普通评分流程得到 `5bd1500e…`。对同一张 1024×667 JPEG，原尺寸 RGB 有 323,356 个通道不同，每个差值均为 1；缩放到 768×500 后最大差值为 8。Alpha 全部相同。

| 观察状态 | 原尺寸 RGBA SHA-256 前缀 | 768×500 RGBA SHA-256 前缀 |
| --- | --- | --- |
| 普通评分流程 | `78ad868a…` | `5bd1500e…` |
| 取消恢复后 | `d7c4fe25…` | `36ca148f…` |

这只定位到 HTMLImageElement → Canvas2D 的像素路径；原尺寸读回仍包含绘制、颜色转换和量化，**不是独立 JPEG 解码器的原始输出**。浏览器内部采用何种解码缓存、颜色转换或 GPU/CPU 路径尚未观测，不能据此断言根因或给出浏览器通用保证。恢复前后的办公室八份模型画面摘要一致，差异不来自模型渲染。

## 未采用：直接设置 willReadFrequently

对六张留出照片，各运行三次，分别使用默认 Canvas2D 与 `{willReadFrequently:true}`，交替先读原尺寸或先读缩放尺寸，共 72 组。每种设置在本次三次重复及两种顺序中保持相同摘要，但两种设置之间的六张原尺寸与缩放图均不同。记录中的 `cpu` 仅标识这个请求选项，未测量实际执行后端。

在真实查看器中再对六个视角各运行两次，共 12 次视角取样。生产路径先读取参考图，再对**同一已解码 Image 实例**做诊断；同一份模型 RGBA 分别对两种参考图评分，排除模型变化。

| 场景 / 照片 | 3DGS ΔPSNR（dB） | 3DGS ΔSSIM | Mesh ΔPSNR（dB） | Mesh ΔSSIM |
| --- | ---: | ---: | ---: | ---: |
| pipes / 01 | +0.072443 | -0.00026623 | +0.024662 | -0.00018857 |
| pipes / 09 | +0.051800 | +0.00095472 | +0.024731 | +0.00032894 |
| office / 01 | +0.012902 | -0.00134224 | -0.001928 | -0.00107635 |
| office / 09 | +0.051317 | -0.00011087 | +0.010378 | -0.00061172 |
| office / 17 | +0.059932 | +0.00096765 | +0.033245 | +0.00008201 |
| office / 25 | +0.001295 | -0.00103021 | +0.004296 | -0.00079653 |

Δ 为 `willReadFrequently=true` 减默认设置。两次重复的模型摘要与成绩一致。数字来自参考输入改变，**不代表画质提升或退化**。该选项也没有复现完整的历史缩放状态：办公室 01 的频繁读取画布为 `b377910a…`，不同于恢复后的 `36ca148f…`。因此暂不用于修复，也不把得分上升视为优化。

另一个保留的观察：pipes 照片 09 在独立照片夹具与完整查看器之间，默认设置的原尺寸、缩放摘要均有变化；完整查看器内部两次重复相同。这进一步说明不能用一次独立画布运行代替完整页面状态。HTTP 缓存未受控，本次没有计时、内存或跨浏览器比较。

## 验证与复现

- 两场景沿用完整 SH3、关闭 LoD、DPR=1，pipes 为 768×505，office 为 768×500；模型绘制串行，照片、相机、留出划分不变。
- 72 组独立参考读回、12 次真实视角评分、office 四项取消检查完成，无页面错误或未处理拒绝。原有 116 项测试、类型检查与生产构建通过。
- 保存了 38 份不同摘要的原始 RGBA；夹具提供按摘要命名的下载链接，字节数与 SHA-256 已核对。仓库保存测量和摘要；本地原始文件保留在 `.qa/reference-pixels/`。
- `scene.json` 的 `views[].sha256` 是缩放前来源照片摘要，并非网页 JPEG 摘要，见[准备脚本](../scripts/prepare_scenes.py)。汇总另列实际网页 JPEG 的摘要，六个文件均与基线 Git 内容一致；不能将两类摘要混用。

执行 `npm run dev -- --port 5190`，依次打开：

1. `tests/browser/reference-pixels.html`：运行独立读回矩阵，导出原尺寸及缩放 RGBA。
2. `tests/browser/reference-quality.html?scene=pipes` 与 `?scene=office`：各加载一次场景，运行两次逐视角评分，完成后释放查看器。
3. `tests/browser/image-decode.html?scene=office&probe=reference`：沿用已有取消恢复检查，在正常评分期间附加原尺寸读回。诊断在生产参考输入已取出后执行，仍可能影响后续浏览器状态，不当作无干扰内部跟踪。

原始记录：[72 组矩阵](benchmarks/reference-pixels-matrix-2026-10-29.json)、[pipes 评分](benchmarks/reference-pixels-quality-pipes-2026-10-29.json)、[office 评分](benchmarks/reference-pixels-quality-office-2026-10-29.json)、[取消恢复](benchmarks/reference-pixels-recovery-office-2026-10-29.json)、[来源、差异和完整摘要](benchmarks/reference-pixels-summary-2026-10-29.json)。

下一步优先用独立解码得到的明确 RGB 输入与原尺寸 Canvas2D 对照，或记录实际浏览器解码/颜色路径，分别验证第一次读取、取消恢复和跨页面状态。若未来固定软件读回或重采样，必须作为新的评分协议明确标识，并重建全部基线；暂不引入参考图缓存。

## 研究参考

[HTML Canvas 标准](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-imagesmoothingquality)不指定具体插值算法；`willReadFrequently` 是读回优化提示，不保证跨实现逐像素一致。

[Brush 当前图片加载实现](https://github.com/ArthurBrussee/brush/blob/1388f74c6fe0236f68ee4915564bf00e9d2e3747/crates/brush-dataset/src/load_image.rs)显式选择 JPEG 缩放解码及后续 Lanczos3，不能与浏览器默认 drawImage 混作同一参考管线。[3DGS 质量评价综述](https://arxiv.org/html/2609.23027v1#S5)强调视角、渲染配置与观察协议，详见[研究索引](RESEARCH.md#测量参考参考图管线也是评分协议的一部分)。
