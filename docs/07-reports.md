# 第七章 出实验报告：截图与排版

[← 上一章：做实验](06-experiments.md) | [返回目录](../README.md) | [下一章：踩坑清单 →](08-pitfalls.md)

---

## 7.1 三种截图方式，按场景选

| 方式 | 适用 | 优点 | 缺点 |
|:---|:---|:---|:---|
| **headless 浏览器** | HDFS/YARN/JobHistory 等 Web UI | 高清 1400×900、自动、可批量 | 需要 SSH 隧道 + full-access |
| **VNC 抓屏** | 控制台、登录界面、`jps` 输出 | 无依赖，任何画面都能抓 | 只有 800×600，纯文本 |
| **vmrun capture_screen** | 客户机当前画面 | MCP 直接调 | 需要 Tools 且分辨率受限 |

## 7.2 Web UI 截图：必须走 SSH 隧道

**这是最容易卡住的地方。** 现象：宿主机浏览器打不开 `http://192.168.7.128:8088`。

### 原因有两个

```bash
# 8088 只绑定 127.0.0.1（Hadoop 默认行为）
LISTEN  127.0.0.1:8088

# 9870 虽然绑 *，但被 firewalld 拦了
LISTEN  *:9870
systemctl is-active firewalld  →  active
```

### 解决办法：SSH 隧道

把客户机端口映射到宿主机本地端口：

```powershell
ssh -i "$env:USERPROFILE\.ssh\vmware_centos" -N `
    -L 18088:localhost:8088 `
    -L 19870:localhost:9870 `
    -L 19888:localhost:19888 `
    root@192.168.7.128
```

之后访问：

| 服务 | 隧道地址 |
|:---|:---|
| YARN | `http://127.0.0.1:18088/cluster/apps` |
| HDFS | `http://127.0.0.1:19870/explorer.html#/user/hive/warehouse` |
| JobHistory | `http://127.0.0.1:19888/jobhistory` |

> **`-N` 表示不执行远程命令**，只做端口转发。这个进程会一直挂着，用后台方式启动。

### 后台启动隧道

```powershell
$p = Start-Process -FilePath $ssh -ArgumentList $args -PassThru -WindowStyle Hidden
$p.Id | Out-File .tunnel.pid
```

关闭时读 pid 文件 `Stop-Process`。

## 7.3 headless 浏览器截图

### 基本命令

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --no-sandbox --disable-gpu `
  --hide-scrollbars --window-size=1400,1200 `
  --virtual-time-budget=8000 `
  --user-data-dir="$env:TEMP\edge-shot" `
  --screenshot=D:\shots\yarn.png `
  "http://127.0.0.1:18088/cluster/apps"
```

### 关键参数

| 参数 | 作用 | 不写会怎样 |
|:---|:---|:---|
| `--headless=new` | 无界面模式 | 弹窗，脚本无法继续 |
| `--no-sandbox` | 避免权限问题 | 可能启动失败 |
| `--window-size` | 窗口尺寸 | **任务多时表格被截断** |
| `--virtual-time-budget` | 等 JS 渲染完再截 | **截到空白页** |
| `--user-data-dir` | 独立配置目录 | 与已开的浏览器冲突 |

> **`--virtual-time-budget` 是重中之重。** YARN 页面是 JS 渲染的，
> 给不够时间会截到一张空白页。8000ms 实测够用。

### 坑：沙箱阻断

headless 浏览器依赖**命名管道 IPC** 与渲染子进程通信。

在 `workspace-write` 沙箱下会报：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:187
Check failed: . : 拒绝访问。 (0x5)
```

**必须切到 `danger-full-access`。** 这是硬限制，没有绕过方法。

### 效果

![YARN UI](../assets/yarn-ui.png)

## 7.4 VNC 截图：控制台专用

当需要截「`jps` 输出」「登录界面」这类控制台画面时用 VNC：

```powershell
node vnc.mjs shot  127.0.0.1:5901 out.png
node vnc.mjs login 127.0.0.1:5901 root 123456
node vnc.mjs type  127.0.0.1:5901 "jps"
node vnc.mjs keys  127.0.0.1:5901 Return
```

> **注意**：VNC 端口由 **VMware 提供**（`vmware-vmx` 进程监听 5901），
> 不是客户机里的 vncserver。客户机里查 `ss -lnt | grep 590` 是空的，这是正常的。

### 分辨率限制

VNC 只有 800×600，纯文本界面。放进报告勉强能看，但不如 Web UI 截图清楚。
**能用 Web UI 截图就别用 VNC。**

## 7.5 报告生成器：把内容写成 JSON

`report_builder.py` 接受一份 JSON 配置，支持 7 种内容块。

### 块类型

| 类型 | 作用 | 关键字段 |
|:---|:---|:---|
| `h1` / `h2` / `h3` | 三级标题 | `text` |
| `p` | 正文段落 | `text`, `bold` |
| `bullet` | 无序列表 | `text` |
| `code` | 等宽代码块 | `text`, `size` |
| `table` | 表格 | `headers`, `rows` |
| `image` | 图片 + 图注 | `path`, `caption`, `width_cm` |
| `pagebreak` | 分页 | — |

### 配置示例

```json
{
  "title": "实验报告标题",
  "subtitle": "副标题",
  "meta": "日期 / 主机",
  "blocks": [
    { "type": "h1", "text": "一、实验目标" },
    { "type": "p", "text": "正文内容" },
    { "type": "code", "text": "yum install -y xxx" },
    {
      "type": "table",
      "headers": ["项目", "值"],
      "rows": [["Hadoop", "3.3.6"]]
    },
    {
      "type": "image",
      "path": "shots/yarn-final.png",
      "caption": "图1 YARN 应用列表",
      "width_cm": 15.5
    }
  ]
}
```

### 生成命令

```powershell
python lab/report_builder.py --out 报告.docx --config 配置.json
```

## 7.6 排版的两个必做检查

### ① 图片宽度不能超过页面可用宽度

```python
from docx import Document

d = Document("报告.docx")
s = d.sections[0]
avail = (s.page_width - s.left_margin - s.right_margin) / 360000.0
# A4 (21cm) + 2.54cm 边距 → 15.92 cm

for sh in d.inline_shapes:
    w = sh.width / 360000.0
    print(f"{w:.2f} cm  {'OK' if w <= avail else '溢出!'}")
```

**超了会溢出到页边距外。** `report_builder.py` 已自动限制在可用宽度内。

> 默认 `python-docx` 生成的文档是 **Letter**（21.59×27.94cm），不是 A4。
> 必须显式设置 `sec.page_width = Cm(21.0)`，否则宽度计算全错。

### ② 渲染成图片实际看一眼

用 LibreOffice Kit 把 docx 渲染成 PNG，逐页检查：

```powershell
node cli.js render --input 报告.docx --output-dir ./render --pages "1,4,5"
```

重点看：

- 表格是否被挤变形
- 代码块是否折行
- 图片是否完整
- 图注是否跟着图
- 中文是否有字体缺失

## 7.7 报告内容怎么组织

一份好的实验报告应该包含：

| 章节 | 内容 | 数据来源 |
|:---|:---|:---|
| 实验目标 | 对应哪份文档、哪一节 | 原文 |
| 实验环境 | 版本、资源、网络 | `lab.ps1 status` |
| 执行步骤 | 每步命令 + 真实结果 | 脚本输出 |
| 运行截图 | Web UI 截图 | 自动截取 |
| 验收点核对 | 逐条对照 | 实测 |
| 踩坑记录 | 遇到的问题 + 解决 | 真实经历 |
| 结论 | 目标是否达成 | 综合 |

> **踩坑记录是最有价值的部分。** 它证明你真的动手做了，而不是抄的。

---

[← 上一章：做实验](06-experiments.md) | [返回首页](../README.md) | [下一章：踩坑清单 →](08-pitfalls.md)
