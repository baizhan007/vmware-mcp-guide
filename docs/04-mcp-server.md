# 第四章 编写 MCP 服务器

[← 上一章：打通通道](03-channels.md) | [返回目录](../README.md) | [下一章：注册 MCP →](05-register.md)

---

> 本章的代码和仓库里的 [`examples/server.js`](../examples/server.js) **逐行对应**。
> 你可以先跑起来，再回头读代码，不用先"抄一遍"。

## 4.1 目录结构

```
vmware-mcp-guide/
├── examples/
│   ├── server.js            # MCP 服务器（1500 行，零依赖）
│   ├── config.json          # 你的配置（由 config.example.json 复制，不进 git）
│   ├── config.example.json  # 配置模板
│   ├── test-client.js       # 命令行测试客户端
│   ├── guest-sh.ps1         # SSH 执行封装
│   └── lab.ps1              # 日常操作总入口
└── scripts/
    ├── doctor.mjs           # 环境自检：一条命令告诉你哪一步没通
    ├── smoke.mjs            # 真实握手测试（CI 跑的就是它）
    └── check-links.mjs      # 文档断链检查
```

## 4.2 不需要 `npm install`

`server.js` 只用了 Node 内置模块（`child_process` / `fs` / `os` / `path` / `net`），
MCP 的 JSON-RPC 协议是**手写**的，没有引入任何第三方包。

```powershell
node examples/server.js      # 直接就能跑（终端里会打印帮助，不是卡住）
```

> **为什么手写协议而不是用 SDK？**
>
> 1. 教学目的：你能看到 `initialize` / `tools/list` / `tools/call` 的原始报文，而不是被 SDK 包住；
> 2. 零依赖 = 没有 `node_modules`、没有版本冲突、clone 下来就能跑；
> 3. 这个服务器的工具面很小（25 个），手写的成本远低于理解 SDK 的抽象。
>
> 想用官方 SDK 的话，注册工具的写法是 `server.registerTool(name, { description, inputSchema }, handler)`
> （`McpServer` 类，`@modelcontextprotocol/sdk` 1.x 起）。两条路都行，本仓库选前者。

## 4.3 config.json：把所有环境差异关进一个文件

`server.js` 里没有一处写死你的路径。它按这个顺序找配置：

| 顺序 | 位置 | 用途 |
|:---:|:---|:---|
| 1 | `%VMWARE_MCP_CONFIG%` | 环境变量，指定任意路径（CI / 多套环境） |
| 2 | `examples/config.json` | 默认位置，和 `server.js` 同目录 |
| 3 | `%USERPROFILE%\.vmware-mcp\config.json` | 想把配置放在仓库外时用 |

```json
{
  "vmrunPath": "",
  "hostType": "ws",
  "defaultVm": "centos",
  "vms": {
    "centos": "D:\\VMs\\CentOS 7 64 位.vmx",
    "ubuntu": "D:\\VMs\\Ubuntu.vmx"
  },
  "scanRoots": ["D:\\VMs"],
  "guestUser": "root",
  "guestPassword": "your-password",
  "vmPassword": "",
  "sshKeyPath": "C:\\Users\\you\\.ssh\\id_ed25519",
  "vmrunTimeoutMs": 120000,
  "startTimeoutMs": 600000,
  "encoding": "gbk"
}
```

### 字段说明

| 字段 | 说明 | 常见错误 |
|:---|:---|:---|
| `vmrunPath` | vmrun.exe 绝对路径，**留空自动探测** | 装在非默认盘时探测不到，填绝对路径 |
| `hostType` | Workstation 固定 `ws` | 写成 `player` 会失败 |
| `defaultVm` | 不指定 vm 时用哪个 | 别名要和 `vms` 的 key 一致 |
| `vms` | 别名 → .vmx 路径 | 路径含中文没问题，反斜杠要写 `\\` |
| `scanRoots` | 自动扫描 .vmx 的目录（最多 3 层） | 不填则只认 `vms` 里配的 |
| `guestUser`/`guestPassword` | 客户机凭据 | 只影响 Tools 通道，不影响 SSH |
| `sshKeyPath` | `guest-sh.ps1` / `lab.ps1` 用的私钥 | 不填则用 `~/.ssh/id_ed25519` |
| `encoding` | `.vmx` 的编码，中文 Windows 上是 `gbk` | 写 `utf8` 会读出乱码中文名 |

> **`vmrunPath` 的自动探测顺序**：`%VMWARE_VMRUN%` → 安装注册表
> `HKLM\SOFTWARE\WOW6432Node\VMware, Inc.\VMware Workstation\InstallPath`
> → `Program Files` 两个常见目录 → `PATH`。
> 这样即使 Workstation 装在 `D:\VMware 17.0\`，也能自己找到。

## 4.4 server.js 的三段骨架

整个服务器就三段：**配置 → 工具表 → 协议循环**。

### ① 统一的 vmrun 包装（所有工具的唯一出口）

```javascript
const { spawn, spawnSync } = require("node:child_process");

function vmrun(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(CONFIG.vmrunPath, ["-T", CONFIG.hostType, ...args], {
      env: vmrunEnv(),            // 见下方「环境变量」一节
      windowsHide: true,
    });
    // ...收集 stdout/stderr，超时就 kill...
  });
}
```

所有工具都走它，超时、编码、退出码、错误文案只处理一次。

> **为什么要补环境变量**：agent 沙箱常把子进程环境清空，`vmrun` 会因为缺
> `SystemDrive` 直接崩在 `VERIFY bora\lib\ssl\ssl.c`。`vmrunEnv()` 把
> `SystemDrive` / `SystemRoot` / `ComSpec` / `PATH` 等补回去，这个问题就不再出现。

### ② 工具表：一个数组 + 一个注册函数

```javascript
const tools = [];

function tool(name, description, inputSchema, handler) {
  tools.push({ name, description, inputSchema, handler });
}

tool("start_vm", "Power on a VM (GUI window unless gui is false). Waits for the VM to start.", {
  type: "object",
  properties: {
    vm:  { type: "string", description: "VM alias, display name, or absolute .vmx path." },
    gui: { type: "boolean", description: "Show the VMware window (default true)." },
  },
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await vmrun(["start", vmx, args.gui === false ? "nogui" : "gui"]);
  return text(`started ${args.vm || CONFIG.defaultVm}`);
});
```

**这就是全部魔法**：注册一个工具 = 往数组里放一条记录。
`tools/list` 直接把它序列化给客户端，`tools/call` 按名字找 handler。

### ③ 协议循环：三行一个 JSON

```javascript
case "tools/list":
  reply(id, { tools: tools.map((t) => ({
    name: t.name, description: t.description, inputSchema: t.inputSchema,
  })) });
  return;

case "tools/call": {
  const entry = tools.find((t) => t.name === params.name);
  if (!entry) return replyError(id, -32602, `unknown tool: ${params.name}`);
  const result = await entry.handler(params.arguments || {});
  return reply(id, result);
}
```

`initialize` 时返回 `capabilities.tools` 和一段 `instructions`（给模型看的操作说明，
由 `config.json` 动态生成，不会写死某台机器的别名）。

> **传输层是 stdio**：一行一个 JSON-RPC 报文，`stdout` 只走协议，日志一律走 `stderr`。
> 这就是为什么你能用 `node examples/test-client.js` 直接测它。

## 4.5 25 个工具清单

按用途分四组。

### 电源管理（6 个）

| 工具 | 参数 | 作用 |
|:---|:---|:---|
| `start_vm` | `vm`, `gui` | 开机（gui=true 显示窗口） |
| `stop_vm` | `vm`, `mode` | 关机（soft 走系统关机，hard 直接断电） |
| `reset_vm` | `vm`, `mode` | 重启 |
| `suspend_vm` | `vm`, `mode` | 挂起到磁盘（.vmss） |
| `pause_vm` | `vm`, `paused` | 暂停/恢复（冻结，不存状态） |
| `vm_status` | `vm` | 查电源状态 + Tools 状态 + IP |

### 快照（4 个）— 改配置前必打

| 工具 | 参数 | 作用 |
|:---|:---|:---|
| `take_snapshot` | `vm`, `name` | 创建快照 |
| `list_snapshots` | `vm`, `tree` | 列出快照（可看树形） |
| `revert_snapshot` | `vm`, `name` | 回滚（丢弃当前状态） |
| `delete_snapshot` | `vm`, `name`, `deleteChildren` | 删除 |

### 客户机操作（6 个）— 需要 Tools + 凭据

| 工具 | 参数 | 作用 |
|:---|:---|:---|
| `run_command_in_guest` | `vm`, `command`, `user`, `password`, `timeoutMs` | 跑命令（Linux 用 bash，Windows 用 cmd） |
| `run_program_in_guest` | `vm`, `program`, `args` | 跑可执行文件（不过 shell） |
| `copy_file_to_guest` | `vm`, `hostPath`, `guestPath` | 宿主机 → 客户机 |
| `copy_file_from_guest` | `vm`, `guestPath`, `hostPath` | 客户机 → 宿主机 |
| `list_processes_in_guest` | `vm` | 列进程 |
| `kill_process_in_guest` | `vm`, `pid` | 按 PID 杀进程 |

### 其他（9 个）

| 工具 | 作用 |
|:---|:---|
| `list_vms` | 列出配置/发现的虚拟机 |
| `vm_info` | 看 .vmx 静态配置 |
| `capture_screen` | 截客户机画面 |
| `guest_file_op` | 列目录/判存在/建目录/删/改名 |
| `get_guest_ip` | 拿客户机 IP |
| `check_tools_state` | Tools 状态 |
| `list_host_networks` | 宿主机虚拟网络 |
| `vmrun_raw` | 逃生口：直接跑任意白名单 vmrun 命令 |
| `probe_channels` | **一次性探测所有通道可用性** |

> **`probe_channels` 是最该先调的工具。** 它直接告诉你哪个通道能用，省掉大量试错。

## 4.6 工具设计的三条原则

### ① 参数用别名，不用绝对路径

```javascript
// 好
{ vm: "centos" }

// 差
{ vm: "D:\\VMs\\CentOS 7 64 位.vmx" }
```

别名解析在 `resolveVm()` 里做，AI 不用记路径。

### ② 错误信息要能指导下一步

```javascript
// 好
throw new Error('VM is not running: ... Start it with start_vm first.');

// 差
throw new Error('error');
```

AI 看到「用 start_vm」就知道该怎么做了。

### ③ 保留逃生口

`vmrun_raw` 允许直接跑任意白名单 vmrun 命令，避免「有个功能没封装」就卡死。

```javascript
tool("vmrun_raw", "Escape hatch: run any allow-listed vmrun command directly.", {
  type: "object",
  properties: {
    command: { type: "string", description: "vmrun subcommand, e.g. listSnapshots." },
    vm:      { type: "string", description: "Optional VM alias." },
    args:    { type: "array", items: { type: "string" } },
  },
  required: ["command"],
}, async (args) => text(await vmrun([args.command, ...(args.args || [])])));
```

## 4.7 本地测试（三条命令）

不用等客户端，按顺序跑：

```powershell
# ① 环境自检：Node / vmrun / 配置 / 虚拟机 / SSH 密钥
node scripts/doctor.mjs

# ② 真实握手：启动 server → initialize → tools/list → 校验 25 个工具的 schema
node scripts/smoke.mjs

# ③ 调用具体工具
node examples/test-client.js examples/server.js '[{"name":"list_vms","arguments":{}}]'
```

输出示例：

```
running VMs: 1

running      CentOS 7 64 位  (D:\VMs\CentOS 7 64 位.vmx)

aliases:
centos -> D:\VMs\CentOS 7 64 位.vmx
```

`smoke.mjs` 就是 CI 跑的那一个——它真的把 server 拉起来通信，
而不是只做 `node --check` 语法解析（那种检查曾让一个"启动即崩"的版本通过了 CI）。

---

[← 上一章：打通通道](03-channels.md) | [返回首页](../README.md) | [下一章：注册 MCP →](05-register.md)
