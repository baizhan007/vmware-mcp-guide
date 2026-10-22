# 宣传视频（纯代码生成）

`vmware-mcp-guide-promo.mp4` —— 30 秒 / 1920×1080 / 30fps / 900 帧。

**没有一帧是录屏，也没有用任何视频编辑软件。** 全部由 `make_video.py` 用 Python + Pillow 逐帧绘制。

## 分镜

| 时间 | 场景 | 画面 |
|:---|:---|:---|
| 0:00 – 0:05 | 痛点 | 终端里打出「一份大数据实验报告，要花多久？」，答案 4~6 小时弹出，其中 70% 是重复劳动 |
| 0:05 – 0:11 | 思路 | 「如果 AI 能直接操作虚拟机」+ 四节点流水线：你 → MCP → server.js → 虚拟机 |
| 0:11 – 0:17 | 执行 | 真实命令逐字打出：`vmrun start` / `ssh start-dfs.sh` / `hive -e select count(*)`，MR 任务 SUCCESS |
| 0:17 – 0:23 | 产出 | 两张卡片滑入：自动生成的 A4 报告 + 自动截取的 YARN 页面 |
| 0:23 – 0:30 | 收尾 | 仓库名、三行数据、GitHub 地址、三个标签 |

## 技术实现

### 中英混排字体选择

一个容易踩的坑：中文字体和等宽字体宽度不同，逐段切换会导致「25 个 MCP 工具」这种混排句子间距诡异。

解决方式是按整行判断：

```python
def pick_font(text, size, bold=False):
    """纯 ASCII 用等宽字体（代码感），含中文则整行用中文字体（间距均匀）。"""
    if has_cjk(text):
        return font(F_CJK_BD if bold else F_CJK, size)
    return font(F_MONO_BD if bold else F_MONO, size)
```

### 缓动与动画

| 函数 | 用途 |
|:---|:---|
| `ease_out` | 卡片滑入、淡入 |
| `ease_in_out` | 位置插值 |
| `ease_back` | 数字放大弹入（带轻微过冲） |

`ease_back` 的过冲系数：

```python
def ease_back(t):
    c = 1.70158
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2
```

### 场景交叉淡化

每个场景独立渲染成完整画面，再按权重叠加：

```python
SCENES = [
    (0.0, 5.0, scene_pain),
    (5.0, 11.0, scene_idea),
    ...
]
XF = 0.5  # 交叉淡化时长（秒）

def scene_alpha(t, s, e):
    h = XF / 2
    if t < s - h or t > e + h:
        return 0.0
    a = 1.0
    if t < s + h:
        a = (t - (s - h)) / XF
    if t > e - h:
        a = ((e + h) - t) / XF
    return clamp(a)
```

### 背景只渲染一次

渐变 + 网格 + 两团柔光（GaussianBlur 180~200px）很慢，900 帧每帧重算会跑到天荒地老。
所以 `build_background()` 只调用一次，之后每帧 `copy()`：

```python
base_img = build_background()   # 全局，只算一次
...
img = base_img.copy()           # 每帧复制
```

实测 900 帧约 3 分钟渲染完。

### 打字机效果

```python
def typed(text, t, start, cps):
    """返回已显示的文本和是否仍在打字。"""
    n = int(max(0.0, t - start) * cps)
    n = max(0, min(len(text), n))
    return text[:n], n < len(text)
```

配合闪烁光标，`blink(t, 0.4)` 让光标 0.4 秒一个周期。

## 重新生成

```powershell
# 1. 装依赖
pip install pillow

# 2. 渲染 900 帧（约 3 分钟）
python make_video.py

# 3. 编码成 mp4
ffmpeg -y -framerate 30 -i frames/%05d.png `
  -c:v libx264 -preset slow -crf 18 `
  -pix_fmt yuv420p -movflags +faststart `
  vmware-mcp-guide-promo.mp4
```

调试单个画面时只渲染指定帧，秒出：

```powershell
python make_video.py --preview 140 141    # 只渲染第 140 帧
```

## 改内容

改文案只需编辑 `make_video.py` 里的字符串常量：

| 想改什么 | 改哪里 |
|:---|:---|
| 痛点数字 | `scene_pain()` 里的 `"4 ~ 6 小时"` |
| 流水线节点 | `scene_idea()` 里的 `nodes` 列表 |
| 终端输出 | 文件顶部 `SCENE3_LINES` |
| 收尾地址 | `scene_cta()` 里的 `url` |
| 场景时长 | `SCENES` 里的起止秒数 |

## 参数

| 项 | 值 |
|:---|:---|
| 分辨率 | 1920×1080 |
| 帧率 | 30 fps |
| 时长 | 30.0 秒 |
| 帧数 | 900 |
| 编码 | H.264 / yuv420p / CRF 18 |
| 体积 | 约 1.25 MB |

> `-pix_fmt yuv420p` 是必须的：不加的话很多播放器和微信预览会显示黑屏。

## 素材

| 文件 | 来源 |
|:---|:---|
| `assets/report/page-0001.png` | `report_builder.py` 生成的 docx，用 LibreOffice 渲染成图 |
| `assets/yarn-final.png` | `lab.ps1 shot yarn` 自动截取 |

换成你自己的素材时，保持文件名不变即可，脚本会按比例缩放塞进卡片。
