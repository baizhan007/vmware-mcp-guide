#!/usr/bin/env node
/**
 * vmware-workstation MCP server (stdio, zero dependencies).
 *
 * Bridges Model Context Protocol tools onto VMware Workstation's `vmrun.exe`,
 * so an agent can power-cycle VMs, manage snapshots, run guest commands,
 * move files, and capture the screen.
 *
 * Protocol: JSON-RPC 2.0, newline-delimited, legacy MCP wire era (2025-*).
 * stdout carries protocol frames only; all logging goes to stderr.
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "vmware-workstation";
const SERVER_VERSION = "1.0.0";

// Legacy-era revisions only: this server speaks the 2025 wire format.
const SUPPORTED_PROTOCOLS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const FALLBACK_PROTOCOL = "2025-06-18";

const RAW_COMMANDS = [
  "list", "start", "stop", "reset", "suspend", "pause", "unpause",
  "listSnapshots", "snapshot", "deleteSnapshot", "revertToSnapshot",
  "listHostNetworks", "listPortForwardings", "setPortForwarding", "deletePortForwarding",
  "runProgramInGuest", "runScriptInGuest", "fileExistsInGuest", "directoryExistsInGuest",
  "setSharedFolderState", "addSharedFolder", "removeSharedFolder",
  "enableSharedFolders", "disableSharedFolders",
  "listProcessesInGuest", "killProcessInGuest", "deleteFileInGuest",
  "createDirectoryInGuest", "deleteDirectoryInGuest", "CreateTempfileInGuest",
  "listDirectoryInGuest", "CopyFileFromHostToGuest", "CopyFileFromGuestToHost",
  "renameFileInGuest", "typeKeystrokesInGuest",
  "connectNamedDevice", "disconnectNamedDevice", "captureScreen",
  "writeVariable", "readVariable", "getGuestIPAddress",
  "upgradevm", "installTools", "checkToolsState", "clone",
];

// ---------------------------------------------------------------- logging ---

function log(message) {
  try {
    process.stderr.write(`[vmware-mcp] ${message}\n`);
  } catch {
    /* stderr closed; nothing useful to do */
  }
}

// ----------------------------------------------------------------- config ---

const DEFAULTS = {
  // Change this to your vmrun.exe path, or override it in config.json.
  vmrunPath: "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
  hostType: "ws",
  defaultVm: "",
  vms: {},
  scanRoots: [],
  guestUser: "",
  guestPassword: "",
  vmPassword: "",
  vmrunTimeoutMs: 120000,
  startTimeoutMs: 600000,
  screenDir: "",
  // Host ANSI code page used by .vmx files and vmrun output.
  encoding: process.platform === "win32" ? "gbk" : "utf-8",
};

function loadConfig() {
  const dir = __dirname;
  let file = {};
  const configPath = path.join(dir, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      log(`config.json is not valid JSON: ${error.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...file };
  if (process.env.VMWARE_VMRUN) cfg.vmrunPath = process.env.VMWARE_VMRUN;
  if (process.env.VMWARE_HOST_TYPE) cfg.hostType = process.env.VMWARE_HOST_TYPE;
  if (process.env.VMWARE_DEFAULT_VM) cfg.defaultVm = process.env.VMWARE_DEFAULT_VM;
  if (process.env.VMWARE_GUEST_USER) cfg.guestUser = process.env.VMWARE_GUEST_USER;
  if (process.env.VMWARE_GUEST_PASSWORD) cfg.guestPassword = process.env.VMWARE_GUEST_PASSWORD;
  cfg.vms = cfg.vms && typeof cfg.vms === "object" ? cfg.vms : {};
  cfg.scanRoots = Array.isArray(cfg.scanRoots) ? cfg.scanRoots : [];
  cfg.screenDir = cfg.screenDir || path.join(os.tmpdir(), "vmware-mcp-screens");
  return cfg;
}

// config.json is re-read when its mtime changes, so editing aliases or guest
// credentials does not require restarting the MCP server.
let cachedConfig = null;
let cachedMtimeMs = 0;

function currentConfig() {
  const configPath = path.join(__dirname, "config.json");
  try {
    const stat = fs.statSync(configPath);
    if (!cachedConfig || stat.mtimeMs !== cachedMtimeMs) {
      cachedConfig = loadConfig();
      cachedMtimeMs = stat.mtimeMs;
      if (cachedConfig) log("config.json (re)loaded");
    }
  } catch {
    if (!cachedConfig) {
      cachedConfig = loadConfig();
      cachedMtimeMs = 0;
    }
  }
  return cachedConfig;
}

// Read-through view over currentConfig() so existing CONFIG.x call sites keep
// working while picking up on-disk edits.
const CONFIG = new Proxy(
  {},
  {
    get: (_target, prop) => currentConfig()[prop],
    has: (_target, prop) => prop in currentConfig(),
    ownKeys: () => Reflect.ownKeys(currentConfig()),
    getOwnPropertyDescriptor: (_target, prop) => ({
      value: currentConfig()[prop],
      enumerable: true,
      configurable: true,
      writable: false,
    }),
  },
);

// --------------------------------------------------------------- decoding ---

const decoders = new Map();

function decoderFor(label) {
  if (!decoders.has(label)) {
    try {
      decoders.set(label, new TextDecoder(label));
    } catch {
      decoders.set(label, null);
    }
  }
  return decoders.get(label);
}

function isAscii(buffer) {
  for (const byte of buffer) {
    if (byte >= 0x80) return false;
  }
  return true;
}

/**
 * Decode text with an explicit code page, falling back to UTF-8.
 * @param {Buffer} buffer
 * @param {string} label  e.g. "utf-8" or "gbk"
 */
function decodeWith(buffer, label) {
  if (!buffer || buffer.length === 0) return "";
  if (isAscii(buffer)) return buffer.toString("latin1");
  const decoder = decoderFor(label);
  if (decoder) {
    try {
      const text = decoder.decode(buffer);
      if (!text.includes("\uFFFD")) return text;
    } catch {
      /* fall through */
    }
  }
  return buffer.toString("utf8");
}

/**
 * vmrun itself writes UTF-8 to its pipes on this host, while .vmx files
 * carry their own `.encoding` (GBK on a zh-CN install). Keep the two apart:
 * guessing one code page for both corrupts Chinese VM names or error text.
 */
function decodeBuffer(buffer) {
  return decodeWith(buffer, "utf-8");
}

/** Exit codes above 2^31 are negative values reported as unsigned. */
function signedExitCode(code) {
  if (typeof code !== "number") return code;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

// --------------------------------------------------------------- vmrun env ---

/**
 * VMware's vix library needs a handful of Windows environment variables to
 * locate its SSL material and runtime paths. A host that scrubs the child
 * environment (agent sandboxes do) makes vmrun abort with
 * "VMware Workstation unrecoverable error: (vix) VERIFY bora\lib\ssl\ssl.c"
 * — verified on 17.0.0 and 17.6.4. SystemDrive is the one that actually
 * triggers it, but we repair the whole essential set so a bare environment
 * can never break the bridge again.
 */
const WINDOWS_ENV_DEFAULTS = {
  SystemDrive: () => {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const match = /^([A-Za-z]):/.exec(root);
    return match ? `${match[1].toUpperCase()}:` : "C:";
  },
  SystemRoot: () => `${WINDOWS_ENV_DEFAULTS.SystemDrive()}\\Windows`,
  windir: () => WINDOWS_ENV_DEFAULTS.SystemRoot(),
  ComSpec: () => `${WINDOWS_ENV_DEFAULTS.SystemRoot()}\\system32\\cmd.exe`,
  PATH: () =>
    [
      `${WINDOWS_ENV_DEFAULTS.SystemRoot()}\\system32`,
      WINDOWS_ENV_DEFAULTS.SystemRoot(),
      `${WINDOWS_ENV_DEFAULTS.SystemRoot()}\\System32\\Wbem`,
      `${WINDOWS_ENV_DEFAULTS.SystemRoot()}\\System32\\WindowsPowerShell\\v1.0`,
    ].join(";"),
  PATHEXT: () => ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
  ProgramData: () => `${WINDOWS_ENV_DEFAULTS.SystemDrive()}\\ProgramData`,
  ProgramFiles: () => `${WINDOWS_ENV_DEFAULTS.SystemDrive()}\\Program Files`,
  "ProgramFiles(x86)": () => `${WINDOWS_ENV_DEFAULTS.SystemDrive()}\\Program Files (x86)`,
  CommonProgramFiles: () => `${WINDOWS_ENV_DEFAULTS.ProgramFiles()}\\Common Files`,
  TEMP: () => os.tmpdir(),
  TMP: () => os.tmpdir(),
  NUMBER_OF_PROCESSORS: () => String(os.cpus().length || 1),
  PROCESSOR_ARCHITECTURE: () => (process.arch === "ia32" ? "x86" : "AMD64"),
};

let cachedVmrunEnv = null;

/** The parent environment with the Windows essentials guaranteed present. */
function vmrunEnv() {
  if (cachedVmrunEnv) return cachedVmrunEnv;
  const env = { ...process.env };
  if (process.platform === "win32") {
    for (const [name, fallback] of Object.entries(WINDOWS_ENV_DEFAULTS)) {
      if (!env[name]) {
        try {
          env[name] = fallback();
        } catch {
          /* best effort */
        }
      }
    }
  }
  cachedVmrunEnv = env;
  return env;
}

// ------------------------------------------------------------------ vmrun ---

/**
 * Run vmrun with the given command arguments.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function vmrun(args, options = {}) {
  const argv = ["-T", CONFIG.hostType];
  const vmPassword = options.vmPassword ?? CONFIG.vmPassword;
  const guestUser = options.user ?? CONFIG.guestUser;
  const guestPassword = options.password ?? CONFIG.guestPassword;
  if (vmPassword) argv.push("-vp", vmPassword);
  if (guestUser) argv.push("-gu", guestUser);
  if (guestUser && guestPassword) argv.push("-gp", guestPassword);
  argv.push(...args);

  const timeoutMs = options.timeoutMs ?? CONFIG.vmrunTimeoutMs;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CONFIG.vmrunPath, argv, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: vmrunEnv(),
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: `cannot start vmrun: ${error.message}`, timedOut: false });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = decodeBuffer(Buffer.concat(out)).trim();
      const stderr = decodeBuffer(Buffer.concat(err)).trim();
      resolve({ ok: !timedOut && code === 0, code, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: "", stderr: `cannot start vmrun: ${error.message}`, timedOut: false });
    });
    child.on("close", (code) => finish(signedExitCode(code)));
  });
}

function failure(result, what) {
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (result.timedOut) return new Error(`${what} timed out`);
  if (/VERIFY bora\\lib\\ssl|unrecoverable error: \(vix\)/i.test(detail)) {
    return new Error(
      `${what} failed: VMware's vix library aborted (${detail}). ` +
        `This is the known "missing SystemDrive in the child environment" crash; ` +
        `the server repairs it automatically, so check that ${CONFIG.vmrunPath} is intact and that no stale vmrun.exe is stuck.`,
    );
  }
  return new Error(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
}

async function mustVmrun(args, options, what) {
  const result = await vmrun(args, options);
  if (!result.ok) throw failure(result, what);
  return result;
}

// -------------------------------------------------------------------- VMs ---

function readVmxInfo(vmxPath) {
  const info = { path: vmxPath, name: path.basename(vmxPath, ".vmx"), keys: {} };
  try {
    // .vmx files declare their own code page: `.encoding = "GBK"` on zh-CN hosts.
    const raw = fs.readFileSync(vmxPath);
    const declared = /^\s*\.encoding\s*=\s*"([^"]+)"/m.exec(raw.toString("latin1"));
    const label = (declared && declared[1]) || CONFIG.encoding || "utf-8";
    const text = decodeWith(raw, /^gb/i.test(label) ? "gbk" : label.toLowerCase());
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([\w.:\-]+)\s*=\s*"(.*)"\s*$/.exec(line);
      if (match) info.keys[match[1]] = match[2];
    }
  } catch (error) {
    log(`cannot read ${vmxPath}: ${error.message}`);
  }
  info.displayName = info.keys.displayName || info.name;
  info.guestOS = info.keys.guestOS || "";
  info.memoryMB = info.keys.memsize || "";
  info.cpus = info.keys.numvcpus || "";
  info.network = info.keys["ethernet0.connectionType"] || "";
  info.firmware = info.keys.firmware || "bios";
  info.isWindows = /windows/i.test(info.guestOS);
  return info;
}

/** Resolve an alias, display name, or absolute .vmx path to an absolute path. */
function resolveVm(input) {
  const value = (input && String(input).trim()) || CONFIG.defaultVm;
  if (!value) {
    throw new Error("no VM given and no defaultVm configured; call list_vms first");
  }

  const aliases = CONFIG.vms;
  const lower = value.toLowerCase();
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias.toLowerCase() === lower) return assertVmx(target);
  }

  if (/\.vmx$/i.test(value)) return assertVmx(value);

  // Match on the vmx file name or the displayName inside it.
  for (const target of Object.values(aliases)) {
    if (!fs.existsSync(target)) continue;
    const info = readVmxInfo(target);
    if (info.displayName.toLowerCase() === lower || info.name.toLowerCase() === lower) return target;
  }

  const discovered = discoverVms();
  for (const item of discovered) {
    if (item.info.displayName.toLowerCase() === lower || item.info.name.toLowerCase() === lower) return item.path;
  }
  throw new Error(`unknown VM "${value}"; call list_vms to see configured and discovered VMs`);
}

function assertVmx(candidate) {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) throw new Error(`VMX not found: ${resolved}`);
  if (!/\.vmx$/i.test(resolved)) throw new Error(`not a .vmx file: ${resolved}`);
  return resolved;
}

function normalisePath(value) {
  return String(value).replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/\\$/, "").toLowerCase();
}

async function runningVms() {
  const result = await vmrun(["list"]);
  if (!result.ok) throw failure(result, "vmrun list");
  const lines = result.stdout.split(/\r?\n/);
  const vms = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (/^total running vms:/i.test(text)) continue;
    if (/^error:/i.test(text)) continue;
    vms.push(text);
  }
  return vms;
}

async function isRunning(vmxPath) {
  const target = normalisePath(vmxPath);
  const vms = await runningVms();
  return vms.some((entry) => normalisePath(entry) === target);
}

function isSuspended(vmxPath) {
  // The suspend state is "<name>.vmss" or "<name>-<hash>.vmss".
  const dir = path.dirname(vmxPath);
  const base = path.basename(vmxPath, path.extname(vmxPath)).toLowerCase();
  try {
    return fs
      .readdirSync(dir)
      .some((entry) => entry.toLowerCase().endsWith(".vmss") && entry.toLowerCase().startsWith(base));
  } catch {
    return fs.existsSync(vmxPath.replace(/\.vmx$/i, ".vmss"));
  }
}

function discoverVms() {
  const found = new Map();
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth < 0 || found.size >= 200) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^\$|^(System Volume Information|Windows|Program Files.*|node_modules)$/i.test(entry.name)) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        walk(full, depth - 1);
      } else if (/\.vmx$/i.test(entry.name)) {
        const key = full.toLowerCase();
        if (!found.has(key)) found.set(key, { path: full, info: readVmxInfo(full) });
      }
    }
  };
  for (const root of CONFIG.scanRoots) {
    if (fs.existsSync(root)) walk(root, 3);
  }
  for (const target of Object.values(CONFIG.vms)) {
    if (!fs.existsSync(target)) continue;
    const key = path.resolve(target).toLowerCase();
    if (!found.has(key)) found.set(key, { path: path.resolve(target), info: readVmxInfo(path.resolve(target)) });
  }
  return [...found.values()];
}

async function describeState(vmxPath) {
  if (await isRunning(vmxPath)) return "running";
  if (isSuspended(vmxPath)) return "suspended";
  return "powered off";
}

const GUEST_CREDENTIAL_HINT =
  "Guest operations need VMware Tools plus credentials: pass `user` and `password`, " +
  "or set guestUser/guestPassword in config.json (or VMWARE_GUEST_USER / VMWARE_GUEST_PASSWORD).";

/**
 * Fail fast instead of letting vmrun hang for its whole timeout when the VM is
 * powered off, VMware Tools is not running, or no guest credentials are known.
 */
async function requireGuestReady(vmxPath, options = {}) {
  await requireToolsRunning(vmxPath);
  if (!(options.user || CONFIG.guestUser)) {
    throw new Error(`No guest credentials configured. ${GUEST_CREDENTIAL_HINT}`);
  }
}

/** A running VM with a live VMware Tools channel (no credentials needed). */
async function requireToolsRunning(vmxPath) {
  if (!(await isRunning(vmxPath))) {
    throw new Error(`VM is not running: ${vmxPath}. Start it with start_vm first.`);
  }
  const tools = await vmrun(["checkToolsState", vmxPath]);
  const state = (tools.stdout || "").toLowerCase();
  if (!tools.ok || !state || state.includes("unknown")) {
    throw new Error(
      `VMware Tools is not running in the guest (checkToolsState: ${tools.stdout || tools.stderr || "unknown"}). ` +
        `Guest operations require VMware Tools inside the guest.`,
    );
  }
  return tools.stdout;
}

// ------------------------------------------------------------- formatting ---

function formatInfo(info) {
  return [
    `displayName: ${info.displayName}`,
    `vmx: ${info.path}`,
    `guestOS: ${info.guestOS || "unknown"}`,
    `cpu/memory: ${info.cpus || "?"} vCPU / ${info.memoryMB || "?"} MB`,
    `network: ${info.network || "unknown"}`,
    `firmware: ${info.firmware}`,
  ].join("\n");
}

// ------------------------------------------------------------------ tools ---

const tools = [];

function tool(name, description, inputSchema, handler) {
  tools.push({ name, description, inputSchema, handler });
}

const VM_ARG = {
  type: "string",
  description: "VM alias (see config.json), display name, or absolute .vmx path. Defaults to the configured default VM.",
};

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

tool(
  "list_vms",
  "List configured, discovered and currently running VMware Workstation VMs with their power state.",
  {
    type: "object",
    properties: {
      scan: { type: "boolean", description: "Also scan scanRoots for .vmx files (default true)." },
    },
  },
  async (args) => {
    const running = await runningVms();
    const runningKeys = new Set(running.map(normalisePath));
    const rows = [];
    const listed = args.scan === false ? [] : discoverVms();

    for (const item of listed) {
      const state = runningKeys.has(normalisePath(item.path))
        ? "running"
        : isSuspended(item.path)
          ? "suspended"
          : "powered off";
      rows.push(`${state.padEnd(12)} ${item.info.displayName}  (${item.path})`);
    }
    for (const entry of running) {
      if (!listed.some((item) => normalisePath(item.path) === normalisePath(entry))) {
        rows.push(`${"running".padEnd(12)} ${path.basename(entry, ".vmx")}  (${entry})`);
      }
    }
    const aliases = Object.entries(CONFIG.vms).map(([alias, target]) => `${alias} -> ${target}`);
    return text(
      [
        `running VMs: ${running.length}`,
        "",
        rows.length ? rows.join("\n") : "(no VMs discovered)",
        "",
        aliases.length ? `aliases:\n${aliases.join("\n")}` : "(no aliases configured)",
      ].join("\n"),
    );
  },
);

tool("vm_info", "Show the static configuration of a VM (.vmx settings) and its current power state.", {
  type: "object",
  properties: { vm: VM_ARG },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const info = readVmxInfo(vmx);
  return text(`${formatInfo(info)}\nstate: ${await describeState(vmx)}`);
});

tool("vm_status", "Report whether a VM is running, suspended or powered off, plus VMware Tools state and guest IP when running.", {
  type: "object",
  properties: { vm: VM_ARG },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const state = await describeState(vmx);
  const lines = [`state: ${state}`];
  if (state === "running") {
    const toolsState = await vmrun(["checkToolsState", vmx]);
    const raw = (toolsState.stdout || toolsState.stderr || "").trim();
    const toolsText = !raw || /unknown/i.test(raw)
      ? "not running (VMware Tools missing, stopped, or the guest is still booting)"
      : raw;
    lines.push(`tools: ${toolsText}`);
    const ip = await vmrun(["getGuestIPAddress", vmx], { timeoutMs: 15000 });
    if (ip.ok && ip.stdout) lines.push(`guest IP: ${ip.stdout}`);
  }
  return text(lines.join("\n"));
});

tool("start_vm", "Power on a VM (GUI window unless gui is false). Waits for the VM to start.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    gui: { type: "boolean", description: "Show the VMware window (default true)." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  if (await isRunning(vmx)) return text(`already running: ${vmx}`);
  const mode = args.gui === false ? "nogui" : "gui";
  await mustVmrun(["start", vmx, mode], { timeoutMs: CONFIG.startTimeoutMs }, `start ${path.basename(vmx)}`);
  return text(`started (${mode}): ${vmx}\nstate: ${await describeState(vmx)}`);
});

tool("stop_vm", "Power off a VM. mode=soft asks the guest to shut down (needs VMware Tools), hard cuts power.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    mode: { type: "string", enum: ["soft", "hard"], description: "Default soft." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const mode = args.mode === "hard" ? "hard" : "soft";
  await mustVmrun(["stop", vmx, mode], { timeoutMs: CONFIG.startTimeoutMs }, `stop ${path.basename(vmx)}`);
  return text(`stopped (${mode}): ${vmx}\nstate: ${await describeState(vmx)}`);
});

tool("reset_vm", "Reset (reboot) a running VM. mode=soft needs VMware Tools, hard is a virtual power cycle.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    mode: { type: "string", enum: ["soft", "hard"], description: "Default soft." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const mode = args.mode === "hard" ? "hard" : "soft";
  await mustVmrun(["reset", vmx, mode], { timeoutMs: CONFIG.startTimeoutMs }, `reset ${path.basename(vmx)}`);
  return text(`reset (${mode}): ${vmx}`);
});

tool("suspend_vm", "Suspend a running VM to disk (.vmss) so it can be resumed later.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    mode: { type: "string", enum: ["soft", "hard"], description: "Default soft." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const mode = args.mode === "hard" ? "hard" : "soft";
  await mustVmrun(["suspend", vmx, mode], { timeoutMs: CONFIG.startTimeoutMs }, `suspend ${path.basename(vmx)}`);
  return text(`suspended (${mode}): ${vmx}`);
});

tool("pause_vm", "Pause or unpause a running VM (freezes execution without saving state).", {
  type: "object",
  properties: {
    vm: VM_ARG,
    paused: { type: "boolean", description: "true pauses, false unpauses. Default true." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const command = args.paused === false ? "unpause" : "pause";
  await mustVmrun([command, vmx], {}, `${command} ${path.basename(vmx)}`);
  return text(`${command}d: ${vmx}`);
});

tool("list_snapshots", "List the snapshots of a VM (optionally as a tree).", {
  type: "object",
  properties: {
    vm: VM_ARG,
    tree: { type: "boolean", description: "Show the snapshot hierarchy." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const command = args.tree ? ["listSnapshots", vmx, "showTree"] : ["listSnapshots", vmx];
  const result = await mustVmrun(command, {}, `listSnapshots ${path.basename(vmx)}`);
  return text(result.stdout || "(no snapshots)");
});

tool("take_snapshot", "Create a named snapshot of a VM.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    name: { type: "string", description: "Snapshot name." },
  },
  required: ["vm", "name"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await mustVmrun(["snapshot", vmx, args.name], { timeoutMs: CONFIG.startTimeoutMs }, `snapshot ${args.name}`);
  return text(`snapshot created: ${args.name}`);
});

tool("revert_snapshot", "Revert a VM to a named snapshot (discards current state).", {
  type: "object",
  properties: {
    vm: VM_ARG,
    name: { type: "string", description: "Snapshot name." },
  },
  required: ["vm", "name"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await mustVmrun(["revertToSnapshot", vmx, args.name], { timeoutMs: CONFIG.startTimeoutMs }, `revertToSnapshot ${args.name}`);
  return text(`reverted to snapshot: ${args.name}\nstate: ${await describeState(vmx)}`);
});

tool("delete_snapshot", "Delete a snapshot of a VM. Set deleteChildren to remove its whole subtree.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    name: { type: "string", description: "Snapshot name." },
    deleteChildren: { type: "boolean", description: "Also delete child snapshots." },
  },
  required: ["vm", "name"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const command = args.deleteChildren
    ? ["deleteSnapshot", vmx, args.name, "andDeleteChildren"]
    : ["deleteSnapshot", vmx, args.name];
  await mustVmrun(command, { timeoutMs: CONFIG.startTimeoutMs }, `deleteSnapshot ${args.name}`);
  return text(`snapshot deleted: ${args.name}`);
});

tool(
  "run_command_in_guest",
  "Run a shell command inside a running guest and return its combined stdout/stderr. Requires VMware Tools and guest credentials. Linux uses bash, Windows uses cmd.",
  {
    type: "object",
    properties: {
      vm: VM_ARG,
      command: { type: "string", description: "Command line to execute in the guest." },
      timeoutMs: { type: "number", description: "Execution timeout in ms (default 120000)." },
      user: { type: "string", description: "Guest user name (default from config)." },
      password: { type: "string", description: "Guest password (default from config)." },
    },
    required: ["vm", "command"],
  },
  async (args) => {
    const vmx = resolveVm(args.vm);
    const info = readVmxInfo(vmx);
    await requireGuestReady(vmx, args);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const hostBase = path.join(os.tmpdir(), `vmware-mcp-${stamp}`);
    const creds = { user: args.user, password: args.password, timeoutMs: args.timeoutMs ?? 120000 };

    const hostScript = `${hostBase}.${info.isWindows ? "bat" : "sh"}`;
    const hostOut = `${hostBase}.log`;
    const guestScript = info.isWindows ? `C:\\Windows\\Temp\\vmware-mcp-${stamp}.bat` : `/tmp/vmware-mcp-${stamp}.sh`;
    const guestOut = info.isWindows ? `C:\\Windows\\Temp\\vmware-mcp-${stamp}.log` : `/tmp/vmware-mcp-${stamp}.log`;

    const body = info.isWindows
      ? `@echo off\r\n${args.command} > "${guestOut}" 2>&1\r\n`
      : `#!/bin/bash\n${args.command} > ${guestOut} 2>&1\n`;
    fs.writeFileSync(hostScript, body, "utf8");

    try {
      await mustVmrun(["CopyFileFromHostToGuest", vmx, hostScript, guestScript], creds, "copy script to guest");
      const run = await vmrun(
        ["runProgramInGuest", vmx, info.isWindows ? "C:\\Windows\\System32\\cmd.exe" : "/bin/bash",
          ...(info.isWindows ? ["/c", guestScript] : [guestScript])],
        creds,
      );
      if (!run.ok && !run.timedOut) {
        throw failure(run, "run program in guest");
      }
      const copyBack = await vmrun(["CopyFileFromGuestToHost", vmx, guestOut, hostOut], creds);
      let output = "";
      if (copyBack.ok && fs.existsSync(hostOut)) {
        output = decodeBuffer(fs.readFileSync(hostOut));
      } else {
        output = `(no output captured)\n${copyBack.stderr || ""}`.trim();
      }
      const exitNote = run.timedOut
        ? `\n\n[timeout after ${creds.timeoutMs} ms; the guest command may still be running]`
        : "";
      return text(`${output || "(empty output)"}${exitNote}`);
    } finally {
      for (const file of [hostScript, hostOut]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already removed */
        }
      }
      vmrun(["deleteFileInGuest", vmx, guestScript], creds).catch(() => {});
      vmrun(["deleteFileInGuest", vmx, guestOut], creds).catch(() => {});
    }
  },
);

tool("run_program_in_guest", "Run an executable inside a running guest (no shell). Requires VMware Tools and guest credentials.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    program: { type: "string", description: "Absolute path of the program in the guest." },
    args: { type: "array", items: { type: "string" }, description: "Program arguments." },
    noWait: { type: "boolean", description: "Return immediately instead of waiting for exit." },
    interactive: { type: "boolean", description: "Allow guest UI interaction." },
    user: { type: "string" },
    password: { type: "string" },
    timeoutMs: { type: "number" },
  },
  required: ["vm", "program"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await requireGuestReady(vmx, args);
  const argv = ["runProgramInGuest", vmx];
  if (args.noWait) argv.push("-noWait");
  if (args.interactive) argv.push("-interactive");
  argv.push(args.program, ...(args.args || []));
  await mustVmrun(argv, { user: args.user, password: args.password, timeoutMs: args.timeoutMs ?? 120000 }, "runProgramInGuest");
  return text(`program launched: ${args.program}${args.noWait ? " (not waited)" : " (exited)"}`);
});

tool("copy_file_to_guest", "Copy a file from the host into the guest OS.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    hostPath: { type: "string" },
    guestPath: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
  },
  required: ["vm", "hostPath", "guestPath"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  if (!fs.existsSync(args.hostPath)) throw new Error(`host file not found: ${args.hostPath}`);
  await requireGuestReady(vmx, args);
  await mustVmrun(
    ["CopyFileFromHostToGuest", vmx, path.resolve(args.hostPath), args.guestPath],
    { user: args.user, password: args.password, timeoutMs: 300000 },
    "CopyFileFromHostToGuest",
  );
  return text(`copied ${args.hostPath} -> ${args.guestPath}`);
});

tool("copy_file_from_guest", "Copy a file from the guest OS onto the host.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    guestPath: { type: "string" },
    hostPath: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
  },
  required: ["vm", "guestPath", "hostPath"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await requireGuestReady(vmx, args);
  await mustVmrun(
    ["CopyFileFromGuestToHost", vmx, args.guestPath, path.resolve(args.hostPath)],
    { user: args.user, password: args.password, timeoutMs: 300000 },
    "CopyFileFromGuestToHost",
  );
  const size = fs.existsSync(args.hostPath) ? fs.statSync(args.hostPath).size : 0;
  return text(`copied ${args.guestPath} -> ${args.hostPath} (${size} bytes)`);
});

tool(
  "guest_file_op",
  "Inspect or modify paths inside the guest: list a directory, test existence, create a directory, delete a file or rename one.",
  {
    type: "object",
    properties: {
      vm: VM_ARG,
      op: { type: "string", enum: ["list", "exists", "mkdir", "delete", "rename"] },
      path: { type: "string", description: "Guest path." },
      to: { type: "string", description: "New path (rename only)." },
      user: { type: "string" },
      password: { type: "string" },
    },
    required: ["vm", "op", "path"],
  },
  async (args) => {
    const vmx = resolveVm(args.vm);
    const creds = { user: args.user, password: args.password };
    await requireGuestReady(vmx, args);
    switch (args.op) {
      case "list": {
        const result = await mustVmrun(["listDirectoryInGuest", vmx, args.path], creds, "listDirectoryInGuest");
        return text(result.stdout || "(empty directory)");
      }
      case "exists": {
        const file = await vmrun(["fileExistsInGuest", vmx, args.path], creds);
        const dir = await vmrun(["directoryExistsInGuest", vmx, args.path], creds);
        return text(`file: ${file.ok ? "yes" : "no"}\ndirectory: ${dir.ok ? "yes" : "no"}`);
      }
      case "mkdir":
        await mustVmrun(["createDirectoryInGuest", vmx, args.path], creds, "createDirectoryInGuest");
        return text(`directory created: ${args.path}`);
      case "delete":
        await mustVmrun(["deleteFileInGuest", vmx, args.path], creds, "deleteFileInGuest");
        return text(`file deleted: ${args.path}`);
      case "rename": {
        if (!args.to) throw new Error("rename needs the `to` parameter");
        await mustVmrun(["renameFileInGuest", vmx, args.path, args.to], creds, "renameFileInGuest");
        return text(`renamed ${args.path} -> ${args.to}`);
      }
      default:
        throw new Error(`unsupported op: ${args.op}`);
    }
  },
);

tool("list_processes_in_guest", "List the processes running inside the guest.", {
  type: "object",
  properties: { vm: VM_ARG, user: { type: "string" }, password: { type: "string" } },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await requireGuestReady(vmx, args);
  const result = await mustVmrun(["listProcessesInGuest", vmx], { user: args.user, password: args.password }, "listProcessesInGuest");
  return text(result.stdout || "(no processes reported)");
});

tool("kill_process_in_guest", "Kill a process inside the guest by PID.", {
  type: "object",
  properties: {
    vm: VM_ARG,
    pid: { type: "number", description: "Guest process id." },
    user: { type: "string" },
    password: { type: "string" },
  },
  required: ["vm", "pid"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await requireGuestReady(vmx, args);
  await mustVmrun(["killProcessInGuest", vmx, String(args.pid)], { user: args.user, password: args.password }, "killProcessInGuest");
  return text(`process ${args.pid} killed`);
});

tool("get_guest_ip", "Get the IP address of a running guest (needs VMware Tools).", {
  type: "object",
  properties: {
    vm: VM_ARG,
    wait: { type: "boolean", description: "Wait for an address to become available." },
  },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  await requireToolsRunning(vmx);
  const command = args.wait ? ["getGuestIPAddress", vmx, "-wait"] : ["getGuestIPAddress", vmx];
  const result = await vmrun(command, { timeoutMs: args.wait ? 90000 : 30000 });
  if (!result.ok) throw failure(result, "getGuestIPAddress");
  return text(result.stdout || "(no address)");
});

tool(
  "capture_screen",
  "Capture the VM console screen to a PNG on the host and return it as an image. Requires the VM to be running; on this host VMware also demands guest credentials for the capture.",
  {
    type: "object",
    properties: {
      vm: VM_ARG,
      hostPath: { type: "string", description: "Optional output PNG path; a temp file is used otherwise." },
      user: { type: "string", description: "Guest user name (default from config)." },
      password: { type: "string", description: "Guest password (default from config)." },
    },
    required: ["vm"],
  },
  async (args) => {
    const vmx = resolveVm(args.vm);
    if (!(await isRunning(vmx))) throw new Error(`VM is not running: ${vmx}. Start it with start_vm first.`);
    fs.mkdirSync(CONFIG.screenDir, { recursive: true });
    const target = args.hostPath
      ? path.resolve(args.hostPath)
      : path.join(CONFIG.screenDir, `${path.basename(vmx, ".vmx")}-${Date.now()}.png`);
    try {
      await mustVmrun(
        ["captureScreen", vmx, target],
        { timeoutMs: 60000, user: args.user, password: args.password },
        "captureScreen",
      );
    } catch (error) {
      if (/LoginInGuest|anonymous|匿名/i.test(error.message)) {
        throw new Error(`${error.message}\n${GUEST_CREDENTIAL_HINT}`);
      }
      throw error;
    }
    if (!fs.existsSync(target)) throw new Error(`screen was not written: ${target}`);
    const data = fs.readFileSync(target).toString("base64");
    return {
      content: [
        { type: "text", text: `screenshot saved: ${target}` },
        { type: "image", data, mimeType: "image/png" },
      ],
    };
  },
);

tool("check_tools_state", "Report the VMware Tools state of a VM (installed, running, version).", {
  type: "object",
  properties: { vm: VM_ARG },
  required: ["vm"],
}, async (args) => {
  const vmx = resolveVm(args.vm);
  const result = await vmrun(["checkToolsState", vmx]);
  if (!result.ok) throw failure(result, "checkToolsState");
  return text(result.stdout || "(unknown)");
});

// ------------------------------------------------------- channel probing ---

/**
 * Probe every way of getting bytes into the guest, in preference order.
 *
 * Written after a session where six host-side keyboard-injection variants were
 * tried and all failed, while an out-of-band channel (VNC) worked first time.
 * The lesson: when the task needs input in a guest, enumerate channels first.
 *
 * Order is deliberate - out-of-band transports beat host input synthesis:
 *   VMware Tools > SSH > VNC > serial console > host keyboard injection
 */
/**
 * True when the current process runs with administrator rights.
 *
 * Several vmrun guest commands (notably typeKeystrokesInGuest) are refused with
 * "insufficient permissions in the host OS" unless elevated, so the channel
 * probe reports this rather than letting a caller discover it the hard way.
 *
 * The check reads the token's integrity level rather than trying `net session`,
 * because the latter also fails when the Server service is simply stopped.
 * High integrity (S-1-16-12288) means the UAC filter has been bypassed.
 */
let elevatedCache = null;

function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== "win32") {
    elevatedCache = typeof process.getuid === "function" && process.getuid() === 0;
    return elevatedCache;
  }
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("whoami", ["/groups"], {
      encoding: "utf8",
      timeout: 5000,
      env: vmrunEnv(),
      windowsHide: true,
    });
    // S-1-16-12288 is "High Mandatory Level"; -8192 is Medium, -16384 is System.
    elevatedCache = /S-1-16-12288/.test(out) || /S-1-16-16384/.test(out);
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
}

function tcpProbe(host, port, timeoutMs = 2500, wantBanner = false) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      if (!wantBanner) return done({ ok: true });
      let banner = "";
      socket.on("data", (chunk) => {
        banner += chunk.toString("latin1");
        if (banner.includes("\n")) done({ ok: true, banner: banner.trim() });
      });
      // Some services wait for the client to speak first.
      setTimeout(() => done({ ok: true, banner: banner.trim() || "(connected, no banner)" }), timeoutMs);
    });
    socket.once("timeout", () => done({ ok: false, error: "timeout" }));
    socket.once("error", (error) => done({ ok: false, error: error.code || error.message }));
    socket.connect(port, host);
  });
}

tool(
  "probe_channels",
  "Probe every channel for reaching this guest and report which ones work. Call this FIRST whenever the task " +
    "needs to run something inside a guest - do not start with host keyboard injection. " +
    "Returns a table plus the recommended next action.",
  {
    type: "object",
    properties: {
      vm: VM_ARG,
      sshPort: { type: "number", description: "SSH port to probe (default 22)." },
    },
    required: ["vm"],
  },
  async (args) => {
    const vmx = resolveVm(args.vm);
    const info = readVmxInfo(vmx);
    const running = await isRunning(vmx);
    const sshPort = Number(args.sshPort) || 22;

    const rows = [];
    const add = (channel, status, detail, hint) => rows.push({ channel, status, detail, hint });

    // --- 1. VM power state -------------------------------------------------
    if (!running) {
      return text(
        [
          `VM: ${info.displayName}`,
          `state: not running`,
          "",
          "Start it first: start_vm",
          "Nothing else can be probed until the VM is powered on.",
        ].join("\n"),
      );
    }
    add("power", "ok", "running", "");

    // --- 2. VMware Tools ---------------------------------------------------
    const toolsResult = await vmrun(["checkToolsState", vmx]);
    const toolsState = toolsResult.ok ? (toolsResult.stdout || "").trim() : "unknown";
    if (toolsState === "running") {
      add("vmware_tools", "ok", "running", "run_command_in_guest / copy_file_* / capture_screen all work");
    } else if (toolsState === "installed") {
      add("vmware_tools", "degraded", "installed but not running", "start vmtoolsd inside the guest");
    } else {
      add("vmware_tools", "fail", toolsState || "not installed", "install open-vm-tools (see README 6.4)");
    }

    // --- 3. Guest IP (needed by SSH / VNC-by-IP) ---------------------------
    let guestIp = "";
    if (toolsState === "running") {
      const ipResult = await vmrun(["getGuestIPAddress", vmx], { timeoutMs: 20000 });
      if (ipResult.ok) guestIp = (ipResult.stdout || "").trim();
    }
    if (!guestIp) {
      // Nothing to probe over IP; Tools is the only source of an address here.
    }
    add(
      "guest_ip",
      guestIp ? "ok" : "unknown",
      guestIp || "not reported by Tools",
      guestIp ? "" : "SSH/VNC-over-IP cannot be probed without an address",
    );

    // --- 4. SSH ------------------------------------------------------------
    if (guestIp) {
      const ssh = await tcpProbe(guestIp, sshPort, 3000, true);
      if (ssh.ok) {
        add("ssh", "ok", `${guestIp}:${sshPort} ${ssh.banner || ""}`.trim(), "best for scripted commands; set up a key for passwordless use");
      } else {
        add("ssh", "fail", `${guestIp}:${sshPort} ${ssh.error}`, "");
      }
    } else {
      add("ssh", "skipped", "no guest IP", "");
    }

    // --- 5. VNC ------------------------------------------------------------
    const vncEnabled = (info.keys["RemoteDisplay.vnc.enabled"] || "").toUpperCase() === "TRUE";
    if (!vncEnabled) {
      add("vnc", "off", "not enabled in .vmx", "add RemoteDisplay.vnc.enabled=TRUE + port, ip=127.0.0.1 (README 6.2)");
    } else {
      const port = Number(info.keys["RemoteDisplay.vnc.port"]) || 5900;
      const bindIp = info.keys["RemoteDisplay.vnc.ip"] || "";
      const host = bindIp && bindIp !== "0.0.0.0" ? bindIp : "127.0.0.1";
      const vnc = await tcpProbe(host, port, 2500, true);
      if (vnc.ok) {
        const warn = !bindIp || bindIp === "0.0.0.0"
          ? "WARNING: bound to 0.0.0.0 and Workstation VNC has no password - restrict to 127.0.0.1"
          : "";
        add("vnc", "ok", `${host}:${port} ${vnc.banner || ""}`.trim(), warn || "use vnc.mjs to type and screenshot");
      } else {
        add("vnc", "fail", `${host}:${port} ${vnc.error}`, "VM may need a restart to open the port");
      }
    }

    // --- 6. Serial console -------------------------------------------------
    const serialType = (info.keys["serial0.fileType"] || "").toLowerCase();
    const serialPresent = (info.keys["serial0.present"] || "").toUpperCase() === "TRUE";
    if (!serialPresent) {
      add("serial", "off", "no serial0 device", "needs serial0 + a getty on ttyS0 inside the guest");
    } else if (serialType === "pipe") {
      const pipeName = (info.keys["serial0.fileName"] || "").replace(/^.*pipe\\/i, "");
      const pipeExists = fs.existsSync(`\\\\.\\pipe\\${pipeName}`);
      add(
        "serial",
        pipeExists ? "partial" : "fail",
        pipeExists ? `pipe \\\\.\\pipe\\${pipeName} exists` : `pipe ${pipeName} missing`,
        "a pipe alone is not enough: the guest also needs serial-getty@ttyS0 enabled",
      );
    } else {
      add("serial", "off", `serial0.fileType=${serialType}`, "");
    }

    // --- 7. Virtual-hardware keystroke injection --------------------------
    // vmrun typeKeystrokesInGuest would be the ideal channel: it injects USB HID
    // scan codes at the virtual hardware layer, so it needs neither VMware Tools
    // nor console focus. It is unfortunately non-functional on Workstation
    // 17.6.4. Verified 2026-10-22: every invocation fails with "insufficient
    // permissions in the host operating system" - from a normal process AND
    // from an elevated one (scheduled task, RunLevel Highest, same session as
    // vmware-vmx), for plain text, bare scan codes, hex and comma lists alike.
    // vmrun is a thin wrapper over the deprecated VIX API, and that error text
    // does not describe the real cause, so do not chase host permissions here.
    add(
      "usb_hid",
      "broken",
      "typeKeystrokesInGuest fails even when elevated (VMware VIX defect)",
      isElevated()
        ? "confirmed broken in Workstation 17.6.4; use the vnc channel for console input"
        : "confirmed broken in Workstation 17.6.4 even when elevated; use the vnc channel for console input",
    );

    // --- 8. Host keyboard injection ---------------------------------------
    add(
      "host_keyboard",
      "last-resort",
      "SendKeys / keybd_event / SendInput / PostMessage",
      "empirically never reaches this Workstation console - do not spend time here",
    );

    const best = rows.find((r) => r.status === "ok" && r.channel !== "power" && r.channel !== "guest_ip");

    const lines = [];
    lines.push(`VM: ${info.displayName}  (${vmx})`);
    lines.push("");
    lines.push("channel           status        detail");
    lines.push("----------------  ------------  ------------------------------------------");
    for (const row of rows) {
      lines.push(`${row.channel.padEnd(17)} ${row.status.padEnd(12)}  ${row.detail}`);
    }

    lines.push("");
    if (best) {
      lines.push(`RECOMMENDED: ${best.channel}`);
      if (best.hint) lines.push(`  ${best.hint}`);
    } else {
      lines.push("RECOMMENDED: none available");
      const actionable = rows.filter((r) => r.hint && (r.status === "off" || r.status === "fail"));
      for (const row of actionable) lines.push(`  ${row.channel}: ${row.hint}`);
    }
    const warnings = rows.filter((r) => /^WARNING/.test(r.hint || ""));
    if (warnings.length) {
      lines.push("");
      for (const row of warnings) lines.push(row.hint);
    }
    return text(lines.join("\n"));
  },
);

tool("list_host_networks", "List the host virtual networks (VMnet0..N) with their settings.", {
  type: "object",
  properties: {},
}, async () => {
  const result = await mustVmrun(["listHostNetworks"], {}, "listHostNetworks");
  return text(result.stdout || "(no networks)");
});

tool(
  "vmrun_raw",
  "Escape hatch: run any allow-listed vmrun command directly. Use the dedicated tools when they exist.",
  {
    type: "object",
    properties: {
      command: { type: "string", description: "vmrun command name, e.g. listSnapshots." },
      vm: { type: "string", description: "Optional VM (alias or .vmx path); inserted as the first argument." },
      args: { type: "array", items: { type: "string" }, description: "Remaining arguments." },
      user: { type: "string" },
      password: { type: "string" },
    },
    required: ["command"],
  },
  async (args) => {
    if (!RAW_COMMANDS.includes(args.command)) {
      throw new Error(`command not allowed: ${args.command}`);
    }
    const argv = [args.command];
    if (args.vm) argv.push(resolveVm(args.vm));
    argv.push(...(args.args || []));
    const result = await vmrun(argv, { user: args.user, password: args.password });
    if (!result.ok) throw failure(result, `vmrun ${args.command}`);
    return text(result.stdout || `vmrun ${args.command}: ok`);
  },
);

// --------------------------------------------------------------- protocol ---

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Controls VMware Workstation on this host through vmrun. Call list_vms first to see configured aliases; " +
            "the default alias is 'centos'. Guest credentials come from config.json (currently user 'root'). " +
            "When a task needs anything to run INSIDE a guest, call probe_channels first: it reports which transports " +
            "actually work (VMware Tools, SSH, VNC, serial) and which are known-broken, plus the recommended next step. " +
            "Prefer vmware_tools for commands/files/screenshots and ssh for scripts. " +
            "For CONSOLE input (typing at a login prompt, BIOS, boot menus) use the VNC channel: " +
            "'node vnc.mjs type 127.0.0.1:5901 \"text\"' (see vnc.mjs header for shot/login/clear/keys). " +
            "Do NOT synthesize host keyboard input (SendKeys/keybd_event/SendInput/PostMessage) - verified never to " +
            "reach this console. Do NOT use vmrun typeKeystrokesInGuest - verified broken on Workstation 17.6.4 even " +
            "when elevated; its 'insufficient permissions' message is misleading. " +
            "Local helper scripts (guest-sh.ps1, vnc.mjs, ocr.ps1) and README.md / RETROSPECTIVE.md / RESEARCH.md " +
            "live in this server's working directory - read README.md section 6 for known issues and workarounds.",
        });
        return;
      }
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, {
          tools: tools.map((entry) => ({
            name: entry.name,
            description: entry.description,
            inputSchema: entry.inputSchema,
          })),
        });
        return;
      case "tools/call": {
        const name = params && params.name;
        const entry = tools.find((item) => item.name === name);
        if (!entry) {
          replyError(id, -32602, `unknown tool: ${name}`);
          return;
        }
        try {
          const result = await entry.handler(params.arguments || {});
          reply(id, result && result.content ? result : { content: [{ type: "text", text: String(result) }] });
        } catch (error) {
          reply(id, {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          });
        }
        return;
      }
      case "resources/list":
        reply(id, { resources: [] });
        return;
      case "resources/templates/list":
        reply(id, { resourceTemplates: [] });
        return;
      case "prompts/list":
        reply(id, { prompts: [] });
        return;
      case "logging/setLevel":
        reply(id, {});
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return;
      default:
        if (isNotification) return;
        replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    log(`handler error for ${method}: ${error.stack || error.message}`);
    if (!isNotification) replyError(id, -32603, error.message);
  }
}

function handleMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    replyError(null, -32700, "parse error");
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) handleRequest(item);
    return;
  }
  handleRequest(parsed);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on("end", () => {
  const line = buffer.trim();
  if (line) handleMessage(line);
  process.exit(0);
});

process.on("uncaughtException", (error) => log(`uncaught: ${error.stack || error.message}`));
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error && error.message}`));

log(`ready (${tools.length} tools, vmrun: ${CONFIG.vmrunPath})`);
