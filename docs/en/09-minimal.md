# Chapter 9 — Minimal checklist

[← Chapter 8: Pitfalls](../08-pitfalls.md) | [Docs index](README.md) | [中文](../09-minimal.md)

---

> **Just want it running? Three steps, and no `npm install`.**

## Three steps

### 1. Copy the config and edit a few values

```powershell
cd vmware-mcp-guide
copy examples\config.example.json examples\config.json
```

Open `examples\config.json` and change only what applies to you:

```json
{
  "vmrunPath": "",
  "defaultVm": "centos",
  "vms": { "centos": "D:\\VMs\\CentOS 7 64 bit.vmx" },
  "guestUser": "root",
  "guestPassword": "your-password",
  "sshKeyPath": "C:\\Users\\you\\.ssh\\id_ed25519"
}
```

- `vmrunPath` — **leave it empty**; it is detected from the installer registry,
  then `Program Files`, then `PATH`.
- `vms` — absolute `.vmx` path per alias. The alias is whatever you want to call it.
- `guestPassword` / `sshKeyPath` — only needed for the VMware Tools channel and SSH.

### 2. Self-check

```powershell
node scripts/doctor.mjs
```

It reports Node, vmrun, the config file, VM state, guest IP and SSH key.
Lines marked `✗` are blockers; `!` is advice.

### 3. Verify the server

```powershell
node scripts/smoke.mjs
```

This actually spawns the server, performs `initialize` → `tools/list`, and
validates the schema of all 25 tools. `smoke: ok` means the server is fine and
any remaining problem is client configuration.

---

## Register with a client

One block of config. DSH:

```yaml
- insert:
    - id: mcp-vmware
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: vmware
        transport: stdio
        command: "C:\\Program Files\\nodejs\\node.exe"
        args: ["D:\\work\\vmware-mcp-guide\\examples\\server.js"]
        cwd: "D:\\work\\vmware-mcp-guide\\examples"
```

Claude Desktop / Cline / Cursor: see [chapter 5](../05-register.md).

Then ask the agent to call `list_vms`:

```
AI: call list_vms

→ running VMs: 1
  CentOS 7 64 bit  (D:\VMs\CentOS 7 64 bit.vmx)
  aliases: centos -> D:\VMs\CentOS 7 64 bit.vmx
```

---

## Grow it in stages

| Stage | Add | You can then | Time |
|:---|:---|:---|:---:|
| **L1** | config + MCP registration | start/stop VMs, run one command | 10 min |
| **L2** | SSH key + `guest-sh.ps1` | run multi-line scripts, get full output | +15 min |
| **L3** | `lab.ps1` | one-command start, status, queries | +30 min |
| **L4** | tunnel + screenshots + `report_builder.py` | generated report with images | +1 h |

> **Aim for L2 at least.** L1 works, but the output limits of
> `run_command_in_guest` make every interaction awkward.

---

## Common misreads

- **"MCP means the agent can do anything."** It can only do what a tool exposes.
- **"Automate everything from day one."** Run it by hand once, then script it.
- **"Snapshots are optional."** Take one before changing config; it is seconds versus a reinstall.
- **"Nobody checks the numbers."** Every number in a report should come from real output.

---

[← Chapter 8: Pitfalls](../08-pitfalls.md) | [Docs index](README.md) | [中文](../09-minimal.md)
