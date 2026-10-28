# 3DGS 研究索引

查阅日期：2026-10-27。以下区分已验证的应用改进与尚未验证收益的研究候选。

## 实现

| 项目                                                   | 关注点                                            | 当前状态                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Spark](https://github.com/sparkjsdev/spark)           | 浏览器渲染、排序、LoD、资源生命周期与压缩格式支持 | 当前使用 2.4.0，基础加载与查看已检查；应用层加载取消与回滚有专项测试，分页/LoD 和新格式仍待验证 |
| [Brush](https://github.com/ArthurBrussee/brush)        | 跨平台重建、训练与模型导出                        | 默认模型来自 0.3.0；新版本和参数另建实验                                                                                 |
| [gsplat](https://github.com/nerfstudio-project/gsplat) | 光栅化、训练与内存管理实现                        | 参考；先核对后端和设备条件                                                                                               |
| [COSA-GS](https://github.com/pengpeng-yu/COSA-GS)      | 压缩模型与跨平台解码一致性                        | 待评估；检查实现、许可和浏览器解码成本                                                                                   |

## 论文

| 论文                                                                                                 | 日期    | 研究方向与本项目关注点                                   |
| ---------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| [3D Gaussian Splatting for Real-Time Radiance Field Rendering](https://arxiv.org/abs/2308.04079)     | 2023-08 | 表示、优化与光栅化基础；作为实现和测量口径参考           |
| [Mip-Splatting](https://arxiv.org/abs/2311.16493)                                                    | 2023-11 | 多尺度抗锯齿；检查缩放与远近视角中的细节变化             |
| [StopThePop](https://arxiv.org/abs/2402.00525)                                                       | 2024-02 | 排序与视角一致性；关注移动相机中的跳变及计算代价         |
| [Towards Practical Compression of 3D Gaussian Splatting / COSA-GS](https://arxiv.org/abs/2609.30245) | 2026-09 | 压缩与跨平台解码；关注模型体积、解码一致性和本地可实现性 |
| [RDCompGS](https://arxiv.org/abs/2610.19538)                                                         | 2026-10 | 面向图像编码的率失真优化；关注码率、解码成本与画质权衡   |

## 近期结论

Spark 官方按需渲染说明，建议通过 `onDirty` 合并异步排序、LoD 和流式加载的重绘请求，避免静态场景用定时器轮询。当前项目采用同样的失效通知机制，但仍固定使用完整 PLY 和关闭 LoD；版本升级与 LoD 模型另行验证。

### 已采用：关闭 GLTF 解码位图

Three.js 的 `Texture.dispose()` 释放 GPU 纹理，但不会替应用关闭 `ImageBitmap`。GLTFLoader 会优先使用 ImageBitmapLoader，且同一场景可能共享材质和图像源。当前独立加载的 GLB 按场景持有资源；切换或销毁时去重释放 GPU 对象，并关闭对应位图。两组默认场景已复现并验证修复，记录见[资源回收对照](benchmarks/mesh-resources-2026-10-24.json)。

参考：[Three.js 资源释放](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)、[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)。

### 加载取消与销毁边界

Spark 2.4.0 的 [#476](https://github.com/sparkjsdev/spark/pull/476) 处理渲染器销毁后仍在运行的排序与 LoD 任务拒绝；该补丁不改变调用方持有的 `SplatMesh.initialized` Promise。当前依赖使用 2.4.0。应用层增加每次加载独立的资源所有权与取消检查，覆盖旧元数据晚返回、旧首帧晚完成、单模型失败及销毁后的回调。不可中断的解析与初始化仍可能继续计算，但其结果到达后会被释放，不能再安装到当前场景。分页/LoD 路径不在这些验证范围内。详见[加载生命周期检查](LOAD-LIFECYCLE.md)。

重新查阅的 [COSA-GS](https://arxiv.org/abs/2609.30245) 涉及率失真训练与跨平台解码，继续保留为独立压缩实验候选；文件压缩率和解码资源回收分别测量。

### 训练候选：gsplat 图片缓存

gsplat 最近的 [image cache 提交](https://github.com/nerfstudio-project/gsplat/commit/512d366b67073d77ca099ede742683c165dfc23b) 报告在 8 张 B200 上将 steady step 从 13.88ms 降至 9.78ms（1.42×），代价是每 rank 约 502MiB 主机缓存和 1.44s 预加载。当前项目只在浏览器查看预训练模型，没有训练数据加载路径，因此不直接移植；后续 Brush 训练实验应单独核对主机内存和端到端时间。

### 已采用：gzip PLY 流式读取

现有 PLY 不改格式，使用浏览器响应流直接解压，并把加载取消信号传入读取与解压阶段。HTTP 已自动解压的响应按原始 PLY 读取。验证范围是完整字节一致性和中断行为，未将其称为 LoD 或渐进渲染；详见[读取验证](MODEL-STREAM.md)。

### 待验证：分块格式与渐进传输

Spark [#463](https://github.com/sparkjsdev/spark/pull/463)（2026-10-16 合并）将分页内容获取抽象成 FetchSource，适合后续探索分块读取。当前完整 PLY 不是分页资源，不能直接以该接口替换并宣称首帧收益。

[SPZ 官方实现](https://github.com/nianticlabs/spz)采用 MIT 许可；查阅版本 [affd0ec](https://github.com/nianticlabs/spz/commit/affd0ecea7fbb4c265ee119475af7ee5b2997482)（2026-08-05）的说明包含 SPZ v4 的 ZSTD 压缩及属性量化。转换会涉及精度与坐标约定，需要独立测试 SH3、解码耗时和留出画质，当前尚未转换默认模型。

[SplatStream](https://arxiv.org/abs/2607.25971)（2026-07-28，v2 更新于 07-29）研究动态 GS 的质量/分辨率分层、重要性分包和自适应传输。分包思路值得研究，但其动态编码与传输系统不能直接等同于本项目的静态 PLY 流式解压；暂列研究候选，不记录为已实现收益。

### 已采用：区分页面缓存与永久离页

浏览器的 `pagehide.persisted=true` 表示文档计划进入 bfcache，不能直接按永久销毁处理。当前页面保留已就绪且上下文有效的查看器，返回时重新请求绘制；普通离页则中止评测并释放资源，监听在首次异步加载前安装。未就绪或失效的缓存视图恢复时重载。

[Google 的 bfcache 指南](https://web.dev/articles/bfcache)（页面更新于 2026-10-16）和 [MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event) 用于确定事件语义；[Spark 按需渲染](https://sparkjs.dev/docs/on-demand-rendering/) 用于恢复时的重绘请求。合成事件回归已通过；静态构建的实际导航得到 `persisted=false`，尚不能给出真实缓存命中下的性能结论。详见[页面生命周期记录](PAGE-LIFECYCLE.md)。

### 暂缓：同时关闭两侧绘图缓冲保留

在 Spark 2.4.0 / Three.js 0.180.0、Apple M5 / Chromium 153 上完成 ABBA 对照。全部留出像素一致，但办公室 3DGS 的 GPU 时间没有稳定收益，Mesh 时间增加，故保留默认值。仅调整高斯上下文可另建实验。详见[耗时、画质与原始样本](DRAWING-BUFFER.md)，此次 GPU 查询不覆盖完整浏览器合成成本。

### 待验证：WebSplatter 的不透明度边界

[WebSplatter 论文 v1](https://arxiv.org/html/2602.03207v1)发表于 2026-02-03；[作者主页](https://websplatter.github.io/)列为 ACM Multimedia 2026，标题与 v1 有调整。查阅[公开实现 16bb06e](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be)（2026-08-29）及 [1.0.0 发行](https://github.com/websplatter/WebSplatter/releases/tag/1.0.0)（2026-08-10，未附发行说明），代码为 MIT。论文与新版主页的设备集合、速度数字不同，均不作为本项目结果。

其 [WGSL 绘制实现](https://github.com/websplatter/WebSplatter/blob/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be/src/shaders/gaussian_render_conic.wgsl)按峰值不透明度收紧 quad，减少最终低于 alpha 阈值的片元；排序则采用分阶段 WebGPU compute，避免跨工作组自旋等待。后者需要 WebGPU，不能直接接入当前 WebGL2 Spark；Apple 设备还需浏览器支持 WebGPU/Metal 后端，不依赖 CUDA，当前未运行该实现。

可行动假设是先在现有 GLSL 光栅化中评估等阈值的不透明度边界，而非更换整个后端。已核对 [Spark 2.4.0 顶点着色器](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/shaders/splatVertex.glsl)：普通高斯仍以 `maxStdDev` 定义覆盖范围，另做低 alpha 剔除。其默认 `minAlpha=0.5/255`，普通衰减为 `exp(-0.5*r²)`，与 WebSplatter 的坐标和阈值不同，不能直接复制半径公式。候选需限定普通高斯与默认 falloff，保留抗锯齿后的 alpha、现有最大半径及精度边界，并对全部留出视角和移动路径核对像素差异。尚未实现或测得收益。

### 已修复：评测的迟到参考图像

应用在参考照片解码期间可能被取消或销毁。Spark 的内部释放处理不覆盖该 Promise；现在在图像返回后检查评测信号，且不再恢复已销毁的查看器。实际模型的闸门测试复现旧版多余绘制和相机操作，修复后均为 0，详见[取消检查](QUALITY-CANCELLATION.md)。

同时核对了仍标为 open 的 [Spark #408](https://github.com/sparkjsdev/spark/issues/408)：几何释放修复 [#410](https://github.com/sparkjsdev/spark/pull/410)已于 2026-09-21 合并，当前 [2.4.0 源码](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SparkRenderer.ts)的 `dispose()` 已释放 geometry 和 material，故不再额外补写同一清理逻辑。该判断来自当前实现，未声称所有内存泄漏均已消除。

### 测量参考：重建系统的任务边界

[Gaussian Splatting for Real-Time Scene Reconstruction: Methods, Systems, and Trade-offs](https://arxiv.org/abs/2610.17513)（v1，2026-10-13，论文 CC BY 4.0）在第 4.2–4.3 节区分已有模型渲染、场景生成、更新与训练成本，并要求一致的输入、设备和计时范围。它是综述；正文未发现配套评测仓库入口，本次没有移植代码或验证其跨方法结果。该测量口径适用于当前 WebGL2，以及后续 WebGPU/Metal/CUDA 实验；具体后端收益仍须独立测量。

对本项目的直接约束是：取消路径只报告避免的无效绘制/读回次数；后续加载实验单列下载、解码、初始化与首帧，不用稳态 FPS 代替交互等待时间。

### 已采用：解码流中的文件头校验

重新核对 [Spark 2.4.0 的 SplatLoader](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)后，保留应用先解压、再显式按 PLY 初始化的路径；gzip 魔数只能确认容器，不能确认解码内容。当前在解码流中提前检查 PLY 签名，避免错误响应必须读到末尾才失败。分块源对照与预读限制见[记录](PLY-HEADER.md)，未新增正常加载耗时或内存峰值结论。

### 压缩候选：KISS-GS / SOG-XT

[论文 v1](https://arxiv.org/abs/2608.26948)发表于 2026-08-27、收录 ECCV 2026，arXiv 使用非独占永久发布许可。研究把高斯精简、图像编码和可选微调分开，SOG-XT 将属性和 SH 码本存为图像；后续若验证，须先固定高斯数量与 SH3，仅评估编码，再单列剪枝与微调的画质代价。

[作者主页](https://fraunhoferhhi.github.io/KISS-GS/)仍标注完整代码待发布，但提供[独立 NumPy 解码器](https://fraunhoferhhi.github.io/KISS-GS/decode_sogxt.py)；已阅读附录 6.9 和脚本，依赖 NumPy、Pillow、PyYAML，解码本身无需 CUDA。下载响应的修改时间为 2026-09-03，SHA-256 为 `05ddc2cb9a243ffc5a231cee987cd0aa4e0d28230a8d537c0cd8dab051876573`，脚本未附明确代码许可。

[公开仓库 24e78b5](https://github.com/fraunhoferhhi/KISS-GS/tree/24e78b5c29f32a70a7802cc5dd0ada15e70bb6b0)只有项目页 README，链接至 [ffsplat](https://github.com/w-m/ffsplat/tree/3fb6444c5faed6de9aa55fa2313df6c2a4104193)（当前 main 提交 2025-07-10，Apache-2.0，快速启动要求 CUDA 12.x）。该旧版框架不能直接视为论文完整实现，其许可也不能自动套用于独立脚本。本项目暂未复制代码、转换模型或运行训练。

浏览器图像解码思路可用于未来 WebGL2/WebGPU 上传路径，但 SOG-XT 不等同于 Spark 已支持的 SOGS，仍需属性、SH 布局和量化兼容验证；Metal 训练支持也未验证。下一步条件是取得可核实许可的实现与格式版本，再测相同模型的压缩体积、解码时间、CPU 内存峰值和全部留出画质，不使用论文压缩倍数作为本项目成绩。

### 已采用：画布尺寸检查与相机重绘分开

Three.js r180 的 [setSize 实现](https://github.com/mrdoob/three.js/blob/r180/src/renderers/WebGLRenderer.js)每次都会给 canvas 宽高赋值。[Spark 当前 2.4.0 实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SparkRenderer.ts)（2026-10-20，MIT）从渲染器读取 drawing buffer 尺寸；[按需渲染说明](https://sparkjs.dev/docs/on-demand-rendering/)要求相机改变和异步结果到达后继续绘制。应用现在只去掉相同尺寸的重复设置，保留这些失效通知。实测照片切换每侧 2 次降为 0 次，画质不变，详见[对照记录](VIEW-RESIZE.md)；未把调用数下降等同于 GPU 加速。

### 暂缓：随机光栅化与时序神经降噪

[Ultra-fast Neural Inference for Stochastic Gaussian Splatting Denoising](https://arxiv.org/html/2609.25604v1)（v1，2026-09-22，arXiv 非独占永久发布许可）通过随机采样去掉排序/混合，再用历史重投影、双路 EMA 和神经置信度降噪；论文在随机 2DGS 上验证，并明确仍与有序混合存在 PSNR 差距。

第 5.1 节实现使用 PyTorch、SlangPy 与 NVRHI/Vulkan，在 RTX 3090 上测量；不能据此推断 WebGL2、WebGPU 或 Metal 的收益。正文称补充材料提供代码，但当前 arXiv 页面没有可核实版本和许可的作者仓库入口，本项目尚未移植。其逐高斯额外参数和多帧历史也超出当前标准 SH3 PLY 路径。

对后续实验的约束是：相机/分辨率变化后的历史有效性和静止画面的收敛帧数必须单独检查。当前按需渲染会在没有新结果时停帧，若换成随机渲染，不能只比较单帧吞吐而忽略噪声、收敛和持续绘制开销。先保持现有有序渲染，优先完成加载与移动相机分段测量。

### 已采用：将模型初始化与首帧准备分开计时

Spark 2.4.0（最新发行 2026-10-20，MIT）的 [SplatMesh.initialized 实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatMesh.ts)覆盖模型解析与生成器初始化；首帧绘制和异步排序仍由渲染路径驱动。应用现在独立记录这两个阶段，以及并行模型读取、GLB 解析和总等待，失败或过期请求不发布记录。详见[计时边界与本地样本](LOAD-TIMING.md)。

重新核对 [#321](https://github.com/sparkjsdev/spark/issues/321)（2026-04-24 创建，当前 open）及 [FetchSource #463](https://github.com/sparkjsdev/spark/pull/463)（2026-10-16 合并）：脚本/Worker 的初始化与分块模型读取是不同层次的等待，现有 load() 记录不覆盖脚本下载，也不能代表分页初始视图。后续网络实验须另列导航起点和缓存控制。

### 待验证：LMG 的分层就绪边界

[LMG: Efficient Streaming of Layered Mesh–Gaussian 3D Scenes](https://doi.org/10.1145/3793853.3795764)发表于 MMSys 2026（Crossref 出版日期 2026-04-04、在线 04-06）；[作者主页](https://aiins-nthu.github.io/LMG/)说明先交付可交互 Mesh 基础层，再按可见性加载 Gaussian 增强层。其模型是联合训练的混合表示，与本项目两个独立重建结果不同。

已阅读[公开实现 2ab8767](https://github.com/SYJINTW/layered-mesh-gaussian/tree/2ab8767a3db44c2e7adfd63cb983ee652d2cbf90)（2026-04-11）中的安装说明、Mesh-Gaussian renderer 和许可。实现依赖 CUDA（安装说明测试 11.7）、PyTorch、自定义高斯光栅化及 Mesh 深度/颜色合成；使用限制于非商业研究/评估的 Gaussian-Splatting 许可，并非 MIT。未复制实现或训练模型；当前 WebGL2 路径不能直接调用，WebGPU/Metal 适配未验证。

可行动结论是后续分页或低精度预览实验必须分别报告“基础视图可交互”和“完整目标画质就绪”，并固定画质预算。现在只测完整模型就绪，不能从论文分层传输结果推导当前 PLY 的收益；更不能把它作为传统 Mesh 与 3DGS 的独立公平对照。

### 暂缓：按解压长度预分配缓冲

在原 PLY/gzip 格式上完成 32 次串行 A/B/B/A 对照，完整输出哈希一致。预分配在已解压内存输入上减少约 2ms，gzip 输入差值仅约 1–2ms且范围重叠，未证明首帧或峰值内存改善，默认加载器保持原样。详见[实验与复现](READ-BUFFER.md)。当前主要等待仍值得从解压成本与格式入手研究。

核对 [Spark 当前 SplatLoader](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)（2.4.0，2026-10-20，MIT），`fileBytes` 路径还会复制输入后交给 Worker；因此当前读取器局部实验不代表整个初始化链的分配次数。公开 stream 接口可请求下一块，但与模型解码、取消和进度的整合需要独立验证。

### 压缩候选：SpeedyGS 的编码复杂度取舍

[SpeedyGS](https://arxiv.org/html/2607.12656v1)（v1，2026-07-14，arXiv 非独占永久发布许可）将量化/剪枝的结构形成与后续统计编码分开；第 3.4 节比较按通道固定比特宽度和学习式自回归编码。对本项目有用的假设是较简单的解码可能抵消更大文件的传输成本，需以目标网络和设备的总就绪时间验证，不能只比较文件大小。

当前论文页面未提供可核实版本和代码许可的作者仓库，定向检索也未找到对应实现；没有移植或复现论文数字。其训练和学习式编码并非当前浏览器 PLY 读取流程，WebGL2/WebGPU/Metal 及 CUDA 的可复现实现条件仍未确认，暂不进入默认资产转换。后续若取得实现，应固定照片与相机，分别列出量化/剪枝画质代价、解码、上传和首帧成本。

### 暂缓：默认 SPZ3 属性量化

当前 Spark 2.4.0（2026-10-20，MIT）的 [SPZ API](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/spz.ts)只写 SPZ2/3；[SPZ4 读取补丁](https://github.com/sparkjsdev/spark/pull/484)于 10-15 合并。Niantic 的 [v3.0.0 库发行](https://github.com/nianticlabs/spz/releases/tag/v3.0.0)（05-05）包含 SPZ4 文件格式；库标签和文件版本不可混淆。参考库当前提交仍为 [affd0ec](https://github.com/nianticlabs/spz/tree/affd0ecea7fbb4c265ee119475af7ee5b2997482)（08-05，MIT）。

已用 Spark 浏览器转换器独立生成两场景 SPZ3，保持点数与 SH3；但[编码器](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/spz.rs)量化位置、颜色、不透明度、尺度、旋转与 SH，SH1 用 5bit、SH2/3 用 4bit。16 次内存输入加载和全部六个留出视角验证显示：文件减少约 89%，加载等待下降，但平均 PSNR 分别降低 0.692/0.758dB。默认模型不替换，完整[参数、耗时及截图](SPZ-FORMAT.md)保留。

本次只验证 WebGL2 + CPU/WASM 解码、ANGLE Metal 绘制，不依赖 CUDA，也没有改成 GPU 驻留压缩或 WebGPU。后续先分离各属性量化误差，或用参考 SPZ4 编码器调整精度，再测目标网络端到端等待；不能把多流容器支持解释成当前浏览器已并行解码，或将文件缩小等同显存节省。

### 候选：GPU 纹理编码与传输压缩分开

[Compression of 3D Gaussian Splatting Data Using GPU-friendly Graphics Texture Coding](https://arxiv.org/html/2607.14513v1)（v1，2026-07-16，CC BY 4.0）研究按颜色分组后的 BC1/BC7 SH 编码和随机访问。第 V-A 节使用 AMD Compressonator 编解码 SH；其余属性保持浮点，论文图像 PSNR 对照原始渲染，并非留出照片分数。

论文及定向检索未找到可核实版本、许可证的作者完整仓库，尚未移植；第三方编码工具也不能代替论文完整实现。可行动假设是单独比较传输容器和渲染驻留表示，检查上传后是否仍展开，分别测 CPU 解码、GPU 内存与画质。WebGL2/WebGPU 的纹理格式能力以及 Metal/CUDA 后端条件需独立验证，不能从论文画质表推断当前 Spark 的运行性能。

### 已验证：SPZ3 的 SH 属性误差

[属性对照](SPZ-ATTRIBUTES.md)保持高斯数、相机、完整 SH3 和 768 长边不变，以原始/压缩的其他属性与 SH 做四组组合。恢复原始 SH 后 pipes / office 的平均 PSNR 相对完整 SPZ 回升 0.522 / 0.462dB，仍低于原始 PLY；20 组复制控制逐像素一致。优先验证高精度 SH 的实际文件体积与画质，不将内存混合属性当作已实现压缩收益。

核对 Spark 主分支仍为 [ffe210d](https://github.com/sparkjsdev/spark/commit/ffe210dc0a45d0515a06c9235878108112827d61)（2026-10-20，2.4.0）。[SH 共享指数修复 #465](https://github.com/sparkjsdev/spark/pull/465)已于 10-02 合并，当前版本已包含。另确认 [GsplatArray](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/gsplat.rs)采用半精度中间属性，并固定返回抗锯齿标志 true；[SPZ 解码](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/spz.rs)未将 bit 0 应用成渲染选项。因此属性对照覆盖整条转换路径，不能将损失全部归到 SPZ 单一量化步骤。代码 MIT，实际验证 WebGL2 / ANGLE Metal；没有 CUDA 或 WebGPU 实验。

### 待验证：以图像失真约束 SH 压缩

[Transforming Harmonic Coefficients for 3D Splat Compression](https://arxiv.org/abs/2609.15735)（Tam Thuc Do、Philip A. Chou、Gene Cheung；v1，2026-09-14；论文 CC BY-NC-ND 4.0）从图像空间误差出发讨论 SH 正交化与 KLT。[正文第 4.1 节](https://arxiv.org/html/2609.15735v1#S4.SS1)实验基于稀疏体素、RAHT、量化和 ANS，不能直接视作 Spark 高斯实现。正文未提供匹配实现链接，本次检索也未找到可核实的作者公开代码及代码许可；WebGL2/WebGPU/Metal/CUDA 支持均未验证。

可行动方向是先在本项目的固定画面上检验 SH 精度，避免仅用系数均方误差决定压缩参数。若后续估计变换，限定训练相机拟合，留出视角不参与调参；作者报告的收益不作为本项目结果。

### 已验证、暂不采用：SPZ3 的 8 位 SH 文件

[实际文件对照](SPZ-SH8.md)仅替换 SH 字节，原 5/4 位量化控制全部复现，非 SH 字节完全不变。两场景平均 PSNR 相对原 SPZ 回升 0.520 / 0.461dB，候选为 11.96 / 8.51MiB；但六个留出视角仍低于原始 PLY，默认不替换。8 位候选已接近恢复原始 SH 的组合，下一步优先拆分其他属性，暂不继续搜索 SH 位宽。

本次仍按 [Spark 2.4.0 / ffe210d](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/spz.rs)（2026-10-20，MIT）核对编码；[Niantic 主分支 affd0ec](https://github.com/nianticlabs/spz/tree/affd0ecea7fbb4c265ee119475af7ee5b2997482)仍为 2026-08-05、MIT。文件缩小约 81% 不代表新的加载、首帧、显存或 GPU 性能收益；本次只验证 Spark 解码、WebGL2 / ANGLE Metal 绘制，没有验证其他解码器、WebGPU 或 CUDA。

### 暂缓：CCT-GS 的学习式 SH 压缩

[CCT-GS: Codec-Compatible Learned Compression for 3D Gaussian Splatting](https://arxiv.org/abs/2610.26920)的 v1 提交于 2026-10-17，页面注明收录 IEEE VCIP 2026，论文为 arXiv 非独占永久发布许可。[原文](https://arxiv.org/html/2610.26920v1)将 45 个 SH-AC 通道编码为 15 通道潜变量，再用 HEVC 编码属性图；LoRA 适配还需传输场景相关权重。实验使用 RTX 4090、HM18.0 与 DeepCABAC，不能据此推断浏览器的解码或上传收益。

论文摘要链接公开实现，但截至 2026-10-27，[作者仓库 73c4f3e](https://github.com/yfffffy/CCT-GS/tree/73c4f3e917a7ea0938180935bd7b62cdcbebb0fe)（提交 2026-10-16）只有 README，明确表示代码和预训练模型待发布，未附代码许可证。未复制实现、训练或复现论文跑分；WebGL2/WebGPU/Metal 适配没有证据，CUDA 可复现实验也需等待代码与依赖。

后续进入实验的条件是取得有许可的编码器、解码器和权重，再将共享解码模型、LoRA、属性图的总传输量与解码成本一起测量。若需要场景适配，只使用训练视角；当前先完成非学习式属性误差定位，避免仅凭单个压缩文件大小判断可部署性。

### 已定位：SH8 文件中的不透明度误差

[非 SH 属性对照](SPZ-NONSH.md)固定 SH8，逐项恢复位置、DC 颜色、不透明度、尺度和旋转。只恢复不透明度，pipes / office 平均 PSNR 回升 0.171 / 0.306dB；其他单项影响较小且不总是改善。80 次画面、20 项复制控制及全部不透明度字节复现通过；两个场景都没有正值被量化成零。当前是内存诊断，没有对应新文件大小或加载时间，默认仍保留 PLY。

继续核对 [Spark 主分支 ffe210d](https://github.com/sparkjsdev/spark/commit/ffe210dc0a45d0515a06c9235878108112827d61)（2026-10-20）、[2.4.0 发行](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)、[SPZ 编码](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/spz.rs)及[扩展属性布局](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/utils.ts)，MIT。当前非 LoD 路径的 alpha 使用均匀 uint8；下一步先验证保留较高精度 alpha 的实际存储和浏览器解码成本，不能直接将诊断组合称为标准 SPZ3。已验证 WebGL2 / ANGLE Metal；WebGPU、CUDA 和跨解码器互操作未验证。

### 待验证：PLEDGE 的属性约束边界

[PLEDGE](https://arxiv.org/abs/2610.17605)（v1，2026-10-13，arXiv 非独占永久发布许可）按位置、形状、颜色和不透明度约束组织渐进量化。[原文](https://arxiv.org/html/2610.17605v1)明确：不透明度仅有参数误差约束；合成颜色的界限要求几何和 alpha 固定；默认剪枝处于保证范围之外。论文使用 A100 编码并以 gsplat 重渲染，正文和定向检索未找到可核实的作者代码版本及许可。未移植或复现数字，WebGL2/WebGPU/Metal/CUDA 的可复现实现条件未确认。

对当前实验的约束是：alpha 数值误差小并不能替代最终画质检查；若后续采用渐进或裁剪，须分开报告缺失高斯和参数量化的代价。先完成固定点数下的高精度不透明度文件验证。

## 后续研究记录

记录新增来源时注明论文日期或仓库 commit/tag，以及与当前瓶颈的关系。进入实现前，补充最小实验、对照设置和可验证指标；完成后链接对应 CHANGELOG 或实验报告，标明采用或暂缓的理由。

优先验证现有渲染器能够支持的局部改进。涉及新训练流程、格式或 GPU 后端的方案，先在独立实验中验证兼容性和收益。


### 已验证、待接入：SH8 的高精度不透明度附加文件

[AP16 文件实验](SPZ-ALPHA16.md)将原始 Spark 解码的 binary16 不透明度独立 gzip 存储，绑定准确的 SH8 文件 SHA-256 与点序。合计 12.47 / 8.90MiB，20 个画面完全复现此前诊断，附加处理 7.40 / 4.80ms；完整加载只测暖运行时、内存输入，未测冷/热网络和内存峰值。它是自定义附加格式，不能宣称为标准 SPZ3 或通用解码器能力。默认仍为 PLY，下一步验证候选加载的取消、回退、解压上限与缓存。

核对 [Spark 2.4.0 主分支](https://github.com/sparkjsdev/spark/commit/ffe210dc0a45d0515a06c9235878108112827d61)仍为 2026-10-20 的 ffe210d，MIT；按 [ExtSplats 作者实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/ExtSplats.ts)在首次绘制前恢复低 16 位并触发纹理上传，其他属性不变。实际使用 WebGL2 / CPU-WASM / ANGLE Metal；没有 WebGPU、CUDA 或手机测试。

### 候选：MesonGS++ 的总码流核算与分属性精度

[MesonGS++](https://arxiv.org/abs/2604.26799v2)于 2026-04-29 提交 v1，05-07 更新 v2，论文 CC BY-NC-SA 4.0。[正文 III-D 至 III-G](https://arxiv.org/html/2604.26799v2)联合考虑属性精度、点保留量与存储预算；其体积核算包括几何、属性、码本和元数据。可行动启示是先验证属性敏感性，并统计全部实际文件，而非仅按位宽估算或只计主码流；不直接采用论文压缩率。

截至 2026-10-27，[作者仓库最新提交 0004153](https://github.com/mmlab-sigs/mesongs_plus/commit/0004153458b73387e0044b6f553f62116117388d)为 05-07（增加结果表），没有 GitHub Release。[qbit_search_tool.py](https://github.com/mmlab-sigs/mesongs_plus/blob/0004153458b73387e0044b6f553f62116117388d/splatwizard/model_zoo/mesongs_plus/qbit_search_tool.py)实际生成属性流和元数据，再读取 ZIP 大小校正预算。根目录许可证为 MIT，仓库另含第三方组件的独立许可，不能据此概括全部依赖。

作者安装路径使用 PyTorch 2.4.0 + CUDA 12.1、CUDA 扩展及外部 G-PCC `tmc3`；未见 WebGL2/WebGPU/Metal 的等价运行路径。当前机器未运行该编码器或搜索，不把其 CUDA 结果当作浏览器收益。若后续移植，先核对所有依赖许可、顺序一致性、解码器大小及总耗时，任何重要性估计或拟合仅使用训练视角。此时优先完成已有 AP16 候选的可靠加载。


### 已验证、待接入：AP16 响应流取消与完成边界

[CPU 读取验证](ALPHA16-STREAM.md)新增按已知点数限定长度的流式读取器，支持原始 gzip 与 HTTP 已展开的 AP16，完整校验和取消检查后才写回。旧路径取消后仍会写入的合成用例已复现，新路径保留目标数组；真实文件解码位一致。没有占用正在被其他训练任务使用的 GPU，也没有据此新增画质或性能数字。模型加载事务、回退和真实缓存仍待接入。

截至 2026-10-27，Spark 最新仍为 [ffe210d / 2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)（发布 10-20，MIT）。[SplatLoader](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)的流选项与 Worker `nextChunk` 路径没有向调用方提供 AbortSignal 参数；因此不能把自有响应流的取消视为已经终止 Spark 的模型初始化。后续应隔离请求所有权，并清理迟到结果；不修改或重复实现已有渲染器释放修复。

### 候选：MoQSplat 的接收状态与完整数据发布

[MoQSplat](https://arxiv.org/abs/2609.18624) v1 为 2026-09-16，页面注明 IEEE MMSP 2026，arXiv 标注 CC BY-SA 4.0。[正文 III 节](https://arxiv.org/html/2609.18624v1)区分缺失、下载中和缓存完成状态，接收中断后重新请求，使用已有层维持显示。对当前附加属性的启示是数据完成之前不发布，取消不修改现有模型；这是待接入事务的设计假设，不等于采用该论文的渐进表示。

[作者仓库](https://github.com/emanuele-artioli/MoQSplat/tree/15e02a669456d767abf5d68f9fb1f909f260dde0)最新提交为 15e02a6（09-16），没有 GitHub Release。已阅读 [client.py](https://github.com/emanuele-artioli/MoQSplat/blob/15e02a669456d767abf5d68f9fb1f909f260dde0/src/moq3dgs/transport/client.py) 的接收与断开、[cache.py](https://github.com/emanuele-artioli/MoQSplat/blob/15e02a669456d767abf5d68f9fb1f909f260dde0/src/moq3dgs/render/cache.py) 的缓存边界；客户端读取完整消息再解码/写缓存，断开时取消接收任务。[包元数据](https://github.com/emanuele-artioli/MoQSplat/blob/15e02a669456d767abf5d68f9fb1f909f260dde0/pyproject.toml)声明 MIT，但仓库没有独立 LICENSE/COPYING 文件，未复制作者代码。

作者路径为 Python/PyTorch/gsplat 与 CUDA、MoQ/QUIC 组件，论文使用 NVIDIA GV100；没有验证 WebGL2/WebGPU/Metal 等价实现。当前静态 Pages 没有引入中继或新服务；没有复现其网络跑分，后续需要将传输、缓存、解码和 GPU 上传的完成状态分别验证。


### 已验证：候选文件配对、迟到初始化与回退

[独立加载验证](PAIRED-MODEL.md)把流式 AP16 与真实 Spark 模型连通：固定 SPZ/原始 AP16/解压后 PLY 三份摘要，发布前核对点数与 SH3；取消不回退，迟到初始化释放后拒绝。30 个画面和 12 个模型释放记录通过，默认网页未变。真实缓存、冷/热首帧及峰值内存仍待测，不能把 dispose 次数当作显存回收量。

重新核对 [Spark 2.4.0 / ffe210d](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)（2026-10-20，MIT）。[#392](https://github.com/sparkjsdev/spark/pull/392)于 08-24 合并，改动 [SplatPager.ts](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatPager.ts)：PagedSplats 释放时取消 fetch，获取结果后再次检查中止状态。它不是普通 `SplatMesh.initialized` 的取消 API；当前实验仍等待初始化结束，再按所有权释放。已测 WebGL2 / ANGLE Metal，未测 WebGPU 或 CUDA。

### 候选：ProGS 的版本清单与完整前缀

[ProGS: Towards Progressive Coding for 3D Gaussian Splatting](https://arxiv.org/abs/2603.09703) v1 提交于 2026-03-10，论文 CC BY-SA 4.0。[正文 III 节](https://arxiv.org/html/2603.09703v1)通过八叉树父子依赖组织渐进层级，低层画质需要单独训练约束。此处与 Zhiye Tang 等人的 ProGS 对应，不混同其他同名缩写项目。

[作者公开实现 f0e7b5d](https://github.com/ZhiyeTang/ProGS-Official/tree/f0e7b5d977fe38bde47eeb45a985c7b15940d0d9)于 08-28 发布源码，截至 10-27 无 GitHub Release。[artifact.py](https://github.com/ZhiyeTang/ProGS-Official/blob/f0e7b5d977fe38bde47eeb45a985c7b15940d0d9/progs/artifact.py)检查格式版本、文件存在性、字节数和 SHA-256；[model_codec.py](https://github.com/ZhiyeTang/ProGS-Official/blob/f0e7b5d977fe38bde47eeb45a985c7b15940d0d9/progs/model_codec.py)在解码前校验所需前缀文件和模型配置。可行动启示是分别验证每个依赖文件的身份，不能只检查主文件或 URL；本项目已增加 AP16 自身摘要，尚未采用其渐进表示。

作者环境为 Ubuntu / PyTorch 2.1.2 / CUDA 12.1 / RTX 4090，含本地 CUDA 扩展和神经解码组件，没有验证 WebGL2/WebGPU/Metal 路径。根 [LICENSE.md](https://github.com/ZhiyeTang/ProGS-Official/blob/f0e7b5d977fe38bde47eeb45a985c7b15940d0d9/LICENSE.md)为 Gaussian-Splatting 研究/非商业许可，子模块另有许可证，并非 MIT。未复制作者实现、安装编码器或复现论文性能；若未来评估渐进数据，应先核对依赖许可、完整前缀的总字节与解码成本。

### 已验证：HTTP 缓存身份与文件摘要的不同作用

[真实 HTTP 实验](HTTP-MODEL.md)确认，长期有效的固定 URL 可能持续返回旧 AP16；摘要校验能阻止错配显示，但重复加载仍回退。实验清单采用包含内容摘要的新 URL 后正常加载并缓存。两场景 304、断连与取消也通过，尚未验证 CDN 或首帧速度。后续应先发布版本资源再更新清单，摘要校验与版本 URL 同时保留。

2026-10-28 核对 Spark 最新发行仍为 [2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)（10-20），主分支 [ffe210d](https://github.com/sparkjsdev/spark/commit/ffe210dc0a45d0515a06c9235878108112827d61)，MIT。[worker.ts](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/worker.ts)和 [PagedSplatsFetcher.ts](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/PagedSplatsFetcher.ts)构造普通 Request，没有显式覆盖 cache 模式；后者另传 Range 与 AbortSignal。不能据此推断它已提供内容版本管理或把分页行为套到普通模型初始化。参考 [Fetch 缓存说明](https://developer.mozilla.org/en-US/docs/Web/API/Request/cache)，本地服务器记录 304，应用收到合并缓存后的 200；仅本机 WebGL2 / ANGLE Metal 实测，WebGPU、CUDA 和移动端未测。

### 待验证：SplatStream 的依赖清单与网络评价边界

[SplatStream](https://arxiv.org/abs/2607.25971v2) v1 为 2026-07-28，v2 为 07-29，页面注明 Asilomar 2026 接收；论文为 arXiv 非独占永久发布许可。[正文 II-F / II-G](https://arxiv.org/html/2607.25971v2)让清单记录分层字节数、预测元数据和依赖，解码按依赖关系进行。第 III 节与表 II 的所需带宽按四帧 GOP、30fps 和字节量计算，并非浏览器 HTTP 缓存或启动等待测量。

本次原文与定向检索未找到可核实的作者实现仓库、发布版本及代码许可；正文也未明确可复现的 WebGL2/WebGPU/Metal/CUDA 软件配置。没有移植其动态预测、剪枝或引用论文性能作为本项目结果。可行动约束是将完整依赖数据量、实际 HTTP 请求/缓存、解码及首帧分开记录；当前静态双文件候选先完成后两项，不能把文件缩小或估算带宽直接换算成用户等待改善。


### 已测：候选读取收益与初始化成本分离

[受控 HTTP 加载](PACED-MODEL.md)固定 5MiB/s 正文、每请求服务器等待 40ms，保持 SH3/点数/画幅。热运行时下，候选缓存未命中等待缩短 77.4% / 78.3%，缓存命中缩短 45.0% / 44.9%；候选初始化反而较慢。32 个样本、52 个像素控制通过。后续应定位初始化与内存成本，不能把总等待下降写成解码或 GPU 加速。

再次核对 [Spark 2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)仍为最新发行，GitHub 发布时间 2026-10-20（发行说明标题为 10-19），主分支仍为 `ffe210d`，MIT。发行说明包含 SPZ gzip 后端替换，但本次两组使用同一版本，不归因为库升级。[worker.ts](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/worker.ts)的 `fileBytes` 分支重新建立读取流，没有证明命中 HTTP 缓存能复用已解码模型。

### 候选：KoalaGS 的时间—画质评价

[KoalaGS v1](https://arxiv.org/abs/2610.28615v1)提交于 2026-10-20，标注 NeurIPS 2026 Spotlight，论文 CC BY-SA 4.0。[正文 §5.5、附录 B.2 / D.3](https://arxiv.org/html/2610.28615v1)研究按复杂度排序的模型前缀与时间—画质关系；实现基于 gsplat 的 3DGS-MCMC，实验为 NVIDIA H100。保留大面积高斯提高低预算覆盖，但不保证更快渲染；未验证 WebGL2/WebGPU/Metal 移植。

[作者页面](https://rdbch.github.io/koalags/)明确区分演示和论文：演示使用降低 SH 阶数的 SPZ 分块并模拟到达时间，不能直接比较本项目完整 SH3 的真实 HTTP 加载。论文正文写每点 236B，页面对论文设置写 244B，核算前需澄清，不据其带宽曲线推导本项目首帧。

截至 2026-10-28，[作者仓库 `5821f00`](https://github.com/rdbch/koalags/tree/5821f00dfe9f2fe9fb5289d45344aee9ee58fb1e)最新提交为 10-21，仅 README 提示代码待发布；没有可核实的训练实现或代码许可证，不把论文许可当作代码许可。可行动结论是后续渐进实验同时记录实际传输、达到的画质与 SH/点数预算；当前先补冷运行时和内存测量，暂不重训或移植。


### 已采用：默认 PLY 读取核对解压后长度

[PLY 长度检查](PLY-SIZE.md)把清单的 `decodedBytes` 用于默认加载，超长块在结果收集前拒绝，短包和缺失长度也拒绝。4 组真实文件字节、3 种查看器失败与恢复、10 个原始画面控制通过；没有测峰值内存或声称正常加载加速。模拟流供给量不能替代进程、Worker 或显存统计。

Spark 最新发行仍为 [2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)，发布于 2026-10-20，主分支 `ffe210d`，MIT；本次没有升级依赖。[SplatLoader.ts](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)向 Worker 传递 `fileBytes?.slice()`，完整输入之后还有复制和解析阶段。当前先在这些步骤前拒绝长度不符的数据；正常初始化副本的生命期及实际峰值仍待测，不把文件大小当作总内存。

### 待验证：BoundedGS 的工作集与预取生命周期

[BoundedGS v1](https://arxiv.org/abs/2610.34233v1)发表于 2026-10-25，论文为 arXiv 非独占永久发布许可。[正文 §3.4 / §4.1](https://arxiv.org/html/2610.34233v1)区分临时渲染工作集、持久参数/优化器状态及主机内存，限制同时驻留的解码图像。其训练内存口径不能直接用于浏览器加载峰值。

[作者仓库 `23bca83`](https://github.com/XiaoBin2001/BoundedGS/tree/23bca8369a793ab9e29cc2b5d7c5966d4660d850)最新提交为 10-27 的链接更新，截至 10-28 无 GitHub Release，已公开实现。[image_prefetch.py](https://github.com/XiaoBin2001/BoundedGS/blob/23bca8369a793ab9e29cc2b5d7c5966d4660d850/utils/image_prefetch.py)按 `prefetch_count` 限制待处理队列，结束时取消未执行任务并等待执行器关闭。可行动启示是同时核对容量与释放时点；本项目的流取消和输出字节计数仍不能说明内部解压/WASM 状态已释放。

[README 环境](https://github.com/XiaoBin2001/BoundedGS/blob/23bca8369a793ab9e29cc2b5d7c5966d4660d850/README.md)为 Ubuntu 22.04、PyTorch 2.5.1 / CUDA 12.1 / RTX 4090；WebGL2、WebGPU、Metal 未验证。[LICENSE.md](https://github.com/XiaoBin2001/BoundedGS/blob/23bca8369a793ab9e29cc2b5d7c5966d4660d850/LICENSE.md)对原创贡献使用 MIT，继承的 3DGS / ImprovedGS 及其他组件继续受各自许可约束，不能称整个工程为纯 MIT。未安装或移植作者实现，暂保留为后续内存计量参考。


### 已采用：页面调度与排序就绪分开处理

[后台排序恢复](SETTLE-VISIBILITY.md)修复可见性计时与取消，不更换排序算法。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)说明隐藏标签页通常暂停动画帧；当前 15 秒上限改为累计可见时间，加载报告仍保留墙钟等待。合成可见性测试通过，原生限流/睡眠恢复仍待验。

2026-10-28 再次核对 Spark 最新发行仍为 [2.4.0](https://github.com/sparkjsdev/spark/releases/tag/v2.4.0)，10-20 发布，主分支 `ffe210d`，MIT。[SparkRenderer.driveSort](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SparkRenderer.ts)先异步 `readbackDepth`，再 `sortWorker.call("sortSplats32")`，最终才清除 `sorting`。网页长时间没有帧不能独立证明 Worker 或 GPU 排序故障；本次不提前宣告就绪，也不改库内同步。

### 候选：WebSplatter 的排序推进保证

[arXiv v1](https://arxiv.org/abs/2602.03207v1)为 2026-02-03，非独占永久发布许可；截至 10-28 仅列 v1。[§3.3](https://arxiv.org/html/2602.03207v1)把跨工作组依赖拆成多阶段 radix sort，避免忙等。当前[作者页面](https://websplatter.github.io/)标注 ACM Multimedia 2026，其标题、作者列表及评价口径与早期 arXiv 不同；仓库 README 的会议届次又与项目页不一致，引用时保留各版本原链接，不合并跑分。

[作者仓库](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be)最新提交为 2026-08-29，`16bb06e`；[1.0.0 发行](https://github.com/websplatter/WebSplatter/releases/tag/1.0.0)为 08-10，[Zenodo 归档](https://zenodo.org/records/21798977)标 08-05、提交 `beb9532`。仓库 [LICENSE](https://github.com/websplatter/WebSplatter/blob/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be/LICENSE)为 MIT，保留 shrekshao 版权。

已阅读 [gaussian-renderer.ts](https://github.com/websplatter/WebSplatter/blob/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be/src/gaussian-renderer.ts)与 [scatter WGSL](https://github.com/websplatter/WebSplatter/blob/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be/src/shaders/gaussian_sort_scatter.wgsl)：每个 radix round 分直方图、六个前缀子 pass 与 scatter；局部位图通过 `atomicOr`、工作组屏障和 `countOneBits` 得到稳定 rank。需要 WebGPU compute，不能直接放进当前 WebGL2 Spark 渲染器。论文含 Apple 设备，但本项目未运行其 WebGPU/Metal 路径；也不是 CUDA 移植结果。

可行动方向是后续独立排序后端原型明确记录 GPU pass、读回、Worker 等待与页面可见性，并在相同 SH3/点数/画幅下检查画质。当前先保留已验证的 WebGL2 路径，不把 GPU 工作组推进保证当作浏览器后台恢复保证。
