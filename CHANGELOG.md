# 更新日志

## 2026-10-25

- 修复参考照片解码期间取消评测后仍执行 3DGS 绘制、读回和画质计算的问题；排序等待同步接入取消信号，已释放的查看器不再恢复相机或重新开启预览。
- 延迟返回检查中，取消后的像素读取由 1 次降至 0 次；离页销毁后的绘制、相机修改均由 1 次降至 0 次。见[回归说明](docs/QUALITY-CANCELLATION.md)与[原始记录](docs/benchmarks/quality-cancel-2026-10-25.json)。参考照片解码本身仍不可中断。
- 两场景全部 6 个留出视角正常评测与 JSON 导出通过，逐视角 PSNR/SSIM/MAE 与原记录差异小于 1e-12；39 项测试、类型检查与构建通过，不新增 FPS 提升结论。
- 参考 [Spark 异步销毁修复](https://github.com/sparkjsdev/spark/pull/476)与[重建系统综述](https://arxiv.org/abs/2610.17513)；核实 Spark 几何释放修复已包含在当前版本，避免重复清理。

- 完成绘图缓冲保留的串行 ABBA 对照，新增可复现检查页、2,560 个原始帧样本与[耗时报告](docs/DRAWING-BUFFER.md)。
- 不采用两侧同时关闭保留的方案：office 3DGS 的 GPU 时间没有稳定收益，Mesh 中位数由 0.645ms 增至 0.765ms；pipes 3DGS 的下降只记录为当前设备观察，不推广为 FPS 提升。
- 全部 6 个留出视角、两个后端的像素哈希和画质指标完全一致；候选空闲显示、拖动和复位正常。39 项测试、类型检查与构建通过，默认模型和渲染设置保持原样。
- 新增 [WebSplatter 论文](https://arxiv.org/abs/2602.03207)与[作者实现](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be)研究：核对 WebGPU 排序和不透明度边界，记录 Spark 的阈值差异；后续先验证等阈值片元裁剪。截图读取参考 [Three.js 说明](https://threejs.org/manual/pages/tips.html)。

- 区分页面缓存与真正离页：缓存事件保留已就绪的查看器，返回时恢复按需绘制；未就绪或上下文失效时重载。清理监听提前到首次模型加载之前。
- 两次合成缓存往返中，旧版会销毁模型，新版复用原模型且额外加载次数为 0；合成早期离页也能在元数据返回前清理查看器。见[原始记录](docs/benchmarks/page-lifecycle-2026-10-25.json)。
- 新增 6 项页面生命周期测试，39 项测试和构建通过。当前浏览器的真实后退未命中 bfcache，不报告原生缓存命中率或导航加速。
- 参考：[浏览器前进/后退缓存](https://web.dev/articles/bfcache)、[pagehide 事件](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)、[Spark 按需渲染](https://sparkjs.dev/docs/on-demand-rendering/)。


- Gaussian gzip PLY 改为响应流直接解压，省去完整压缩包的中间 ArrayBuffer/Blob；仍在解压完成后初始化 Spark。
- 读取和解压接入加载取消信号，中断时停止数据源并释放读取锁，统一浏览器的取消错误。
- 管道房与办公室在 HTTP 自动解压、原始 gzip 两条路径下，输出哈希均与旧版一致；33 项测试通过，包含完整模型逐字节对照。见[浏览器记录](docs/benchmarks/model-stream-2026-10-25.json)和[复现说明](docs/MODEL-STREAM.md)。未测量内存峰值、首帧耗时或 FPS 增益。
- 参考：[Compression Streams](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)、[Spark FetchSource](https://github.com/sparkjsdev/spark/pull/463)；新增 [SPZ](https://github.com/nianticlabs/spz) 与 [SplatStream](https://arxiv.org/abs/2607.25971) 研究候选，尚未转换默认模型或引入分页渲染。


- 修复旧加载晚完成时覆盖相机或清空新场景的问题；每次加载独立持有资源，失败、取消和销毁只回收对应对象。
- 一个模型失败时立即中止同次下载并回收另一个已成功解析的模型；取消后才返回的解析结果也会释放。故障注入中未关闭位图从 12 张降为 0，随后重试成功。
- 新增 5 项单元测试和 4 项确定性浏览器检查，旧版本四项均复现问题，修复后全部通过；24 项测试与构建通过。见[对照记录](docs/benchmarks/load-lifecycle-2026-10-25.json)及[复现方法](docs/LOAD-LIFECYCLE.md)。
- 修正历史记录范围：原按钮切换记录只覆盖顺序操作；位图对照的两个版本均使用 Spark 2.3.1。
- 参考：[Spark #476](https://github.com/sparkjsdev/spark/pull/476)、[GLTFLoader 解析接口](https://threejs.org/docs/pages/GLTFLoader.html)。模型、相机与渲染参数未改动，不新增 FPS 或画质提升结论。

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
