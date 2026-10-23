# 第三章 打通宿主机与虚拟机的通道

[← 上一章：宿主机准备](02-host-prep.md) | [返回目录](../README.md) | [下一章：编写 MCP 服务器 →](04-mcp-server.md)

---

> **这是整套方案最关键的一章。90% 的失败都出在这里。**

## 3.1 通道优先级：先枚举，再动手

**不要凭想象选通道。** 按这个顺序尝试：

| 优先级 | 通道 | 前提 | 能干什么 | 局限 |
|:---:|:---|:---|:---|:---|
| 1 | **VMware Tools**（vmrun） | 装了 open-vm-tools 且在跑 | 跑命令、传文件、截屏 | 输出合并，多命令只回最后一条 |
| 2 | **SSH** | 有 IP 且 sshd 在跑 | 完整输出、脚本、管道 | 需要免密配置 |
| 3 | **VNC** | `.vmx` 里启用 | 控制台发按键、抓画面 | 800×600，纯文本，拿不到输出 |
| ✗ | USB HID 注入 | — | 理论可行 | **17.6.4 上必失败，提权也无效** |
| ✗ | 宿主机键盘注入 | — | — | **永远到不了客户机** |

### 两条已被证伪的路，不要重复验证

这两条是实际花了大量时间才确认的，写在这里帮你省时间：

**① 宿主机键盘注入（SendKeys / keybd_event / SendInput / PostMessage）**

六种方式全部实测失败，与 UIPI、窗口焦点都无关。宿主机发的按键**永远到不了客户机**。

**② `vmrun typeKeystrokesInGuest`**

理论上等价于 vSphere 的 `PutUsbScanCodes`，能在虚拟硬件层注入扫描码，不依赖 Tools、不需要窗口焦点。

但在 Workstation 17.6.4 上：

```
报错：主机操作系统中的权限不足
真实原因：vmrun 走的是已弃用的 VIX API
```

这个错误信息**具有误导性**。已用计划任务 `RunLevel Highest` 提权验证，照样失败。
网上有大量同样报告（StackOverflow 51045974、Broadcom 社区、Reddit r/vmware）。

> **结论：控制台输入用 VNC，别在这条路上花时间。**

## 3.2 安装 VMware Tools

CentOS 7 用 `open-vm-tools`，一条命令：

```bash
yum install -y open-vm-tools
systemctl enable --now vmtoolsd
systemctl status vmtoolsd     # 确认 active
```

装好后，宿主机就能用 vmrun 拿到虚拟机 IP：

```powershell
& "C:\...\vmrun.exe" -T ws getGuestIPAddress "D:\VMs\CentOS 7 64 位.vmx"
# 192.168.7.128
```

### 如果装不上

CentOS 7 已 EOL，yum 源可能失效。换成阿里云 vault 源：

```bash
mv /etc/yum.repos.d/CentOS-Base.repo /etc/yum.repos.d/CentOS-Base.repo.bak
curl -o /etc/yum.repos.d/CentOS-Base.repo https://mirrors.aliyun.com/repo/Centos-7.repo
yum clean all && yum makecache
yum install -y open-vm-tools
```

## 3.3 配置 SSH 免密登录（强烈推荐）

这是整套方案效率的核心。配好之后所有命令都是秒回。

### 第一步：在宿主机生成密钥

```powershell
cmd.exe /c 'ssh-keygen.exe -t ed25519 -f "%USERPROFILE%\.ssh\vmware_centos" -N "" -C dsh-vmware-mcp'
```

> **坑：必须用 `cmd.exe /c` 传空口令。**
>
> PowerShell 里写 `-N '""'` 会被设成**字面量密码**（两个引号字符），
> 导致每次 SSH 都提示输入密码，而且你输什么都不对。

密钥文件名随你取（这里是 `vmware_centos`）。生成后**把路径填进 `config.json` 的 `sshKeyPath`**，
`guest-sh.ps1` 和 `lab.ps1` 都会读它，脚本里就不用改任何硬编码路径：

```json
{ "sshKeyPath": "C:\\Users\\you\\.ssh\\vmware_centos" }
```

不填则默认用 `%USERPROFILE%\.ssh\id_ed25519`。

### 第二步：把公钥放进虚拟机

**方式 A（推荐）** — 在 VMware 窗口里登录 root，粘贴公钥内容：

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat >> /root/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... dsh-vmware-mcp
EOF
chmod 600 /root/.ssh/authorized_keys
```

公钥内容在宿主机上查看：

```powershell
Get-Content "$env:USERPROFILE\.ssh\vmware_centos.pub"
```

**方式 B** — 用 vmrun 传文件（需要 Tools 已就绪）：

```powershell
& "C:\...\vmrun.exe" -T ws -gu root -gp yourpassword copyFileFromHostToGuest `
  "D:\VMs\CentOS 7 64 位.vmx" `
  "$env:USERPROFILE\.ssh\vmware_centos.pub" `
  /root/.ssh/authorized_keys
```

> 方式 B 有个坑：如果 `/root/.ssh` 目录不存在，复制会失败。先用方式 A 建好目录。

### 第三步：验证

```powershell
ssh -i "$env:USERPROFILE\.ssh\vmware_centos" -o BatchMode=yes root@192.168.7.128 "hostname"
# 应该直接返回 localhost，不提示密码
```

> **`BatchMode=yes` 的意义**：连不上立刻失败，不会卡在密码提示上。
> **脚本里必须加**，否则自动化会永久挂起。

## 3.4 一条命令验证所有通道

写个探测脚本，一次看清所有通道状态：

```bash
#!/bin/sh
IP=192.168.7.128

echo "SSH:   $(ssh -o BatchMode=yes -o ConnectTimeout=5 root@$IP hostname 2>&1)"
echo "Tools: $(systemctl is-active vmtoolsd)"
echo "VNC:   $(ss -lnt | grep -c ':590[0-9]') 个监听"
```

正常情况下 **SSH 可用就够了**，VNC 只在需要敲控制台时用。

### 用 MCP 工具探测

如果你已经有 server.js，直接调 `probe_channels`：

```
AI: 调用 probe_channels {vm: "centos"}
```

输出示例：

```
channel           status        detail
----------------  ------------  ------------------------------------------
power             ok            running
vmware_tools      ok            running
guest_ip          ok            192.168.7.128
ssh               ok            192.168.7.128:22 SSH-2.0-OpenSSH_7.4
vnc               ok            127.0.0.1:5901 RFB 003.008
serial            off           no serial0 device
host_keyboard     last-resort   SendKeys / keybd_event / SendInput / PostMessage

RECOMMENDED: vmware_tools
```

## 3.5 封装 SSH 执行（guest-sh.ps1）

MCP 的 `run_command_in_guest` 有两个硬伤：多命令只回最后一条、单次调用 120 秒超时。
所以需要一个 SSH 封装。完整实现只有 90 行，见 [`examples/guest-sh.ps1`](../examples/guest-sh.ps1)，
这里只看三个关键点。

### ① 别名 → 当前 IP

虚拟机的 IP 会变（DHCP），别名不会。所以每次执行前用 `vmrun getGuestIPAddress` 现查：

```powershell
$vmx = $Cfg.vms.$alias
$ip  = & $vmrun -T ws getGuestIPAddress $vmx 2>&1
```

### ② 路径全部来自 config.json

```powershell
$User    = if ($User)    { $User }    elseif ($Cfg.guestUser)  { $Cfg.guestUser }  else { "root" }
$KeyPath = if ($KeyPath) { $KeyPath } elseif ($Cfg.sshKeyPath) { $Cfg.sshKeyPath } else { "$env:USERPROFILE\.ssh\id_ed25519" }
```

换机器、换密钥名，只改 `config.json`，脚本不动。

### ③ CRLF 归一化 + cmd 的 stdin 重定向

```powershell
$body = (Get-Content $Script -Raw) -replace "`r`n", "`n" -replace "`r", "`n"
...
cmd.exe /c "`"$ssh`" $argLine < `"$tmp`""
```

**为什么必须这样做**

- 不转 LF：`tail -1` 会变成 `tail -1\r`，客户机报 `invalid option -- '1'`。
- 不用 cmd 重定向：PowerShell 5.1 无法把原始字节喂给原生命令，管道会破坏脚本内容。

调用示例：

```powershell
.\guest-sh.ps1 "uname -r"                 # 默认虚拟机
.\guest-sh.ps1 "uname -r" -Vm centos      # 指定别名
.\guest-sh.ps1 -Script .\local.sh         # 整个脚本送进去跑
```

## 3.6 本章检查清单

- [ ] VMware Tools 已装且 `vmtoolsd` 在跑
- [ ] `vmrun getGuestIPAddress` 能返回 IP
- [ ] SSH 密钥已生成（用 cmd 传空口令）
- [ ] 公钥已放进 `/root/.ssh/authorized_keys`，权限 600
- [ ] `ssh -o BatchMode=yes` 能免密登录
- [ ] `guest-sh.ps1` 能跑多行脚本

全部通过就可以进 [第四章](04-mcp-server.md) 了。

---

[← 上一章：宿主机准备](02-host-prep.md) | [返回首页](../README.md) | [下一章：编写 MCP 服务器 →](04-mcp-server.md)
