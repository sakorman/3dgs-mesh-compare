# PLY 文件头提前校验

错误页面或其他格式的内容被当作模型返回时，原读取器要先收齐并解压整个响应，再检查 `ply\n` 文件头。现在在解码流的前四个字节到达时逐字节检查，发现不匹配立即拒绝，取消剩余源流并释放读取锁。有效数据保持原样传递给后续 PLY 解析器。

浏览器可能把流里的格式错误包装成 `TypeError: Failed to fetch`，因此单独保留文件头校验错误；取消信号仍优先保留调用方的取消原因。

## 验证

基线 `1e51e8d`。浏览器夹具生成 1 MiB 固定数据（xorshift32，seed=42，开头替换为 `<html>`），分别测试原始内容和浏览器 `CompressionStream` 压缩的 gzip 内容。源每次提供 1 KiB，再用 `setTimeout(0)` 让出事件循环，模拟分批到达的数据；两版本使用同一夹具。

| 路径 | 输入总字节 | 旧版源已提供 | 修复后源已提供 | 修复后取消剩余源流 |
| --- | ---: | ---: | ---: | --- |
| 原始错误响应 | 1,048,576 | 1,048,576 | 1,024 | 是 |
| gzip 错误响应 | 1,048,919 | 1,048,919 | 1,024 | 是 |

两条修复路径均返回“高斯模型文件格式无效”，没有等到源结束，读取锁已释放。有效 PLY 和 gzip 的逐字节分块夹具仍输出相同字节，页面没有未处理错误。完整结果见[浏览器记录](benchmarks/ply-header-2026-10-25.json)。

新增 3 项单元测试，覆盖剩余响应尚未到达时拒绝原始/gzip 错误头，以及短头、跨块错字节和既有 CRLF 拒绝行为。42 项测试、类型检查和生产构建通过；pipes/office 完整模型的流式输出与 zlib 参考逐字节相等，模型文件和照片完整性检查通过。

此处只检查既有的四字节签名，不替代 Spark 的完整 PLY 结构解析，也未放宽格式支持。

## 范围与限制

上表是人工分块源的供给量，不能换算为真实 HTTP 节省量或显存/内存下降。一次无节流的内存 gzip 检查中，上游在输出解码字节前已读到末尾，取消回调没有触发。解码器和浏览器可能预读，尤其当完整响应已经缓存或到达时；提前校验不能撤销这部分工作。

单元测试因此对尚未到达的尾部设置 Promise 闸门，验证错误头一旦可解码就无需等待 EOF；浏览器表格则保留两版本在相同异步分块条件下的实际计数。没有将“读取 1 KiB”当作所有浏览器或网络环境的上限。

本次检查仅使用 CPU 和 Streams API，与正在运行的重建训练错开 GPU 使用。没有新测量冷/热加载、首帧、FPS 或画质指标；合法模型字节不变，不报告这些指标的提升。

## 复现

在仓库根目录准备基线副本：

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess
Path('.qa').mkdir(exist_ok=True)
Path('.qa/header-baseline.ts').write_text(
    subprocess.check_output(['git', 'show', '1e51e8d:src/model-bytes.ts'], text=True))
PY
npm run dev
```

打开 `/tests/browser/ply-header.html?variant=baseline`，点击 **Run header checks** 读取旧版计数；去掉参数后运行修复版本。该页面不创建 WebGL 上下文，也不进入生产构建。

参考：[TransformStream](https://developer.mozilla.org/en-US/docs/Web/API/TransformStream)、[Spark 2.4.0 文件类型识别](https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/SplatLoader.ts)。当前应用在解压后显式交给 Spark 按 PLY 解析，不将 gzip 容器本身视为 PLY 类型证明。
