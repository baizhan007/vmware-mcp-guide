# 第五章 在各 MCP 客户端注册

[← 上一章：编写 MCP 服务器](04-mcp-server.md) | [返回目录](../README.md) | [下一章：做实验 →](06-experiments.md)

---

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
        command: "D:\\nodejs\\node.exe"
        args:
          - "D:\\path\\to\\vmware-mcp\\server.js"
        cwd: "D:\\path\\to\\vmware-mcp"
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
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "vmware": {
      "command": "D:\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\vmware-mcp\\server.js"],
      "cwd": "D:\\path\\to\\vmware-mcp"
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
    "command": "D:\\nodejs\\node.exe",
    "args": ["D:\\path\\to\\vmware-mcp\\server.js"],
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
      "command": "D:\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\vmware-mcp\\server.js"]
    }
  }
}
```

## 5.5 通用调试方法

不管哪个客户端，出问题都可以用这个脚本单独测：

```powershell
node test-client.js server.js '[{"name":"list_vms","arguments":{}}]'
```

如果能通，说明 server.js 没问题，是客户端配置的问题。

### 常见启动失败原因

| 现象 | 原因 | 解决 |
|:---|:---|:---|
| 客户端看不到工具 | 路径写错 | 用绝对路径，别用 `~` 或环境变量 |
| 报 `Cannot find module` | 没 `npm install` | 在 vmware-mcp 目录执行 |
| 报 `config.json not found` | 缺配置文件 | 复制 `examples/config.example.json` 为 `config.json` |
| 工具调不通 | cwd 不对 | 显式设置 `cwd` |
| 中文路径报错 | 编码问题 | `config.json` 里 `encoding: "gbk"` |

---

[← 上一章：编写 MCP 服务器](04-mcp-server.md) | [返回首页](../README.md) | [下一章：做实验 →](06-experiments.md)
