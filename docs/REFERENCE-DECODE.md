# 独立解码 RGB 与 PNG 对照

2026-10-29，基线 `08e1507`。接续[参考图像素诊断](REFERENCE-PIXELS.md)，把网页 JPEG 用浏览器以外的解码器读成明确的 RGB，再以 PNG 无损保存该 RGB，区分原尺寸输入与后续缩放。生产代码、默认照片与模型均未改变。

## 观察结果

Python 3.12.14 / Pillow 11.3.0 / libjpeg-turbo 3.1.1 解出的六张原尺寸 RGBA，均与上次浏览器 `willReadFrequently=true` 路径**逐字节相同**，也匹配 office 照片 01 取消恢复后的原尺寸结果。六张网页 JPEG 均只包含 JFIF 信息，未发现 ICC / EXIF 项；转换不额外应用颜色变换、不缩放。

浏览器 Chromium 156 / macOS 对六张照片分别读取 JPEG 和 PNG、默认与频繁读取画布，每种组合重复三次，共 72 组。第三次读取前丢弃一张已解码 Image 的 src，再重新读取；该步骤未模拟停流或正式评测取消。

- 36 次 PNG 原尺寸读回全部等于独立解码 RGB，覆盖两种画布设置和三次重复。
- 六张 PNG 在默认与频繁读取画布之间仍各有两种不同的缩放摘要；同种设置下三次重复一致。因此固定原尺寸 RGB 仍不足以统一 Canvas2D 重采样。
- 六张 JPEG 的频繁读取画布与独立解码 RGB 一致，默认画布仍出现每个变化通道相差 1 的原尺寸差异；本次各组合内部未出现重复波动。

办公室照片 01 的对照特别明确：

| 路径 | 原尺寸 RGBA 摘要前缀 | 768×500 摘要前缀 |
| --- | --- | --- |
| JPEG → 默认画布 | `78ad868a…` | `5bd1500e…` |
| 独立 RGB → PNG → 默认画布 | `d7c4fe25…` | `36ca148f…` |
| JPEG 或 PNG → 频繁读取画布 | `d7c4fe25…` | `b377910a…` |

PNG 默认画布完整复现了此前取消恢复后的参考图摘要。这个控制实验将**原尺寸像素来源**与**缩放设置**分成两项可验证变量；浏览器内部具体的 JPEG 解码、颜色转换、量化或缓存路径仍未直接观测。不能据此宣称已确定具体浏览器实现缺陷，也不能把 Pillow 输出视为拍摄前或 JPEG 编码前的真值。

## 体积与评分代价

| 照片 | JPEG 字节 | RGB PNG 字节 | PNG / JPEG |
| --- | ---: | ---: | ---: |
| pipes / 01 | 159,332 | 616,200 | 3.87× |
| pipes / 09 | 169,953 | 678,629 | 3.99× |
| office / 01 | 131,949 | 525,256 | 3.98× |
| office / 09 | 88,351 | 377,794 | 4.28× |
| office / 17 | 151,130 | 605,988 | 4.01× |
| office / 25 | 130,693 | 534,645 | 4.09× |
| 合计 | **831,408** | **3,338,512** | **4.02×** |

PNG 使用 Pillow `compress_level=6`，仅为该编码设置下的文件字节比，未测网络冷加载或解码耗时。候选文件存于 `.qa/reference-decode/`，没有覆盖默认 JPEG。

复用上次保存的 12 份模型 RGBA，用当前 `src/metrics.ts` 对本次新采集的默认画布 JPEG / PNG 参考图评分：最大绝对变化为 **0.00437383dB PSNR / 0.00110235 SSIM**。两边始终使用同一份模型像素；这不是新的渲染性能、画质收益或 GPU 实验。pipes 为 768×505，office 为 768×500，照片划分与像素尺寸保持一致。

**暂不替换默认参考图。** PNG 总体积约为 JPEG 的四倍，且仍需规定缩放算法和评分协议。后续渲染优化应保留并检查参考与模型输入摘要，输入不同的微小分差不能直接归因于模型。若采用固定解码和固定重采样，另设明确版本的评分协议与基线，不混入现有结果。当前已获得可复现的独立 RGB 控制，不再重复同一 JPEG/PNG 矩阵；加载冷启动、峰值内存与候选初始化仍按原计划推进。

## 复现与验证

1. 使用项目 Python 环境运行 `.venv/bin/python scripts/reference_decode_control.py`，生成六张 PNG、RGBA 与版本/来源清单。默认不改 `public/`。如有上次 `.qa/reference-pixels/` 的原始捕获，会校验摘要并比较；缺失时标记 `capture-unavailable`，不伪造结果，也不阻止生成控制。
2. 运行 `npm run dev -- --port 5190`，打开 `tests/browser/reference-decode.html` 并运行检查。夹具先核验 JPEG、PNG 和独立 RGBA 的 SHA-256，提供不同摘要的原始 RGBA 下载。将结果保存到 `.qa/reference-decode/browser.json`，下载的 RGBA 保存至同目录。
3. 有上次模型原始捕获时，运行 `node --import tsx scripts/reference_decode_scores.ts`，用 `.qa/reference-pixels/` 中的固定模型字节重算分差。缺少模型捕获需先通过[原评分夹具](../tests/browser/reference-quality.ts)保存输入；不得用新画面冒充旧摘要。

六张 JPEG 与基线 Git 字节相同；PNG 在 Pillow 中往返解码无损；72 组浏览器检查无错误，36 次 PNG 原尺寸读回匹配，12 组冻结模型评分完成。原始捕获保留于本地，公开记录：[独立解码及版本](benchmarks/reference-decode-manifest-2026-10-29.json)、[浏览器样本](benchmarks/reference-decode-browser-2026-10-29.json)、[逐视角分差](benchmarks/reference-decode-scores-2026-10-29.json)、[汇总](benchmarks/reference-decode-summary-2026-10-29.json)。

类型检查、评分脚本单独严格类型检查、116 项原有测试与生产构建通过；网页构建产物与此前一致。本次没有训练、模型切换、漫游变化或 GPU 计时。

## 参考

[原始 3DGS render.py](https://github.com/graphdeco-inria/gaussian-splatting/blob/54c035f7834b564019656c3e3fcc3646292f727d/render.py)保存参考图与渲染 PNG，再由 [metrics.py](https://github.com/graphdeco-inria/gaussian-splatting/blob/54c035f7834b564019656c3e3fcc3646292f727d/metrics.py)读入评价；参考文件的生成步骤也是评分口径的一部分。仅借鉴保存明确输入的验证思路，未复制其代码或替换当前指标。

新读 [3DGSI-Assessor](https://arxiv.org/abs/2608.03279) 将整体、几何与颜色质量分别建模；但其[公开仓库](https://github.com/YukeXing/3DGSI-Assessor/tree/6e50dad6491fcafd2793e76eb30dace3223e55a9)目前只有 README 与 LICENSE，无法验证作者实现，暂不接入。版本、许可和适用范围见[研究索引](RESEARCH.md#候选固定评价输入与分维度质量检查)。
