# 场景纹理资源回收

## 问题与修复

旧版本仅调用几何、材质和基础颜色纹理的 `dispose()`，未关闭 GLTFLoader 解码得到的 `ImageBitmap`。Three.js 将纹理和位图的生命周期分开管理，因此回收 GPU 对象后，位图仍需要应用显式关闭。

`src/mesh-resources.ts` 收集单个 GLB 场景持有的几何、材质、所有材质纹理属性和位图，并按对象去重释放。该函数只处理由该场景独占的资源，不适用于跨活动场景共享的全局纹理缓存。

## 浏览器对照

基线为 `98d62a4`，基线使用 Three.js 0.180.0 / Spark 2.3.1，候选使用 Three.js 0.180.0 / Spark 2.4.0。按 pipes → office → pipes → dispose 顺序运行，保留旧位图引用读取关闭前后尺寸，比较重新加载前后的两个画布像素哈希。

| 操作 | 待关闭位图 | 基线剩余打开 | 修复后剩余打开 |
| --- | ---: | ---: | ---: |
| 管道房切到办公室 | 12 | 12 | 0 |
| 办公室切回管道房 | 22 | 22 | 0 |
| 销毁管道房查看器 | 12 | 12 | 0 |

两个版本初次载入和重新载入后的 3DGS / Mesh 像素哈希一致，当前场景的位图尺寸始终有效。没有修改模型、相机、材质或渲染算法，故这里验证像素一致性而非重新估计训练画质。记录中的 RGBA 大小由图片尺寸估算，不是进程驻留内存或显存测量。

[原始结果](benchmarks/mesh-resources-2026-10-24.json)

## 复现

运行 `npm run dev`，打开 `http://127.0.0.1:5178/tests/browser/mesh-resources.html`，待显示 Ready 后点击 Run scene lifecycle。检查 `passed: true`、每步 `remainingOpen: 0`、`activeBitmapsValid: true` 和 `pixelsMatch: true`。

准备旧版对照时，在项目根目录执行：

```bash
python3 - <<'PY'
import subprocess
from pathlib import Path
source = subprocess.check_output(['git', 'show', '98d62a4:src/viewer.ts'], text=True)
for module in ['camera', 'model-bytes', 'render-scheduler', 'types']:
    source = source.replace('"./' + module + '"', '"../src/' + module + '"')
Path('.qa').mkdir(exist_ok=True)
Path('.qa/resource-baseline.ts').write_text(source)
PY
```

然后打开同一检查页并加上 `?variant=baseline`。旧版预期 `passed: false`，未关闭位图计数大于 0；页面在完成计数后会关闭测试持有的旧位图。此页面只用于本地验证，不包含在生产构建中。

参考：[Three.js 资源释放](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)、[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)；相关异步销毁问题另见 [Spark #476](https://github.com/sparkjsdev/spark/pull/476)。
