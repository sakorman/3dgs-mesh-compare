# 更新日志

## 2026-10-30 · 候选配对文件并行读取

- SPZ 与 AP16 改为并行读取，保留双文件完整校验；任一失败取消同组请求，用户取消不触发 PLY 回退，迟到响应不改写已完成报告。
- 在每请求独立 5MiB/s、40ms 等待条件下，32 个样本中未命中缓存的总等待中位数减少 158 / 126ms（5.5% / 6.0%）；热缓存无明显收益，非共享链路或 GPU 提速，见[完整记录与截图](docs/PARALLEL-PAIR.md)。
- 52 次候选画面、六张留出评分和两次 PLY 回退画面保持一致；38 个模型各释放一次，122 项回归、类型检查与构建通过。默认 PLY 与生产页面不变。
- 复核 [Spark 读取接口](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/PagedSplatsFetcher.ts)，补充 [ProGS 论文](https://arxiv.org/abs/2603.09703)及[作者实现](https://github.com/ZhiyeTang/ProGS-Official/tree/f0e7b5d977fe38bde47eeb45a985c7b15940d0d9)：渐进解码存在父级依赖，CUDA 与非商业研究许可另列，未移植或引用论文速度倍数。

## 2026-10-29 · 首次初始化与 Worker 复用

- 增加新文档首次/同页重复初始化对照：12 个文档、36 个串行样本、52 次画面摘要全部匹配，见[耗时记录](docs/RUNTIME-INIT.md)。
- 复用 Worker 后，SH8 + AP16 初始化仍比 PLY 慢 22.50 / 20.15ms；首次启动不是差距的唯一来源，下一步分解 SPZ 解压与属性转换，不引入常驻预热。
- 36 个模型各释放一次，解析 Worker 仍由文档内池持有；未测内存峰值、整页冷启动或 GPU 时间。116 项测试、类型检查与构建通过，默认资源不变。
- 核对 [Spark SPZ 解压更新](https://github.com/sparkjsdev/spark/pull/485)及 [Visionary 原文](https://arxiv.org/abs/2512.08478)与[实现](https://github.com/Visionary-Laboratory/visionary/blob/76a2b93cec0e0dfaeb598fd320b6ceabf4b39d48/src/io/spz_loader.ts)；后者的原生解压思路待单独适配验证，不沿用论文速度倍数。

## 2026-10-29 · 独立解码与参考图控制

- 增加独立 RGB 解码及 PNG 对照工具；六张照片与既有频繁读取画布逐字节一致，72 组浏览器检查中 36 次 PNG 原尺寸读回全部匹配，见[验证记录](docs/REFERENCE-DECODE.md)。
- 独立 RGB 路径复现办公室取消恢复后的参考图；固定 RGB 后，两种画布设置的缩放结果仍不同，已将原尺寸来源与重采样分开验证，浏览器内部具体原因仍待确认。
- 暂不替换 JPEG：PNG 总体积为原来的 4.02 倍，固定模型像素下仅换参考图就有最大 0.00437383dB / 0.00110235 SSIM 分差，未记作画质提升。
- 116 项测试、严格类型检查与构建通过；生产页面与默认资源不变。补充[原始 3DGS 评价实现](https://github.com/graphdeco-inria/gaussian-splatting/blob/54c035f7834b564019656c3e3fcc3646292f727d/metrics.py)及 [3DGSI-Assessor 论文](https://arxiv.org/abs/2608.03279)，后者公开仓库尚无可核验实现，暂不接入。

## 2026-10-29 · 参考图像素与评分口径

- 新增原尺寸、缩放参考图及真实评分输入的诊断与 RGBA 导出，见[实验记录](docs/REFERENCE-PIXELS.md)。72 组读回、12 次视角评分和 4 项恢复检查完成，116 项测试、类型检查与构建通过。
- 再次复现办公室首张参考图的两种状态；原尺寸已有 323,356 个 RGB 通道相差 1，缩放后最大差值为 8，八份模型画面摘要不变。具体解码、颜色转换或缓存原因仍待确认。
- 暂不采用 `willReadFrequently`：只换参考图读回设置，PSNR / SSIM 最大绝对变化就达到 0.072443dB / 0.00134224，不能当作画质提升；保留原评分管线与全部默认资源。
- 补充 [Brush 图片加载实现](https://github.com/ArthurBrussee/brush/blob/1388f74c6fe0236f68ee4915564bf00e9d2e3747/crates/brush-dataset/src/load_image.rs)、[相关提交](https://github.com/ArthurBrussee/brush/commit/8b7f5c6c0638892204b540d9aced219f62fc2192)与[质量评价综述](https://arxiv.org/abs/2609.23027)，明确参考取样、稳态缓存和评价协议的边界。

## 2026-10-29 · 参考照片等待取消

- 修复参考照片解码等待期间取消评测仍锁住控件的问题；取消时解除图片源和监听，迟到完成不再读取无用像素，见[验证记录](docs/IMAGE-DECODE.md)。
- 8 项浏览器取消检查及两次原生 JPEG 停流检查通过；正常流程的 12 份重建画面摘要不变，取消后可恢复原视角与重新评测。
- 办公室首张参考图波动在旧版复测中也出现，已定位到参考输入而非重建画面；保留首次最大 0.00076960dB / 0.00100159 SSIM 差异，具体解码或缩放原因待查。
- 新增 9 项回归，共 116 项测试、类型检查与生产构建通过。原生解码 Promise 在短时观察内仍可能挂起，未宣称底层解码终止或性能提升。
- 补充 [gsplat 图片缓存实现](https://github.com/nerfstudio-project/gsplat/commit/512d366b67073d77ca099ede742683c165dfc23b)与[论文](https://arxiv.org/html/2409.06765v1#S4)，区分预解码成本、常驻内存、训练步耗时与总耗时；暂不引入参考图缓存。

## 2026-10-29 · 场景加载取消与重试

- 首页和评测页增加「取消加载」，下载等待时可退出并重试或切换场景；取消后清除旧画面，迟到解析结果不覆盖新场景，见[对照记录](docs/LOAD-CANCEL.md)。
- 两场景共 10 项取消、重试与迟到结果检查通过，6 个留出画面摘要与原始 PLY 一致；真实 HTTP 停流后两次请求均在正文完成前关闭并成功重试。
- 107 项测试、类型检查与生产构建通过；底层已提交解析可能继续结束，未宣称下载或 GPU 提速，线上 CDN 慢加载原因仍待查。
- 补充 [Spark 读取取消接口](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/PagedSplatsFetcher.ts)、[MoQSplat 论文](https://arxiv.org/abs/2609.18624v1)及[公开实现](https://github.com/emanuele-artioli/MoQSplat/tree/15e02a669456d767abf5d68f9fb1f909f260dde0)，区分界面恢复、传输终止与解析结束。

## 2026-10-29 · 画质评测取消与恢复

- 补齐画质评分间隔和相机恢复的取消信号，修复停帧后控件锁定，以及恢复阶段取消仍保留报告的问题；见[验证与截图](docs/QUALITY-FRAMES.md)。
- 10 项浏览器取消检查通过，恢复原照片视角且无残留报告；复测 18 份评分输入摘要及全部 PSNR/SSIM/MAE 一致，默认模型不变。
- 107 项测试、类型检查与构建通过；初测最大 0.00091731dB 波动保留待查，未宣称画质或 GPU 提升，参考照片解码仍不可中断。
- 补充 [Brush 帧资源实现](https://github.com/ArthurBrussee/brush/commit/1388f74c6fe0236f68ee4915564bf00e9d2e3747)与 [WebSplatter 论文](https://arxiv.org/html/2602.03207v1#S4)，区分等待结束、资源生命周期和后端性能。
- 线上取消与重新评分复验通过；单次未受控 CDN 加载约 332 秒，主要等待资源读取，已保存分段作为后续排查依据，不作版本提速或退化结论。

## 2026-10-28 · 性能评测取消

- 修复性能评测取消仍等待下一帧的问题，信号覆盖排序准备、帧采样与查询收尾；暂停帧时也能清理查询和恢复操作，见[对照记录](docs/BENCHMARK-CANCEL.md)。
- 7 项浏览器取消检查通过，原来滞留的 3 个查询均删除，18 次画面校验与原始 PLY 一致；没有发布残缺性能成绩，不宣称 GPU 提速。
- 新增 10 项回归，共 107 项测试、类型检查与生产构建通过；保持原有 AB/BA 顺序、每组 160 帧及默认模型。
- 复核 [Spark 销毁修复](https://github.com/sparkjsdev/spark/pull/476)，补充 [TIGAS 论文](https://arxiv.org/abs/2605.08699)与[作者取消实现](https://github.com/Rekenar/GaussianAdaptiveStreamer/blob/8143b03687577e91b106ea5fe1be44678dd66cf2/templates/player.html)，区分取消请求、任务结束和 GPU 执行；原生后台限流与系统睡眠待验。

## 2026-10-28 · 分块输入与失败边界

- 完成 PLY 完整输入与 1MiB 分块对照：单次 Worker 输入由 67.52 / 52.09MiB 限为 1MiB，总复制量不变；16 个热运行时样本未证明初始化提速，未测峰值内存，见[数据与截图](docs/STREAM-INPUT.md)。
- 36 次画面校验及解码属性摘要一致，20 个实验模型均释放；新增 3 项回归，共 97 项测试、类型检查和生产构建通过。
- 复现流读取失败后初始化在一秒观察窗口内仍未结束、reader 未解锁的问题。暂缓采用分块接口，默认加载和线上模型不变；后续先验证错误传递、取消与恢复。
- 补充 [Spark 状态回调实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatWorker.ts)、[RLSplat v2](https://arxiv.org/html/2610.27712v2)及[作者预算生成代码](https://github.com/mlvlab/RLSplat/tree/0eee023e1892996a35dd2af58a32738d331a57a3)，区分单次传递、实际生成和峰值分配，不套用 CUDA 跑分。

## 2026-10-28 · 后台排序恢复

- 修复排序等待把后台停留计入超时的问题：隐藏时暂停检查，恢复后等待稳定帧，前台累计 15 秒超时保护仍保留；见[验证与截图](docs/SETTLE-VISIBILITY.md)。
- 取消、场景清理和销毁无需再等下一帧；两场景各模拟隐藏 16 秒后恢复，期间绘制 0 次，7 项生命周期检查通过。
- 10 个留出与偏转画面逐像素不变；新增 9 项回归，类型检查和构建通过。加载报告仍包含后台等待，未宣称 GPU 加速；原生后台限流与系统睡眠待验。
- 核对 [Spark 排序实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SparkRenderer.ts)，补充 [WebSplatter 论文](https://arxiv.org/abs/2602.03207v1)与[公开 WebGPU 代码](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be)，区分 GPU 同步与页面调度，不混用论文版本跑分。

## 2026-10-28 · PLY 加载长度检查

- 默认高斯加载按场景清单检查解压后长度，超长块在结果收集前拒绝并取消源流，短包与缺失长度也不进入模型初始化；见[边界验证与截图](docs/PLY-SIZE.md)。
- 模拟超长输入从完整读取约 1MiB 变为供给 1KiB 后拒绝；这是流计数，不是网络或内存峰值。4 组真实文件字节、3 种失败后恢复和 10 个原始画面对照通过。
- 新增 7 项回归，共 85 项测试、类型检查及构建通过；默认照片、模型、SH3 与画质不变，正常加载耗时未重新测量。
- 补充 [BoundedGS v1](https://arxiv.org/abs/2610.34233v1)、[作者有界预取](https://github.com/XiaoBin2001/BoundedGS/blob/23bca8369a793ab9e29cc2b5d7c5966d4660d850/utils/image_prefetch.py)及 [Spark 输入复制](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)；区分临时工作集与总内存，未套用 CUDA 训练跑分。

## 2026-10-28 · 受控加载耗时

- 补齐候选模型的限速加载对照：5MiB/s、每请求服务器等待 40ms，热运行时下缓存未命中等待由管道 12.686s 降至 2.870s、办公室 9.640s 降至 2.090s；见[分段耗时与截图](docs/PACED-MODEL.md)。
- 缓存命中后仍需 223.75 / 173.75ms，候选初始化本身较慢，收益主要来自读取减少。计至排序稳定后的绘制提交，未测屏幕首帧、峰值内存或 CDN。
- 32 个耗时样本、52 个像素控制通过，36 个模型各释放一次；新增 3 项回归，共 78 项测试、类型检查与构建通过。保留候选量化代价，默认模型不变。
- 补充 [KoalaGS v1](https://arxiv.org/abs/2610.28615v1)、[作者演示](https://rdbch.github.io/koalags/)与 [Spark Worker](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/worker.ts)；记录论文/演示字节口径差异，作者训练代码及许可尚未发布，不套用论文跑分。

## 2026-10-28

- 完成候选模型的真实 HTTP 缓存验证，复现固定 URL 的旧 AP16 连续触发 PLY 回退；含内容摘要的新 URL 恢复候选加载，并可正常命中缓存。见[结果、截图与复现](docs/HTTP-MODEL.md)。
- 两场景 20 项加载检查通过，覆盖缓存命中、304、连接中断及主动取消；36 个画面对照一致，18 个模型各释放一次。正文 0B 不等于免除解码，不新增首帧或内存提升结论。
- 新增 3 项 HTTP 回归，75 项测试、类型检查及构建通过；默认页面与资源未变，下一步使用版本化资源测受控网络首帧。
- 复核 [Spark Worker 读取](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/worker.ts)与 [Fetch 缓存规则](https://developer.mozilla.org/en-US/docs/Web/API/Request/cache)，补充 [SplatStream v2](https://arxiv.org/abs/2607.25971v2)；区分论文带宽估算与真实 HTTP 测量，未移植未核实许可的作者实现。

## 2026-10-27

- 接通独立 SH8 + AP16 候选加载，校验配对及各文件摘要；取消后释放迟到模型，失败时回退原始 PLY，回退也失败则保留原画面。见[验证、截图与原始记录](docs/PAIRED-MODEL.md)。
- 两场景 30 个画面对照逐像素一致，10 项浏览器加载结果通过，12 个实验模型各释放一次；候选和回退漫游正常。未测真实缓存、首帧或内存，不新增性能提升结论。
- 新增 10 项回归，72 项测试、类型检查和构建通过；默认网页、资源及生产包未变，后续优先验证受控 HTTP 缓存与端到端加载。
- 参考 [ProGS 论文](https://arxiv.org/abs/2603.09703)、[作者清单校验](https://github.com/ZhiyeTang/ProGS-Official/blob/f0e7b5d977fe38bde47eeb45a985c7b15940d0d9/progs/artifact.py)与 [Spark 分页取消修复](https://github.com/sparkjsdev/spark/pull/392)；区分下载取消和不可中断初始化，未移植研究许可的编码器。

- 新增 AP16 候选数据的可取消流式读取器，修复旧实验读取在取消后仍写入属性的问题；错误模型、异常头部、超长数据和 CRC 失败均在写回前拒绝。见[对照与原始数据](docs/ALPHA16-STREAM.md)。
- 浏览器模拟源中，错误头供给量从 262,242B 降至 1,024B，取消后目标数组保持原样；结果缓冲按点数限定并设 8MiB 上限。计数不代表真实网络节省或峰值内存。
- 两场景 AP16 的 gzip/HTTP 展开输入共 4 组检查逐字节一致；新增 11 项回归，62 项测试、类型检查与构建通过。只验证 CPU 读取组件，尚未接入正式模型加载，未重复 GPU 实验或更换默认资源。
- 核对 [Spark 加载实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)，补充 [MoQSplat 论文](https://arxiv.org/abs/2609.18624)及[作者接收代码](https://github.com/emanuele-artioli/MoQSplat/blob/15e02a669456d767abf5d68f9fb1f909f260dde0/src/moq3dgs/transport/client.py)；后续验证模型初始化迟到结果、回退和缓存配对，不将流取消等同 Worker 取消。

- 完成 SH8 + 高精度不透明度附加文件验证，pipes / office 合计 12.47 / 8.90MiB，比 gzip PLY 小 79.84% / 80.97%；20 个画面逐像素复现此前恢复效果，见[文件、画质、耗时与截图](docs/SPZ-ALPHA16.md)。
- 16 次串行内存输入加载中，总等待中位数为 366.65→233.25ms、296.55→188.05ms；附加解压/校验/恢复分别为 7.40 / 4.80ms。尚未验证网络冷/热加载、显存或 FPS，默认模型不替换。
- 新增模型摘要绑定和完整数据验证，异常输入在写回前拒绝；两场景漫游及复位正常，51 项测试、类型检查与构建通过。候选仍有少数视角低于原始画质，后续先验证取消、回退和缓存。
- 参考 [MesonGS++ v2](https://arxiv.org/abs/2604.26799v2)、[作者总文件核算](https://github.com/mmlab-sigs/mesongs_plus/blob/0004153458b73387e0044b6f553f62116117388d/splatwizard/model_zoo/mesongs_plus/qbit_search_tool.py)与 [Spark 属性实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/ExtSplats.ts)，保留附加数据和解码开销，不套用论文跑分。

- 定位 SH8 压缩后的主要剩余误差：单独恢复不透明度，pipes / office 留出平均 PSNR 回升 0.171 / 0.306dB，接近原始 PLY；新增[属性对照、截图与原始数据](docs/SPZ-NONSH.md)。
- 完成 80 个画面、20 项逐像素复制控制，并复现全部 531,428 个不透明度字节；没有高斯因量化变为完全透明。下一步优先验证高精度不透明度的真实文件与解码成本，默认模型不替换。
- 实验页支持逐项查看与漫游，修正手动切换时复制模型的清理，避免跨场景叠加；新增 3 项属性掩码检查，47 项测试、类型检查与构建通过。内存诊断不沿用既有压缩率或耗时收益。
- 参考 [PLEDGE 论文](https://arxiv.org/abs/2610.17605)、[Spark 属性布局](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/utils.ts)与[SPZ 编码器](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/spz.rs)，区分参数误差与最终合成画质；新论文的作者实现和许可仍待核实。

- 完成独立 SPZ3 高精度 SH 文件实验，非 SH 属性逐字节不变；pipes / office 留出平均 PSNR 比原 SPZ 回升 0.520 / 0.461dB，实际文件为 11.96 / 8.51MiB。见[数据、耗时、截图与复现](docs/SPZ-SH8.md)。
- 候选比 gzip PLY 小 80.65% / 81.80%，但六个留出视角仍低于原始模型；暂不替换默认资源，不沿用原 SPZ 的加载速度。后续优先拆分颜色、尺度、旋转和不透明度误差。
- 30 次画面对照完成，20 个控制画面与此前像素哈希一致，自由查看与复位正常；3 项 Python 检查、44 项 Node 测试、类型检查和构建通过。
- 核对 [Spark SH 编码实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/spz.rs)，新增 [CCT-GS 论文](https://arxiv.org/abs/2610.26920)及[作者仓库](https://github.com/yfffffy/CCT-GS/tree/73c4f3e917a7ea0938180935bd7b62cdcbebb0fe)研究；代码、预训练模型和代码许可尚未发布，保留为候选。

- 分离 SPZ3 的 SH 与其他属性误差：恢复原始 SH 后，pipes / office 留出平均 PSNR 回升 0.522 / 0.462dB，但仍低于原始模型 0.170 / 0.296dB；优先验证更高精度 SH，默认模型不替换。
- 完成 40 次画面对照，20 组复制控制逐像素一致，点序符合定点量化误差范围；新增[原始数据、截图与复现页](docs/SPZ-ATTRIBUTES.md)。混合属性尚无对应压缩文件，不沿用完整 SPZ 的体积或耗时收益。
- 更正 SPZ 抗锯齿标志说明：flags=1 来自编码器固定值，不代表原始元数据已保留；区分半精度中间表示和 SPZ 位宽的误差来源。44 项测试、类型检查及构建通过。
- 参考 [SH 颜色压缩论文](https://arxiv.org/abs/2609.15735)、[Spark 属性实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/rust/spark-lib/src/gsplat.rs)和[共享指数修复](https://github.com/sparkjsdev/spark/pull/465)；后者已包含于当前版本，不重复修改。

## 2026-10-26

- 完成独立 SPZ3 格式对照，保留高斯数量与 SH3：两场景文件比 gzip PLY 减少 88.86% / 89.55%；16 次串行加载、全部留出视角和偏转画面记录见[报告与截图](docs/SPZ-FORMAT.md)。
- 内存输入下加载中位数由 417.65→244.55ms、392.30→232.70ms；这不包含网络，不作为冷加载、FPS 或显存提升结论，且 SPZ 解压计入初始化阶段。
- 暂不更新默认模型：六个留出视角 PSNR/SSIM 均下降，场景平均 PSNR 损失 0.692 / 0.758dB。候选单独归档，后续先检查量化误差；漫游、截图复核及 44 项测试、类型检查和构建通过。
- 核对 [Spark SPZ 编码实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/spz.ts)、[SPZ4 发行](https://github.com/nianticlabs/spz/releases/tag/v3.0.0)和 [GPU 纹理压缩论文](https://arxiv.org/abs/2607.14513)，区分格式读写支持、传输体积与渲染驻留成本。

- 完成预分配解码缓冲的 32 次串行对照：两场景、原始 PLY/gzip 两条内存输入路径，完整输出哈希全部一致。保留[原始耗时与复现脚本](docs/READ-BUFFER.md)。
- 暂不接入默认加载器：已解压 PLY 收集快约 2ms，但 gzip 路径仅差约 1–2ms且样本范围重叠；未验证端到端首帧、峰值内存或取消路径收益。
- 默认模型与线上渲染保持原样。后续优先研究格式与解压成本，不把局部内存流结果解释为网络加载提速。
- 参考 [SpeedyGS 论文](https://arxiv.org/abs/2607.12656)的编码复杂度取舍与 [Spark 读取实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)，记录代码可用性和后端适配的待验证项。

- 评测页新增本次场景加载耗时，可在加载完成后直接导出 JSON；分别记录读取/解压、模型解析初始化、首帧准备与总等待，保留原始阶段偏移。
- 计时区分并行阶段、加载时画幅及后台经历，失败/取消不发布部分记录，旧请求不覆盖新场景。缓存未受控时不标注冷/热加载，首帧准备也不混作独立 GPU 或排序线程耗时。
- 本地两场景四次加载已形成[分段样本](docs/LOAD-TIMING.md)：高斯读取/解压与首帧准备是下一步关注环节。全部留出像素与画质指标不变，四项生命周期及桌面/窄屏检查通过；44 项测试与构建通过，不新增提速比例。
- 参考 [Spark 初始化实现](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatMesh.ts)、[加载依赖链讨论](https://github.com/sparkjsdev/spark/issues/321)及 [LMG 论文与作者实现](https://aiins-nthu.github.io/LMG/)，记录分层预览与完整模型就绪的不同边界。

- 照片切换时只在画布像素尺寸真正变化后调用 setSize，每侧重复设置由 2 次降为 0 次；相机和按需重绘仍正常更新。
- 两场景全部留出视角的 12 对像素哈希及画质指标完全一致；512/1024/768 尺寸切换的另 12 对图像也与各自基线一致，漫游与复位检查通过。见[对照与截图](docs/VIEW-RESIZE.md)。
- 42 项测试、类型检查和构建通过。此次记录调用数下降，未测量 FPS、GPU 时间或显存重分配，不宣称修复了当前浏览器未复现的闪烁。
- 参考 [Three.js r180](https://github.com/mrdoob/three.js/blob/r180/src/renderers/WebGLRenderer.js) 与 [Spark 按需渲染](https://sparkjs.dev/docs/on-demand-rendering/)；新增[随机高斯时序降噪论文](https://arxiv.org/abs/2609.25604)评估，保留为需要独立验证后端与收敛代价的候选。

## 2026-10-25

- 将 PLY 文件头校验前移到解码流，错误响应无需等到末尾才失败，同时停止剩余读取并保留准确的格式错误提示。
- 浏览器异步分块夹具中，原始/gzip 错误响应的源供给量从约 1 MiB 降至 1 KiB；这是模拟源计数，预读和缓存可能改变结果，不作为实际网络或内存节省承诺。见[验证记录](docs/PLY-HEADER.md)。
- 新增 3 项回归测试，42 项测试、类型检查和构建通过；pipes/office 完整模型输出逐字节不变。本次仅验证 CPU 加载路径，未运行 GPU 性能对照。
- 参考 [Spark 文件类型识别](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)；补充 [KISS-GS 论文](https://arxiv.org/abs/2608.26948)及[作者解码器](https://fraunhoferhhi.github.io/KISS-GS/decode_sogxt.py)研究，记录格式与许可待核实条件，尚未替换默认模型。

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
