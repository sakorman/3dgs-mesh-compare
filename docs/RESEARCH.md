# 3DGS 研究索引

查阅日期：2026-10-25。以下是持续跟踪与实验候选；除当前依赖外，尚未在本项目验证收益。

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

## 后续研究记录

记录新增来源时注明论文日期或仓库 commit/tag，以及与当前瓶颈的关系。进入实现前，补充最小实验、对照设置和可验证指标；完成后链接对应 CHANGELOG 或实验报告，标明采用或暂缓的理由。

优先验证现有渲染器能够支持的局部改进。涉及新训练流程、格式或 GPU 后端的方案，先在独立实验中验证兼容性和收益。
