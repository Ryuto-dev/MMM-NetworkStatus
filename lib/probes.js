/* MMM-NetworkStatus - lib/probes.js
 *
 * Backend probes used by the node helper:
 *   - connectivity check (DNS + HTTP reachability)
 *   - latency measurement (system `ping`, TCP fallback, HTTP fallback)
 *   - speed measurement (Ookla Speedtest CLI, speedtest-cli, librespeed-cli
 *     and a dependency free HTTP fallback)
 *
 * Every probe resolves instead of rejecting whenever a "normal" network
 * failure occurs, so the caller can always render a state.
 *
 * MIT Licensed.
 */
"use strict";

const dns = require("node:dns");
const net = require("node:net");
const https = require("node:https");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const parsers = require("./parsers");

const USER_AGENT = "MMM-NetworkStatus/1.0 (+https://github.com/Ryuto-dev/MMM-NetworkStatus)";

/* ------------------------------------------------------------------ *
 * Connectivity
 * ------------------------------------------------------------------ */

/**
 * Check whether the mirror can reach the internet.
 *
 * @param {object} options
 * @param {string} [options.host] host used for the DNS lookup
 * @param {string} [options.url] URL used for the reachability check
 * @param {number} [options.timeout] milliseconds
 * @returns {Promise<{online: boolean, latency: number|null, reason: string|null}>}
 */
async function checkConnectivity (options = {}) {
  const host = options.host || "one.one.one.one";
  const url = options.url || "https://www.google.com/generate_204";
  const timeout = options.timeout ?? 5000;

  const started = performance.now();
  const dnsOk = await resolveHost(host, timeout);
  const httpOk = await headRequest(url, timeout);
  const latency = Math.round(performance.now() - started);

  if (httpOk.ok) return { online: true, latency, reason: null };
  if (dnsOk.ok) {
    // DNS resolves but HTTP fails: most likely a captive portal or a
    // blocked endpoint. Try a plain TCP connect as last resort.
    const tcp = await tcpProbe(host, 443, timeout);
    if (tcp.ok) return { online: true, latency: tcp.latency, reason: null };
    return { online: false, latency: null, reason: httpOk.reason || "HTTP_UNREACHABLE" };
  }
  return { online: false, latency: null, reason: dnsOk.reason || "DNS_FAILED" };
}

function resolveHost (host, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, reason: "DNS_TIMEOUT" });
      }
    }, timeout);

    dns.lookup(host, { all: false }, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err ? { ok: false, reason: `DNS_${err.code || "FAILED"}` } : { ok: true, reason: null });
    });
  });
}

function headRequest (url, timeout) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, reason: "INVALID_URL" });
      return;
    }
    const client = target.protocol === "http:" ? http : https;
    const req = client.request(
      target,
      { method: "GET", timeout, headers: { "User-Agent": USER_AGENT, Connection: "close" } },
      (res) => {
        // Any answer proves that we reached the internet.
        res.resume();
        const ok = res.statusCode !== undefined && res.statusCode < 500;
        resolve({ ok, reason: ok ? null : `HTTP_${res.statusCode}` });
      }
    );
    req.on("timeout", () => req.destroy(new Error("HTTP_TIMEOUT")));
    req.on("error", (err) => resolve({ ok: false, reason: `HTTP_${err.code || "ERROR"}` }));
    req.end();
  });
}

function tcpProbe (host, port, timeout) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeout);
    const finish = (ok, reason) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, latency: ok ? performance.now() - started : null, reason });
    };
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "TCP_TIMEOUT"));
    socket.once("error", (err) => finish(false, `TCP_${err.code || "ERROR"}`));
  });
}

/* ------------------------------------------------------------------ *
 * Latency
 * ------------------------------------------------------------------ */

/**
 * Measure latency. Tries the system `ping` binary first (most accurate,
 * ICMP) and falls back to a TCP handshake measurement when `ping` is
 * unavailable (common inside containers or when ICMP is filtered).
 *
 * @param {object} options
 * @param {string} [options.host]
 * @param {number} [options.count]
 * @param {number} [options.timeout] milliseconds for the whole run
 * @param {"auto"|"icmp"|"tcp"} [options.method]
 * @param {number} [options.tcpPort]
 * @returns {Promise<{latency:number|null, jitter:number|null, packetLoss:number|null, method:string, error:string|null}>}
 */
async function measurePing (options = {}) {
  const host = options.host || "1.1.1.1";
  const count = Math.max(1, Math.min(options.count ?? 3, 20));
  const timeout = options.timeout ?? 10000;
  const method = options.method || "auto";
  const port = options.tcpPort ?? 443;

  if (method !== "tcp") {
    const icmp = await icmpPing(host, count, timeout);
    if (icmp.latency !== null) return { ...icmp, method: "icmp", error: null };
    if (method === "icmp") {
      return { latency: null, jitter: null, packetLoss: 100, method: "icmp", error: icmp.error || "PING_FAILED" };
    }
  }

  const tcp = await tcpPing(host, port, count, timeout);
  return { ...tcp, method: "tcp" };
}

function pingArgs (host, count, timeoutSeconds) {
  if (process.platform === "win32") {
    return ["-n", String(count), "-w", String(Math.max(1000, timeoutSeconds * 1000)), host];
  }
  if (process.platform === "darwin") {
    return ["-c", String(count), "-t", String(timeoutSeconds), host];
  }
  return ["-c", String(count), "-w", String(timeoutSeconds), host];
}

function icmpPing (host, count, timeout) {
  return new Promise((resolve) => {
    const seconds = Math.max(1, Math.ceil(timeout / 1000));
    let child;
    try {
      child = spawn("ping", pingArgs(host, count, seconds), { windowsHide: true });
    } catch (err) {
      resolve({ latency: null, jitter: null, packetLoss: null, error: `SPAWN_${err.code || "ERROR"}` });
      return;
    }

    let stdout = "";
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch { /* already gone */ }
      resolve(payload);
    };
    const timer = setTimeout(() => done({ latency: null, jitter: null, packetLoss: null, error: "PING_TIMEOUT" }), timeout + 1500);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => done({ latency: null, jitter: null, packetLoss: null, error: `PING_${err.code || "ERROR"}` }));
    child.on("close", () => {
      const parsed = parsers.parsePingOutput(stdout);
      if (!parsed || parsed.latency === null) {
        done({ latency: null, jitter: null, packetLoss: 100, error: "PING_NO_REPLY" });
        return;
      }
      done({
        latency: parsed.latency,
        jitter: parsed.jitter,
        packetLoss: parsed.packetLoss,
        error: null
      });
    });
  });
}

async function tcpPing (host, port, count, timeout) {
  const samples = [];
  let failures = 0;
  const perAttempt = Math.max(1000, Math.floor(timeout / count));

  for (let i = 0; i < count; i += 1) {
    const result = await tcpProbe(host, port, perAttempt);
    if (result.ok && Number.isFinite(result.latency)) samples.push(result.latency);
    else failures += 1;
  }

  if (!samples.length) {
    return { latency: null, jitter: null, packetLoss: 100, error: "TCP_NO_REPLY" };
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const jitter = samples.length > 1
    ? samples.reduce((acc, v) => acc + Math.abs(v - avg), 0) / samples.length
    : null;
  return {
    latency: avg,
    jitter,
    packetLoss: (failures / count) * 100,
    error: null
  };
}

/* ------------------------------------------------------------------ *
 * Speed test engines
 * ------------------------------------------------------------------ */

const ENGINE_COMMANDS = {
  ookla: { command: "speedtest", probeArgs: ["--version"] },
  "speedtest-cli": { command: "speedtest-cli", probeArgs: ["--version"] },
  librespeed: { command: "librespeed-cli", probeArgs: ["--version"] }
};

/**
 * Check whether a CLI binary is callable.
 */
function commandAvailable (command, probeArgs = ["--version"], timeout = 5000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, probeArgs, { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch { /* noop */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 || code === 1));
  });
}

/**
 * Resolve which engine should be used.
 *
 * @param {"auto"|"ookla"|"speedtest-cli"|"librespeed"|"http"} preferred
 * @returns {Promise<string>}
 */
async function detectEngine (preferred = "auto") {
  if (preferred && preferred !== "auto") {
    if (preferred === "http") return "http";
    const spec = ENGINE_COMMANDS[preferred];
    if (spec && (await commandAvailable(spec.command, spec.probeArgs))) return preferred;
    return "http";
  }
  for (const name of ["ookla", "speedtest-cli", "librespeed"]) {
    const spec = ENGINE_COMMANDS[name];
    if (await commandAvailable(spec.command, spec.probeArgs)) return name;
  }
  return "http";
}

/**
 * Run a speed test with the requested engine.
 *
 * @param {object} options
 * @param {string} options.engine resolved engine name
 * @param {boolean} [options.acceptLicense] pass --accept-license/--accept-gdpr
 * @param {string|number} [options.serverId] Ookla server id
 * @param {number} [options.timeout] hard timeout in ms
 * @param {object} [options.http] configuration of the HTTP fallback
 * @param {(update: object) => void} [onProgress]
 * @returns {Promise<{ok: boolean, engine: string, result: object|null, error: string|null}>}
 */
async function runSpeedTest (options = {}, onProgress = () => {}) {
  const engine = options.engine || (await detectEngine(options.preferredEngine || "auto"));
  switch (engine) {
    case "ookla":
      return runOokla(options, onProgress, engine);
    case "speedtest-cli":
      return runJsonCli(
        "speedtest-cli",
        ["--json"],
        parsers.parseSpeedtestCliJson,
        options,
        onProgress,
        engine
      );
    case "librespeed":
      return runJsonCli(
        "librespeed-cli",
        ["--json"],
        parsers.parseLibrespeedJson,
        options,
        onProgress,
        engine
      );
    default:
      return runHttpFallback(options, onProgress);
  }
}

function runOokla (options, onProgress, engine) {
  const args = ["--format=jsonl", "--progress=yes"];
  if (options.acceptLicense !== false) args.push("--accept-license", "--accept-gdpr");
  if (options.serverId) args.push("--server-id=" + options.serverId);
  if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("speedtest", args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, engine, result: null, error: `SPAWN_${err.code || "ERROR"}` });
      return;
    }

    let buffer = "";
    let stderr = "";
    let finalResult = null;
    let errorMessage = null;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch { /* noop */ }
      resolve(payload);
    };
    const timer = setTimeout(
      () => finish({ ok: false, engine, result: null, error: "SPEEDTEST_TIMEOUT" }),
      options.timeout ?? 180000
    );

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parsers.parseOoklaLine(line);
        if (!parsed) continue;
        if (parsed.kind === "progress") {
          onProgress({
            stage: parsed.stage,
            progress: parsed.progress,
            bandwidth: parsed.bandwidth,
            latency: parsed.latency
          });
        } else if (parsed.kind === "result") {
          finalResult = parsed.result;
        } else if (parsed.kind === "error") {
          errorMessage = parsed.message;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish({ ok: false, engine, result: null, error: `SPAWN_${err.code || "ERROR"}` }));
    child.on("close", () => {
      if (finalResult) {
        finish({ ok: true, engine, result: finalResult, error: null });
        return;
      }
      finish({
        ok: false,
        engine,
        result: null,
        error: errorMessage || firstLine(stderr) || "SPEEDTEST_FAILED"
      });
    });
  });
}

function runJsonCli (command, args, parse, options, onProgress, engine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, engine, result: null, error: `SPAWN_${err.code || "ERROR"}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pulse);
      try {
        child.kill();
      } catch { /* noop */ }
      resolve(payload);
    };
    const timer = setTimeout(
      () => finish({ ok: false, engine, result: null, error: "SPEEDTEST_TIMEOUT" }),
      options.timeout ?? 180000
    );

    // These CLIs offer no progress stream, so emit a synthetic heartbeat to
    // keep the frontend animation alive.
    let ticks = 0;
    const pulse = setInterval(() => {
      ticks += 1;
      const stage = ticks < 3 ? "ping" : ticks < 12 ? "download" : "upload";
      onProgress({ stage, progress: null, bandwidth: null, latency: null, indeterminate: true });
    }, 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish({ ok: false, engine, result: null, error: `SPAWN_${err.code || "ERROR"}` }));
    child.on("close", () => {
      const result = parse(stdout);
      if (result) finish({ ok: true, engine, result, error: null });
      else finish({ ok: false, engine, result: null, error: firstLine(stderr) || "SPEEDTEST_FAILED" });
    });
  });
}

/* ------------------------------------------------------------------ *
 * HTTP fallback engine
 * ------------------------------------------------------------------ */

const DEFAULT_HTTP_CONFIG = {
  downloadUrl: "https://speed.cloudflare.com/__down?bytes=25000000",
  uploadUrl: "https://speed.cloudflare.com/__up",
  uploadBytes: 5 * 1024 * 1024,
  maxDurationMs: 10000
};

/**
 * Dependency free speed measurement used when no CLI is installed.
 * It streams a file, samples the throughput continuously (which drives the
 * live animation) and then pushes a buffer upstream.
 */
async function runHttpFallback (options = {}, onProgress = () => {}) {
  const cfg = { ...DEFAULT_HTTP_CONFIG, ...(options.http || {}) };
  const engine = "http";
  const result = parsers.EMPTY_RESULT();

  // Ping stage (TCP based, works everywhere).
  onProgress({ stage: "ping", progress: 0, bandwidth: null, latency: null });
  const ping = await measurePing({
    host: options.pingHost || "1.1.1.1",
    count: options.pingCount ?? 3,
    timeout: 6000
  });
  result.ping.latency = ping.latency;
  result.ping.jitter = ping.jitter;
  result.ping.packetLoss = ping.packetLoss;
  onProgress({ stage: "ping", progress: 1, bandwidth: null, latency: ping.latency });

  const download = await httpDownload(cfg, (update) => onProgress({ stage: "download", ...update }));
  if (download.error && !download.bandwidth) {
    return { ok: false, engine, result: null, error: download.error };
  }
  result.download.bandwidth = download.bandwidth;
  onProgress({ stage: "download", progress: 1, bandwidth: download.bandwidth, latency: null });

  const upload = await httpUpload(cfg, (update) => onProgress({ stage: "upload", ...update }));
  result.upload.bandwidth = upload.bandwidth;
  onProgress({ stage: "upload", progress: 1, bandwidth: upload.bandwidth, latency: null });

  result.server = { name: "HTTP fallback", location: hostOf(cfg.downloadUrl), id: null };
  return { ok: true, engine, result, error: null };
}

function httpDownload (cfg, onProgress) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(cfg.downloadUrl);
    } catch {
      resolve({ bandwidth: null, error: "INVALID_DOWNLOAD_URL" });
      return;
    }
    const client = target.protocol === "http:" ? http : https;
    const started = performance.now();
    let bytes = 0;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seconds = (performance.now() - started) / 1000;
      const bandwidth = seconds > 0 && bytes > 0 ? (bytes * 8) / seconds : null;
      resolve({ bandwidth, error: bandwidth ? null : error || "DOWNLOAD_FAILED" });
    };

    const req = client.get(
      target,
      { timeout: 10000, headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" } },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          finish(`HTTP_${res.statusCode}`);
          return;
        }
        const total = Number.parseInt(res.headers["content-length"] ?? "", 10);
        res.on("data", (chunk) => {
          bytes += chunk.length;
          const seconds = (performance.now() - started) / 1000;
          if (seconds > 0.2) {
            onProgress({
              progress: Number.isFinite(total) && total > 0
                ? Math.min(bytes / total, 0.99)
                : Math.min(seconds / (cfg.maxDurationMs / 1000), 0.99),
              bandwidth: (bytes * 8) / seconds
            });
          }
          if (performance.now() - started > cfg.maxDurationMs) {
            res.destroy();
            finish(null);
          }
        });
        res.on("end", () => finish(null));
        res.on("error", (err) => finish(`DOWNLOAD_${err.code || "ERROR"}`));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish("DOWNLOAD_TIMEOUT");
    }, cfg.maxDurationMs + 8000);
    req.on("timeout", () => req.destroy(new Error("DOWNLOAD_TIMEOUT")));
    req.on("error", (err) => finish(`DOWNLOAD_${err.code || "ERROR"}`));
  });
}

function httpUpload (cfg, onProgress) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(cfg.uploadUrl);
    } catch {
      resolve({ bandwidth: null, error: "INVALID_UPLOAD_URL" });
      return;
    }
    const client = target.protocol === "http:" ? http : https;
    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize, 0x30);
    const totalBytes = Math.max(chunkSize, cfg.uploadBytes);
    let sent = 0;
    let settled = false;
    const started = performance.now();

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seconds = (performance.now() - started) / 1000;
      const bandwidth = seconds > 0 && sent > 0 ? (sent * 8) / seconds : null;
      resolve({ bandwidth, error: bandwidth ? null : error || "UPLOAD_FAILED" });
    };

    const req = client.request(
      target,
      {
        method: "POST",
        timeout: 10000,
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(totalBytes)
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => finish(null));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, cfg.maxDurationMs + 8000);

    const writeNext = () => {
      while (sent < totalBytes) {
        const size = Math.min(chunkSize, totalBytes - sent);
        const ok = req.write(size === chunkSize ? chunk : chunk.subarray(0, size));
        sent += size;
        const seconds = (performance.now() - started) / 1000;
        if (seconds > 0.2) {
          onProgress({
            progress: Math.min(sent / totalBytes, 0.99),
            bandwidth: (sent * 8) / seconds
          });
        }
        if (performance.now() - started > cfg.maxDurationMs) break;
        if (!ok) {
          req.once("drain", writeNext);
          return;
        }
      }
      req.end();
    };

    req.on("timeout", () => req.destroy(new Error("UPLOAD_TIMEOUT")));
    req.on("error", (err) => finish(`UPLOAD_${err.code || "ERROR"}`));
    writeNext();
  });
}

function firstLine (text) {
  if (typeof text !== "string") return null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 200) : null;
}

function hostOf (url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_HTTP_CONFIG,
  checkConnectivity,
  commandAvailable,
  detectEngine,
  measurePing,
  runSpeedTest,
  tcpProbe
};
