# 第八章 踩坑清单

[← 上一章：出报告](07-reports.md) | [返回目录](../README.md) | [下一章：最小可用清单 →](09-minimal.md)

---

> **以下每一条都是实际卡住过、花了时间才解决的。按此清单检查能省几小时。**

## 8.1 通道与输入

### 坑 1：无法向控制台发按键

**现象**

```
vmrun typeKeystrokesInGuest → 主机操作系统中的权限不足
SendKeys / keybd_event / SendInput / PostMessage → 全部无效
```

**原因**

- `vmrun typeKeystrokesInGuest` 走**已弃用的 VIX API**，错误信息具有误导性
- 宿主机键盘注入**永远到不了客户机**，与 UIPI、窗口焦点无关

**解决**

用 **VNC** 发按键，别在这条路上花时间。

```powershell
node vnc.mjs login 127.0.0.1:5901 root 123456
node vnc.mjs type  127.0.0.1:5901 "ls -l /root"
node vnc.mjs keys  127.0.0.1:5901 Return
```

---

## 8.2 环境安装

### 坑 2：Hive 启动报 NoSuchMethodError

**现象**

```
java.lang.NoSuchMethodError: com.google.common.base.Preconditions.checkArgument
```

**原因**

Hive 3.1.3 自带 `guava-19.0.jar`，Hadoop 3.3.6 用 `guava-27.0-jre.jar`，版本冲突。

**解决**

```bash
rm -f $HIVE_HOME/lib/guava-19.0.jar
cp $HADOOP_HOME/share/hadoop/common/lib/guava-27.0-jre.jar $HIVE_HOME/lib/
```

### 坑 3：`start-dfs.sh` 报 JAVA_HOME is not set

**现象**

```
JAVA_HOME is not set and could not be found.
```

**原因**

Hadoop 3.3.6 的 `hadoop-env.sh` 里 `JAVA_HOME` **全是注释行**：

```bash
# export JAVA_HOME=
# export JAVA_HOME=/usr/java/testing
```

**解决**

在文件**末尾追加**一行真实 export，不能只 sed 注释行：

```bash
echo "export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk" >> $HADOOP_HOME/etc/hadoop/hadoop-env.sh
```

### 坑 4：Hive 3.1.3 下载 404

**现象**

阿里云 / 腾讯云 / 清华 TUNA / 中科大 / 北外 / 南大，全部 404 或 403。

`archive.apache.org` 能下但只有 **50 KB/s**，326 MB 要近两小时。

**解决**

用 `repo.huaweicloud.com`，实测 **1.9 MB/s**：

```
https://repo.huaweicloud.com/apache/hive/hive-3.1.3/apache-hive-3.1.3-bin.tar.gz
```

### 坑 5：`schematool` 第二次执行报错

**现象**

```
ERROR: Table 'VERSION' already exists
```

**原因**

元数据表已初始化过。`schematool -initSchema` **只能执行一次**。

**解决**

重装需先删库：

```sql
DROP DATABASE hive_metastore;
```

---

## 8.3 网络与截图

### 坑 6：宿主机打不开 8088/9870

**现象**

浏览器访问 `http://192.168.7.128:8088` 超时或 502。

**原因**

- 8088 只绑 `127.0.0.1`
- 9870/19888 被 `firewalld` 拦

**解决**

SSH 隧道：

```powershell
ssh -i "$env:USERPROFILE\.ssh\vmware_centos" -N `
    -L 18088:localhost:8088 `
    -L 19870:localhost:9870 `
    -L 19888:localhost:19888 `
    root@192.168.7.128
```

> **注意**：如果宿主机配了代理（如 Clash），`curl` 会走代理导致 502。
> 加 `--noproxy '*'` 绕过。

### 坑 7：headless 浏览器报 platform_channel.cc:187

**现象**

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:187
Check failed: . : 拒绝访问。 (0x5)
```

**原因**

headless 浏览器依赖**命名管道 IPC**，`workspace-write` 沙箱阻断。

**解决**

切到 `danger-full-access`。这是硬限制，无绕过方法。

### 坑 8：截图截到空白页

**现象**

截图是全白或只有页头。

**原因**

Web UI 是 JS 渲染的，截太早。

**解决**

```powershell
--virtual-time-budget=8000
```

给足渲染时间。任务多时同时加大 `--window-size`。

---

## 8.4 MCP 与脚本

### 坑 9：MCP 调用超时

**现象**

```
Error: Request timed out
```

**原因**

装包 / 跑 MR 超过默认 120 秒。

**解决**

写成 `.sh` 脚本，通过 SSH 后台执行：

```powershell
nohup ./task.sh > task.log 2>&1 &
```

或者调大 `toolCallTimeoutMs`（但治标不治本）。

### 坑 10：guest-sh 报 `invalid option -- '1'`

**现象**

```
tail: invalid option -- '1'
```

**原因**

脚本内容带 CRLF（Windows 换行），`tail -1` 变成 `tail -1\r`。

**解决**

发送前做 CRLF→LF 归一化：

```powershell
$body = (Get-Content $Script -Raw) -replace "`r`n", "`n" -replace "`r", "`n"
```

### 坑 11：PowerShell 生成密钥后每次都问密码

**现象**

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\vmware_centos" -N '""'
```

之后每次 SSH 都提示输密码，而且输什么都不对。

**原因**

`-N '""'` 被 PowerShell 解析成**字面量密码**（两个引号字符），不是空口令。

**解决**

用 `cmd.exe /c` 传空口令：

```powershell
cmd.exe /c 'ssh-keygen.exe -t ed25519 -f "%USERPROFILE%\.ssh\vmware_centos" -N "" -C dsh-vmware-mcp'
```

### 坑 12：多命令串联只返回最后一条

**现象**

```javascript
run_command_in_guest { command: "echo A; echo B; echo C" }
→ 只返回 "C"
```

**原因**

`run_command_in_guest` 的 `;` 行为：vmrun 只回最后一个命令的输出。

**解决**

改用 SSH 脚本，或用 `&&` 并重定向到文件再 cat。

### 坑 13：`vmrun start ... gui` 让脚本永久挂起

**现象**

PowerShell 脚本执行到「开机」这一步就卡住不动，几分钟都没输出，也不报错。

```powershell
& $Vmrun -T ws start $Vmx gui 2>&1 | Out-Null   # 卡死在这里
Start-Sleep -Seconds 10
```

但虚拟机窗口确实弹出来了，系统也在正常启动。

**原因**

`gui` 模式下 `vmrun start` 会拉起 `vmware.exe`，然后**一直等待窗口进程**。
PowerShell 的 `&` 调用运算符会跟着阻塞，直到 VMware 窗口关闭。

**解决**

用 `Start-Process` 不等待，再轮询虚拟机状态：

```powershell
$startMode = if ($env:LAB_START_GUI -eq "1") { "gui" } else { "nogui" }
Start-Process -FilePath $Vmrun `
    -ArgumentList @("-T", "ws", "start", $Vmx, $startMode) `
    -WindowStyle Hidden | Out-Null

# 轮询，最多等 5 分钟
$up = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    $list = & $Vmrun -T ws list 2>&1
    if ($list -match [regex]::Escape($Vmx)) { $up = $true; break }
}
if (-not $up) { throw "虚拟机开机超时" }
```

> **建议默认用 `nogui`。** 服务器 / 自动化场景不需要窗口，
> 需要看画面时临时 `$env:LAB_START_GUI=1`。

### 坑 14：开机后立刻 SSH 会失败

**现象**

虚拟机刚启动，`vmrun list` 显示已在运行，但 SSH 报 `Connection refused`。

**原因**

`vmrun list` 只表示虚拟机**电源已开**，不代表 `sshd` 已起来。
CentOS 7 从开机到 sshd 就绪大约要 15~40 秒。

**解决**

开机后轮询 SSH，直到真正可用：

```powershell
$sshReady = $false
for ($i = 0; $i -lt 40; $i++) {
    $probe = & $Ssh -i $KeyPath -o BatchMode=yes -o ConnectTimeout=3 `
        "root@$ip" "echo ready" 2>&1
    if ($probe -match "ready") { $sshReady = $true; break }
    Start-Sleep -Seconds 3
}
```

### 坑 15：`jps` 显示 `-- process information unavailable`

**现象**

以 root 执行 `jps`：

```
3729 -- process information unavailable
3557 -- process information unavailable
```

**原因**

Hadoop 进程是以 `hadoop` 用户启动的。**root 看不到其他用户的 JVM 详细信息**
（`/tmp/hsperfdata_hadoop/` 目录权限限制）。

**解决**

用进程所属用户执行：

```bash
su - hadoop -c "jps"
```

> 这个坑很隐蔽：进程其实**正常运行**，只是 `jps` 显示不出来。
> 如果据此判断「Hadoop 没启动」，会做很多无用功。

### 坑 16：`jps` 只显示 `Jps` 自己

**现象**

```bash
jps
# 3355 Jps
```

**原因**

**环境变量未加载**。SSH 非交互式 shell 不会读 `~/.bash_profile`，
`JAVA_HOME`、`HADOOP_HOME` 都没设，`jps` 找不到 JVM。

**解决**

脚本里显式导出：

```bash
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
export HADOOP_HOME=/home/hadoop/hadoop
export PATH=$PATH:$JAVA_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin
```

### 坑 17：`.ps1` 直接双击或运行报「禁止运行脚本」

**现象**

```
无法加载文件 ...\lab.ps1，因为在此系统上禁止运行脚本。
```

**原因**

Windows 客户端默认执行策略是 `Restricted`，未签名的脚本一律拒绝。

**解决**

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # 只影响当前用户，不需要管理员
```

`node scripts/doctor.mjs` 会检查这一项。

### 坑 18：脚本里的中文变成 `鐣欑┖` 并语法报错

**现象**

```
Unexpected token 'config.json"
```

同时报错行里夹杂乱码，看起来像是文件损坏。

**原因**

脚本是 **UTF-8 无 BOM**，Windows PowerShell 5.1 按 GBK 解码，
中文字符被拆成非法字节，引号配对被破坏。

**解决**

- 用 **PowerShell 7（`pwsh`）** 运行，它默认 UTF-8；
- 或者用编辑器把文件另存为 **UTF-8 with BOM**（仓库里的 `.ps1` 已带 BOM，
  别用会去掉 BOM 的工具保存）。

---

## 8.5 快速排查表

| 症状 | 先查什么 |
|:---|:---|
| 客户端看不到工具 | 路径是否绝对、server 能否用 `node scripts/smoke.mjs` 通过 |
| 工具调不通 | `config.json` 的 `encoding` 是否 `gbk` |
| 报 `require is not defined in ES module scope` | `package.json` 里不该有 `"type": "module"` |
| SSH 连不上 | 密钥是否用 cmd 生成、`authorized_keys` 权限是否 600 |
| 虚拟机没 IP | `systemctl status vmtoolsd`、网络模式 |
| 命令没输出 | 是否被 `grep` 过滤掉了、是否超时 |
| 截图空白 | `--virtual-time-budget` 是否够、URL 是否通 |
| 中文乱码 | `.vmx` 是 GBK、`vmrun` 输出是 UTF-8 |
| **脚本卡在开机** | `vmrun start` 是否用了 `gui` → 改 `nogui` + `Start-Process` |
| **开机后 SSH 拒绝** | sshd 还没起，需要轮询等待 |
| **`jps` 显示 unavailable** | 用 `su - hadoop -c "jps"`，别用 root |
| **`jps` 只有 Jps** | 环境变量没导出 |

> 上面这些症状里，前四条可以用一条命令筛掉：
> `node scripts/doctor.mjs`（环境）+ `node scripts/smoke.mjs`（服务器本身）。

---

[← 上一章：出报告](07-reports.md) | [返回首页](../README.md) | [下一章：最小可用清单 →](09-minimal.md)
