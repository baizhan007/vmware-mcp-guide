# 第九章 最小可用清单

[← 上一章：踩坑清单](08-pitfalls.md) | [返回目录](../README.md)

---

> **只想最快跑起来？三步，不需要 `npm install`。**

## 三步

### ① 复制配置，改几个值

```powershell
cd vmware-mcp-guide
copy examples\config.example.json examples\config.json
```

打开 `examples\config.json`，只需要改这三处：

```json
{
  "vmrunPath": "",
  "defaultVm": "centos",
  "vms": { "centos": "D:\\VMs\\CentOS 7 64 位.vmx" },
  "guestUser": "root",
  "guestPassword": "你的密码",
  "sshKeyPath": "C:\\Users\\你\\.ssh\\id_ed25519"
}
```

- `vmrunPath` **留空即可**，会自动探测（注册表 → Program Files → PATH）。
- `vms` 填你的 `.vmx` 绝对路径，别名随便取。
- `guestPassword` / `sshKeyPath` 只在用 Tools 通道和 SSH 时才需要。

### ② 自检

```powershell
node scripts/doctor.mjs
```

逐项告诉你哪里没通：Node、vmrun、config、虚拟机状态、IP、SSH 密钥。
带 `✗` 的必须修，`!` 只是提醒。

### ③ 验证服务器能启动

```powershell
node scripts/smoke.mjs
```

它会真的把 server 拉起来，走一遍 `initialize` → `tools/list`，并校验 25 个工具的 schema。
看到 `smoke: ok` 就说明服务器本身没问题。

---

## 接入客户端

只差一段配置。DSH：

```yaml
- insert:
    - id: mcp-vmware
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: vmware
        transport: stdio
        command: "C:\\Program Files\\nodejs\\node.exe"
        args: ["D:\\work\\vmware-mcp-guide\\examples\\server.js"]
        cwd: "D:\\work\\vmware-mcp-guide\\examples"
```

其他客户端（Claude Desktop / Cline / Cursor）见 [第五章](05-register.md)。

注册后让 AI 调 `list_vms`：

```
AI: 调用 list_vms

→ running VMs: 1
  CentOS 7 64 位  (D:\VMs\CentOS 7 64 位.vmx)
  aliases: centos -> D:\VMs\CentOS 7 64 位.vmx
```

---

## 分阶段投入

不用一次做完。按需逐层加：

| 阶段 | 做什么 | 能干什么 | 耗时 |
|:---|:---|:---|:---:|
| **L1 最小** | config + 注册 MCP | AI 能开关虚拟机、跑单条命令 | 10 分钟 |
| **L2 顺手** | + SSH 免密 + `guest-sh.ps1` | 能跑多行脚本、拿完整输出 | +15 分钟 |
| **L3 高效** | + `lab.ps1` | 一键启停、状态总览、查询封装 | +30 分钟 |
| **L4 完整** | + 隧道 + 截图 + `report_builder.py` | 自动出带图报告 | +1 小时 |

> **建议至少做到 L2。** L1 虽然能用，但 `run_command_in_guest` 的输出限制会让每次操作都很别扭。

---

## 常见误区

### ❌ 以为装了 MCP 就什么都能干

MCP 只是**调用通道**。没封装成工具的操作，AI 做不了。
所以工具设计得全不全，直接决定能力边界。

### ❌ 一开始就想做全自动

先手动跑通一遍，确认每步都可行，再封装成脚本。
直接写自动化脚本，出错了很难定位。

### ❌ 忽略快照

改配置前不打快照，装崩了只能重装系统。**这个成本极高。**

```
AI: 调用 take_snapshot {"vm":"centos","name":"before-change"}
```

一条命令，几秒钟，能救你几小时。

### ❌ 在报告里编数字

验收时老师问「这个 54 秒是怎么来的」，答不上来就露馅了。
**每个数字都应该是脚本真实输出的。**

---

## 下一步

跑通最小版后，建议按这个顺序扩展：

1. 读 [第三章](03-channels.md)，把 SSH 通道彻底配好
2. 读 [第六章](06-experiments.md)，把常用命令封装成脚本
3. 读 [第七章](07-reports.md)，配置截图和报告生成
4. 遇到问题查 [第八章](08-pitfalls.md)

---

## 参考实现

本仓库 `examples/` 目录下的文件都是**可运行**的：

| 文件 | 说明 |
|:---|:---|
| `config.example.json` | 配置模板（复制成 `config.json`） |
| `server.js` | MCP 服务器完整实现（25 工具，零依赖） |
| `guest-sh.ps1` | SSH 脚本执行封装 |
| `lab.ps1` | 日常操作总入口 |
| `report_builder.py` | 报告生成器（7 种内容块） |
| `experiments/hive-import.sh` | 示例实验脚本 |

配套脚本：

| 文件 | 说明 |
|:---|:---|
| `scripts/doctor.mjs` | 环境自检 |
| `scripts/smoke.mjs` | 真实握手测试（CI 也跑这个） |
| `scripts/check-links.mjs` | 文档断链检查 |

---

[← 上一章：踩坑清单](08-pitfalls.md) | [返回首页](../README.md)
