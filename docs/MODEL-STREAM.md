# Gaussian PLY 流式读取

## 改动

原读取路径先将响应缓冲为完整 ArrayBuffer；收到原始 gzip 时，再用 Blob 建立解压流。新路径从响应体读取前两个字节判断 gzip，将这些字节所属的分块与剩余输入接回同一流，再交给 `DecompressionStream`。

应用层不再为完整压缩包创建中间 ArrayBuffer 和 Blob。最终仍需一个完整的解压后 PLY 缓冲区交给 Spark，因此这不是渐进渲染，也没有改变模型格式、点数、SH 阶数或画质设置。没有测量进程内存峰值、加载耗时或 FPS，不据此计算性能提升百分比。

读取与解压共用当前加载的 AbortSignal。取消时停止原始流、释放读取锁并保留取消原因；对部分浏览器将中断报告为通用 TypeError 的行为做了归一化。网络错误和损坏文件仍按错误返回。

## 验证

| 场景 | gzip 文件大小 | 解压后 PLY 大小 | 对照 |
| --- | ---: | ---: | --- |
| pipes | 64,843,796 字节 | 70,801,551 字节 | HTTP 自动解压与原始 gzip 两种路径，前后哈希一致 |
| office | 49,050,760 字节 | 54,618,559 字节 | HTTP 自动解压与原始 gzip 两种路径，前后哈希一致 |

基线为 `84a2903` 的读取函数。Node 测试额外将两个完整模型的流式输出与 zlib gunzip 输出逐字节比较；浏览器记录包含四组输入的 SHA-256，以及取消后停止数据源、释放读取锁的结果。

测试还覆盖单字节分块、空分块、重复 gzip 响应头、损坏 gzip、空响应、读取前取消、输入尚未结束时取消、压缩输入已经结束时取消及网络中断。验证只使用 CPU 解码，未与其他重建任务并行执行 GPU 测速。

[原始浏览器记录](benchmarks/model-stream-2026-10-25.json)

## 复现

先准备无 Content-Encoding 的测试入口和旧版读取函数：

```bash
python3 - <<'PY'
import os
import subprocess
from pathlib import Path
Path('.qa').mkdir(exist_ok=True)
for scene in ['pipes', 'office']:
    source = Path('public/scenes') / scene / 'gaussians.ply.gz'
    target = Path('.qa') / (scene + '-gaussians.bin')
    if not target.exists():
        os.link(source, target)
Path('.qa/baseline-model-bytes.ts').write_text(
    subprocess.check_output(['git', 'show', '84a2903:src/model-bytes.ts'], text=True)
)
PY
npm run dev
```

打开 `http://127.0.0.1:5178/tests/browser/model-stream.html`，点击 Run decode checks。加 `?variant=baseline` 可运行旧版读取函数。两种 HTTP 路径的同一场景必须有相同哈希，候选的 `cancellation.error` 应为 `AbortError`，`sourceCancelled` 和 `readerUnlocked` 均为 true。检查页不会进入生产构建。

参考：[Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)、[ReadableStream.pipeThrough](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/pipeThrough)。
