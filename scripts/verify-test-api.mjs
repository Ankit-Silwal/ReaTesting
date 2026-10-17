import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
await mkdir(".verification", { recursive: true });
const directory = await mkdtemp(resolve(".verification/test-api-"));
const file = join(directory, "records.json");
const executable = resolve("target/debug/relay-test-api.exe");
const origin = `http://127.0.0.1:${port}`;
let child;
let output = "";

async function start() {
  child = spawn(executable, ["--port", String(port), "--file", file], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      /* Wait for the owned child to bind. */
    }
    await pause(50);
  }
  throw new Error(`Server did not become ready: ${output}`);
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}
async function request(method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

try {
  await start();
  assert.equal((await request("GET", "/test/1")).body.id, 1);
  const created = await request("POST", "/test", {
    name: "Wire test",
    extra: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 2);
  assert.equal(created.headers.get("location"), "/test/2");
  assert.equal((await request("GET", "/test/2")).body.name, "Wire test");
  const replaced = await request("PUT", "/test/2", { name: "Replaced" });
  assert.equal(replaced.body.extra, undefined);
  assert.equal(replaced.body.id, 2);
  const patched = await request("PATCH", "/test/2", { count: 42 });
  assert.equal(patched.body.name, "Replaced");
  assert.equal(patched.body.count, 42);
  assert.deepEqual((await request("DELETE", "/test/2")).body, {
    deleted: true,
    id: 2,
  });
  assert.equal((await request("GET", "/test/2")).status, 404);
  await stop();
  await start();
  assert.equal(
    (await request("POST", "/test", { name: "After restart" })).body.id,
    3,
  );
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(disk.nextId, 4);
  assert.equal(disk.records.length, 2);
  console.log(
    "PASS: real HTTP GET, POST, PUT, PATCH, DELETE, JSON file persistence, and increasing IDs across restart",
  );
  console.log(`Test data retained at ${file}`);
} finally {
  await stop();
}
