// Minimal MCP stdio client used to verify the vmware-mcp server end to end.
"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");

const serverPath = process.argv[2] || path.join(__dirname, "server.js");
const calls = JSON.parse(process.argv[3] || "[]");

const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
const pending = new Map();
let nextId = 1;

child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.log("<< unparsable:", line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify(payload) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout waiting for " + method));
      }
    }, 180000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

(async () => {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  });
  console.log("initialize ->", JSON.stringify(init.result, null, 2));
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  console.log("tools:", list.result.tools.map((t) => t.name).join(", "));
  console.log("tool count:", list.result.tools.length);

  for (const call of calls) {
    const res = await request("tools/call", { name: call.name, arguments: call.arguments || {} });
    const content = res.result ? res.result.content : res.error;
    const isError = res.result && res.result.isError;
    console.log(`\n=== ${call.name} ${JSON.stringify(call.arguments || {})} -> ${isError ? "ERROR" : "ok"}`);
    for (const block of Array.isArray(content) ? content : [content]) {
      if (block.type === "image") console.log(`[image ${block.mimeType}, ${block.data.length} base64 chars]`);
      else console.log(block.text ?? JSON.stringify(block));
    }
  }
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  child.kill();
  process.exit(1);
});
