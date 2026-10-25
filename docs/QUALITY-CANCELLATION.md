# 留出画质评测取消检查

## 问题与修复

在参考照片解码的 `await` 期间取消评测，旧流程仍会执行一次 3DGS 绘制、像素读回和 PSNR/SSIM 计算，到下一帧才检查取消状态。如果期间发生永久离页，查看器已经释放，旧流程还会调用一次绘制，并在 `finally` 中恢复相机。

现在在参考图像返回后先检查本次评测的取消信号和查看器状态；排序等待也接收该信号。查看器已释放或上下文失效时跳过相机恢复，结束处理不会重新启用预览或控件。正常取消仍会恢复原照片视角。

该改动阻止迟到结果触发后续计算，不中断 `Image.decode()` 本身，也不承诺取消后立即终止照片下载。参考图像仍须返回或失败后才能结束该等待。这里没有测量 FPS、GPU 时间、内存峰值或解码时间改善。

## 浏览器对照

基线 `59fb8bf`，Spark 2.4.0、Three.js 0.180.0，管道房完整 SH3、LoD 关闭，768×505。检查页加载实际应用和模型，将真实参考图像的返回值暂存在 Promise 闸门后，在该等待点触发取消或离页，再放行结果。无需靠点击速度制造竞争。

| 场景 | 指标 | 旧版 | 修复后 |
| --- | --- | ---: | ---: |
| 点击取消 | 取消后的 `pixels()` 调用 | 1 | 0 |
| 永久离页 | 销毁后的 `render()` 调用 | 1 | 0 |
| 永久离页 | 销毁后的 `setView()` 调用 | 1 | 0 |
| 永久离页 | 结束后重新启用预览 | 是 | 否 |

两种情况下都不生成部分画质报告。修复后普通取消解锁控件，永久离页则保持禁用；无页面错误或未处理 Promise 拒绝。离页由合成 `pagehide.persisted=false` 触发，用于确定性验证清理逻辑，不涉及原生导航缓存命中率。

正常路径另从 `benchmark.html` 运行 pipes 的 2 个和 office 的 4 个留出视角并导出 JSON。与[此前同配置浏览器记录](benchmarks/drawing-buffer-2026-10-25.json)比较，逐视角 PSNR 最大差异为 1.78e-15 dB，SSIM 和 MAE 完全一致，全部通过 1e-12 的数值容差。默认模型、相机、分辨率、着色器及评分公式未改动。详见[原始记录](benchmarks/quality-cancel-2026-10-25.json)。

## 复现

在仓库根目录为旧版应用入口准备隔离副本；其查看器与依赖和当前版本相同：

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess
source = subprocess.check_output(['git', 'show', '59fb8bf:src/main.ts'], text=True)
source = source.replace('from "./', 'from "../src/')
source = source.replace('import "./style.css"', 'import "../src/style.css"')
Path('.qa').mkdir(exist_ok=True)
Path('.qa/quality-main-baseline.ts').write_text(source)
PY
npm run dev
```

打开 `/tests/browser/quality-cancel.html`，点击 **Run delayed reference check**。`?case=cancel` 测试取消，`?case=dispose` 测试永久离页；添加 `&variant=baseline` 运行旧版。输出 JSON 中修复后 `passed` 为 `true`，两种基线均为 `false`。每个检查结束会释放模型，重新加载页面才能重跑；检查页不进入生产构建。

## 相关研究

[Spark #476](https://github.com/sparkjsdev/spark/pull/476)解决依赖内部的销毁后异步拒绝，不能替代应用在图像解码边界的取消检查。[近期重建系统综述](https://arxiv.org/html/2610.17513v1#S4.SS2)区分渲染吞吐与构建、更新等阶段成本；本记录只报告被阻止的无效工作次数，不将它换算为稳态渲染加速。
