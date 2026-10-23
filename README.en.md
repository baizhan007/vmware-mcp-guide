# From zero to lab report: driving VMware VMs over MCP

> Let an AI agent operate your virtual machine: run experiments, capture UI pages, write the report.

[中文](README.md) | **English**

[![docs-check](https://github.com/baizhan007/vmware-mcp-guide/actions/workflows/docs-check.yml/badge.svg)](https://github.com/baizhan007/vmware-mcp-guide/actions/workflows/docs-check.yml)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)]()
[![VMware](https://img.shields.io/badge/VMware%20Workstation-17.x-orange)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)]()
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

---

## The problem this solves

The usual workflow: type commands in the VMware window → screenshot → paste into Word → fight the layout.
A single data-engineering lab report takes 4–6 hours, and roughly 70% of that is copy-paste.

This project turns it into:

```
You: "run the experiment and write the report"
  → the agent drives the VM over MCP (install, run, verify)
  → it captures the web UI pages itself
  → it generates a formatted .docx with real output and screenshots
  → you read it, fix the wording, done
```

**Why it is worth the setup**

- **Traceable** — every command and every number in the report came from a real run
- **Reusable** — install once; later experiments only need start/stop
- **Bugs already paid for** — [18 documented pitfalls](docs/08-pitfalls.md) save you hours
- **Zero dependencies** — the server uses only Node built-ins, so a clone runs as-is

---

## Quick start

Requirements: **Node 18+** and **VMware Workstation 17.x on Windows**.

```powershell
git clone https://github.com/baizhan007/vmware-mcp-guide.git
cd vmware-mcp-guide

# 1. Copy the config template and point it at your .vmx (leave vmrunPath empty: it self-detects)
copy examples\config.example.json examples\config.json

# 2. Self-check: Node / vmrun / config / VMs / SSH key, one command tells you what is broken
node scripts/doctor.mjs

# 3. Real handshake: start the server, initialize + tools/list, validate all 25 tool schemas
node scripts/smoke.mjs
```

`smoke: ok` means the server itself is healthy. Register it with your MCP client:

> `npm run doctor` / `npm run smoke` / `npm run check` work too, and none of them need `npm install`.

```yaml
# DSH: %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
- insert:
    - id: mcp-vmware
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: vmware
        transport: stdio
        command: "C:\\Program Files\\nodejs\\node.exe"
        args: ["D:\\work\\vmware-mcp-guide\\examples\\server.js"]
        cwd: "D:\\work\\vmware-mcp-guide\\examples"
        failOnStartupError: true
        toolCallTimeoutMs: 120000
```

Claude Desktop / Cline / Cursor variants: see [chapter 5](docs/05-register.md) (Chinese; the JSON snippets are copy-paste ready).

Verify:

```
AI: call list_vms

→ running VMs: 1
  CentOS 7 64 bit  (D:\VMs\CentOS 7 64 bit.vmx)
  aliases: centos -> D:\VMs\CentOS 7 64 bit.vmx
```

Then read [chapter 3](docs/03-channels.md) to get every channel working.

> **In a hurry?** The [minimal checklist](docs/en/09-minimal.md) is the three-step path.

---

## Table of contents

| Chapter | What it covers | Difficulty |
|:---|:---|:---:|
| [1. Architecture](docs/01-architecture.md) | How data flows | ⭐ |
| [2. Host setup](docs/02-host-prep.md) | VMware / Node / the VM | ⭐ |
| [3. Channels](docs/03-channels.md) | **The chapter that matters** | ⭐⭐⭐ |
| [4. The MCP server](docs/04-mcp-server.md) | server.js + config.json | ⭐⭐⭐ |
| [5. Registering](docs/05-register.md) | DSH / Claude Desktop / Cline / Cursor | ⭐⭐ |
| [6. Experiments](docs/06-experiments.md) | Turning commands into scripts | ⭐⭐ |
| [7. Reports](docs/07-reports.md) | Screenshots and layout | ⭐⭐ |
| [8. Pitfalls](docs/08-pitfalls.md) | **18 field-tested lessons** | ⭐ |
| [9. Minimal checklist](docs/09-minimal.md) | Copy, paste, run | ⭐ |

Chapters are written in Chinese first; English translations land chapter by chapter —
see [`docs/en/`](docs/en/README.md) for current status.

---

## What is in the box

```
vmware-mcp-guide/
├── README.md / README.en.md
├── docs/                        # 9 chapters (Chinese) + en/ (translations)
├── examples/
│   ├── server.js                # MCP server: 25 tools, zero dependencies
│   ├── config.example.json      # Copy to config.json
│   ├── guest-sh.ps1             # SSH wrapper (full stdout/stderr, no 120 s cap)
│   ├── test-client.js           # Tiny stdio client for manual calls
│   ├── lab.ps1                  # Day-to-day driver: start, status, tunnel, shots
│   ├── report_builder.py        # JSON-driven .docx builder (python-docx)
│   └── experiments/             # Example experiment scripts
├── scripts/
│   ├── doctor.mjs               # Environment self-check
│   ├── smoke.mjs                # Real handshake test (also runs in CI)
│   └── check-links.mjs          # Markdown link checker
├── video/                       # 30 s promo, rendered frame by frame in Python
└── .github/workflows/docs-check.yml
```

---

## Design decisions

| Decision | Why |
|:---|:---|
| **SSH as the main channel** | Full stdout/stderr; `run_command_in_guest` only returns the last command of a chain |
| **Long jobs as `.sh` scripts** | MCP calls default to a 120 s timeout; installs and MapReduce jobs blow through it |
| **Headless browser for UI shots** | 1400×900 and batchable; VNC gives you 800×600 of text |
| **Web UI through an SSH tunnel** | YARN binds 127.0.0.1:8088; 9870/19888 are blocked by firewalld |
| **Report content as JSON** | Content and layout stay separate; editing prose never touches code |
| **Hand-rolled JSON-RPC** | Zero dependencies, visible protocol frames, and only 25 tools to serve |

---

## Known limitations

1. **Windows + VMware Workstation only** — the helper scripts are PowerShell and assume Windows paths
2. **The headless browser needs `danger-full-access`** — it uses named-pipe IPC and dies under a `workspace-write` sandbox (`platform_channel.cc:187`)
3. **Hadoop does not auto-start after a VM reboot** — rerun the start script
4. **VNC is 800×600** — fine for the console, useless for web UI screenshots
5. **`vmrun typeKeystrokesInGuest` is broken on Workstation 17.6.4** — see [chapter 3](docs/03-channels.md)

---

## Good fit / bad fit

- ✅ Data engineering, database and OS lab work
- ✅ Environments that must be rebuilt repeatedly
- ✅ Auto-generated lab reports and acceptance documents
- ✅ Teams sharing one VM image

- ❌ Experiments that need a GUI session inside the guest
- ❌ Real-time interactive debugging (MCP is request/response)

---

## Contributing

Open an [issue](https://github.com/baizhan007/vmware-mcp-guide/issues) with a pitfall you hit.
Translations are welcome: keep the chapter structure and the "conclusion → why → how → verify" order.

Before pushing:

```powershell
node scripts/check-links.mjs
node scripts/smoke.mjs
```

CI runs the same checks plus PowerShell/Python/Shell syntax and a secret scan.

## License

[MIT](LICENSE)
