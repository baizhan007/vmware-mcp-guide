# 第一章 整体架构

[← 返回目录](../README.md) | [下一章：宿主机准备 →](02-host-prep.md)

---

先搞清楚数据是怎么流动的，否则后面每个坑都会莫名其妙。

## 1.1 全景图

```
┌──────────────┐
│   你（人）    │  说一句「做实验」
└──────┬───────┘
       │
┌──────▼───────┐
│  MCP 客户端   │  读配置，知道有个叫 vmware 的 MCP 服务器
│ (DSH/Claude) │
└──────┬───────┘
       │  stdio（JSON-RPC）
┌──────▼───────┐
│  server.js    │  MCP 服务器，把「开虚拟机」翻译成 vmrun 命令
└──────┬───────┘
       │  ① vmrun      ② SSH      ③ VNC
┌──────▼───────────────────────────────────┐
│         VMware Workstation                │
│  ┌────────────────────────────────────┐  │
│  │  CentOS 7 虚拟机                    │  │
│  │  sshd :22   Hadoop   Hive   MySQL   │  │
│  └────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

## 1.2 三个关键认知

### ① MCP 是「工具协议」，不是「远程桌面」

MCP（Model Context Protocol）让 AI 调用一个个**具名函数**，而不是看屏幕点鼠标。

```
AI 想开机 → 调用 start_vm {vm: "centos"}
AI 想跑命令 → 调用 run_command_in_guest {command: "uptime"}
AI 想截图 → 调用 capture_screen {}
```

这意味着一件事：**凡是没封装成工具的操作，AI 都做不了**。所以工具设计得全不全，直接决定能干什么。

### ② server.js 是唯一的中间层

它把 AI 的调用翻译成两种东西：

| AI 的意图 | server.js 的动作 |
|:---|:---|
| 开/关/重启虚拟机 | `vmrun start/stop/reset` |
| 打快照/回滚 | `vmrun snapshot` |
| 在虚拟机里跑命令 | `vmrun runProgramInGuest` 或 SSH |
| 传文件 | `vmrun copyFileFromHostToGuest` |

**所有环境差异都集中在 `config.json`**，server.js 不用改。这是复用的关键。

### ③ 真正干活的是虚拟机里的 sshd

虽然 MCP 提供了 `run_command_in_guest`（走 VMware Tools），但实际用下来 **SSH 才是主力**：

| 对比项 | VMware Tools | SSH |
|:---|:---|:---|
| 完整输出 | ❌ 多命令只回最后一条 | ✅ stdout + stderr 分开 |
| 管道/重定向 | ❌ 受限 | ✅ 完整 shell |
| 速度 | 慢（每次走 vmrun） | 快（长连接） |
| 脚本 | 难 | 天然支持 |

所以本教程的推荐架构是：**MCP 管生命周期，SSH 管具体操作**。

## 1.3 一次完整调用的时序

以「跑一个 Hive 查询」为例：

```
你: 帮我看看 Hive 里有几个库

AI:  ① 调用 vm_status        → 确认虚拟机在跑
     ② 调用 get_guest_ip     → 拿到 192.168.7.128
     ③ 执行本地脚本          → ssh root@192.168.7.128 "su - hadoop -c 'hive -e ...'"
     ④ 拿到输出              → OK / default / Time taken
     ⑤ 回复你                → "只有 default 一个库"
```

注意第 ③ 步：**AI 并没有用 MCP 工具跑这条命令**，而是让宿主机执行了本地 ssh 命令。
这是刻意的设计——SSH 输出完整、速度快、支持复杂 shell 逻辑。

## 1.4 什么时候必须用 MCP 工具

| 场景 | 用什么 | 原因 |
|:---|:---|:---|
| 开机 / 关机 / 重启 | MCP `start_vm` 等 | SSH 在关机状态下不可用 |
| 打快照 / 回滚 | MCP `take_snapshot` | 只有 vmrun 能做 |
| 查虚拟机状态 | MCP `vm_status` | 直接读 vmrun |
| 虚拟机没网时传文件 | MCP `copy_file_to_guest` | 走 VMware Tools 通道 |
| 日常跑命令 | **SSH** | 输出完整、速度快 |
| 长任务（装包/跑 MR） | **SSH + 后台脚本** | 避免 120 秒超时 |

## 1.5 为什么要这么设计

如果全部用 MCP 工具会怎样？

```
run_command_in_guest {command: "yum install -y java-1.8.0-openjdk"}
→ 60 秒后返回 "完毕！"
→ 但你看不到装了哪些包、有没有警告
```

如果命令要 3 分钟呢？

```
run_command_in_guest {command: "start-dfs.sh && sleep 60 && jps"}
→ 120 秒后 MCP 超时
→ 任务被中断，你不知道进行到哪一步
```

**结论**：MCP 适合「短、明确、需要特权」的操作；SSH 适合「长、复杂、需要完整反馈」的操作。

---

[← 返回目录](../README.md) | [下一章：宿主机准备 →](02-host-prep.md)
