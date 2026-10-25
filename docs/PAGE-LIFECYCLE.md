# 页面返回与资源生命周期

## 修复

原页面在首个模型加载完成后才注册一次性 `pagehide` 监听，且每次离页都销毁查看器。这会漏掉首次加载期间的清理；若文档进入前进/后退缓存，恢复的页面还可能持有已经销毁的查看器。

新监听在首次异步加载前安装。`persisted=true` 时保留当前资源并中止未完成的评测；返回后，已就绪且 WebGL 上下文有效的查看器重新请求绘制。未就绪、已销毁或上下文失效时重新加载页面。`persisted=false` 时中止评测并释放查看器，随后移除监听。后台预览暂停继续由现有 visibilitychange 逻辑负责。

## 验证范围

基线为 `9e4bd00`。测试在独立静态构建中运行，排除开发服务 HMR 连接的影响。

| 检查 | 基线 | 修复后 |
| --- | --- | --- |
| 两次合成缓存往返 | 第一次离页即销毁，模型不可用 | 同一查看器及模型保留，额外模型加载为 0 |
| 元数据阻塞期间触发合成普通离页 | 未及时销毁 | 响应返回前已销毁，后续未创建模型 |
| 初次 pageshow、重复事件、普通销毁和不可恢复状态 | — | 6 项单元测试通过 |

**原生导航限制：** 当前内嵌浏览器的真实离页/返回均观察到 `persisted=false`，恢复的是新文档。上表的缓存分支由合成 PageTransitionEvent 验证，并非真实 bfcache 命中；不报告导航加速或下载节省量。上下文失效后的重载选择已做单元检查，原生 WebGL 上下文恢复仍需单独验证。

[原始记录](benchmarks/page-lifecycle-2026-10-25.json)

## 复现

准备旧页面入口：

```bash
python3 - <<'PY'
import subprocess
from pathlib import Path
source = subprocess.check_output(['git', 'show', '9e4bd00:src/main.ts'], text=True)
for module in ['style.css', 'viewer', 'benchmark', 'metrics', 'types']:
    source = source.replace('"./' + module + '"', '"../src/' + module + '"')
Path('.qa').mkdir(exist_ok=True)
Path('.qa/page-main-baseline.ts').write_text(source)
PY
npx vite build --config tests/browser/vite-page-lifecycle.config.ts
python3 -m http.server 4179 --bind 127.0.0.1 --directory .qa/history-build
```

打开 `http://127.0.0.1:4179/tests/browser/page-lifecycle.html?variant=candidate`：

- 等模型加载后，点击 Leave for history check，再用浏览器后退；检查原生事件的 `persisted` 标记。
- 点击 Simulate cached return，检查 `restored`、`modelsReused` 为 true，`extraLoads` 为 0。记录中的 `native:false` 表示合成事件。
- 加 `&case=early` 检查首次加载前的离页清理，`disposedBeforeResponse` 应为 true。
- 将 `variant` 改为 `baseline` 可复现旧行为。

此构建及旧版入口仅用于本地检查，不进入线上站点。参考：[bfcache 指南](https://web.dev/articles/bfcache)、[MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)。
