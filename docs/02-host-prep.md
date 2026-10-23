# 第二章 宿主机准备

[← 上一章：整体架构](01-architecture.md) | [返回目录](../README.md) | [下一章：打通通道 →](03-channels.md)

---

## 2.1 安装 VMware Workstation

版本建议 **17.x**。本教程基于 `17.6.4 build-24832109`，vmrun `1.17.0`。

安装后确认 vmrun 可用：

```powershell
# 默认安装路径
& "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe" -T ws list

# 输出示例
Total running VMs: 1
D:\VMs\CentOS 7 64 位.vmx
```

> **不知道装在哪？不用找。** `server.js` 和 `doctor.mjs` 会按这个顺序自动探测：
> 安装注册表 `HKLM\SOFTWARE\WOW6432Node\VMware, Inc.\VMware Workstation\InstallPath`
> → `Program Files` 两个常见目录 → `PATH`。
>
> ```powershell
> node scripts/doctor.mjs    # 会直接打印探测到的 vmrun 路径
> ```
>
> 只有装在非常规位置且注册表里没有记录时，才需要手动填 `config.json` 的 `vmrunPath`。

## 2.2 安装 Node.js

MCP 服务器是 Node 写的，需要 **Node 18+**（推荐 20/22 LTS）。

```powershell
node --version
# v22.12.0

where.exe node
# C:\Program Files\nodejs\node.exe
```

> **建议记下 node.exe 的绝对路径**。如果你同时装了多个 Node 版本（nvm、volta），
> MCP 配置里写绝对路径能避免版本漂移。

## 2.3 PowerShell 的两个门槛

`.ps1` 脚本（`lab.ps1` / `guest-sh.ps1`）在 Windows 上有两个常见拦路虎，
一次配好，后面就不用管：

### ① 执行策略

默认策略会拒绝运行未签名的脚本：

```
无法加载文件 ...lab.ps1，因为在此系统上禁止运行脚本。
```

修法（只影响当前用户，不需要管理员）：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`node scripts/doctor.mjs` 会检查这一项。

### ② 编码

脚本里含中文注释，文件是 **UTF-8 with BOM**。
Windows PowerShell 5.1 读不带 BOM 的 UTF-8 会乱码（`鐣欑┖` 这种），
脚本直接语法报错。仓库里的 `.ps1` 都带了 BOM，**不要用会去掉 BOM 的编辑器保存**。

> 用 **PowerShell 7（`pwsh`）** 就没有这个问题，它默认按 UTF-8 读取。
> 两个版本都支持，随你用哪个。

## 2.4 准备虚拟机

本教程用 **CentOS 7.9 最小化安装** 演示。关键配置建议：

| 项目 | 建议值 | 原因 |
|:---|:---|:---|
| 内存 | **4 GB** | Hadoop + Hive + MySQL 最低要求，2 GB 会 OOM |
| CPU | **4 核** | MR 任务并发 |
| 磁盘 | **20 GB+** | Hadoop/Hive 解压后约 2 GB，留足空间 |
| 网络 | **NAT（VMnet8）** | 宿主机能 SSH 进去，虚拟机也能上网 |
| 安装类型 | **最小化** | 不需要桌面，省内存；全程命令行操作 |

### 为什么要最小化安装

- 省 1~2 GB 内存（桌面环境本身就要 1 GB）
- 少几百个进程，Hadoop 跑得更稳
- 所有操作都是命令行，桌面没用

> 如果你已经装了桌面，也可以：`systemctl set-default multi-user.target` 切回文本模式。

### 装完系统先做三件事

```bash
# 1. 设置 root 密码
passwd root

# 2. 确认网络通
ip addr show          # 看有没有拿到 192.168.x.x
ping -c 2 mirrors.aliyun.com

# 3. 关掉 SELinux（Hadoop 会有权限问题）
setenforce 0
sed -i 's/SELINUX=enforcing/SELINUX=disabled/' /etc/selinux/config
```

## 2.5 虚拟机网络模式选择

| 模式 | 宿主机能否访问 | 虚拟机能否上网 | 推荐场景 |
|:---|:---:|:---:|:---|
| **NAT** | ✅ | ✅ | **本教程推荐** |
| 桥接 | ✅ | ✅ | 需要局域网其他机器访问 |
| 仅主机 | ✅ | ❌ | 完全离线环境 |

NAT 模式下虚拟机会拿到 `192.168.x.x` 地址，宿主机可以直接 SSH。

### 确认能 SSH

```bash
# 虚拟机内
systemctl status sshd
ss -lnt | grep :22
```

CentOS 7 最小化安装默认就有 sshd，不用额外装。

## 2.6 检查清单

动手之前，确认这几条都通过：

```powershell
# 一条命令代替下面所有手工检查
node scripts/doctor.mjs
```

它会逐项报告：Node 版本、vmrun 路径、config.json、虚拟机别名、电源状态、客户机 IP、SSH 密钥。
输出里带 `✗` 的才是阻塞项，`!` 只是建议。

手工检查的话：

```powershell
# ① vmrun 可用
& "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe" -T ws list

# ② Node 可用
node --version

# ③ 能拿到 IP
& "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe" -T ws getGuestIPAddress "D:\VMs\CentOS 7 64 位.vmx"

# ④ 能连 22 端口（NAT 模式下 ping 可能不通，用端口测试更准）
Test-NetConnection -ComputerName 192.168.7.128 -Port 22
```

全部通过就可以进 [第三章](03-channels.md) 了。

---

[← 上一章：整体架构](01-architecture.md) | [返回首页](../README.md) | [下一章：打通通道 →](03-channels.md)
