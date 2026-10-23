# 更新日志

## 2026-10-23

- 预览渲染改为按需触发：静态页面不再持续提交双画布帧，Spark 排序完成、相机变化、窗口尺寸变化和 Mesh 线框变化会合并为下一帧。
- 管道房同条件浏览器回归：空闲 2 秒的渲染提交由每侧 240 次降为 0 次；照片切换、缩放、线框和相机变化与停帧后的像素结果一致，留出视角 PSNR/SSIM 与基线完全一致。
- 新增 5 项渲染调度测试，覆盖失效合并、暂停恢复、异步回调和释放；`npm test` 14 项通过，`npm run build` 通过。候选改动只影响空闲预览，性能实验仍由 benchmark 手动提交帧。
- 参考 [Spark 按需渲染说明](https://sparkjs.dev/docs/on-demand-rendering/)、[Spark 2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)；其 `onDirty` 机制用于合并异步排序和 LoD 完成后的重绘请求。

## 2026-10-23（计划）

- 建立 [3DGS 优化计划](docs/ROADMAP.md)，优先检查加载与资源生命周期、空闲绘制、排序和画质稳定性。
- 整理 [研究索引](docs/RESEARCH.md)，加入近期压缩研究；后续以相同场景、相机和评分尺寸验证收益。
- 参考：[Spark](https://github.com/sparkjsdev/spark)、[COSA-GS 论文](https://arxiv.org/abs/2609.30245)与[实现](https://github.com/pengpeng-yu/COSA-GS)、[RDCompGS](https://arxiv.org/abs/2610.19538)。
