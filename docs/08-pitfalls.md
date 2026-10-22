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

---

## 8.5 快速排查表

| 症状 | 先查什么 |
|:---|:---|
| 客户端看不到工具 | 路径是否绝对、是否 `npm install` |
| 工具调不通 | `config.json` 的 `encoding` 是否 `gbk` |
| SSH 连不上 | 密钥是否用 cmd 生成、`authorized_keys` 权限是否 600 |
| 虚拟机没 IP | `systemctl status vmtoolsd`、网络模式 |
| 命令没输出 | 是否被 `grep` 过滤掉了、是否超时 |
| 截图空白 | `--virtual-time-budget` 是否够、URL 是否通 |
| 中文乱码 | `.vmx` 是 GBK、`vmrun` 输出是 UTF-8 |

---

[← 上一章：出报告](07-reports.md) | [返回首页](../README.md) | [下一章：最小可用清单 →](09-minimal.md)
