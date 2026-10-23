# 第五章 在各 MCP 客户端注册

[← 上一章：编写 MCP 服务器](04-mcp-server.md) | [返回目录](../README.md) | [下一章：做实验 →](06-experiments.md)

---

> 下面的路径统一写成 `<repo>`，代表你 clone 下来的仓库根目录，例如 `D:\work\vmware-mcp-guide`。
> 服务器入口是 **`<repo>\examples\server.js`**。本仓库只支持 **Windows 上的 VMware Workstation**。

## 5.1 DeepSeek Harness（DSH）

配置文件在：

```
%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
```

在文件末尾追加：

```yaml
- insert:
    - id: mcp-vmware
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: vmware
        transport: stdio
        command: "C:\\Program Files\\nodejs\\node.exe"
        args:
          - "<repo>\\examples\\server.js"
        cwd: "<repo>"
        failOnStartupError: true
        toolCallTimeoutMs: 120000
```

### 字段说明

| 字段 | 说明 |
|:---|:---|
| `serverName` | 工具名前缀。设为 `vmware`，工具就叫 `mcp__vmware__start_vm` |
| `transport` | `stdio`：本地进程；也可用 `sse` / `http` |
| `command` | node.exe 绝对路径 |
| `args` | server.js 绝对路径 |
| `cwd` | 工作目录，影响相对路径解析 |
| `failOnStartupError` | `true` 时启动失败直接报错，不静默 |
| `toolCallTimeoutMs` | 单次调用超时。跑长命令要调大 |

> **YAML 里的反斜杠要双写**（`\\`），否则会被当转义符。

### 重启验证

重启 DSH，工具列表里会出现 `mcp__vmware__*` 系列。让 AI 调 `list_vms` 验证：

```
AI: 调用 list_vms

→ running VMs: 1
  CentOS 7 64 位  (D:\VMs\CentOS 7 64 位.vmx)
  aliases: centos -> D:\VMs\CentOS 7 64 位.vmx
```

## 5.2 Claude Desktop

配置文件：

| 系统 | 路径 |
|:---|:---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "vmware": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<repo>\\examples\\server.js"],
      "cwd": "<repo>"
    }
  }
}
```

改完**完全退出** Claude（托盘图标也要退），再重启。

## 5.3 Cline / Roo Code（VS Code 插件）

在插件设置里找到 MCP Servers，添加：

```json
{
  "vmware": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["<repo>\\examples\\server.js"],
    "disabled": false,
    "autoApprove": ["list_vms", "vm_status", "get_guest_ip"]
  }
}
```

> `autoApprove` 里放只读工具，避免每次都确认。**不要**把 `stop_vm`、`delete_snapshot` 放进去。

## 5.4 Cursor

配置文件：`%USERPROFILE%\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "vmware": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<repo>\\examples\\server.js"]
    }
  }
}
```

## 5.5 通用调试方法

不管哪个客户端，出问题都按这个顺序排查：

```powershell
# ① 环境有没有问题
node scripts/doctor.mjs

# ② 服务器本身能不能启动、工具在不在
node scripts/smoke.mjs

# ③ 具体工具能不能调
node examples/test-client.js examples/server.js '[{"name":"list_vms","arguments":{}}]'
```

三条都过 → server.js 没问题，是客户端配置的问题。
第 ② 条过不了 → 直接看它打印的 stderr，不用怀疑客户端。

### 常见启动失败原因

| 现象 | 原因 | 解决 |
|:---|:---|:---|
| 客户端看不到工具 | 路径写错 | 用绝对路径，别用 `~` 或环境变量 |
| 报 `Cannot find module` | 用了旧版说明，去 `npm install` 了 | 本仓库零依赖，删掉 `node_modules` 也能跑 |
| 报 `require is not defined in ES module scope` | 仓库里混进了 `"type": "module"` | 删掉 `package.json` 里的这一行 |
| 工具调不通 | cwd 不对 | 显式设置 `cwd` |
| 中文路径报错 | 编码问题 | `config.json` 里 `encoding: "gbk"` |
| 启动后立刻退出 | 用 `node` 手工启动，而它等 stdin | 正常现象：终端里运行会打印帮助并退出，交给客户端启动即可 |

> 想看协议原文：`npx @modelcontextprotocol/inspector node examples/server.js`，
> 在网页里点 `tools/list` / `tools/call`，能直接看到 JSON-RPC 报文。

---

[← 上一章：编写 MCP 服务器](04-mcp-server.md) | [返回首页](../README.md) | [下一章：做实验 →](06-experiments.md)
