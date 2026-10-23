# 示例代码

这里的文件都是**可运行**的参考实现，不是伪代码。
服务器零依赖（只用 Node 内置模块），**不需要 `npm install`**。

## 目录布局

```
vmware-mcp-guide/
├── examples/                  <- MCP 服务器 + 脚本
│   ├── server.js              <- 入口
│   ├── config.json            <- 由 config.example.json 复制（不进 git）
│   ├── guest-sh.ps1
│   ├── lab.ps1
│   ├── report_builder.py
│   └── experiments/
└── scripts/                   <- 开发/检查工具
    ├── doctor.mjs
    ├── smoke.mjs
    └── check-links.mjs
```

`lab.ps1` 会自动找配置文件，两种布局都支持，不用改脚本：

- **仓库自带布局**（推荐）：`examples\lab.ps1` 旁边就是 `examples\config.json`；
- **自建布局**：`D:\mywork\lab\lab.ps1` 与 `D:\mywork\vmware-mcp\config.json` 同级。

截图输出统一写到工作区根目录的 `shots\`。

## 文件说明

| 文件 | 作用 | 依赖 |
|:---|:---|:---|
| `config.example.json` | 配置模板 | — |
| `server.js` | MCP 服务器（25 个工具） | 无（Node 18+ 内置模块） |
| `guest-sh.ps1` | SSH 脚本执行封装 | OpenSSH 客户端 |
| `test-client.js` | 命令行测试客户端 | 无 |
| `lab.ps1` | 日常操作总入口 | `guest-sh.ps1`、Edge |
| `report_builder.py` | 报告生成器 | `python-docx` |
| `experiments/hive-import.sh` | 示例实验脚本 | Hive 环境 |

## 快速验证

在**仓库根目录**执行：

```powershell
# 1. 复制配置并改成你的路径
copy examples\config.example.json examples\config.json

# 2. 自检：Node / vmrun / 配置 / 虚拟机 / SSH 密钥
node scripts\doctor.mjs

# 3. 真实握手：启动 server，initialize + tools/list + schema 校验
node scripts\smoke.mjs

# 4. 调具体工具
node examples\test-client.js examples\server.js '[{"name":"list_vms","arguments":{}}]'
node examples\test-client.js examples\server.js '[{"name":"probe_channels","arguments":{"vm":"centos"}}]'
```

`test-client.js` 也可以直接在 `examples` 目录里跑：`node test-client.js server.js '[...]'`。

## 修改指南

### `server.js`

不需要改。路径全部来自 `config.json`（`vmrunPath` 留空会自动探测）。
想加新工具，照现有写法加一条：

```javascript
tool("my_tool", "一句话说明这个工具做什么，写给模型看。", {
  type: "object",
  properties: { vm: { type: "string", description: "VM alias." } },
}, async (args) => {
  return text(await vmrun(["listSnapshots", resolveVm(args.vm)]));
});
```

加完跑一次 `node ..\scripts\smoke.mjs`——它会检查新工具的 schema 是否可用
（工具数变了记得同步改 `scripts/smoke.mjs` 里的 `EXPECTED_TOOLS`）。

### `lab.ps1`

需要改的通常是布局相关的一处（见上），以及可选的浏览器路径：

```powershell
$Edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

SSH 密钥路径从 `config.json` 的 `sshKeyPath` 读，不用改脚本。

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
