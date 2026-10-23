<#
.SYNOPSIS
    CentOS 大数据实验虚拟机工具箱 — 环境启停 / SSH 隧道 / Web UI 截图 / Hive 查询

.DESCRIPTION
    封装本机 VMware 虚拟机的常用操作，避免每次重新踩坑。
    复用 vmware-mcp\config.json 的 VM 配置与 ~\.ssh\vmware_centos 密钥。

.EXAMPLE
    .\lab.ps1 status
    .\lab.ps1 start
    .\lab.ps1 shot yarn
    .\lab.ps1 hive "show databases;"
    .\lab.ps1 tunnel stop
#>
param(
    [Parameter(Position = 0)][string]$Command = "help",
    [Parameter(Position = 1)][string]$Arg1 = "",
    [Parameter(Position = 2)][string]$Arg2 = ""
)

$ErrorActionPreference = "Stop"

# ---------------- 路径与配置 ----------------
# 支持两种布局，自动探测，不用改脚本：
#   A. 仓库自带布局：examples\lab.ps1 + examples\config.json + examples\server.js
#   B. 自建布局：      D:\mywork\lab\lab.ps1 + D:\mywork\vmware-mcp\config.json
# 截图输出统一放到仓库（或工作区）根目录的 shots\。
$LabRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Workspace = Split-Path $LabRoot -Parent

$McpDir = $null
foreach ($candidate in @(
    $LabRoot,                                  # A：配置就在本目录
    (Join-Path $Workspace "vmware-mcp"),       # B：同级 vmware-mcp 目录
    (Join-Path $LabRoot "vmware-mcp")
)) {
    if (Test-Path (Join-Path $candidate "config.json")) { $McpDir = $candidate; break }
}
if (-not $McpDir) {
    throw "找不到 config.json：请在 examples\config.json 或同级 vmware-mcp\config.json 里放一份（模板见 config.example.json）"
}

$CfgPath = Join-Path $McpDir "config.json"
$GuestSh = Join-Path $McpDir "guest-sh.ps1"
$KeyPath = ""   # 留空则用 config.json 的 sshKeyPath，见下方
$PidFile = Join-Path $LabRoot ".tunnel.pid"
$ShotDir = Join-Path $Workspace "shots"

$Ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
if (-not (Test-Path $Ssh)) {
    $found = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if (-not $found) { throw "找不到 ssh.exe，请启用 Windows OpenSSH 客户端" }
    $Ssh = $found.Source
}

$Edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $Edge)) {
    $Edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}

if (-not (Test-Path $CfgPath)) { throw "找不到配置: $CfgPath" }
$Cfg = Get-Content $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 所有路径都来自 config.json，脚本里不再写死密钥名或虚拟机名。
$KeyPath = if ($Cfg.sshKeyPath) { $Cfg.sshKeyPath } else { "$env:USERPROFILE\.ssh\id_ed25519" }
$VmAlias = if ($Cfg.defaultVm) { $Cfg.defaultVm } else { @($Cfg.vms.PSObject.Properties.Name)[0] }
if (-not $VmAlias) { throw "config.json 的 vms 里没有任何虚拟机，请先填一个别名" }
$Vmrun = $Cfg.vmrunPath
if (-not $Vmrun) {
    # 留空时按安装目录探测（Workstation 可能装在非默认路径）
    $candidates = @(
        "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe",
        "C:\Program Files\VMware\VMware Workstation\vmrun.exe"
    )
    $Vmrun = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Vmrun -or -not (Test-Path $Vmrun)) { throw "找不到 vmrun.exe；请在 config.json 里填 vmrunPath 的绝对路径" }
$Vmx = $Cfg.vms.$VmAlias

# MySQL 密码来源（按优先级）：
#   1. config.json 的 mysqlPassword 字段
#   2. 环境变量 LAB_MYSQL_PWD
#   3. 演示默认值 "123456"（仅用于跟着教程走一遍，实际使用请配到 config.json）
$MySqlPwd = if ($Cfg.mysqlPassword) { $Cfg.mysqlPassword }
            elseif ($env:LAB_MYSQL_PWD) { $env:LAB_MYSQL_PWD }
            else { "123456" }

# 隧道端口映射：本地端口 -> 客户机端口
$TunnelMap = @{
    "yarn"    = @{ Local = 18088; Remote = 8088;  Url = "http://127.0.0.1:18088/cluster/apps";       Name = "YARN Application 列表" }
    "hdfs"    = @{ Local = 19870; Remote = 9870;  Url = "http://127.0.0.1:19870/explorer.html#/user/hive/warehouse"; Name = "HDFS 目录浏览" }
    "history" = @{ Local = 19888; Remote = 19888; Url = "http://127.0.0.1:19888/jobhistory";        Name = "JobHistory 历史任务" }
}

# ---------------- 基础工具 ----------------
function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [X] $msg" -ForegroundColor Red }

function Get-GuestIp {
    if (-not (Test-Path $Vmrun)) { throw "找不到 vmrun: $Vmrun" }
    $ip = & $Vmrun -T ws getGuestIPAddress $Vmx 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $ip) { throw "拿不到客户机 IP（虚拟机是否已启动且 Tools 就绪？）: $ip" }
    return ($ip | Select-Object -Last 1).ToString().Trim()
}

function Get-VmState {
    if (-not (Test-Path $Vmrun)) { return "unknown" }
    $list = & $Vmrun -T ws list 2>&1
    if ($list -match [regex]::Escape($Vmx)) { return "running" }
    return "stopped"
}

# 在客户机里跑一段 shell（走 SSH），返回文本
function Invoke-Guest([string]$ShellText, [int]$TimeoutSec = 120) {
    $tmp = [System.IO.Path]::Combine($env:TEMP, "lab-" + [guid]::NewGuid().ToString("N") + ".sh")
    $body = $ShellText -replace "`r`n", "`n" -replace "`r", "`n"
    if (-not $body.EndsWith("`n")) { $body += "`n" }
    [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $ip = Get-GuestIp
        $argLine = @(
            "-i", $KeyPath,
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=NUL",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=8",
            "-o", "LogLevel=ERROR",
            "root@$ip", "sh -s"
        ) -join " "
        return (cmd.exe /c "`"$Ssh`" $argLine < `"$tmp`"" 2>&1 | Out-String)
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

# ---------------- 隧道 ----------------
function Get-TunnelPid {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -Raw).Trim()
    if (-not $raw) { return $null }
    $p = Get-Process -Id $raw -ErrorAction SilentlyContinue
    if ($p) { return [int]$raw }
    return $null
}

function Test-PortOpen([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(1200)
        if ($ok -and $c.Connected) { $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}

function Start-Tunnel {
    $existing = Get-TunnelPid
    if ($existing) {
        Write-Ok "隧道已在运行 (pid $existing)"
        return
    }
    if (-not (Test-Path $KeyPath)) { throw "找不到 SSH 密钥: $KeyPath" }
    $ip = Get-GuestIp
    $forwards = @()
    foreach ($k in $TunnelMap.Keys) {
        $m = $TunnelMap[$k]
        $forwards += "-L"
        $forwards += "$($m.Local):localhost:$($m.Remote)"
    }
    $args = @(
        "-i", $KeyPath,
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=NUL",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-N"
    ) + $forwards + @("root@$ip")

    $p = Start-Process -FilePath $Ssh -ArgumentList $args -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 4
    if ($p.HasExited) { throw "隧道启动失败（检查密钥权限或客户机 sshd）" }
    $p.Id | Out-File $PidFile -Encoding ascii

    # 等端口真正可连
    foreach ($k in $TunnelMap.Keys) {
        $m = $TunnelMap[$k]
        $ok = $false
        for ($i = 0; $i -lt 10; $i++) {
            if (Test-PortOpen $m.Local) { $ok = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if ($ok) { Write-Ok "隧道 $($m.Local) -> 客户机 $($m.Remote)  ($($m.Name))" }
        else { Write-Warn2 "隧道 $($m.Local) 未就绪" }
    }
}

function Stop-Tunnel {
    $existing = Get-TunnelPid
    if ($existing) {
        Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
        Write-Ok "隧道已关闭 (pid $existing)"
    } else {
        Write-Step "隧道未在运行"
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# ---------------- 截图 ----------------
function Clear-HeadlessEdge {
    Get-Process msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq '' } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
}

function Save-Shot([string]$Target, [string]$OutFile) {
    if (-not (Test-Path $Edge)) { throw "找不到 Edge: $Edge" }
    if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }

    $url = ""
    if ($TunnelMap.ContainsKey($Target)) {
        if (-not (Get-TunnelPid)) { Start-Tunnel }
        $url = $TunnelMap[$Target].Url
    } elseif ($Target -match '^https?://') {
        $url = $Target
    } else {
        throw "未知截图目标 '$Target'，可用: $($TunnelMap.Keys -join ', ') 或完整 URL"
    }

    if (-not $OutFile) {
        $OutFile = Join-Path $ShotDir ("{0}-{1}.png" -f $Target, (Get-Date -Format "yyyyMMdd-HHmmss"))
    } elseif (-not [System.IO.Path]::IsPathRooted($OutFile)) {
        $OutFile = Join-Path $ShotDir $OutFile
    }
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

    $profile = Join-Path $env:TEMP ("edge-lab-" + [guid]::NewGuid().ToString("N"))
    # 窗口高度可用 LAB_SHOT_HEIGHT 覆盖；YARN 多任务列表建议 1200
    $shotH = if ($env:LAB_SHOT_HEIGHT) { [int]$env:LAB_SHOT_HEIGHT } else { 900 }
    $edgeArgs = @(
        "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
        "--window-size=1400,$shotH", "--virtual-time-budget=8000",
        "--user-data-dir=$profile", "--screenshot=$OutFile", $url
    )
    $proc = Start-Process -FilePath $Edge -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden -Wait
    Start-Sleep -Milliseconds 1200

    if (Test-Path $OutFile) {
        $kb = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
        Write-Ok "截图已保存: $OutFile  ($kb KB)"
        return $OutFile
    }
    throw "截图失败。若沙箱为 workspace-write，headless Edge 无法建立命名管道 IPC；请切换到 danger-full-access 后重试。"
}

# ---------------- 命令实现 ----------------
function Show-Help {
    @"
CentOS 大数据实验工具箱

用法: .\lab.ps1 <命令> [参数]

  status              查看虚拟机、服务、版本、元数据库状态
  start               启动 HDFS / YARN / JobHistoryServer / MariaDB
  stop                停止 YARN / HDFS
  tunnel start        开 SSH 隧道（yarn/hdfs/history 三个端口）
  tunnel stop         关隧道
  tunnel status       查看隧道状态
  shot <目标> [文件名] 截图。目标: yarn | hdfs | history | 完整URL
  hive "<SQL>"        以 hadoop 用户执行 Hive 查询
  sql "<SQL>"         以 root 执行 MySQL 查询
  run <本地.sh路径>   把本地脚本送进客户机执行
  help                显示本帮助

示例:
  .\lab.ps1 start
  .\lab.ps1 shot yarn
  .\lab.ps1 hive "select * from student2;"
"@ | Write-Host
}

function Show-Status {
    Write-Host "=== 虚拟机 ===" -ForegroundColor White
    $state = Get-VmState
    if ($state -ne "running") {
        Write-Err "虚拟机未运行 (状态: $state)，先执行: .\lab.ps1 start"
        return
    }
    $ip = Get-GuestIp
    Write-Ok "$VmAlias 运行中，IP $ip"

    $statusScript = @'
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
echo "###PROC###"
# 必须以 hadoop 用户跑 jps，否则 root 看到的是 "process information unavailable"
su - hadoop -c "jps" 2>/dev/null | grep -v Jps
echo "###SVC###"
echo "mariadb=$(systemctl is-active mariadb 2>/dev/null)"
echo "###VER###"
java -version 2>&1 | head -1
su - hadoop -c "hadoop version" 2>/dev/null | head -1
echo "hive=$(ls -d /home/hadoop/apache-hive-3.1.3-bin 2>/dev/null)"
echo "mysql=$(mysql -uroot -p__MYSQL_PWD__ -N -e 'select version();' 2>/dev/null)"
echo "###TABLES###"
mysql -uroot -p__MYSQL_PWD__ -N -e "select count(*) from information_schema.tables where table_schema='hive_metastore';" 2>/dev/null
echo "###HIVETBLS###"
mysql -uroot -p__MYSQL_PWD__ -N -e "select TBL_NAME from hive_metastore.TBLS;" 2>/dev/null
'@
    $out = Invoke-Guest ($statusScript.Replace("__MYSQL_PWD__", $MySqlPwd))

    $sec = ""; $proc = @(); $svc = ""; $ver = @(); $mt = ""; $ht = @()
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -eq "###PROC###") { $sec = "proc"; continue }
        if ($line -eq "###SVC###")  { $sec = "svc"; continue }
        if ($line -eq "###VER###")  { $sec = "ver"; continue }
        if ($line -eq "###TABLES###") { $sec = "mt"; continue }
        if ($line -eq "###HIVETBLS###") { $sec = "ht"; continue }
        if (-not $line.Trim()) { continue }
        switch ($sec) {
            "proc" { $proc += $line.Trim() }
            "svc"  { $svc = $line.Trim() }
            "ver"  { $ver += $line.Trim() }
            "mt"   { $mt = $line.Trim() }
            "ht"   { $ht += $line.Trim() }
        }
    }

    Write-Host "=== 进程 ===" -ForegroundColor White
    if ($proc.Count) { $proc | ForEach-Object { Write-Host "  $_" } } else { Write-Warn2 "没有 Hadoop 进程，执行: .\lab.ps1 start" }

    Write-Host "=== 服务 ===" -ForegroundColor White
    Write-Host "  $svc"

    Write-Host "=== 版本 ===" -ForegroundColor White
    $ver | ForEach-Object { Write-Host "  $_" }

    Write-Host "=== 元数据库 ===" -ForegroundColor White
    Write-Host "  hive_metastore 表数: $mt"
    if ($ht.Count) { Write-Host "  已登记 Hive 表: $($ht -join ', ')" } else { Write-Warn2 "  当前没有任何 Hive 表（实验后可能已 drop）" }

    Write-Host "=== 隧道 ===" -ForegroundColor White
    $tp = Get-TunnelPid
    if ($tp) { Write-Ok "运行中 (pid $tp)" } else { Write-Step "未开启（截图时会自动开启）" }
}

function Start-Lab {
    Write-Host "=== 启动实验环境 ===" -ForegroundColor White
    $state = Get-VmState
    if ($state -ne "running") {
        Write-Step "虚拟机未运行，正在开机..."
        # 关键：不要用 & $Vmrun ... gui
        # gui 模式下 vmrun 会拉起 vmware.exe 并一直等待，PowerShell 的 & 会跟着阻塞。
        # 用 Start-Process 不等待，再轮询状态。
        $startMode = if ($env:LAB_START_GUI -eq "1") { "gui" } else { "nogui" }
        Start-Process -FilePath $Vmrun `
            -ArgumentList @("-T", "ws", "start", $Vmx, $startMode) `
            -WindowStyle Hidden | Out-Null

        $up = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 5
            $list = & $Vmrun -T ws list 2>&1
            if ($list -match [regex]::Escape($Vmx)) { $up = $true; break }
        }
        if (-not $up) { throw "虚拟机开机超时（5 分钟），检查 VMware 窗口是否有报错" }
        Write-Ok "虚拟机已开机，等待 sshd 就绪..."

        # 等 SSH 真正可用，否则后续脚本会连不上
        $sshReady = $false
        for ($i = 0; $i -lt 40; $i++) {
            $probe = & $Ssh -i $KeyPath -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL `
                -o BatchMode=yes -o ConnectTimeout=3 -o LogLevel=ERROR `
                "root@$(Get-GuestIp)" "echo ready" 2>&1
            if ($probe -match "ready") { $sshReady = $true; break }
            Start-Sleep -Seconds 3
        }
        if ($sshReady) { Write-Ok "SSH 已就绪" } else { Write-Warn2 "SSH 尚未就绪，后续步骤可能失败" }
    }
    $out = Invoke-Guest @'
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
export HADOOP_HOME=/home/hadoop/hadoop
export HIVE_HOME=/home/hadoop/apache-hive-3.1.3-bin
export PATH=$PATH:$JAVA_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$HIVE_HOME/bin

echo "[1/4] MariaDB"
systemctl start mariadb 2>&1 | tail -1
systemctl is-active mariadb

echo "[2/4] HDFS"
if su - hadoop -c "jps" 2>/dev/null | grep -q NameNode; then
  echo "NameNode 已在运行，跳过"
else
  su - hadoop -c "start-dfs.sh" 2>&1 | tail -2
fi

echo "[3/4] YARN"
if su - hadoop -c "jps" 2>/dev/null | grep -q ResourceManager; then
  echo "ResourceManager 已在运行，跳过"
else
  su - hadoop -c "start-yarn.sh" 2>&1 | tail -2
fi

echo "[4/4] JobHistoryServer"
if su - hadoop -c "jps" 2>/dev/null | grep -q JobHistoryServer; then
  echo "JobHistoryServer 已在运行，跳过"
else
  su - hadoop -c "mapred --daemon start historyserver" 2>&1 | tail -2
fi

sleep 8
echo "=== 最终进程 ==="
su - hadoop -c "jps" 2>/dev/null
'@ -TimeoutSec 300
    Write-Host $out
}

function Stop-Lab {
    Write-Host "=== 停止实验环境 ===" -ForegroundColor White
    $out = Invoke-Guest @'
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
export HADOOP_HOME=/home/hadoop/hadoop
export PATH=$PATH:$JAVA_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin
su - hadoop -c "mapred --daemon stop historyserver" 2>&1 | tail -1
su - hadoop -c "stop-yarn.sh" 2>&1 | tail -2
su - hadoop -c "stop-dfs.sh" 2>&1 | tail -2
echo "=== 剩余进程 ==="
su - hadoop -c "jps" 2>/dev/null
'@ -TimeoutSec 180
    Write-Host $out
    Write-Step "MariaDB 保持运行（如需停止: systemctl stop mariadb）"
}

function Invoke-Hive([string]$Sql) {
    if (-not $Sql) { throw '缺少 SQL。用法: .\lab.ps1 hive "show databases;"' }
    $esc = $Sql -replace '"', '\"'
    $out = Invoke-Guest @"
export JAVA_HOME=/usr/lib/jvm/java-1.8.0-openjdk
export HADOOP_HOME=/home/hadoop/hadoop
export HIVE_HOME=/home/hadoop/apache-hive-3.1.3-bin
export PATH=`$PATH:`$JAVA_HOME/bin:`$HADOOP_HOME/bin:`$HIVE_HOME/bin
su - hadoop -c 'hive -e "$esc"' 2>&1 | grep -vE '^(SLF4J|log4j|WARN|which:|Logging initialized|Hive Session ID)'
"@ -TimeoutSec 600
    Write-Host $out
}

function Invoke-MySql([string]$Sql) {
    if (-not $Sql) { throw '缺少 SQL。用法: .\lab.ps1 sql "show databases;"' }
    $esc = $Sql -replace '"', '\"'
    $out = Invoke-Guest @"
mysql -uroot -p$MySqlPwd -e "$esc" 2>&1 | grep -v 'Using a password'
"@ -TimeoutSec 120
    Write-Host $out
}

function Invoke-Script([string]$Path) {
    if (-not $Path) { throw "缺少脚本路径。用法: .\lab.ps1 run .\scripts\xx.sh" }
    if (-not [System.IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $Workspace $Path }
    if (-not (Test-Path $Path)) { throw "脚本不存在: $Path" }
    $body = Get-Content $Path -Raw
    Write-Host (Invoke-Guest $body -TimeoutSec 900)
}

# ---------------- 分发 ----------------
switch ($Command.ToLower()) {
    "status"  { Show-Status }
    "start"   { Start-Lab }
    "stop"    { Stop-Lab }
    "tunnel"  {
        switch ($Arg1.ToLower()) {
            "start"  { Start-Tunnel }
            "stop"   { Stop-Tunnel }
            "status" {
                $tp = Get-TunnelPid
                if ($tp) {
                    Write-Ok "隧道运行中 (pid $tp)"
                    foreach ($k in $TunnelMap.Keys) {
                        $m = $TunnelMap[$k]
                        $ok = Test-PortOpen $m.Local
                        Write-Host ("    {0,-8} {1} -> {2}  {3}" -f $k, $m.Local, $m.Remote, $(if ($ok) { "可连" } else { "不可连" }))
                    }
                } else { Write-Step "隧道未运行" }
            }
            default { throw "用法: .\lab.ps1 tunnel [start|stop|status]" }
        }
    }
    "shot"    { Save-Shot $Arg1 $Arg2 | Out-Null }
    "hive"    { Invoke-Hive $Arg1 }
    "sql"     { Invoke-MySql $Arg1 }
    "run"     { Invoke-Script $Arg1 }
    "help"    { Show-Help }
    default   { Show-Help }
}
