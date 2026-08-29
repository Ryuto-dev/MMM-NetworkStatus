"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const probes = require("../lib/probes");

test("commandAvailable detects a missing binary", async () => {
  const available = await probes.commandAvailable("definitely-not-a-real-binary-xyz", ["--version"], 2000);
  assert.equal(available, false);
});

test("commandAvailable detects an existing binary", async () => {
  const available = await probes.commandAvailable("node", ["--version"], 5000);
  assert.equal(available, true);
});

test("detectEngine falls back to http when no CLI is installed", async () => {
  const engine = await probes.detectEngine("librespeed");
  assert.ok(["librespeed", "http"].includes(engine));
});

test("detectEngine honours an explicit http request", async () => {
  assert.equal(await probes.detectEngine("http"), "http");
});

test("tcpProbe succeeds against a local server and fails on a closed port", async () => {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const ok = await probes.tcpProbe("127.0.0.1", port, 2000);
  assert.equal(ok.ok, true);
  assert.ok(Number.isFinite(ok.latency));

  await new Promise((resolve) => server.close(resolve));

  const failed = await probes.tcpProbe("127.0.0.1", port, 1500);
  assert.equal(failed.ok, false);
  assert.equal(failed.latency, null);
  assert.match(failed.reason, /^TCP_/);
});

test("measurePing over TCP against a local server returns a latency", async () => {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const result = await probes.measurePing({
    host: "127.0.0.1",
    tcpPort: port,
    count: 2,
    method: "tcp",
    timeout: 4000
  });
  assert.equal(result.method, "tcp");
  assert.ok(Number.isFinite(result.latency));
  assert.equal(result.packetLoss, 0);

  await new Promise((resolve) => server.close(resolve));
});

test("measurePing reports full packet loss for an unreachable TCP target", async () => {
  const result = await probes.measurePing({
    host: "127.0.0.1",
    tcpPort: 1, // reserved, nothing listens there
    count: 1,
    method: "tcp",
    timeout: 2000
  });
  assert.equal(result.latency, null);
  assert.equal(result.packetLoss, 100);
});

test("checkConnectivity reports offline for an unresolvable host", async () => {
  const result = await probes.checkConnectivity({
    host: "this-host-does-not-exist.invalid",
    url: "https://this-host-does-not-exist.invalid/",
    timeout: 2500
  });
  assert.equal(result.online, false);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("checkConnectivity reports online against a local HTTP endpoint", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const result = await probes.checkConnectivity({
    host: "127.0.0.1",
    url: `http://127.0.0.1:${port}/generate_204`,
    timeout: 3000
  });
  assert.equal(result.online, true);
  assert.ok(Number.isFinite(result.latency));

  await new Promise((resolve) => server.close(resolve));
});

test("runSpeedTest with the http engine measures against a local server", async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      req.resume();
      req.on("end", () => {
        res.statusCode = 200;
        res.end("ok");
      });
      return;
    }
    res.setHeader("Content-Length", String(payload.length));
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const stages = new Set();
  const outcome = await probes.runSpeedTest(
    {
      engine: "http",
      pingHost: "127.0.0.1",
      pingCount: 1,
      http: {
        downloadUrl: `http://127.0.0.1:${port}/down`,
        uploadUrl: `http://127.0.0.1:${port}/up`,
        uploadBytes: 512 * 1024,
        maxDurationMs: 2500
      }
    },
    (update) => stages.add(update.stage)
  );

  assert.equal(outcome.ok, true, `expected success, got ${outcome.error}`);
  assert.equal(outcome.engine, "http");
  assert.ok(outcome.result.download.bandwidth > 0);
  assert.ok(outcome.result.upload.bandwidth > 0);
  assert.ok(stages.has("ping"));
  assert.ok(stages.has("download"));
  assert.ok(stages.has("upload"));

  await new Promise((resolve) => server.close(resolve));
});

test("runSpeedTest with the http engine fails cleanly on a bad url", async () => {
  const outcome = await probes.runSpeedTest({
    engine: "http",
    pingHost: "127.0.0.1",
    pingCount: 1,
    http: {
      downloadUrl: "not-a-url",
      uploadUrl: "not-a-url",
      maxDurationMs: 1000
    }
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "INVALID_DOWNLOAD_URL");
});
