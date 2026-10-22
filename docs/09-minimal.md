# 第九章 最小可用清单

[← 上一章：踩坑清单](08-pitfalls.md) | [返回目录](../README.md)

---

> **只想最快跑起来？只需要四样东西。**

## 四件套

### ① config.json — 填三个值

```json
{
  "vmrunPath": "你的 vmrun.exe 路径",
  "vms": {
    "centos": "你的 .vmx 路径"
  },
  "guestUser": "root",
  "guestPassword": "你的密码"
}
```

完整模板见 [`examples/config.example.json`](../examples/config.example.json)（复制成 `config.json` 后修改）。

### ② server.js — 25 个工具

核心是 `vmrun` 包装 + 工具注册。完整实现见 [`examples/server.js`](../examples/server.js)。

最少需要这三个工具就能开始：

- `list_vms` — 确认能连上
- `start_vm` — 开机
- `vm_status` — 查状态

### ③ 注册配置 — 一段 YAML/JSON

DSH：

```yaml
- insert:
    - id: mcp-vmware
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: vmware
        transport: stdio
        command: "D:\\nodejs\\node.exe"
        args: ["D:\\path\\to\\server.js"]
        cwd: "D:\\path\\to\\vmware-mcp"
```

其他客户端见 [第五章](05-register.md)。

### ④ SSH 密钥 — 一条命令 + 粘贴

```powershell
cmd.exe /c 'ssh-keygen.exe -t ed25519 -f "%USERPROFILE%\.ssh\vmware_centos" -N "" -C dsh-vmware-mcp'
```

把 `%USERPROFILE%\.ssh\vmware_centos.pub` 的内容追加到虚拟机 `/root/.ssh/authorized_keys`。

---

## 验证四步

```powershell
# ① vmrun 可用
& "C:\...\vmrun.exe" -T ws list

# ② 能拿 IP
& "C:\...\vmrun.exe" -T ws getGuestIPAddress "D:\VMs\xxx.vmx"

# ③ SSH 免密
ssh -i "$env:USERPROFILE\.ssh\vmware_centos" -o BatchMode=yes root@192.168.7.128 "hostname"

# ④ MCP 能调
node test-client.js server.js '[{"name":"list_vms","arguments":{}}]'
```

四条全过 → 可以用了。

---

## 分阶段投入

不用一次做完。按需逐层加：

| 阶段 | 做什么 | 能干什么 | 耗时 |
|:---|:---|:---|:---:|
| **L1 最小** | 四件套 | AI 能开关虚拟机、跑单条命令 | 30 分钟 |
| **L2 顺手** | + `guest-sh.ps1` | 能跑多行脚本、拿完整输出 | +15 分钟 |
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
| `config.json` | MCP 配置模板 |
| `server.js` | MCP 服务器完整实现（25 工具） |
| `guest-sh.ps1` | SSH 脚本执行封装 |
| `lab.ps1` | 日常操作总入口 |
| `report_builder.py` | 报告生成器（7 种内容块） |
| `experiments/hive-import.sh` | 示例实验脚本 |

---

[← 上一章：踩坑清单](08-pitfalls.md) | [返回首页](../README.md)
