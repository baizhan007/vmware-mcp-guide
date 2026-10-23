#!/usr/bin/env node
// Host self-check for the VMware MCP bridge. Answers one question: "what is
// broken right now, and what do I type next?"
//
// Usage: node scripts/doctor.mjs [--json]
// Exit code: 0 = usable (warnings allowed), 1 = a hard blocker was found.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VMRUN = "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe";
const JSON_OUT = process.argv.includes("--json");

const results = [];
const blockers = [];
const warnings = [];

function record(level, label, detail) {
  results.push({ level, label, detail: detail || "" });
  if (level === "FAIL") blockers.push(`${label}: ${detail}`);
  if (level === "WARN") warnings.push(`${label}: ${detail}`);
}

function ok(label, detail) {
  record("PASS", label, detail);
}
function warn(label, detail) {
  record("WARN", label, detail);
}
function fail(label, detail) {
  record("FAIL", label, detail);
}

/** Run a command, returning { ok, stdout, stderr, code }. */
function run(file, args, timeout = 15000) {
  try {
    const stdout = execFileSync(file, args, {
      timeout,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout || "", stderr: "", code: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: (error.stdout || "").toString(),
      stderr: (error.stderr || error.message || "").toString(),
      code: typeof error.status === "number" ? error.status : -1,
    };
  }
}

/** Same lookup order as examples/server.js (kept in sync by hand). */
function resolveConfigPath() {
  const candidates = [];
  if (process.env.VMWARE_MCP_CONFIG) candidates.push(path.resolve(process.env.VMWARE_MCP_CONFIG));
  candidates.push(path.join(ROOT, "examples", "config.json"));
  candidates.push(path.join(os.homedir(), ".vmware-mcp", "config.json"));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

function findVmrun() {
  const seen = new Set();
  const found = [];
  const add = (candidate) => {
    if (!candidate) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (fs.statSync(candidate).isFile()) found.push(candidate);
    } catch {
      /* not here */
    }
  };
  add(process.env.VMWARE_VMRUN);
  // The installer's registry entry also covers custom install directories.
  for (const key of [
    "HKLM\\SOFTWARE\\VMware, Inc.\\VMware Workstation",
    "HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation",
  ]) {
    const query = run("reg.exe", ["query", key, "/v", "InstallPath"], 5000);
    const match = query.ok ? /InstallPath\s+REG_SZ\s+(.+)/i.exec(query.stdout) : null;
    if (match) add(path.join(match[1].trim(), "vmrun.exe"));
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (base) add(path.join(base, "VMware", "VMware Workstation", "vmrun.exe"));
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) add(path.join(dir, "vmrun.exe"));
  }
  return found[0] || "";
}

function findSsh() {
  const candidates = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe"),
    "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  const probe = run("where.exe", ["ssh.exe"], 5000);
  return probe.ok ? probe.stdout.split(/\r?\n/)[0].trim() : "";
}

// ---------------------------------------------------------------- host ------

function checkHost() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) ok("Node.js", `${process.versions.node}`);
  else fail("Node.js", `${process.versions.node} is too old; install Node 18 or newer`);

  if (process.platform === "win32") ok("Platform", "Windows");
  else fail("Platform", `${process.platform} — this guide and server target VMware Workstation on Windows`);
}

// ---------------------------------------------------------------- config ----

function checkPowerShell() {
  // Read the registry rather than asking PowerShell: under some agent sandboxes
  // `powershell.exe -NoProfile -Command Get-ExecutionPolicy` cannot load the
  // Security module, which would produce a false warning here.
  const scopes = [
    ["CurrentUser", "HKCU\\Software\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell"],
    ["LocalMachine", "HKLM\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell"],
    ["LocalMachine", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell"],
  ];
  const found = [];
  for (const [scope, key] of scopes) {
    const query = run("reg.exe", ["query", key, "/v", "ExecutionPolicy"], 5000);
    const match = query.ok ? /ExecutionPolicy\s+REG_SZ\s+(\S+)/i.exec(query.stdout) : null;
    if (match) found.push({ scope, policy: match[1] });
  }
  if (!found.length) {
    warn(
      "PowerShell",
      "execution policy not set (Windows clients default to Restricted, which blocks .ps1 helpers) — " +
        "fix with: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
    );
    return;
  }
  const blocking = found.filter((item) => /^(Restricted|AllSigned)$/i.test(item.policy));
  if (blocking.length) {
    const worst = blocking[0];
    warn(
      "PowerShell",
      `execution policy is ${worst.policy} (${worst.scope}), so lab.ps1 / guest-sh.ps1 will not run — ` +
        "fix with: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
    );
  } else {
    ok("PowerShell", `execution policy ${found[0].policy} (${found[0].scope})`);
  }
}

function checkConfig() {
  const configPath = resolveConfigPath();
  if (!configPath) {
    warn(
      "config.json",
      "not found — copy examples/config.example.json to examples/config.json and fill in your .vmx paths",
    );
    return { configPath, cfg: {} };
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail("config.json", `invalid JSON at ${configPath}: ${error.message}`);
    return { configPath, cfg: {} };
  }
  ok("config.json", configPath);

  const vms = cfg.vms && typeof cfg.vms === "object" ? cfg.vms : {};
  const aliases = Object.keys(vms);
  if (!aliases.length) {
    warn("VM aliases", "config.json has no vms entries");
  } else {
    ok("VM aliases", aliases.join(", "));
  }
  if (cfg.defaultVm && !aliases.includes(cfg.defaultVm)) {
    fail("defaultVm", `"${cfg.defaultVm}" is not one of: ${aliases.join(", ") || "(none)"}`);
  }
  if (/change_me/i.test(cfg.guestPassword || "")) {
    warn("guestPassword", "still CHANGE_ME — Tools-based tools will fail until you set it");
  }
  return { configPath, cfg };
}

// ---------------------------------------------------------------- vmrun -----

function checkVmrun(cfg) {
  const configured = cfg.vmrunPath || "";
  let vmrun = configured;
  if (!vmrun || !fs.existsSync(vmrun)) {
    const detected = findVmrun();
    if (detected) {
      if (configured) warn("vmrun", `configured path missing, detected ${detected}`);
      else ok("vmrun", `${detected} (auto-detected)`);
      vmrun = detected;
    }
  } else {
    ok("vmrun", vmrun);
  }

  if (!vmrun) {
    fail("vmrun", `not found; expected ${DEFAULT_VMRUN} — install VMware Workstation or set VMWARE_VMRUN`);
    return { vmrun: "", running: [] };
  }

  const list = run(vmrun, ["-T", "ws", "list"], 20000);
  if (!list.ok) {
    fail("vmrun list", (list.stderr || "failed").trim().split(/\r?\n/)[0]);
    return { vmrun, running: [] };
  }
  const running = list.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^total running vms:/i.test(line) && !/^error:/i.test(line));
  if (running.length) ok("running VMs", `${running.length}`);
  else warn("running VMs", "none — start one with start_vm or vmrun -T ws start <vmx>");
  return { vmrun, running };
}

// ------------------------------------------------------------ per alias -----

function checkAliases(cfg, vmrun, running) {
  const vms = cfg.vms && typeof cfg.vms === "object" ? cfg.vms : {};
  const ssh = findSsh();
  if (ssh) ok("ssh.exe", ssh);
  else warn("ssh.exe", "not found — enable the Windows OpenSSH Client feature for the SSH channel");

  const keyPath = cfg.sshKeyPath || path.join(os.homedir(), ".ssh", "id_ed25519");
  if (fs.existsSync(keyPath)) ok("SSH key", keyPath);
  else warn("SSH key", `${keyPath} missing — the SSH channel needs a keypair`);

  for (const [alias, vmx] of Object.entries(vms)) {
    if (!vmx || !fs.existsSync(vmx)) {
      fail(`alias ${alias}`, `.vmx not found: ${vmx || "(empty)"}`);
      continue;
    }
    const isRunning = running.some((entry) => path.resolve(entry).toLowerCase() === path.resolve(vmx).toLowerCase());
    if (!isRunning) {
      warn(`alias ${alias}`, `powered off — ${path.basename(vmx)}`);
      continue;
    }

    const ip = run(vmrun, ["-T", "ws", "getGuestIPAddress", vmx], 20000);
    const address = ip.ok ? ip.stdout.trim().split(/\r?\n/).pop() : "";
    if (!address || /^error/i.test(address)) {
      warn(`alias ${alias}`, "running but no guest IP — is open-vm-tools running?");
      continue;
    }

    const tools = run(vmrun, ["-T", "ws", "checkToolsState", vmx], 15000);
    const toolsState = tools.ok ? tools.stdout.trim() : "unknown";
    ok(`alias ${alias}`, `${address} · Tools ${toolsState}`);

    if (ssh && fs.existsSync(keyPath) && cfg.guestUser) {
      const probe = run(
        ssh,
        [
          "-i", keyPath,
          "-o", "BatchMode=yes",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=NUL",
          "-o", "ConnectTimeout=4",
          `${cfg.guestUser}@${address}`,
          "hostname",
        ],
        12000,
      );
      if (probe.ok) ok(`SSH ${alias}`, probe.stdout.trim());
      else warn(`SSH ${alias}`, "key not accepted yet — append the .pub to the guest's authorized_keys");
    }
  }
}

// ---------------------------------------------------------------- output ----

function main() {
  checkHost();
  checkPowerShell();
  const { configPath, cfg } = checkConfig();
  const { vmrun, running } = checkVmrun(cfg);
  if (vmrun) checkAliases(cfg, vmrun, running);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: blockers.length === 0, configPath, results }, null, 2));
  } else {
    console.log("VMware MCP doctor\n");
    for (const item of results) {
      const mark = item.level === "PASS" ? "✓" : item.level === "WARN" ? "!" : "✗";
      console.log(`  ${mark} ${item.label.padEnd(14)} ${item.detail}`);
    }

    console.log("");
    if (blockers.length) {
      console.log("Blockers to fix first:");
      for (const item of blockers) console.log(`  - ${item}`);
    } else if (warnings.length) {
      console.log("Usable, with warnings:");
      for (const item of warnings) console.log(`  - ${item}`);
    } else {
      console.log("Everything checks out. Register the server with your MCP client next (docs/05-register.md).");
    }
    if (blockers.length) {
      console.log("\nNext step: fix the blockers above, then re-run `npm run doctor`.");
    }
  }

  process.exit(blockers.length ? 1 : 0);
}

main();
