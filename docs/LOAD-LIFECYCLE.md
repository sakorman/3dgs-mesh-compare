# 加载生命周期回归

## 问题

中止 fetch 不能保证已经开始的 JSON 处理、模型解析和首帧等待立即结束。此前实现有三个资源与状态问题：旧元数据能覆盖新场景的相机；旧请求从首帧等待返回后会清除新场景；一个模型失败时，另一个已解析成功的模型没有被回收。查看器销毁后，迟到的元数据也可能继续修改相机。

## 处理方式

每次加载由独立的 `LoadScope` 持有取消信号和已取得的资源。后续请求、清空场景、加载失败或查看器销毁都会关闭相应 scope。迟到的资源在交给场景之前被释放，旧请求只能处理自己拥有的对象。

元数据、解压、初始化和首帧等待的边界均检查取消状态。任何一个模型失败后，立即中止同次加载的其他下载，并释放已成功取得的模型。GLTF 和高斯初始化没有可用的计算中断接口，因此已开始的解析可能继续执行到完成；本改动保证其结果不会留在场景中。

## 确定性浏览器测试

基线：`6f6d8f4`。两个版本使用相同 Spark 2.4.0、Three.js 0.180.0 和默认模型。

检查页使用 Promise 屏障控制顺序，不依靠点击速度或随机延迟：

1. 暂停 pipes 元数据回调，完整加载 office，再放行旧元数据。
2. 暂停 pipes 首帧等待，完整加载 office，再放行旧请求。
3. 让 pipes GLB 解析完成后令同次 Gaussian 下载失败，检查位图释放，然后重试 office。
4. 暂停元数据回调，销毁查看器，再放行回调。

旧版本分别出现元数据错误覆盖、当前模型被清空、12 张位图未关闭，以及销毁后仍修改相机。修复后的预期是新场景保持有效、失败资源全部回收、重试成功、销毁后无状态写入。

[原始对照记录](benchmarks/load-lifecycle-2026-10-25.json)

## 复现

运行 `npm run dev`，打开 `http://127.0.0.1:5178/tests/browser/load-lifecycle.html`，点击 Run overlapping loads。每项记录应为 `passed: true`，`errors` 为空。

旧版对照文件可在项目根目录生成：

```bash
python3 - <<'PY'
import subprocess
from pathlib import Path
source = subprocess.check_output(['git', 'show', '6f6d8f4:src/viewer.ts'], text=True)
for module in ['camera', 'model-bytes', 'render-scheduler', 'mesh-resources', 'types']:
    source = source.replace('"./' + module + '"', '"../src/' + module + '"')
Path('.qa').mkdir(exist_ok=True)
Path('.qa/load-baseline.ts').write_text(source)
PY
```

对照页加 `?variant=baseline`。此测试页不会进入生产构建。原先的[按钮切换记录](benchmarks/load-race-2026-10-24.json)只覆盖顺序操作：加载时按钮禁用，不能以自动点击的调用顺序推断请求重叠。

参考：[Spark #476](https://github.com/sparkjsdev/spark/pull/476)、[GLTFLoader parseAsync](https://threejs.org/docs/pages/GLTFLoader.html)、[Three.js 资源回收](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)。
