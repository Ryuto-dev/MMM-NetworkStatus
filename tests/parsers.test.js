"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const parsers = require("../lib/parsers");

test("parseOoklaLine reads ping progress", () => {
  const line = JSON.stringify({
    type: "ping",
    timestamp: "2024-01-01T00:00:00Z",
    ping: { jitter: 1.2, latency: 12.4, progress: 0.5 }
  });
  const parsed = parsers.parseOoklaLine(line);
  assert.equal(parsed.kind, "progress");
  assert.equal(parsed.stage, "ping");
  assert.equal(parsed.progress, 0.5);
  assert.equal(parsed.latency, 12.4);
  assert.equal(parsed.jitter, 1.2);
});

test("parseOoklaLine converts bytes/s progress to bits/s", () => {
  const line = JSON.stringify({
    type: "download",
    download: { bandwidth: 1_250_000, bytes: 500_000, elapsed: 400, progress: 0.25 }
  });
  const parsed = parsers.parseOoklaLine(line);
  assert.equal(parsed.stage, "download");
  assert.equal(parsed.bandwidth, 10_000_000); // 1.25 MB/s == 10 Mbps
  assert.equal(parsed.progress, 0.25);
});

test("parseOoklaLine reads the final result", () => {
  const line = JSON.stringify({
    type: "result",
    ping: { jitter: 1.5, latency: 11.9, low: 10, high: 13 },
    download: { bandwidth: 11_800_000, bytes: 100, elapsed: 1000 },
    upload: { bandwidth: 2_300_000, bytes: 100, elapsed: 1000 },
    packetLoss: 0,
    isp: "Example ISP",
    server: { id: 1234, name: "Example Server", location: "Tokyo" },
    result: { id: "abc", url: "https://www.speedtest.net/result/c/abc" }
  });
  const parsed = parsers.parseOoklaLine(line);
  assert.equal(parsed.kind, "result");
  assert.equal(parsed.result.ping.latency, 11.9);
  assert.equal(parsed.result.ping.jitter, 1.5);
  assert.equal(parsed.result.ping.packetLoss, 0);
  assert.equal(parsed.result.download.bandwidth, 94_400_000);
  assert.equal(parsed.result.upload.bandwidth, 18_400_000);
  assert.equal(parsed.result.isp, "Example ISP");
  assert.equal(parsed.result.server.name, "Example Server");
  assert.equal(parsed.result.server.location, "Tokyo");
  assert.equal(parsed.result.resultUrl, "https://www.speedtest.net/result/c/abc");
});

test("parseOoklaLine tolerates junk", () => {
  assert.equal(parsers.parseOoklaLine(""), null);
  assert.equal(parsers.parseOoklaLine("not json"), null);
  assert.equal(parsers.parseOoklaLine(JSON.stringify({ type: "log", message: "x" })), null);
  assert.equal(parsers.parseOoklaLine(null), null);
});

test("parseOoklaLine surfaces errors", () => {
  const parsed = parsers.parseOoklaLine(JSON.stringify({ type: "unknown", error: "Timeout occurred" }));
  assert.equal(parsed.kind, "error");
  assert.equal(parsed.message, "Timeout occurred");
});

test("parseOoklaJson parses the non-streaming document", () => {
  const doc = JSON.stringify({
    ping: { latency: 20 },
    download: { bandwidth: 1_000_000 },
    upload: { bandwidth: 500_000 }
  });
  const result = parsers.parseOoklaJson(doc);
  assert.equal(result.ping.latency, 20);
  assert.equal(result.download.bandwidth, 8_000_000);
  assert.equal(result.upload.bandwidth, 4_000_000);
});

test("parseSpeedtestCliJson keeps bits per second", () => {
  const doc = JSON.stringify({
    ping: 15.2,
    download: 94_000_000,
    upload: 18_000_000,
    server: { sponsor: "ISP Co", name: "Tokyo", id: "9" },
    client: { isp: "Example ISP" }
  });
  const result = parsers.parseSpeedtestCliJson(doc);
  assert.equal(result.ping.latency, 15.2);
  assert.equal(result.download.bandwidth, 94_000_000);
  assert.equal(result.upload.bandwidth, 18_000_000);
  assert.equal(result.server.name, "ISP Co");
  assert.equal(result.isp, "Example ISP");
});

test("parseLibrespeedJson converts Mbps to bps", () => {
  const doc = JSON.stringify([
    { ping: 9.5, jitter: 1.1, download: 94.5, upload: 18.2, server: { name: "LibreSpeed" }, share: "https://x/y.png" }
  ]);
  const result = parsers.parseLibrespeedJson(doc);
  assert.equal(result.ping.latency, 9.5);
  assert.equal(result.ping.jitter, 1.1);
  assert.equal(result.download.bandwidth, 94_500_000);
  assert.equal(result.upload.bandwidth, 18_200_000);
  assert.equal(result.server.name, "LibreSpeed");
});

test("safeJson skips leading noise", () => {
  assert.deepEqual(parsers.safeJson('WARNING: something\n{"a":1}'), { a: 1 });
  assert.equal(parsers.safeJson("garbage"), null);
  assert.equal(parsers.safeJson(""), null);
});

test("parsePingOutput reads the Linux summary", () => {
  const out = [
    "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.",
    "64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=5.11 ms",
    "64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=6.34 ms",
    "",
    "--- 1.1.1.1 ping statistics ---",
    "3 packets transmitted, 3 received, 0% packet loss, time 2003ms",
    "rtt min/avg/max/mdev = 5.110/6.020/7.220/0.812 ms"
  ].join("\n");
  const parsed = parsers.parsePingOutput(out);
  assert.equal(parsed.latency, 6.02);
  assert.equal(parsed.min, 5.11);
  assert.equal(parsed.max, 7.22);
  assert.equal(parsed.jitter, 0.812);
  assert.equal(parsed.packetLoss, 0);
});

test("parsePingOutput reads the Windows summary", () => {
  const out = [
    "Ping statistics for 1.1.1.1:",
    "    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),",
    "Approximate round trip times in milli-seconds:",
    "    Minimum = 4ms, Maximum = 9ms, Average = 6ms"
  ].join("\n");
  const parsed = parsers.parsePingOutput(out);
  assert.equal(parsed.latency, 6);
  assert.equal(parsed.min, 4);
  assert.equal(parsed.max, 9);
  assert.equal(parsed.packetLoss, 0);
});

test("parsePingOutput falls back to averaging samples", () => {
  const out = [
    "64 bytes from 8.8.8.8: icmp_seq=1 ttl=57 time=10.0 ms",
    "64 bytes from 8.8.8.8: icmp_seq=2 ttl=57 time=20.0 ms"
  ].join("\n");
  const parsed = parsers.parsePingOutput(out);
  assert.equal(parsed.latency, 15);
  assert.equal(parsed.min, 10);
  assert.equal(parsed.max, 20);
});

test("parsePingOutput detects total packet loss", () => {
  const out = [
    "--- 10.0.0.1 ping statistics ---",
    "3 packets transmitted, 0 received, 100% packet loss, time 3070ms"
  ].join("\n");
  assert.equal(parsers.parsePingOutput(out), null);
  assert.equal(parsers.parsePacketLoss(out), 100);
});

test("parsePingOutput ignores empty input", () => {
  assert.equal(parsers.parsePingOutput(""), null);
  assert.equal(parsers.parsePingOutput(null), null);
});
