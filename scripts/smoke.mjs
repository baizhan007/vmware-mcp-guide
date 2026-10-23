#!/usr/bin/env node
// End-to-end smoke test: really starts examples/server.js, performs the MCP
// handshake over stdio, and validates every tool schema.
//
// This is the check CI runs instead of `node --check`: a syntax-only pass is
// what let a `require`/ESM mismatch ship while the badge stayed green.
//
// Usage: node scripts/smoke.mjs
// Exit code: 0 = pass, 1 = fail

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "examples", "server.js");
const EXPECTED_TOOLS = 25;
const REQUEST_TIMEOUT_MS = 20000;

const failures = [];
const notes = [];

function check(ok, label, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  const stderr = [];

  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) notes.push(line.trim());
    }
  });

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        failures.push(`stdout carried a non-JSON frame: ${line.slice(0, 120)}`);
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
    });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  return { child, request, notify, stderr };
}

/** Every tool must be callable by an agent: name, prose, object schema. */
function validateTool(tool) {
  const problems = [];
  if (!tool || typeof tool !== "object") return ["tool is not an object"];
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name || "")) problems.push("name is not snake_case");
  if (!tool.description || tool.description.length < 20) problems.push("description too short to guide a model");
  const schema = tool.inputSchema;
  if (!schema || schema.type !== "object") problems.push("inputSchema.type must be 'object'");
  if (schema && schema.type === "object") {
    const props = schema.properties || {};
    if (!props || typeof props !== "object") problems.push("inputSchema.properties must be an object");
    for (const key of schema.required || []) {
      if (!(key in props)) problems.push(`required "${key}" is missing from properties`);
    }
  }
  return problems;
}

async function main() {
  console.log(`smoke: ${path.relative(ROOT, SERVER)}`);
  const { child, request, notify, stderr } = startServer();

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" },
    });
    const info = init.result || {};
    check(typeof info.protocolVersion === "string", "initialize negotiates a protocol version", info.protocolVersion);
    check(Boolean(info.capabilities && info.capabilities.tools), "initialize advertises the tools capability");
    check(Boolean(info.serverInfo && info.serverInfo.name), "initialize returns serverInfo");
    check(typeof info.instructions === "string" && info.instructions.length > 40, "initialize returns instructions for the model");

    notify("notifications/initialized", {});

    const ping = await request("ping", {});
    check(Boolean(ping.result), "ping answers");

    const listed = await request("tools/list", {});
    const tools = (listed.result && listed.result.tools) || [];
    check(tools.length === EXPECTED_TOOLS, `tools/list returns ${EXPECTED_TOOLS} tools`, `got ${tools.length}`);

    const names = tools.map((tool) => tool.name);
    check(new Set(names).size === names.length, "tool names are unique");

    const schemaProblems = [];
    for (const tool of tools) {
      for (const problem of validateTool(tool)) schemaProblems.push(`${tool.name}: ${problem}`);
    }
    check(schemaProblems.length === 0, "every tool has a usable schema", schemaProblems.join("; "));

    const expected = [
      "list_vms",
      "probe_channels",
      "run_command_in_guest",
      "capture_screen",
      "vmrun_raw",
    ].filter((name) => !names.includes(name));
    check(expected.length === 0, "core tools are present", `missing ${expected.join(", ")}`);

    const unknown = await request("tools/call", { name: "no_such_tool", arguments: {} });
    check(
      Boolean(unknown.error) || (unknown.result && unknown.result.isError),
      "unknown tool is rejected instead of crashing",
    );

    const afterError = await request("ping", {});
    check(Boolean(afterError.result), "server still answers after a bad call");
  } finally {
    child.kill();
  }

  const noisy = notes.filter((line) => /error|uncaught|unhandled/i.test(line));
  check(noisy.length === 0, "stderr has no errors", noisy.slice(0, 3).join(" | "));

  if (failures.length) {
    console.error(`\nsmoke: FAILED (${failures.length} check(s))`);
    process.exit(1);
  }
  console.log("\nsmoke: ok");
}

main().catch((error) => {
  console.error(`smoke: FAILED — ${error.message}`);
  process.exit(1);
});
