# 第四章 编写 MCP 服务器

[← 上一章：打通通道](03-channels.md) | [返回目录](../README.md) | [下一章：注册 MCP →](05-register.md)

---

## 4.1 目录结构

```
vmware-mcp/
├── server.js          # MCP 服务器主文件
├── config.json        # 虚拟机配置
├── guest-sh.ps1       # SSH 执行封装（可选但强烈建议）
├── vnc.mjs            # VNC 截图/输入（可选）
└── test-client.js     # 命令行测试工具
```

## 4.2 初始化项目

```powershell
mkdir vmware-mcp
cd vmware-mcp
npm init -y
npm install @modelcontextprotocol/sdk
```

## 4.3 config.json

**把所有环境差异集中到这一个文件**，server.js 不用改。这是复用的关键。

```json
{
  "vmrunPath": "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
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
  "vmrunTimeoutMs": 120000,
  "startTimeoutMs": 600000,
  "encoding": "gbk"
}
```

### 字段说明

| 字段 | 说明 | 常见错误 |
|:---|:---|:---|
| `vmrunPath` | vmrun.exe 绝对路径 | 默认装在 `Program Files (x86)` |
| `hostType` | Workstation 固定 `ws` | 写成 `player` 会失败 |
| `defaultVm` | 不指定 vm 时用哪个 | 别名要和 `vms` 的 key 一致 |
| `vms` | 别名 → .vmx 路径 | 路径含中文要转义或加引号 |
| `scanRoots` | 自动扫描 .vmx 的目录 | 不填则只认 `vms` 里配的 |
| `guestUser`/`guestPassword` | 客户机凭据 | 只影响 Tools 通道，不影响 SSH |
| `encoding` | **必须是 `gbk`** | 写 utf8 会乱码 |

> **`encoding` 为什么是 gbk**：VMware 的 `.vmx` 文件是 GBK 编码，而 `vmrun` 输出是 UTF-8。
> 两者混用会导致中文路径乱码，报「找不到虚拟机」。

## 4.4 server.js 骨架

MCP 服务器本质就是一个**函数注册表**。每个工具 = 一个 JSON Schema + 一段执行逻辑。

```javascript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const CFG = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));

const server = new Server(
  { name: "vmware", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------- 核心：统一的 vmrun 包装 ----------
async function vmrun(args, timeoutMs = CFG.vmrunTimeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      CFG.vmrunPath,
      ["-T", CFG.hostType, ...args],
      { timeout: timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.trim());
      }
    );
  });
}

// ---------- 虚拟机解析 ----------
function resolveVm(value) {
  const name = value || CFG.defaultVm;
  if (!name) throw new Error("no VM given and no defaultVm configured");
  if (CFG.vms?.[name]) return CFG.vms[name];
  if (/\.vmx$/i.test(name)) return name;
  throw new Error(`unknown VM "${name}"; check config.json`);
}

// ---------- 注册工具 ----------
server.tool("start_vm", "Power on a VM", {
  vm: { type: "string", description: "VM alias or .vmx path" },
  gui: { type: "boolean", description: "Show VMware window" }
}, async ({ vm, gui }) => {
  const vmx = resolveVm(vm);
  await vmrun(["start", vmx, gui === false ? "nogui" : "gui"]);
  return { content: [{ type: "text", text: `started ${vm || CFG.defaultVm}` }] };
});

// ---------- 启动 ----------
await server.connect(new StdioServerTransport());
```

> **注意**：`vmrun` 包装函数是整个服务器的心脏。所有工具都走它，
> 统一处理超时、编码、错误，避免每个工具重复写 try/catch。

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

`vmrun_raw` 允许直接跑任意 vmrun 命令，避免「有个功能没封装」就卡死。

```javascript
server.tool("vmrun_raw", "Run any allow-listed vmrun command", {
  command: { type: "string" },
  vm: { type: "string" },
  args: { type: "array", items: { type: "string" } }
}, async ({ command, vm, args }) => {
  const full = vm ? [command, resolveVm(vm), ...(args || [])] : [command, ...(args || [])];
  return { content: [{ type: "text", text: await vmrun(full) }] };
});
```

## 4.7 本地测试

不用等客户端，直接用脚本测：

```powershell
node test-client.js server.js '[{"name":"list_vms","arguments":{}}]'
```

输出：

```
running VMs: 1

running      CentOS 7 64 位  (D:\VMs\CentOS 7 64 位.vmx)

aliases:
centos -> D:\VMs\CentOS 7 64 位.vmx
```

完整实现见 [`examples/server.js`](../examples/server.js)。

---

[← 上一章：打通通道](03-channels.md) | [返回首页](../README.md) | [下一章：注册 MCP →](05-register.md)
