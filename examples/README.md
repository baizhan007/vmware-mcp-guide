# 示例代码

这里的文件都是**可运行**的参考实现，不是伪代码。

## 推荐目录布局

把这些文件放进你自己的工程目录，结构如下：

```
D:\mywork\                      <- 任意路径
├── vmware-mcp\                 <- MCP 服务器目录
│   ├── server.js
│   ├── config.json             <- 由 config.example.json 复制而来
│   └── guest-sh.ps1
├── lab\                        <- 效率工具目录
│   ├── lab.ps1
│   ├── report_builder.py
│   └── experiments\
│       └── hive-import.sh
└── shots\                      <- 截图输出（自动创建）
```

`lab.ps1` 默认按这个布局找 `vmware-mcp\config.json`。
如果你的结构不同，改 `lab.ps1` 开头这两行：

```powershell
$Workspace = Split-Path $LabRoot -Parent
$McpDir = Join-Path $Workspace "vmware-mcp"
```

## 文件说明

| 文件 | 作用 | 依赖 |
|:---|:---|:---|
| `config.example.json` | MCP 配置模板 | — |
| `server.js` | MCP 服务器（25 个工具） | `@modelcontextprotocol/sdk` |
| `guest-sh.ps1` | SSH 脚本执行封装 | OpenSSH 客户端 |
| `test-client.js` | 命令行测试工具 | 无 |
| `lab.ps1` | 日常操作总入口 | `guest-sh.ps1`、Edge |
| `report_builder.py` | 报告生成器 | `python-docx` |
| `experiments/hive-import.sh` | 示例实验脚本 | Hive 环境 |

## 快速验证

```powershell
# 1. 装依赖
npm install

# 2. 配好 config.json 后，测试能否连上虚拟机
node test-client.js server.js '[{"name":"list_vms","arguments":{}}]'

# 3. 探测通道
node test-client.js server.js '[{"name":"probe_channels","arguments":{"vm":"centos"}}]'
```

## 修改指南

### `server.js`

唯一需要改的是 `DEFAULTS.vmrunPath`（或者干脆靠 `config.json` 覆盖）：

```javascript
const DEFAULTS = {
  vmrunPath: "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
  ...
};
```

其他逻辑一般不用动。想加新工具，照现有工具的写法加一个 `server.tool(...)` 即可。

### `lab.ps1`

需要改的通常是三处：

```powershell
$McpDir = Join-Path $Workspace "vmware-mcp"      # MCP 目录位置
$KeyPath = "$env:USERPROFILE\.ssh\vmware_centos" # SSH 密钥路径
$Edge = "C:\Program Files (x86)\..."             # 浏览器路径（已自动探测两处）
```

### `report_builder.py`

开箱即用，不用改。报告内容通过 JSON 配置驱动。

依赖安装：

```powershell
pip install python-docx
```

### `experiments/hive-import.sh`

需要按你的环境改：

```bash
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk   # 你的 JDK 路径
export HADOOP_HOME=/home/hadoop/hadoop              # 你的 Hadoop 路径
export HIVE_HOME=/home/hadoop/apache-hive-3.1.3-bin # 你的 Hive 路径
```

## 安全提醒

- `config.json` 含明文密码，**不要提交到 git**（`.gitignore` 已排除）
- SSH 私钥不要放进仓库
- 示例脚本里的 `123456` 只是演示，实际用强密码
