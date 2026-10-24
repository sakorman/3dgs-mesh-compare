# 3DGS 研究索引

查阅日期：2026-10-24。以下是持续跟踪与实验候选；除当前依赖外，尚未在本项目验证收益。

## 实现

| 项目                                                   | 关注点                                            | 当前状态                                                                           |
| ------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Spark](https://github.com/sparkjsdev/spark)           | 浏览器渲染、排序、LoD、资源生命周期与压缩格式支持 | 当前使用 2.3.1；2.4.0 已加入按需渲染文档与多项稳定性修复，升级前核对具体变更并回归 |
| [Brush](https://github.com/ArthurBrussee/brush)        | 跨平台重建、训练与模型导出                        | 默认模型来自 0.3.0；新版本和参数另建实验                                           |
| [gsplat](https://github.com/nerfstudio-project/gsplat) | 光栅化、训练与内存管理实现                        | 参考；先核对后端和设备条件                                                         |
| [COSA-GS](https://github.com/pengpeng-yu/COSA-GS)      | 压缩模型与跨平台解码一致性                        | 待评估；检查实现、许可和浏览器解码成本                                             |

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

### 待验证：Spark 销毁后的异步任务

Spark 2.4.0 的 [#476](https://github.com/sparkjsdev/spark/pull/476) 处理渲染器销毁后仍在运行的排序与 LoD 任务拒绝；该补丁不改变调用方持有的 `SplatMesh.initialized` Promise。依赖版本保持 2.3.1，后续需单独验证取消加载、排序中销毁与版本升级，不能把这次 Mesh 位图回收当成该问题已解决。

重新查阅的 [COSA-GS](https://arxiv.org/abs/2609.30245) 涉及率失真训练与跨平台解码，继续保留为独立压缩实验候选；文件压缩率和解码资源回收分别测量。

## 后续研究记录

记录新增来源时注明论文日期或仓库 commit/tag，以及与当前瓶颈的关系。进入实现前，补充最小实验、对照设置和可验证指标；完成后链接对应 CHANGELOG 或实验报告，标明采用或暂缓的理由。

优先验证现有渲染器能够支持的局部改进。涉及新训练流程、格式或 GPU 后端的方案，先在独立实验中验证兼容性和收益。
