# Run a command inside a guest over SSH, using the key configured for this VM.
#
# This is the fastest channel for scripted work: no VMware Tools dependency, no
# console window, and it works from any shell. Prefer it over console keystroke
# injection whenever the guest has an IP and sshd running.
#
# Examples:
#   .\guest-sh.ps1 "uname -r"                  # default VM
#   .\guest-sh.ps1 "uname -r" -Vm centos       # alias from config.json
#   .\guest-sh.ps1 "uname -r" -Vm 192.168.7.128
#   .\guest-sh.ps1 -Script .\local.sh
param(
    [Parameter(Position = 0)][string]$Command = "true",
    [string]$Vm = "",
    [string]$User = "root",
    [string]$KeyPath = "$env:USERPROFILE\.ssh\vmware_centos",
    [string]$Script = "",
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is reliable at script scope but not inside functions, so capture it.
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

# Resolve a config.json alias (e.g. "centos") to the guest's current IP, so
# callers can use the same alias the MCP tools use instead of hard-coding an
# address that changes when DHCP reassigns it.
function Resolve-GuestAddress([string]$Name) {
    $cfgPath = Join-Path $ScriptRoot "config.json"
    if (-not (Test-Path $cfgPath)) { return $Name }

    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $alias = if ($Name) { $Name } else { $cfg.defaultVm }
    if (-not $alias) { return $Name }

    # Already an address or hostname? Use it as-is.
    if ($alias -match '^\d{1,3}(\.\d{1,3}){3}$' -or $alias -match '\.[a-zA-Z]{2,}$') { return $alias }

    $vmx = $cfg.vms.$alias
    if (-not $vmx) { throw "unknown VM alias '$alias'; config.json knows: $(($cfg.vms.PSObject.Properties.Name) -join ', ')" }

    $vmrun = $cfg.vmrunPath
    if (-not (Test-Path $vmrun)) { throw "vmrun not found: $vmrun" }
    $ip = & $vmrun -T ws getGuestIPAddress $vmx 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $ip) { throw "cannot get IP for '$alias' (is the VM running with Tools up?): $ip" }
    return ($ip | Select-Object -Last 1).ToString().Trim()
}

$Vm = Resolve-GuestAddress $Vm
if (-not $Vm) { throw "no VM given and config.json has no defaultVm" }

$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
if (-not (Test-Path $ssh)) {
    $found = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if (-not $found) { throw "ssh.exe not found; enable the Windows OpenSSH Client feature" }
    $ssh = $found.Source
}
if (-not (Test-Path $KeyPath)) {
    throw "key not found: $KeyPath`nGenerate one with: ssh-keygen -t ed25519 -f `"$KeyPath`" -N `"`"`nthen append the .pub to the guest's /root/.ssh/authorized_keys"
}

# BatchMode stops ssh from hanging on a password prompt we cannot answer.
$common = @(
    "-i", $KeyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=NUL",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "LogLevel=ERROR"
)

if ($Script) {
    if (-not (Test-Path $Script)) { throw "script not found: $Script" }

    # Normalise to LF and feed via cmd's stdin redirect: PowerShell 5.1 cannot
    # pipe raw bytes into a native command, and a stray \r turns "tail -1" into
    # "tail -1\r" so the guest reports "invalid option -- '1'".
    $body = (Get-Content $Script -Raw) -replace "`r`n", "`n" -replace "`r", "`n"
    if (-not $body.EndsWith("`n")) { $body += "`n" }
    $tmp = [System.IO.Path]::Combine($env:TEMP, "guest-sh-" + [guid]::NewGuid().ToString("N") + ".sh")
    [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $argLine = ($common + @("$User@$Vm", "sh -s")) -join " "
        cmd.exe /c "`"$ssh`" $argLine < `"$tmp`"" 2>&1
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
} else {
    & $ssh @common "$User@$Vm" $Command 2>&1
}

exit $LASTEXITCODE
