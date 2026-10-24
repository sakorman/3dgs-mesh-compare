# 更新日志

## 2026-10-24

- 修复快速切换场景时旧的 scene.json、PLY 和 GLB 下载继续占用网络的问题：新请求会中止旧请求，旧进度不会覆盖当前场景，只有最新请求可以解锁界面。
- 浏览器回归按 pipes → office → pipes 连续切换，最终状态正确回到管道房，控制台无错误，记录见[快速切换检查](docs/benchmarks/load-race-2026-10-24.json)。本轮没有测量实际节省的网络字节。
- 19 项测试、类型检查和生产构建通过；新增逻辑不改变模型、相机或画质路径。
- 参考 [Spark #476](https://github.com/sparkjsdev/spark/pull/476) 的异步销毁问题，以及 [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) 的 ArrayBuffer 解析接口。

- Spark 依赖从 2.3.1 升级到 2.4.0，保留当前按需渲染和位图回收逻辑。
- 升级后 `npm test` 19 项、TypeScript 检查和生产构建通过；浏览器完成管道房加载、自由查看、重置和 Mesh 线框回归，控制台无错误。
- 本轮只验证兼容性，没有宣称新的 FPS 或画质收益；2.4.0 的分页 LoD、新格式和压缩能力保留为后续独立实验。
- 参考 [Spark 2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0) 与 [Spark #476](https://github.com/sparkjsdev/spark/pull/476)。

- 修复场景切换与销毁时纹理位图未关闭的问题，统一回收材质贴图，并对共享几何、材质、纹理和位图去重。
- 浏览器对照：旧版退出管道房、办公室后分别仍有 12、22 张位图未关闭；修复后均为 0，当前场景纹理正常，往返切换的 3DGS 与 Mesh 像素哈希与基线一致。见[原始记录](docs/benchmarks/mesh-resources-2026-10-24.json)。
- 新增 5 项资源回收测试与可重复运行的浏览器检查页；19 项测试和生产构建通过。
- 参考：[Three.js 资源释放](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)、[GLTFLoader 位图说明](https://threejs.org/docs/pages/GLTFLoader.html)。

## 2026-10-23

- 预览渲染改为按需触发：静态页面不再持续提交双画布帧，Spark 排序完成、相机变化、窗口尺寸变化和 Mesh 线框变化会合并为下一帧。
- 管道房同条件浏览器回归：空闲 2 秒的渲染提交由每侧 240 次降为 0 次；照片切换、缩放、线框和相机变化与停帧后的像素结果一致，留出视角 PSNR/SSIM 与基线完全一致。
- 新增 5 项渲染调度测试，覆盖失效合并、暂停恢复、异步回调和释放；`npm test` 14 项通过，`npm run build` 通过。候选改动只影响空闲预览，性能实验仍由 benchmark 手动提交帧。
- 参考 [Spark 按需渲染说明](https://sparkjs.dev/docs/on-demand-rendering/)、[Spark 2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)；其 `onDirty` 机制用于合并异步排序和 LoD 完成后的重绘请求。

## 2026-10-23（计划）

- 建立 [3DGS 优化计划](docs/ROADMAP.md)，优先检查加载与资源生命周期、空闲绘制、排序和画质稳定性。
- 整理 [研究索引](docs/RESEARCH.md)，加入近期压缩研究；后续以相同场景、相机和评分尺寸验证收益。
- 参考：[Spark](https://github.com/sparkjsdev/spark)、[COSA-GS 论文](https://arxiv.org/abs/2609.30245)与[实现](https://github.com/pengpeng-yu/COSA-GS)、[RDCompGS](https://arxiv.org/abs/2610.19538)。
